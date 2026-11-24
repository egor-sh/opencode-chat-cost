import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export type ChatCostOptions = {
  /** Цена за 1M input-токенов, руб. */
  inputPrice?: number
  /** Цена за 1M output-токенов (включая reasoning), руб. */
  outputPrice?: number
  /** Цена за 1M cache read-токенов, руб. */
  cacheReadPrice?: number
  /** Цена за 1M cache write-токенов, руб. */
  cacheWritePrice?: number
  /** Символ валюты для отчёта */
  currency?: string
}

type Tokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

type SessionStats = {
  tokens: Tokens
  prompts: string[]
  tools: Record<string, number>
  files: Set<string>
  messages: number
  turns: number
}

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

  const stats: SessionStats = {
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    prompts: [],
    tools: {},
    files: new Set(),
    messages: 0,
    turns: 0,
  }

  for (const { info, parts } of messages) {
    stats.messages++
    if (info?.role === "assistant" && info?.tokens) {
      const t = info.tokens
      stats.tokens.input += t.input ?? 0
      stats.tokens.output += t.output ?? 0
      stats.tokens.reasoning += t.reasoning ?? 0
      stats.tokens.cacheRead += t.cache?.read ?? 0
      stats.tokens.cacheWrite += t.cache?.write ?? 0
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
  return stats
}

function buildReport(stats: SessionStats, options: ChatCostOptions): string {
  const cur = options.currency ?? "₽"
  const lines: string[] = []

  lines.push("## Токены и стоимость чата")
  lines.push("")
  lines.push("| Категория | Токены |")
  lines.push("|---|---:|")
  lines.push(`| Input | ${fmt(stats.tokens.input)} |`)
  lines.push(`| Output | ${fmt(stats.tokens.output)} |`)
  lines.push(`| Cache read | ${fmt(stats.tokens.cacheRead)} |`)
  lines.push(`| Cache write | ${fmt(stats.tokens.cacheWrite)} |`)

  const hasPrice =
    options.inputPrice != null ||
    options.outputPrice != null ||
    options.cacheReadPrice != null ||
    options.cacheWritePrice != null
  if (hasPrice) {
    const input = ((stats.tokens.input / 1e6) * (options.inputPrice ?? 0))
    const output = ((stats.tokens.output / 1e6) * (options.outputPrice ?? 0))
    const cacheRead = ((stats.tokens.cacheRead / 1e6) * (options.cacheReadPrice ?? 0))
    const cacheWrite = ((stats.tokens.cacheWrite / 1e6) * (options.cacheWritePrice ?? 0))
    const total = input + output + cacheRead + cacheWrite
    lines.push("")
    lines.push("**Расход, " + cur + "** (цены заданы в настройках плагина):")
    if (options.inputPrice != null) lines.push(`- input: ${money(input, cur)}`)
    if (options.outputPrice != null) lines.push(`- output: ${money(output, cur)}`)
    if (options.cacheReadPrice != null) lines.push(`- cache read: ${money(cacheRead, cur)}`)
    if (options.cacheWritePrice != null) lines.push(`- cache write: ${money(cacheWrite, cur)}`)
    lines.push(`- **итого: ${money(total, cur)}**`)
  } else {
    lines.push("")
    lines.push(
      "_Цены не заданы — стоимость не считается. Укажите inputPrice/outputPrice (руб. за 1M токенов) в опциях плагина._",
    )
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

const ChatCostPlugin: Plugin = async (input, options) => {
  // Цены задаются либо в опциях плагина (формат ["путь", { ... }] в opencode.json),
  // либо в файле chat-cost.json рядом с index.ts — на случай, если сборка не передаёт options.
  let fileOptions: ChatCostOptions = {}
  try {
    const srcDir = new URL(".", import.meta.url).pathname
    const rootDir = new URL("../", import.meta.url).pathname
    for (const dir of [srcDir, rootDir]) {
      try {
        fileOptions = JSON.parse(await Bun.file(dir + "chat-cost.json").text())
        break
      } catch {
        // нет в этом каталоге — пробуем следующий
      }
    }
  } catch {
    // Bun недоступен — цены только из options или не заданы
  }
  const opts: ChatCostOptions = { ...fileOptions, ...(options ?? {}) }
  const client: any = input.client
  const directory = input.directory

  return {
    config: (config) => {
      config.command = config.command ?? {}
      config.command["otchet"] = {
        description:
          "Токены и стоимость (₽) чата + краткое описание работ. Опционально: ключ задачи Jira в аргументе, например PROJ-123",
        template: [
          "Вызови инструмент `chat_cost` для текущей сессии.",
          "Выведи пользователю: таблицу токенов и блок стоимости из ответа инструмента как есть (markdown).",
          "Затем на основе раздела «Материал для описания работ» напиши связное описание выполненной работы в 1–3 предложениях — не перечисляй запросы и инструменты по номерам.",
          "",
          "Дальше — про Jira:",
          "- Если в аргументах команды указан ключ задачи (например `$ARGUMENTS`) — предложи прикрепить комментарий к этой задаче.",
          "- Если аргументов нет — поищи ключ задачи Jira (формат ABC-123) в запросах пользователя из материала и в истории текущего чата. Если нашёл — предложи прикрепить комментарий к этой же задаче.",
          "- Если ключ не нашёлся — спроси пользователя, к какой задаче Jira отправить комментарий.",
          "",
          "ВАЖНО: комментарий в Jira самостоятельно не публикуй. Сначала предложи задачу и покажи, какой текст будет отправлен, и дождись явного подтверждения пользователя. Только после подтверждения опубликуй отчёт как комментарий через MCP-сервер atlassian (инструмент jira add comment). Если MCP atlassian недоступен — сообщи об этом.",
        ].join("\n"),
        agent: "build",
      }
    },
    tool: {
      chat_cost: tool({
        description:
          "Считает токены и стоимость текущего чата (по ценам из настроек плагина) и собирает материал о проделанной работе: запросы пользователя и затронутые файлы. Возвращает markdown с таблицей токенов, блоком стоимости и служебным материалом для описания.",
        args: {},
        async execute(_args, context) {
          const stats = await collectStats(client, context.sessionID, directory)
          return buildReport(stats, opts)
        },
      }),
    },
  }
}

export default ChatCostPlugin
