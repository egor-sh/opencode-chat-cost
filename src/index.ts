import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

/** Цены одной модели (или default). Руб. за 1M токенов. */
export type ModelPrices = {
  inputPrice?: number
  outputPrice?: number
  cacheReadPrice?: number
  cacheWritePrice?: number
}

type Tokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

type ModelUsage = Tokens & { providerID: string; modelID: string }

type SessionStats = {
  tokens: Tokens
  perModel: ModelUsage[]
  prompts: string[]
  tools: Record<string, number>
  files: Set<string>
  messages: number
  turns: number
}

/** Формат chat-cost.json: цены по моделям + default; старый плоский формат тоже читается. */
type PriceConfig = {
  currency?: string
  default?: ModelPrices
  models?: Record<string, ModelPrices>
} & ModelPrices

const ZERO: Tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

function fmt(n: number): string {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 0 })
}

function money(n: number, currency: string): string {
  return (
    n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    " " +
    currency
  )
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine
}

/** Достаём путь файла из tool-части сообщения (форма зависит от инструмента). */
function extractFilePath(part: any): string | undefined {
  const candidates = [
    part?.state?.input?.filePath,
    part?.state?.input?.path,
    part?.state?.metadata?.filepath,
    part?.state?.metadata?.filePath,
    part?.state?.metadata?.path,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c
  }
  return undefined
}

function isUserCommandNoise(text: string): boolean {
  // Служебные сообщения opencode (команды, сабтаски) не показываем как запросы
  return text.trim().length === 0
}

/** Цена для конкретной модели: точное "provider/model" → "model" → "*" → default. */
function priceFor(
  config: PriceConfig,
  providerID: string,
  modelID: string,
): ModelPrices | undefined {
  const models = config.models ?? {}
  const direct = models[`${providerID}/${modelID}`] ?? models[modelID]
  if (direct) return direct
  return models["*"] ?? config.default
}

function hasAnyPrice(p?: ModelPrices): boolean {
  return !!p && (p.inputPrice != null || p.outputPrice != null || p.cacheReadPrice != null || p.cacheWritePrice != null)
}

function costOf(t: Tokens, p: ModelPrices): number {
  return (
    (t.input / 1e6) * (p.inputPrice ?? 0) +
    (t.output / 1e6) * (p.outputPrice ?? 0) +
    (t.cacheRead / 1e6) * (p.cacheReadPrice ?? 0) +
    (t.cacheWrite / 1e6) * (p.cacheWritePrice ?? 0)
  )
}

async function collectStats(
  client: any,
  sessionID: string,
  directory: string,
): Promise<SessionStats> {
  const res = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  })
  const messages: Array<{ info: any; parts: any[] }> = res.data ?? res
  return computeStats(messages)
}

/** V2: история сессии через ctx.session.context. */
async function collectStatsV2(ctx: any, sessionID: string): Promise<SessionStats> {
  const res = await ctx.session.context({ sessionID })
  const raw = res?.messages ?? res?.data ?? res
  const list = Array.isArray(raw) ? raw : raw?.messages ?? []
  const messages: Array<{ info: any; parts: any[] }> = list.map((m: any) =>
    Array.isArray(m) ? { info: m[0], parts: m[1] ?? [] } : { info: m.info ?? m, parts: m.parts ?? [] },
  )
  return computeStats(messages)
}

function computeStats(messages: Array<{ info: any; parts: any[] }>): SessionStats {
  const stats: SessionStats = {
    tokens: { ...ZERO },
    perModel: [],
    prompts: [],
    tools: {},
    files: new Set(),
    messages: 0,
    turns: 0,
  }
  const byModel = new Map<string, ModelUsage>()

  for (const { info, parts } of messages) {
    stats.messages++
    if (info?.role === "assistant" && info?.tokens) {
      const t = info.tokens
      stats.tokens.input += t.input ?? 0
      stats.tokens.output += t.output ?? 0
      stats.tokens.reasoning += t.reasoning ?? 0
      stats.tokens.cacheRead += t.cache?.read ?? 0
      stats.tokens.cacheWrite += t.cache?.write ?? 0

      const providerID = String(info.providerID ?? "unknown")
      const modelID = String(info.modelID ?? "unknown")
      const key = `${providerID}/${modelID}`
      let usage = byModel.get(key)
      if (!usage) {
        usage = { ...ZERO, providerID, modelID }
        byModel.set(key, usage)
      }
      usage.input += t.input ?? 0
      usage.output += t.output ?? 0
      usage.reasoning += t.reasoning ?? 0
      usage.cacheRead += t.cache?.read ?? 0
      usage.cacheWrite += t.cache?.write ?? 0
    }
    if (info?.role === "user") {
      stats.turns++
      for (const part of parts ?? []) {
        if (part?.type === "text" && typeof part.text === "string") {
          if (!isUserCommandNoise(part.text)) {
            stats.prompts.push(truncate(part.text, 120))
          }
        }
      }
    }
    if (info?.role === "user") continue
    for (const part of parts ?? []) {
      if (part?.type !== "tool") continue
      const name = String(part.tool ?? part.state?.tool ?? "unknown")
      stats.tools[name] = (stats.tools[name] ?? 0) + 1
      const file = extractFilePath(part)
      if (file) stats.files.add(file)
    }
  }
  stats.perModel = Array.from(byModel.values()).sort((a, b) =>
    `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`),
  )
  return stats
}

function buildReport(stats: SessionStats, config: PriceConfig): string {
  const cur = config.currency ?? "₽"
  const lines: string[] = []

  lines.push("## Токены и стоимость чата")
  lines.push("")
  lines.push("| Категория | Токены |")
  lines.push("|---|---:|")
  lines.push(`| Input | ${fmt(stats.tokens.input)} |`)
  lines.push(`| Output | ${fmt(stats.tokens.output)} |`)
  lines.push(`| Cache read | ${fmt(stats.tokens.cacheRead)} |`)
  lines.push(`| Cache write | ${fmt(stats.tokens.cacheWrite)} |`)

  // Разбивка по моделям
  if (stats.perModel.length > 0) {
    lines.push("")
    lines.push("**По моделям:**")
    lines.push("")
    lines.push("| Модель | Input | Output | Cache read | Cache write | Стоимость |")
    lines.push("|---|---:|---:|---:|---:|---:|")
    const unpriced: string[] = []
    let total = 0
    for (const u of stats.perModel) {
      const key = `${u.providerID}/${u.modelID}`
      const p = priceFor(config, u.providerID, u.modelID)
      if (!hasAnyPrice(p)) {
        unpriced.push(key)
        lines.push(
          `| ${key} | ${fmt(u.input)} | ${fmt(u.output)} | ${fmt(u.cacheRead)} | ${fmt(u.cacheWrite)} | — |`,
        )
        continue
      }
      const cost = costOf(u, p as ModelPrices)
      total += cost
      lines.push(
        `| ${key} | ${fmt(u.input)} | ${fmt(u.output)} | ${fmt(u.cacheRead)} | ${fmt(u.cacheWrite)} | ${money(cost, cur)} |`,
      )
    }
    if (unpriced.length > 0) {
      lines.push(`| **итого (модели с ценами)** | | | | | **${money(total, cur)}** |`)
    } else {
      lines.push(`| **итого** | | | | | **${money(total, cur)}** |`)
    }

    // Служебный маркер для модели: какие модели без цен
    if (unpriced.length > 0) {
      lines.push("")
      lines.push(
        "## Модели без цены (служебное)\n\n" +
          "Для следующих моделей цены не заданы: " +
          unpriced.join(", ") +
          ".",
      )
    }
  }

  // Черновой материал — модель на его основе пишет связное описание, как есть не выводить
  lines.push("")
  lines.push("## Материал для описания работ (служебное, пользователю не выводить дословно)")
  lines.push("")
  if (stats.prompts.length > 0) {
    lines.push("**Запросы пользователя:**")
    for (const [i, p] of stats.prompts.slice(0, 20).entries()) {
      lines.push(`${i + 1}. ${p}`)
    }
    if (stats.prompts.length > 20) {
      lines.push(`…и ещё ${stats.prompts.length - 20} запросов`)
    }
  } else {
    lines.push("Запросов пользователя не найдено.")
  }
  if (stats.files.size > 0) {
    lines.push("")
    lines.push("**Затронутые файлы:** " + Array.from(stats.files).slice(0, 30).join(", "))
    if (stats.files.size > 30) lines.push(`…и ещё ${stats.files.size - 30}`)
  }

  return lines.join("\n")
}

const TOOL_DESCRIPTION =
  "Считает токены и стоимость текущего чата по моделям (цены из chat-cost.json / опций плагина) и собирает материал о проделанной работе: запросы пользователя и затронутые файлы. Возвращает markdown: таблица токенов, разбивка по моделям со стоимостью, список моделей без цены, служебный материал для описания."

const SET_PRICES_DESCRIPTION =
  "Сохраняет цены токенов (руб. за 1M) для модели в chat-cost.json плагина. Вызывайте после того, как пользователь сообщил цены. model — ключ модели: \"providerID/modelID\" или просто \"modelID\"; \"*\" — цены по умолчанию для всех моделей без своей записи."

const COMMAND_DESCRIPTION =
  "Токены и стоимость (₽) чата по моделям + краткое описание работ. Опционально: ключ задачи Jira в аргументе, например PROJ-123"

function commandTemplate(argumentsHint: string): string {
  return [
    "Вызови инструмент `chat_cost` для текущей сессии.",
    "Выведи пользователю: таблицу токенов и разбивку по моделям из ответа инструмента как есть (markdown).",
    "Затем на основе раздела «Материал для описания работ» напиши связное описание выполненной работы в 1–3 предложениях — не перечисляй запросы и инструменты по номерам.",
    "",
    "Если в ответе есть раздел «Модели без цены» — это модели, для которых стоимость посчитать нельзя:",
    "- Спроси у пользователя цены input и output (руб. за 1M токенов) для каждой из этих моделей. Кэш-цены спрашивай, только если пользователь сам про них упомянул.",
    "- Получив цены, вызови `chat_cost_set_prices` для каждой модели (model — ключ из раздела), затем вызови `chat_cost` заново и выведи обновлённый отчёт.",
    "- Если пользователь не хочет называть цены — просто сообщи, что стоимость этих моделей не считается.",
    "",
    "Дальше — про Jira:",
    "- Если в аргументах команды указан ключ задачи (например `" + argumentsHint + "`) — предложи прикрепить комментарий к этой задаче.",
    "- Если аргументов нет — поищи ключ задачи Jira (формат ABC-123) в запросах пользователя из материала и в истории текущего чата. Если нашёл — предложи прикрепить комментарий к этой же задаче.",
    "- Если ключ не нашёлся — спроси пользователя, к какой задаче Jira отправить комментарий.",
    "",
    "ВАЖНО: комментарий в Jira самостоятельно не публикуй. Сначала предложи задачу и покажи, какой текст будет отправлен, и дождись явного подтверждения пользователя. Только после подтверждения опубликуй отчёт как комментарий через MCP-сервер atlassian (инструмент jira add comment). Если MCP atlassian недоступен — сообщи об этом.",
  ].join("\n")
}

// Цены задаются либо в опциях плагина (формат ["путь", { ... }] в opencode.json),
// либо в файле chat-cost.json рядом с index.ts — на случай, если сборка не передаёт options.
async function readPriceConfig(inline?: any): Promise<PriceConfig> {
  let fileConfig: PriceConfig = {}
  try {
    const srcDir = new URL(".", import.meta.url).pathname
    const rootDir = new URL("../", import.meta.url).pathname
    for (const dir of [srcDir, rootDir]) {
      try {
        fileConfig = JSON.parse(await Bun.file(dir + "chat-cost.json").text())
        break
      } catch {
        // нет в этом каталоге — пробуем следующий
      }
    }
  } catch {
    // Bun недоступен — цены только из options или не заданы
  }
  // Старый плоский формат {inputPrice, ...} = цены по умолчанию для всех моделей
  const legacy: ModelPrices = {
    inputPrice: fileConfig.inputPrice,
    outputPrice: fileConfig.outputPrice,
    cacheReadPrice: fileConfig.cacheReadPrice,
    cacheWritePrice: fileConfig.cacheWritePrice,
  }
  const config: PriceConfig = {
    currency: fileConfig.currency,
    default: { ...legacy, ...(fileConfig.default ?? {}) },
    models: fileConfig.models ?? {},
    ...flatPrices(inline),
  }
  if (inline?.currency) config.currency = inline.currency
  return config
}

function flatPrices(src?: ModelPrices): PriceConfig {
  if (!src) return {}
  const has = hasAnyPrice(src)
  return has ? { default: { ...src } } : {}
}

/** Каталог, в который пишем chat-cost.json: предпочитаем уже существующий файл, иначе корень плагина. */
async function priceFileCandidates(): Promise<string[]> {
  const srcDir = new URL(".", import.meta.url).pathname
  const rootDir = new URL("../", import.meta.url).pathname
  const candidates = [rootDir + "chat-cost.json", srcDir + "chat-cost.json"]
  for (const c of candidates) {
    try {
      if (await Bun.file(c).exists()) return [c]
    } catch {}
  }
  return [candidates[0]]
}

const setPricesArgs = {
  model: z
    .string()
    .describe('Ключ модели: "providerID/modelID" или "modelID"; "*" — по умолчанию для всех моделей'),
  inputPrice: z.number().describe("Руб. за 1M input-токенов"),
  outputPrice: z.number().describe("Руб. за 1M output-токенов"),
  cacheReadPrice: z.number().optional().describe("Руб. за 1M cache read-токенов (опционально)"),
  cacheWritePrice: z.number().optional().describe("Руб. за 1M cache write-токенов (опционально)"),
}

async function savePrices(args: {
  model: string
  inputPrice: number
  outputPrice: number
  cacheReadPrice?: number
  cacheWritePrice?: number
}): Promise<string> {
  const files = await priceFileCandidates()
  let config: any = {}
  try {
    config = JSON.parse(await Bun.file(files[0]).text())
  } catch {
    config = {}
  }
  // Старый плоский формат переносим в default, чтобы не потерять
  if (config.inputPrice != null || config.outputPrice != null) {
    config.default = { ...config.default, inputPrice: config.inputPrice, outputPrice: config.outputPrice, cacheReadPrice: config.cacheReadPrice, cacheWritePrice: config.cacheWritePrice }
    delete config.inputPrice
    delete config.outputPrice
    delete config.cacheReadPrice
    delete config.cacheWritePrice
  }
  config.models = config.models ?? {}
  const entry: ModelPrices = { inputPrice: args.inputPrice, outputPrice: args.outputPrice }
  if (args.cacheReadPrice != null) entry.cacheReadPrice = args.cacheReadPrice
  if (args.cacheWritePrice != null) entry.cacheWritePrice = args.cacheWritePrice
  config.models[args.model] = entry
  await Bun.write(files[0], JSON.stringify(config, null, 2) + "\n")
  return `Цены для ${args.model} сохранены в ${files[0]}. Вызови chat_cost заново и покажи обновлённый отчёт.`
}

const ChatCostPlugin: Plugin = async (input, options) => {
  const client: any = input.client
  const directory = input.directory

  return {
    config: (config) => {
      config.command = config.command ?? {}
      config.command["otchet"] = {
        description: COMMAND_DESCRIPTION,
        template: commandTemplate("$ARGUMENTS"),
        agent: "build",
      }
    },
    tool: {
      chat_cost: tool({
        description: TOOL_DESCRIPTION,
        args: {},
        async execute(_args, context) {
          const config = await readPriceConfig(options)
          const stats = await collectStats(client, context.sessionID, directory)
          return buildReport(stats, config)
        },
      }),
      chat_cost_set_prices: tool({
        description: SET_PRICES_DESCRIPTION,
        args: setPricesArgs,
        async execute(args: any) {
          return savePrices(args)
        },
      }),
    },
  }
}

/**
 * V2 (opencode ≥ 2.x): контракт default-экспорта — объект { id, setup }.
 * Всё регистрируется через ctx-домены; возвращаемый объект хуков не используется.
 */
async function v2Setup(ctx: any) {
  await ctx.tool.transform((editor: any) => {
    editor.add({
      name: "chat_cost",
      description: TOOL_DESCRIPTION,
      input: z.object({}),
      execute: async (_input: any, toolCtx: any) => {
        const config = await readPriceConfig(ctx?.options)
        const stats = await collectStatsV2(ctx, toolCtx.sessionID)
        return { content: buildReport(stats, config) }
      },
    })
    editor.add({
      name: "chat_cost_set_prices",
      description: SET_PRICES_DESCRIPTION,
      input: z.object(setPricesArgs),
      execute: async (args: any) => {
        return { content: await savePrices(args) }
      },
    })
  })

  await ctx.command.transform((editor: any) => {
    editor.add({
      name: "otchet",
      description: COMMAND_DESCRIPTION,
      execute: async ({ sessionID, prompt, delivery }: any) => {
        const args = typeof prompt?.text === "string" ? prompt.text.trim() : ""
        await ctx.session.prompt({
          sessionID,
          delivery,
          text: commandTemplate(args ? `аргументы: ${args}` : "$ARGUMENTS"),
        })
      },
    })
  })
}

/**
 * Единый экспорт для обеих версий opencode:
 * - V1 (1.x): читает { id, server } и вызывает server(input, options) → хуки { config, tool }
 * - V2 (2.x): читает { id, setup } и вызывает setup(ctx); лишнее свойство server игнорируется схемой
 */
export default {
  id: "opencode-chat-cost",
  server: ChatCostPlugin,
  setup: v2Setup,
}
