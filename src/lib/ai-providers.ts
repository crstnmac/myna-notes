// Market AI providers for meeting notes (Enhance, chat, polish).
// Most use OpenAI-compatible chat/completions; Anthropic uses Messages API.

export type AIProviderId =
  | "deepseek"
  | "openai"
  | "xai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "openrouter"
  | "mistral"
  | "together"
  | "ollama"
  | "custom"

export type AIProviderApiStyle = "openai" | "anthropic"

export interface AIProviderDef {
  id: AIProviderId
  label: string
  /** Short blurb for Settings */
  description: string
  /** Chat completions base, e.g. https://api.openai.com/v1 (no trailing slash) */
  baseUrl: string
  apiStyle: AIProviderApiStyle
  /** Link to get an API key */
  keyUrl: string
  /** Placeholder for the key field */
  keyPlaceholder: string
  /** Soft key validation hint (not security) */
  keyHint?: string
  /** Placeholder / seed model id when switching to this provider (user can type any id). */
  defaultModel: string
  /** true when no cloud key is required (local Ollama) */
  keyOptional?: boolean
}

export const AI_PROVIDERS: Record<AIProviderId, AIProviderDef> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    description: "Strong value models for notes and chat",
    baseUrl: "https://api.deepseek.com",
    apiStyle: "openai",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-…",
    keyHint: "Usually starts with sk-",
    defaultModel: "deepseek-chat",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    description: "GPT family via OpenAI API",
    baseUrl: "https://api.openai.com/v1",
    apiStyle: "openai",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
    keyHint: "Usually starts with sk-",
    defaultModel: "gpt-4.1-mini",
  },
  xai: {
    id: "xai",
    label: "xAI (Grok)",
    description: "Grok models via api.x.ai",
    baseUrl: "https://api.x.ai/v1",
    apiStyle: "openai",
    keyUrl: "https://console.x.ai",
    keyPlaceholder: "xai-…",
    defaultModel: "grok-4-1-fast-non-reasoning",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude models (Messages API)",
    baseUrl: "https://api.anthropic.com",
    apiStyle: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
    keyHint: "Usually starts with sk-ant-",
    defaultModel: "claude-sonnet-4-20250514",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    description: "Gemini via OpenAI-compatible endpoint",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiStyle: "openai",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
    defaultModel: "gemini-2.5-flash",
  },
  groq: {
    id: "groq",
    label: "Groq",
    description: "Very fast open models",
    baseUrl: "https://api.groq.com/openai/v1",
    apiStyle: "openai",
    keyUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_…",
    defaultModel: "llama-3.3-70b-versatile",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    description: "One key → many providers",
    baseUrl: "https://openrouter.ai/api/v1",
    apiStyle: "openai",
    keyUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-…",
    defaultModel: "openai/gpt-4.1-mini",
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    description: "Mistral models via La Plateforme",
    baseUrl: "https://api.mistral.ai/v1",
    apiStyle: "openai",
    keyUrl: "https://console.mistral.ai/api-keys",
    keyPlaceholder: "API key",
    defaultModel: "mistral-small-latest",
  },
  together: {
    id: "together",
    label: "Together AI",
    description: "Open models hosted by Together",
    baseUrl: "https://api.together.xyz/v1",
    apiStyle: "openai",
    keyUrl: "https://api.together.ai/settings/api-keys",
    keyPlaceholder: "API key",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    description: "Fully local models — no cloud key",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiStyle: "openai",
    keyUrl: "https://ollama.com",
    keyPlaceholder: "(optional)",
    defaultModel: "llama3.2",
    keyOptional: true,
  },
  custom: {
    id: "custom",
    label: "Custom endpoint",
    description: "Any OpenAI-compatible /v1 base URL",
    baseUrl: "",
    apiStyle: "openai",
    keyUrl: "",
    keyPlaceholder: "API key (if required)",
    defaultModel: "",
    keyOptional: true,
  },
}

export const AI_PROVIDER_ORDER: AIProviderId[] = [
  "deepseek",
  "openai",
  "xai",
  "anthropic",
  "gemini",
  "groq",
  "openrouter",
  "mistral",
  "together",
  "ollama",
  "custom",
]

export function getProvider(id: string | undefined | null): AIProviderDef {
  if (id && id in AI_PROVIDERS) return AI_PROVIDERS[id as AIProviderId]
  return AI_PROVIDERS.deepseek
}

/** Soft validation — never blocks empty key for ollama/custom. */
export function validateProviderApiKey(
  providerId: string | undefined,
  key: string,
): string | null {
  const p = getProvider(providerId)
  const k = key.trim()
  if (!k) {
    if (p.keyOptional) return null
    return "API key is required for this provider"
  }
  if (k.length < 8) return "API key looks too short"
  // Provider-specific soft checks only.
  if (p.id === "openai" || p.id === "deepseek") {
    if (!k.startsWith("sk-") && !k.startsWith("sk-proj-")) {
      return "This key usually starts with sk-"
    }
  }
  if (p.id === "anthropic" && !k.startsWith("sk-ant-") && !k.startsWith("sk-")) {
    return "Anthropic keys usually start with sk-ant-"
  }
  return null
}

/** Resolve chat endpoint from settings. */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "")
  if (base.endsWith("/chat/completions")) return base
  if (base.endsWith("/v1")) return `${base}/chat/completions`
  // DeepSeek historic root without /v1
  if (base === "https://api.deepseek.com") return `${base}/chat/completions`
  return `${base}/chat/completions`
}

export function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "") || "https://api.anthropic.com"
  if (base.endsWith("/messages")) return base
  if (base.endsWith("/v1")) return `${base}/messages`
  return `${base}/v1/messages`
}
