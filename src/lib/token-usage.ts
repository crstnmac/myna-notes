// Local per-model token usage ledger for AI calls (Enhance, chat, polish, …).

import type { AIProviderId } from "@/types"

export interface ModelTokenUsage {
  /** Stable key: provider::model */
  key: string
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  requestCount: number
  /** True if any recorded request used char-based estimate (no API usage). */
  estimated?: boolean
  lastUsedAt: string
}

export interface TokenUsageSnapshot {
  version: 1
  byKey: Record<string, ModelTokenUsage>
  updatedAt: string
}

export interface UsageDelta {
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens?: number
  /** When true, counts are estimated (e.g. Ollama without usage field). */
  estimated?: boolean
}

const STORAGE_KEY = "meeting-notes-token-usage"

const listeners = new Set<() => void>()

export function usageKey(provider: string, model: string): string {
  return `${provider || "unknown"}::${model || "unknown"}`
}

export function loadTokenUsage(): TokenUsageSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { version: 1, byKey: {}, updatedAt: new Date().toISOString() }
    }
    const parsed = JSON.parse(raw) as TokenUsageSnapshot
    if (!parsed || parsed.version !== 1 || typeof parsed.byKey !== "object") {
      return { version: 1, byKey: {}, updatedAt: new Date().toISOString() }
    }
    return parsed
  } catch {
    return { version: 1, byKey: {}, updatedAt: new Date().toISOString() }
  }
}

function saveTokenUsage(snap: TokenUsageSnapshot): void {
  const raw = JSON.stringify(snap)
  localStorage.setItem(STORAGE_KEY, raw)
  // Best-effort vault persist (same pattern as other storage keys).
  void import("@/lib/stronghold")
    .then(({ initDatabase, dbSet }) =>
      initDatabase().then(() => dbSet(STORAGE_KEY, raw)),
    )
    .catch(() => {})
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
}

/** Subscribe to usage updates (Settings UI). */
export function subscribeTokenUsage(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function recordTokenUsage(delta: UsageDelta): ModelTokenUsage {
  const provider = (delta.provider || "unknown").trim() || "unknown"
  const model = (delta.model || "unknown").trim() || "unknown"
  const key = usageKey(provider, model)
  const prompt = Math.max(0, Math.round(delta.promptTokens || 0))
  const completion = Math.max(0, Math.round(delta.completionTokens || 0))
  const total =
    delta.totalTokens != null && Number.isFinite(delta.totalTokens)
      ? Math.max(0, Math.round(delta.totalTokens))
      : prompt + completion

  const snap = loadTokenUsage()
  const prev = snap.byKey[key]
  const next: ModelTokenUsage = {
    key,
    provider,
    model,
    promptTokens: (prev?.promptTokens ?? 0) + prompt,
    completionTokens: (prev?.completionTokens ?? 0) + completion,
    totalTokens: (prev?.totalTokens ?? 0) + total,
    requestCount: (prev?.requestCount ?? 0) + 1,
    estimated: Boolean(prev?.estimated || delta.estimated),
    lastUsedAt: new Date().toISOString(),
  }
  snap.byKey[key] = next
  snap.updatedAt = next.lastUsedAt
  saveTokenUsage(snap)
  return next
}

export function listTokenUsage(): ModelTokenUsage[] {
  const snap = loadTokenUsage()
  return Object.values(snap.byKey).sort((a, b) => b.totalTokens - a.totalTokens)
}

export function clearTokenUsage(): void {
  saveTokenUsage({ version: 1, byKey: {}, updatedAt: new Date().toISOString() })
}

/** Rough estimate when the provider returns no usage (chars ≈ 4 tokens). */
export function estimateTokensFromText(text: string): number {
  const n = text?.length ?? 0
  if (n <= 0) return 0
  return Math.max(1, Math.ceil(n / 4))
}

export function estimateMessagesTokens(
  messages: { role: string; content: string }[],
): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokensFromText(m.content) + 4 // role overhead
  }
  return total
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0"
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Extract OpenAI-style usage from a response or stream chunk. */
export function parseOpenAIUsage(data: unknown): {
  promptTokens: number
  completionTokens: number
  totalTokens: number
} | null {
  if (!data || typeof data !== "object") return null
  const u = (data as { usage?: Record<string, unknown> }).usage
  if (!u || typeof u !== "object") return null
  const prompt =
    num(u.prompt_tokens) ??
    num(u.input_tokens) ??
    num(u.promptTokens) ??
    0
  const completion =
    num(u.completion_tokens) ??
    num(u.output_tokens) ??
    num(u.completionTokens) ??
    0
  const total = num(u.total_tokens) ?? num(u.totalTokens) ?? prompt + completion
  if (prompt === 0 && completion === 0 && total === 0) return null
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total }
}

/** Anthropic message usage fields. */
export function parseAnthropicUsage(data: unknown): {
  promptTokens: number
  completionTokens: number
  totalTokens: number
} | null {
  if (!data || typeof data !== "object") return null
  const obj = data as Record<string, unknown>
  // Final message object
  if (obj.usage && typeof obj.usage === "object") {
    const u = obj.usage as Record<string, unknown>
    const prompt = num(u.input_tokens) ?? 0
    const completion = num(u.output_tokens) ?? 0
    if (prompt || completion) {
      return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
      }
    }
  }
  // Stream event: message_start
  if (obj.type === "message_start" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as { usage?: Record<string, unknown> }
    const u = msg.usage
    if (u) {
      const prompt = num(u.input_tokens) ?? 0
      const completion = num(u.output_tokens) ?? 0
      return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
      }
    }
  }
  // Stream event: message_delta with cumulative output
  if (obj.type === "message_delta" && obj.usage && typeof obj.usage === "object") {
    const u = obj.usage as Record<string, unknown>
    const completion = num(u.output_tokens) ?? 0
    if (completion) {
      return { promptTokens: 0, completionTokens: completion, totalTokens: completion }
    }
  }
  return null
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

export function providerLabel(id: string): string {
  try {
    // Lazy import avoid cycles — labels are static enough.
    const map: Record<string, string> = {
      deepseek: "DeepSeek",
      openai: "OpenAI",
      xai: "xAI",
      anthropic: "Anthropic",
      gemini: "Gemini",
      groq: "Groq",
      openrouter: "OpenRouter",
      mistral: "Mistral",
      together: "Together AI",
      ollama: "Ollama",
      custom: "Custom",
    }
    return map[id as AIProviderId] ?? id
  } catch {
    return id
  }
}
