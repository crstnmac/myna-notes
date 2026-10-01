// Multi-provider LLM client. OpenAI-compatible chat/completions + Anthropic Messages.
// Back-compat: callDeepSeek / fetchDeepSeekStream re-exported as aliases.

import { loadAISettings, loadApiKey } from "@/lib/storage"
import { httpFetch } from "@/lib/http"
import {
  getProvider,
  resolveAnthropicMessagesUrl,
  resolveChatCompletionsUrl,
  type AIProviderId,
} from "@/lib/ai-providers"
import {
  estimateMessagesTokens,
  estimateTokensFromText,
  parseAnthropicUsage,
  parseOpenAIUsage,
  recordTokenUsage,
} from "@/lib/token-usage"

const REQUEST_TIMEOUT_MS = 120000
const MAX_RETRIES = 2
const INITIAL_BACKOFF_MS = 1000

export class LLMError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = "LLMError"
    this.status = status
  }
}

/** @deprecated use LLMError */
export class DeepSeekError extends LLMError {
  constructor(message: string, status = 0) {
    super(message, status)
    this.name = "DeepSeekError"
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export interface ChatMessage {
  role: string
  content: string
}

export interface LLMOptions {
  stream?: boolean
  temperature?: number
  maxTokens?: number
  thinking?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

function resolveEndpoint(): {
  providerId: AIProviderId
  baseUrl: string
  model: string
  apiStyle: "openai" | "anthropic"
  label: string
} {
  const settings = loadAISettings()
  const providerId = (settings.provider || "deepseek") as AIProviderId
  const def = getProvider(providerId)
  const override = settings.baseUrl?.trim() ?? ""
  const baseUrl = (override || def.baseUrl).replace(/\/+$/, "")
  const model = settings.model?.trim() || def.defaultModel
  if (!baseUrl) {
    throw new LLMError(
      "Base URL is required for this provider. Set it in Settings → AI.",
    )
  }
  return {
    providerId: def.id,
    baseUrl,
    model,
    apiStyle: def.apiStyle,
    label: def.label,
  }
}

async function requireApiKey(providerId: AIProviderId, label: string): Promise<string> {
  const def = getProvider(providerId)
  const apiKey = (await loadApiKey()).trim()
  if (!apiKey && !def.keyOptional) {
    throw new LLMError(`${label} API key not configured. Set it in Settings.`)
  }
  // Ollama accepts any non-empty bearer; use a dummy if empty.
  return apiKey || "ollama"
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/** Providers known to accept stream_options.include_usage. */
function supportsStreamUsage(providerId: AIProviderId): boolean {
  return (
    providerId === "openai" ||
    providerId === "deepseek" ||
    providerId === "xai" ||
    providerId === "groq" ||
    providerId === "openrouter" ||
    providerId === "gemini"
  )
}

// ─── OpenAI-compatible ───────────────────────────────────────────────────────

async function callOpenAICompatible(
  messages: ChatMessage[],
  opts: LLMOptions,
  endpoint: ReturnType<typeof resolveEndpoint>,
  apiKey: string,
): Promise<string> {
  const {
    stream = false,
    temperature,
    maxTokens = 4096,
    thinking = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = opts

  const url = resolveChatCompletionsUrl(endpoint.baseUrl)
  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages,
    stream,
    max_tokens: maxTokens,
  }
  // Ask compatible APIs to include usage on the final stream chunk (not all local servers support this).
  if (stream && supportsStreamUsage(endpoint.providerId)) {
    body.stream_options = { include_usage: true }
  }

  // DeepSeek reasoning toggle (ignored by most other providers)
  if (thinking && endpoint.providerId === "deepseek") {
    body.thinking = { type: "enabled" }
    body.reasoning_effort = "high"
  } else if (temperature !== undefined) {
    body.temperature = temperature
  } else {
    body.temperature = stream ? 0.7 : 0.3
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  }
  // OpenRouter optional attribution
  if (endpoint.providerId === "openrouter") {
    headers["HTTP-Referer"] = "https://myna.notes.local"
    headers["X-Title"] = "Myna Notes"
  }

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const combinedSignal = opts.signal
      ? anySignal([controller.signal, opts.signal])
      : controller.signal

    try {
      const res = await httpFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combinedSignal,
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => "")
        if (res.status === 401) {
          throw new LLMError(
            `Invalid API key for ${endpoint.label}. Check Settings.`,
            401,
          )
        }
        if (res.status === 429) {
          lastError = new LLMError("Rate limited. Retrying…", 429)
          await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt))
          continue
        }
        if (res.status >= 500) {
          lastError = new LLMError(`Server error (${res.status}). Retrying…`, res.status)
          await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt))
          continue
        }
        const snippet = errText.slice(0, 180).replace(/\s+/g, " ")
        throw new LLMError(
          `API error (${res.status})${snippet ? `: ${snippet}` : ""}`,
          res.status,
        )
      }

      if (!stream) {
        const data = await res.json()
        const content = data.choices?.[0]?.message?.content ?? ""
        recordOpenAIUsage(endpoint, messages, content, data)
        return content
      }

      const reader = res.body?.getReader()
      if (!reader) throw new LLMError("No response stream")

      let result = ""
      const decoder = new TextDecoder()
      let buffer = ""
      let sawUsage = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const data = line.slice(6)
          if (data === "[DONE]") continue
          try {
            const parsed = JSON.parse(data)
            const usage = parseOpenAIUsage(parsed)
            if (usage) {
              sawUsage = true
              recordTokenUsage({
                provider: endpoint.providerId,
                model: endpoint.model,
                ...usage,
              })
            }
            const delta = parsed.choices?.[0]?.delta?.content
            if (delta) result += delta
          } catch {
            continue
          }
        }
      }
      if (!sawUsage) {
        recordOpenAIUsage(endpoint, messages, result, null)
      }
      return result
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LLMError(timedOut ? "Request timed out" : "Request cancelled")
      }
      if (err instanceof LLMError) {
        if (err.status === 429 || err.status >= 500) {
          lastError = err
          if (attempt < MAX_RETRIES) continue
        }
        throw err
      }
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_RETRIES) {
        await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt))
        continue
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  throw lastError ?? new LLMError("Request failed after retries")
}

function recordOpenAIUsage(
  endpoint: ReturnType<typeof resolveEndpoint>,
  messages: ChatMessage[],
  content: string,
  data: unknown,
): void {
  const parsed = parseOpenAIUsage(data)
  if (parsed) {
    recordTokenUsage({
      provider: endpoint.providerId,
      model: endpoint.model,
      ...parsed,
    })
    return
  }
  // Fallback estimate (Ollama / some local servers omit usage).
  const promptTokens = estimateMessagesTokens(messages)
  const completionTokens = estimateTokensFromText(content)
  recordTokenUsage({
    provider: endpoint.providerId,
    model: endpoint.model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  })
}

/** Wrap a byte stream to harvest OpenAI-style usage chunks while forwarding bytes. */
function wrapOpenAIStreamWithUsage(
  source: ReadableStreamDefaultReader<Uint8Array>,
  endpoint: ReturnType<typeof resolveEndpoint>,
  messages: ChatMessage[],
): ReadableStreamDefaultReader<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let lineBuf = ""
  let contentEst = ""
  let sawUsage = false
  let finished = false

  const transformed = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { done, value } = await source.read()
      if (done) {
        if (!finished) {
          finished = true
          if (!sawUsage) {
            recordOpenAIUsage(endpoint, messages, contentEst, null)
          }
        }
        ctrl.close()
        return
      }
      const text = decoder.decode(value, { stream: true })
      lineBuf += text
      const lines = lineBuf.split("\n")
      lineBuf = lines.pop() || ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6)
        if (data === "[DONE]") continue
        try {
          const parsed = JSON.parse(data)
          const usage = parseOpenAIUsage(parsed)
          if (usage) {
            sawUsage = true
            recordTokenUsage({
              provider: endpoint.providerId,
              model: endpoint.model,
              ...usage,
            })
          }
          const delta = parsed.choices?.[0]?.delta?.content
          if (typeof delta === "string") contentEst += delta
        } catch {
          /* partial */
        }
      }
      ctrl.enqueue(value.byteLength ? value : encoder.encode(text))
    },
    cancel() {
      source.cancel()
    },
  })
  return transformed.getReader()
}

async function fetchOpenAIStream(
  messages: ChatMessage[],
  opts: LLMOptions,
  endpoint: ReturnType<typeof resolveEndpoint>,
  apiKey: string,
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; abort: () => void }> {
  const { temperature, maxTokens = 4096, timeoutMs = REQUEST_TIMEOUT_MS, signal } = opts
  const url = resolveChatCompletionsUrl(endpoint.baseUrl)

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  }
  if (endpoint.providerId === "openrouter") {
    headers["HTTP-Referer"] = "https://myna.notes.local"
    headers["X-Title"] = "Myna Notes"
  }

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const combinedSignal = signal
      ? anySignal([controller.signal, signal])
      : controller.signal

    try {
      const res = await httpFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: endpoint.model,
          messages,
          stream: true,
          temperature: temperature ?? 0.3,
          max_tokens: maxTokens,
          ...(supportsStreamUsage(endpoint.providerId)
            ? { stream_options: { include_usage: true } }
            : {}),
        }),
        signal: combinedSignal,
      })

      if (!res.ok) {
        await res.text().catch(() => "")
        if (res.status === 401) throw new LLMError("Invalid API key.", 401)
        if (res.status === 429 || res.status >= 500) {
          lastError = new LLMError(`Server error (${res.status}). Retrying…`, res.status)
          await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt))
          continue
        }
        throw new LLMError(`API error (${res.status})`, res.status)
      }

      const rawReader = res.body?.getReader()
      if (!rawReader) throw new LLMError("No response stream")
      // Don't clear timeout while streaming — caller owns abort via signal.
      clearTimeout(timeout)
      return {
        reader: wrapOpenAIStreamWithUsage(rawReader, endpoint, messages),
        abort: () => controller.abort(),
      }
    } catch (err: unknown) {
      clearTimeout(timeout)
      if (err instanceof Error && err.name === "AbortError") {
        throw new LLMError(timedOut ? "Request timed out" : "Request cancelled")
      }
      if (err instanceof LLMError) {
        if (err.status === 429 || err.status >= 500) {
          lastError = err
          if (attempt < MAX_RETRIES) continue
        }
        throw err
      }
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_RETRIES) {
        await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt))
        continue
      }
    }
  }

  throw lastError ?? new LLMError("Stream request failed after retries")
}

// ─── Anthropic Messages API ──────────────────────────────────────────────────

function toAnthropicBody(messages: ChatMessage[], maxTokens: number, temperature?: number) {
  let system = ""
  const converted: { role: "user" | "assistant"; content: string }[] = []
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content
      continue
    }
    const role = m.role === "assistant" ? "assistant" : "user"
    // Anthropic requires alternating roles; merge consecutive same-role messages.
    const last = converted[converted.length - 1]
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      converted.push({ role, content: m.content })
    }
  }
  // Must start with user
  if (converted.length === 0 || converted[0].role !== "user") {
    converted.unshift({ role: "user", content: "(continue)" })
  }
  const body: Record<string, unknown> = {
    model: resolveEndpoint().model,
    max_tokens: maxTokens,
    messages: converted,
  }
  if (system) body.system = system
  if (temperature !== undefined) body.temperature = temperature
  return body
}

async function callAnthropic(
  messages: ChatMessage[],
  opts: LLMOptions,
  endpoint: ReturnType<typeof resolveEndpoint>,
  apiKey: string,
): Promise<string> {
  const { maxTokens = 4096, temperature, timeoutMs = REQUEST_TIMEOUT_MS } = opts
  const url = resolveAnthropicMessagesUrl(endpoint.baseUrl)
  const body = toAnthropicBody(messages, maxTokens, temperature ?? 0.3)
  body.model = endpoint.model
  body.stream = false

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const combinedSignal = opts.signal
    ? anySignal([controller.signal, opts.signal])
    : controller.signal

  try {
    const res = await httpFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      if (res.status === 401) throw new LLMError("Invalid Anthropic API key.", 401)
      throw new LLMError(
        `Anthropic API error (${res.status})${errText ? `: ${errText.slice(0, 160)}` : ""}`,
        res.status,
      )
    }
    const data = await res.json()
    const parts = data.content
    let text = ""
    if (Array.isArray(parts)) {
      text = parts
        .filter((p: { type?: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("")
    }
    const usage = parseAnthropicUsage(data)
    if (usage) {
      recordTokenUsage({
        provider: endpoint.providerId,
        model: endpoint.model,
        ...usage,
      })
    } else {
      recordOpenAIUsage(endpoint, messages, text, null)
    }
    return text
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LLMError(timedOut ? "Request timed out" : "Request cancelled")
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Anthropic SSE → OpenAI-style SSE bytes so existing parseSSEStream keeps working.
 * Emits data: {"choices":[{"delta":{"content":"..."}}]} chunks.
 */
async function fetchAnthropicStream(
  messages: ChatMessage[],
  opts: LLMOptions,
  endpoint: ReturnType<typeof resolveEndpoint>,
  apiKey: string,
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; abort: () => void }> {
  const { maxTokens = 4096, temperature, signal } = opts
  const url = resolveAnthropicMessagesUrl(endpoint.baseUrl)
  const body = toAnthropicBody(messages, maxTokens, temperature ?? 0.3)
  body.model = endpoint.model
  body.stream = true

  const controller = new AbortController()
  const combinedSignal = signal
    ? anySignal([controller.signal, signal])
    : controller.signal

  const res = await httpFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    if (res.status === 401) throw new LLMError("Invalid Anthropic API key.", 401)
    throw new LLMError(
      `Anthropic API error (${res.status})${errText ? `: ${errText.slice(0, 160)}` : ""}`,
      res.status,
    )
  }

  const src = res.body?.getReader()
  if (!src) throw new LLMError("No response stream")

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let promptTokens = 0
  let completionTokens = 0
  let contentEst = ""
  let recorded = false

  const finishUsage = () => {
    if (recorded) return
    recorded = true
    if (promptTokens || completionTokens) {
      recordTokenUsage({
        provider: endpoint.providerId,
        model: endpoint.model,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      })
    } else {
      recordOpenAIUsage(endpoint, messages, contentEst, null)
    }
  }

  const transformed = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { done, value } = await src.read()
      if (done) {
        finishUsage()
        ctrl.enqueue(encoder.encode("data: [DONE]\n\n"))
        ctrl.close()
        return
      }
      const chunk = decoder.decode(value, { stream: true })
      // Parse Anthropic event stream and re-emit OpenAI-shaped deltas.
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (!data || data === "[DONE]") continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.type === "message_start") {
            const u = parseAnthropicUsage(parsed)
            if (u) promptTokens = Math.max(promptTokens, u.promptTokens)
          }
          if (parsed.type === "message_delta") {
            const u = parseAnthropicUsage(parsed)
            if (u) completionTokens = Math.max(completionTokens, u.completionTokens)
          }
          if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
            const text = parsed.delta.text ?? ""
            if (text) {
              contentEst += text
              const openai = JSON.stringify({ choices: [{ delta: { content: text } }] })
              ctrl.enqueue(encoder.encode(`data: ${openai}\n\n`))
            }
          }
        } catch {
          /* ignore partial JSON */
        }
      }
    },
    cancel() {
      finishUsage()
      src.cancel()
    },
  })

  return {
    reader: transformed.getReader(),
    abort: () => controller.abort(),
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function callLLM(
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<string> {
  const endpoint = resolveEndpoint()
  const apiKey = await requireApiKey(endpoint.providerId, endpoint.label)
  if (endpoint.apiStyle === "anthropic") {
    return callAnthropic(messages, opts, endpoint, apiKey)
  }
  return callOpenAICompatible(messages, opts, endpoint, apiKey)
}

export async function fetchLLMStream(
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; abort: () => void }> {
  const endpoint = resolveEndpoint()
  const apiKey = await requireApiKey(endpoint.providerId, endpoint.label)
  if (endpoint.apiStyle === "anthropic") {
    return fetchAnthropicStream(messages, opts, endpoint, apiKey)
  }
  return fetchOpenAIStream(messages, opts, endpoint, apiKey)
}

/** @deprecated use callLLM */
export const callDeepSeek = callLLM
/** @deprecated use fetchLLMStream */
export const fetchDeepSeekStream = fetchLLMStream
