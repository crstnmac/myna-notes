# Myna Notes — Architecture

## System Overview

```mermaid
graph TB
    subgraph "macOS Desktop App"
        subgraph "WebView (React + TypeScript)"
            APP[App.tsx<br/>State + Hash Router]
            DASH[MeetingDashboard]
            EDITOR[NoteEditor<br/>ProseMirror/Milkdown]
            SETTINGS[SettingsPage]
            ONBOARD[OnboardingWizard]
            CHAT[GlobalChat / AIChatPanel]
            REC[useRecording hook]
            IMPORT[Audio import]
        end

        subgraph "Tauri Rust Backend"
            LIB[lib.rs<br/>App Builder + Plugins]
            CAPTURE[capture.rs<br/>Stream relay]
            FLUID[fluid.rs<br/>Sidecar manager + batch ASR + diarization]
            EMBED[embed.rs<br/>Embedding sidecar]
            CAL[calendar.rs<br/>EventKit]
            CALL[call_detect.rs<br/>Meeting-app detection]
            MCPS[mcp_snapshot.rs<br/>Snapshot writer]
        end

        subgraph "Native Sidecar"
            SIDECAR[fluidasr<br/>Swift + FluidAudio<br/>mic + system capture, VAD, Parakeet v3]
        end

        subgraph "External APIs (opt-in, your key)"
            LLM[LLM provider<br/>DeepSeek / OpenAI / Anthropic / xAI / Gemini / Groq / OpenRouter / Mistral / Together / Ollama / custom]
        end
    end

    subgraph "Local Storage"
        LS[localStorage]
        VAULT[Tauri Stronghold<br/>Encrypted Vault]
        SECURE[Tauri Plugin Store<br/>Secure API Key Store]
    end

    WEBVIEW["`WebView
    React 19 + TypeScript
    Vite + Tailwind v4
    shadcn/ui + Milkdown`"]

    APP --> DASH & EDITOR & SETTINGS & ONBOARD
    APP --> LS & VAULT & SECURE

    REC --> CAPTURE
    IMPORT --> FLUID
    CHAT --> LLM
    EDITOR --> LLM

    CAPTURE --> SIDECAR
    FLUID --> SIDECAR
    EMBED --> SIDECAR

    EDITOR --> REC
    EDITOR --> IMPORT
    DASH --> CHAT
    APP --> CAL & CALL & MCPS

    style WEBVIEW fill:#e5f3ff
```

## Frontend Component Architecture

```mermaid
graph TB
    APP2[App.tsx<br/>State + hash router: dashboard / editor / settings]

    subgraph "Views"
        DASH2[meeting-dashboard + dashboard-views<br/>Notes, Actions, People, Tags]
        EDITOR2[note-editor]
        SETTINGS2[settings-page]
        ONBOARD2[onboarding-wizard]
        CMDK[command-palette + shortcuts-dialog]
    end

    subgraph "Editor sub-components"
        PME[ProseMirrorEditor<br/>Milkdown]
        ART[editor-artifacts<br/>enhanced notes, digest]
        INFO[editor-info-sidebar]
        BRIEF[meeting-brief-panel]
        LIVE[live-assist-panel]
        CHK[checklist-view]
        TPL[meeting-template-selector / template-editor]
        WAVE[Waveform]
        RND[note-renderer / markdown-view]
    end

    subgraph "Dashboard sub-components"
        GC[global-chat<br/>Cross-meeting AI]
    end

    APP2 --> DASH2 & EDITOR2 & SETTINGS2 & ONBOARD2 & CMDK
    EDITOR2 --> PME & ART & INFO & BRIEF & LIVE & CHK & TPL & WAVE & RND
    DASH2 --> GC
```

Shared primitives live in `src/components/ui/` (shadcn/ui on Base UI + Radix). `error-boundary.tsx` wraps the app shell.

## Recording & Transcription Pipeline

All audio capture and recognition happens inside the Swift `fluidasr` sidecar. The Rust layer only relays events; no audio crosses the process boundary.

```mermaid
sequenceDiagram
    participant UI as React (useRecording)
    participant Rust as Tauri (capture.rs / fluid.rs)
    participant Sidecar as fluidasr (Swift)

    UI->>Rust: invoke("prewarm_stream") (editor open / pause)
    Rust->>Sidecar: spawn --stream --source (loads Parakeet + VAD, parks on stdin)

    UI->>Rust: invoke("start_continuous", { language, source, model })
    Rust->>Sidecar: reuse parked sidecar (or spawn) + config frame
    Sidecar-->>Rust: READY
    Note over Sidecar: Start mic (AVAudioEngine, AEC only in "both")<br/>and/or system tap (Core Audio, macOS 14.4+)<br/>→ SpeechGate (Silero VAD) → SlidingWindowAsrManager

    loop Streaming
        Sidecar-->>Rust: {source, confirmed, volatile}
        Rust-->>UI: event "transcript-stream"
        Sidecar-->>Rust: {source, rms}
        Rust-->>UI: event "audio-level"
    end

    UI->>Rust: invoke("stop_continuous")
    Rust->>Sidecar: close stdin (EOF)
    Sidecar-->>Rust: final confirmed text, SESSION_WAV path, DONE
    Rust-->>UI: events "transcript-stream", "session-wav"
    UI->>Rust: invoke("diarize_audio_file_fluid", { path })
    Rust->>Sidecar: offline pyannote/VBx diarization (+ per-segment ASR)
    Sidecar-->>UI: speaker segments → "Speaker N:" labels
```

Key behaviors:

- **Sources:** `mic`, `system`, or `both`. In `both`, `stream-transcript.ts` interleaves the two feeds with `Me:` / `Them:` labels (renamable live).
- **SpeechGate:** Silero VAD + energy floor with pre-roll and hangover. The mic gate is more permissive than the system gate.
- **Lossless streaming:** confirmation thresholds are zero so no window's text is dropped; final text is the streamed confirmed text plus the leftover volatile tail (never `finish()`'s re-decode, which would duplicate).
- **Pre-warm:** a parked sidecar holds the model but captures nothing; it expires after 120 s. `useRecording.prewarm()` runs when the editor opens and on pause.
- **Stop:** Rust closes stdin and waits up to 6 s for `DONE`.
- **Session WAV:** the sidecar writes a 16 kHz WAV (system audio if active, else mic; at least ~2 s) for post-stop diarization.
- **Audio import:** `import-audio.ts` calls `diarize_audio_file_fluid` (with ASR) or falls back to `transcribe_audio_file_fluid`. Supported extensions: mp3, m4a, wav, aac, aiff, caf, flac, ogg, mp4, mov.

## AI Service Architecture

```mermaid
graph TB
    subgraph "ai-service.ts"
        TITLE[generateTitle / generateMeetingDescription]
        STREAMN[streamGenerateNotes / enhanceNotes]
        EDIT[streamRewriteSelection / streamCustomEdit / polishTranscript]
        BRIEF[generateBrief / polishBrief]
        QA[executeQuickAction / runRecipe]
        CHAT[streamChatResponse / streamGlobalChat]
        LIVE[suggestQuestions / suggestLiveQuestions / summarizeWhatDidIMiss]
        TAGS[suggestMeetingTags]
        SPK[detectSpeakers]
        IDX[indexMeetingInMemory]
    end

    subgraph "Retrieval"
        MEM[context-memory.ts<br/>TF-IDF + cosine]
        EMB[embedding.ts<br/>embed_text / embed_batch via Rust sidecar]
        KG[knowledge-extract / knowledge-link / knowledge-search<br/>actions, decisions, topics + edges]
    end

    subgraph "Transport"
        LLMC[llm-client.ts<br/>OpenAI-compatible + Anthropic Messages<br/>120s timeout, 2 retries, SSE via sse-parser.ts]
        PROV[ai-providers.ts<br/>provider registry + endpoints]
        KEY[Secure key store<br/>Tauri plugin-store]
        USAGE[token-usage.ts]
    end

    TITLE & STREAMN & EDIT & BRIEF & QA & CHAT & LIVE & TAGS & SPK --> LLMC
    BRIEF & QA & CHAT --> MEM & KG
    KG --> EMB
    IDX --> MEM
    LLMC --> PROV & KEY & USAGE
```

Supported providers (`ai-providers.ts`): DeepSeek, OpenAI, xAI, Anthropic, Gemini, Groq, OpenRouter, Mistral, Together AI, Ollama, and a custom OpenAI-compatible endpoint. `deepseek-client.ts` is a back-compat alias layer over `llm-client.ts`.

Other AI-adjacent modules: `auto-tag.ts` (apply suggested tags), `catch-up.ts`, `chat-actions.ts`, `citations.ts`, `dictionary.ts` (spelling + protected names), `meeting-brief.ts`, `meeting-content.ts` (single source for assembling meeting text), `speakers.ts`.

## Storage Architecture

Data is held in `localStorage` (synchronous reads) and mirrored to an encrypted Stronghold vault.

- **Write path:** each `save*` / `upsert*` helper in `storage.ts` writes `localStorage`, then persists to Stronghold (`persist`, errors logged not thrown).
- **Startup:** `hydrateFromVault()` reads every key in `ALL_KEYS` from Stronghold into `localStorage` before the app loads.
- **Vault password:** generated randomly on first launch (`stronghold.ts`) and stored in the Tauri plugin-store file `meeting-notes-secure.json`. The Rust side derives the vault key from it with a salted, iterated SHA-256.
- **API keys and the Slack webhook URL** live only in the Tauri plugin-store. `saveApiKey` fails closed rather than falling back to `localStorage`; a legacy plaintext key is migrated once and removed.
- **Keys stored:** meetings, settings, AI settings, templates, memory index, knowledge graph, dictionary, snippets, folders (tags), recipes, people, token usage. Sort preference and saved searches are `localStorage` only.
- **MCP snapshot:** `writeMcpSnapshot()` sends a JSON snapshot to `write_mcp_snapshot`, which writes `meetings-mcp-snapshot.json` into the app data dir for the MCP server.

## Backend Invoke Commands

| Module | Commands |
| --- | --- |
| `capture.rs` | `start_continuous`, `stop_continuous` |
| `fluid.rs` (streaming) | `prewarm_stream` |
| `fluid.rs` (batch) | `transcribe_audio_fluid`, `transcribe_audio_file_fluid`, `diarize_audio_file_fluid` |
| `fluid.rs` (models) | `check_fluid_ready`, `setup_fluid`, `setup_fluid_model`, `download_model`, `cancel_model_setup`, `model_setup_status`, `unload_fluid`, `fluid_loaded`, `model_storage_info`, `delete_model` |
| `fluid.rs` (permissions) | `check_screen_permission`, `request_screen_permission` |
| `embed.rs` | `embed_text`, `embed_batch`, `unload_embed` |
| `calendar.rs` | `request_calendar_access`, `list_upcoming_events`, `calendar_authorization_status` |
| `call_detect.rs` | `detect_call_apps` |
| `mcp_snapshot.rs` | `write_mcp_snapshot`, `mcp_snapshot_path` |

Events emitted to the webview: `transcript-stream`, `audio-level`, `capture-error`, `session-wav`, `fluid-model-progress`, `quick-capture` (global shortcut ⌘⇧N). The webview emits `recording-state`, which `lib.rs` uses to update the tray tooltip.

Plugins: opener, store, dialog, fs, log, stronghold, single-instance, window-state, global-shortcut. The tray menu has Show / Recording status / Quit; Quit stops capture and unloads the sidecars first.

Debug builds honor `FLUID_SIDECAR_BIN` to point at a different sidecar binary.

## Data Model

```mermaid
erDiagram
    Meeting {
        string id PK
        string title
        string date
        number duration
        string transcript
        string notes
        string templateId FK
        MeetingSection[] structuredNotes
        string enhancedNotes
        ChatMessage[] chatHistory
        SpeakerLabel[] speakerLabels
        TranscriptSegment[] transcriptSegments
        string brief
        string memoryDigest
        string memoryIndexedAt
    }

    MeetingTemplate {
        string id PK
        string name
        string icon
        string[] sections
        QuickAction[] quickActions
    }

    MemoryEntry {
        string meetingId FK
        string digest
        Record~string,number~ tf
        string indexedAt
    }

    AppSettings {
        string audioSource
        string preferredDeviceId
        string speechLang
        string titlePrefix
        string theme
    }

    AISettings {
        string provider
        string model
        boolean enabled
    }

    Folder {
        string id PK
        string name
        string color
    }

    Person {
        string id PK
        string name
    }

    KnowledgeItem {
        string id PK
        string meetingId FK
        string kind
        string status
    }

    Meeting ||--o| MeetingTemplate : uses
    Meeting }o--o{ Folder : tagged
    Meeting }o--o{ Person : attended-by
    Meeting ||--o{ KnowledgeItem : yields
    Meeting ||--o| MemoryEntry : indexed-as
```

## File Map

```
myna-notes/
├── src/                            # React frontend
│   ├── App.tsx                     # Root state, hash routing (#dashboard, #editor/<id>, #settings)
│   ├── main.tsx, types.ts, index.css
│   ├── components/                 # Views + editor/dashboard pieces (see diagram above)
│   │   └── ui/                     # shadcn/ui primitives
│   └── lib/
│       ├── ai-service.ts, llm-client.ts, ai-providers.ts, deepseek-client.ts, sse-parser.ts, token-usage.ts
│       ├── context-memory.ts, embedding.ts, knowledge-{extract,link,search}.ts, citations.ts
│       ├── use-recording.ts, stream-transcript.ts, diarize.ts, import-audio.ts, speakers.ts
│       ├── storage.ts, stronghold.ts
│       ├── meeting-content.ts, meeting-brief.ts, catch-up.ts, auto-tag.ts, chat-actions.ts, checklist.ts
│       ├── dictionary.ts, templates.ts, export.ts, share.ts, import-meetings.ts, sidebar-people.ts
│       └── use-{chat,theme,audio-devices,permissions}.ts, onboarding.ts, app-meta.ts, utils.ts, ...
├── src-tauri/                      # Rust backend
│   ├── src/{main,lib,capture,fluid,embed,calendar,call_detect,mcp_snapshot}.rs
│   ├── binaries/fluidasr-aarch64-apple-darwin   # bundled sidecar
│   ├── capabilities/default.json, Entitlements.plist, Info.plist, tauri.conf.json
│   └── icons/
├── fluid-sidecar/                  # Swift sidecar (FluidAudio): capture, VAD, ASR, diarization
├── mcp-server/                     # Rust stdio MCP server reading the snapshot
├── scripts/                        # build-sidecar.sh, package-unsigned.sh, install.sh, process.ts
├── docs/                           # architecture.md, architecture-review.md, images/
├── LAUNCH.md, README.md
└── vite.config.ts, tsconfig*.json, package.json
```
