export interface MeetingSection {
  title: string
  content: string
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
  timestamp: string
  /** Meeting ids cited by the assistant (source-linked ask-anything). */
  sources?: { meetingId: string; title: string }[]
}

export interface QuickAction {
  label: string
  icon: string
  prompt: string
}

export interface MeetingTemplate {
  id: string
  name: string
  icon: string
  sections: string[]
  quickActions: QuickAction[]
  /** Optional per-template persona; overrides the global writing style when set. */
  style?: WritingStyle
}

export interface SpeakerLabel {
  name: string
  color: string
}

// Custom vocabulary: names and jargon the transcriber/AI should always spell
// correctly. `aliases` are the common mis-hearings that get rewritten to the
// canonical `term` (e.g. "siddhart" → "Siddharth").
export interface DictionaryEntry {
  id: string
  term: string
  aliases: string[]
}

// Editor text expansion: typing `;trigger` followed by a space replaces the
// trigger with `expansion` (markdown-supported, with {{date}}/{{time}} vars).
export interface Snippet {
  id: string
  trigger: string
  expansion: string
}

// Persona applied to AI-generated notes. "default" applies no styling;
// per-template override wins over the global setting.
export type WritingStyle = "default" | "formal" | "casual" | "crisp" | "custom"

export const WRITING_STYLES: Record<Exclude<WritingStyle, "custom">, { label: string; hint: string }> = {
  default: { label: "Default", hint: "No specific style — professional meeting notes" },
  formal: { label: "Formal", hint: "Polished and precise, no contractions or slang" },
  casual: { label: "Casual", hint: "Warm and conversational, contractions welcome" },
  crisp: { label: "Crisp", hint: "Short sentences, no filler, maximum signal" },
}

export interface MeetingAttendee {
  name: string
  email?: string
}

export interface Meeting {
  id: string
  title: string
  date: string
  duration: number
  transcript: string
  notes: string
  /** User shorthand taken during the meeting (Granola-style notepad). */
  manualNotes?: string
  templateId?: string
  structuredNotes?: MeetingSection[]
  enhancedNotes?: string
  /**
   * Short plain-text blurb for list cards (from Enhance AI).
   * Not markdown — dashboard shows this instead of note body previews.
   */
  description?: string
  chatHistory?: ChatMessage[]
  speakerLabels?: SpeakerLabel[]
  transcriptSegments?: { speakerIndex: number; text: string }[]
  brief?: string
  memoryDigest?: string
  memoryIndexedAt?: string
  folderIds?: string[]
  calendarEventId?: string
  attendees?: MeetingAttendee[]
  personIds?: string[]
  autoEnhancedAt?: string
  /** Outputs from post-meeting recipes, keyed by recipe id. */
  recipeOutputs?: Record<string, string>
}

/**
 * Concept tag for meetings (product name: “tag”).
 * Multi-label: a meeting may belong to many tags via `Meeting.folderIds`.
 * Storage still uses folder* keys for backward compatibility.
 */
export interface Folder {
  id: string
  name: string
  color?: string
  meetingIds: string[]
  createdAt: string
}

export interface Recipe {
  id: string
  name: string
  prompt: string
  runOnStop?: boolean
  icon?: string
  builtin?: boolean
}

export interface Person {
  id: string
  name: string
  aliases: string[]
  email?: string
  notes?: string
  meetingIds: string[]
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  attendees: MeetingAttendee[]
  calendar: string
  location?: string
}

export interface MemoryEntry {
  meetingId: string
  digest: string
  contentHash: string
  tf: Record<string, number>
  indexedAt: string
}

export interface RelatedMeeting {
  meetingId: string
  score: number
}

export type KnowledgeKind =
  | "decision"
  | "action_item"
  | "key_point"
  | "question"
  | "commitment"
  | "risk"

export type KnowledgeStatus = "open" | "resolved" | "superseded" | "unknown"

export interface KnowledgeItem {
  id: string
  kind: KnowledgeKind
  text: string
  meetingId: string
  speaker?: string
  assignee?: string
  status: KnowledgeStatus
  topics: string[]
  sourceExcerpt?: string
  embedding?: number[]
  extractedAt: string
}

export type KnowledgeEdgeKind = "follows_up_on" | "supersedes" | "contradicts"

export interface KnowledgeEdge {
  id: string
  fromId: string
  toId: string
  kind: KnowledgeEdgeKind
  reason?: string
  createdAt: string
}

export interface KnowledgeGraph {
  items: KnowledgeItem[]
  edges: KnowledgeEdge[]
  version: string
  lastUpdated: string
}

/** Cloud / local chat provider for Enhance, polish, and meeting chat. */
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

export interface AISettings {
  apiKey: string
  model: string
  enabled: boolean
  /** Which market provider / endpoint to use. */
  provider: AIProviderId
  /**
   * Override base URL (OpenAI-compatible root or Anthropic host).
   * Empty = use the provider default.
   */
  baseUrl: string
}

export type TranscriptionModel = "parakeet-v3"

export interface AppSettings {
  audioSource: "mic" | "system" | "both"
  preferredDeviceId: string
  speechLang: string
  transcriptionModel: TranscriptionModel
  titlePrefix: string
  theme: "light" | "dark" | "system"
  writingStyle: WritingStyle
  /** Freeform persona text, used only when writingStyle === "custom". */
  customStylePrompt: string
  /** Show the AI action popup when text is selected in the editor. */
  aiSelectionPopup: boolean
  /** Run AI enhance + knowledge extraction automatically when recording stops. */
  autoEnhanceOnStop: boolean
  /** After Enhance, AI suggests concept tags from notes (reuses existing tags when possible). */
  autoTagOnEnhance: boolean
  /** Show upcoming events from macOS Calendar (EventKit). */
  calendarEnabled: boolean
  /** Write an MCP snapshot on save so Cursor/Claude can query meetings. */
  mcpEnabled: boolean
  /** Default folder for one-click Markdown export. */
  exportFolderPath: string
  /** Slack Incoming Webhook URL for sharing notes (optional). */
  slackWebhookUrl: string
  /**
   * When idle, detect Zoom/Teams/etc. and gently prompt to start notes.
   * Never auto-records — prompt only (consent + privacy).
   */
  callDetectEnabled: boolean
  /** After stop, run a dictionary/calendar-aware transcript polish pass (AI). */
  polishTranscriptOnStop: boolean
  /**
   * After recording stops (or audio import), run FluidAudio offline diarization
   * and rewrite the transcript with Speaker N: labels when possible.
   */
  diarizeOnStop: boolean
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  apiKey: "",
  model: "deepseek-chat",
  enabled: true,
  provider: "deepseek",
  baseUrl: "",
}

export const DEFAULT_SETTINGS: AppSettings = {
  audioSource: "mic",
  preferredDeviceId: "default",
  speechLang: "auto",
  transcriptionModel: "parakeet-v3",
  titlePrefix: "",
  theme: "system",
  writingStyle: "default",
  customStylePrompt: "",
  aiSelectionPopup: true,
  autoEnhanceOnStop: true,
  autoTagOnEnhance: true,
  calendarEnabled: true,
  mcpEnabled: true,
  exportFolderPath: "",
  slackWebhookUrl: "",
  callDetectEnabled: true,
  polishTranscriptOnStop: true,
  diarizeOnStop: true,
}

export const BUILTIN_RECIPES: Recipe[] = [
  {
    id: "recipe-followup-email",
    name: "Follow-up email",
    icon: "mail",
    builtin: true,
    runOnStop: false,
    prompt:
      "Draft a concise follow-up email from my perspective based on this meeting. Include a short greeting, 3–6 bullet takeaways or decisions, clear next steps with owners when known, and a polite close. Output only the email body.",
  },
  {
    id: "recipe-action-digest",
    name: "Action digest",
    icon: "checklist",
    builtin: true,
    runOnStop: true,
    prompt:
      "List every action item from this meeting as a Markdown checklist. Each line: `- [ ] Owner — task (due if mentioned)`. If owner is unknown, use Unassigned. Output only the checklist.",
  },
  {
    id: "recipe-standup-blockers",
    name: "Standup blockers",
    icon: "alert",
    builtin: true,
    // Reachable by default after enhance — previously only via ⋯ → Recipes.
    runOnStop: true,
    prompt:
      "Extract standup-style updates: Done, Doing, and Blockers. Use three Markdown sections with short bullets. Invent nothing — only what appears in the notes/transcript.",
  },
]

/**
 * @deprecated Model ids are free-form now (Settings → Model text field).
 * Kept empty so any old import doesn't crash.
 */
export const AI_MODELS: Record<string, string> = {}

export const SPEECH_LANGS: Record<string, string> = {
  "auto": "Auto-detect",
  "en": "English",
  "zh": "Chinese (Mandarin)",
  "yue": "Cantonese",
  "ja": "Japanese",
  "ko": "Korean",
  "es": "Spanish",
  "fr": "French",
  "de": "German",
  "it": "Italian",
  "pt": "Portuguese",
  "ro": "Romanian",
  "nl": "Dutch",
  "da": "Danish",
  "sv": "Swedish",
  "fi": "Finnish",
  "hu": "Hungarian",
  "et": "Estonian",
  "lv": "Latvian",
  "lt": "Lithuanian",
  "mt": "Maltese",
  "pl": "Polish",
  "cs": "Czech",
  "sk": "Slovak",
  "sl": "Slovenian",
  "hr": "Croatian",
  "bs": "Bosnian",
  "ru": "Russian",
  "uk": "Ukrainian",
  "be": "Belarusian",
  "bg": "Bulgarian",
  "sr": "Serbian",
  "el": "Greek",
}

export const TRANSCRIPTION_MODELS: Record<TranscriptionModel, {
  name: string
  label: string
  description: string
  size: string
  source: string
  runtime: string
  bestFor: string
  capabilities: string[]
  limitations: string[]
}> = {
  "parakeet-v3": {
    name: "Parakeet TDT 0.6B v3",
    label: "Fast live meetings",
    description: "CoreML Parakeet model optimized for low-latency local meeting transcription.",
    size: "~325 MB",
    source: "FluidInference/parakeet-tdt-0.6b-v3-coreml",
    runtime: "Apple Neural Engine",
    bestFor: "Live meeting capture, lower latency, reliable continuous recording",
    capabilities: [
      "Live streaming",
      "Mic, system, and both-source capture",
      "Multilingual ASR",
      "Best default for meetings",
    ],
    limitations: [
      "Language ID is weaker than dedicated multilingual models",
    ],
  },
}
