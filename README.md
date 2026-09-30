# Myna Notes

Local meeting notes for macOS. Live transcription runs **on this Mac** (Apple Neural Engine). Optional AI polish uses **your** API key only when you Enhance or chat.

**Version:** 0.1.0

![Myna Notes — meeting note with enhanced notes, action digest, and record controls](docs/images/myna-notes-note.webp)

## Why Myna Notes

1. **Live captions** — mic, system audio (other side of a call), or both  
2. **Enhance** — structured notes, action digests, concept **tags**  
3. **Weekly review** — Actions, People, and tag filters across the month  
4. **Privacy-first** — ASR stays local; cloud AI is opt-in  

## Features

- **On-device ASR** — Parakeet v3 via [FluidAudio](https://github.com/FluidInference/FluidAudio) Core ML  
- **Speaker diarization** — FluidAudio offline pyannote/VBx pipeline after stop or audio import (`Speaker 1:` …)  
- **System audio capture** — Core Audio process tap (macOS 14.4+); dual mode labels `Me:` / `Them:`  
- **Dual-pane notepad** — shorthand + live transcript; Enhance merges both  
- **Concept tags** — multi-label topics; AI can auto-tag after Enhance  
- **Actions & People** — open loops and memory from enhanced notes  
- **Calendar** — upcoming EventKit events, one-click start with attendees  
- **Dictionary** — teach spellings; known people names are protected from bad rewrites  
- **Recipes & share** — follow-up email, digests; mailto / export / Slack  
- **Meeting briefs & live assist** — pre-meeting brief from past notes; live suggested questions and "what did I miss"  
- **Knowledge graph & search** — decisions, actions and topics extracted per meeting, linked across meetings, searched with on-device embeddings + TF-IDF  
- **Audio import** — transcribe (and diarize) existing recordings: mp3, m4a, wav, aac, aiff, caf, flac, ogg, mp4, mov  
- **Desktop niceties** — menu-bar tray with recording status, global quick capture (⌘⇧N), command palette, call-app detection prompts  
- **Local MCP** — optional snapshot for Cursor/Claude  

## Requirements

- macOS 14+ (Apple Silicon recommended; Fluid sidecar ships `aarch64-apple-darwin`)  
- Xcode CLT for building the sidecar  
- Optional: AI API key for Enhance / chat (DeepSeek, OpenAI, Anthropic, xAI/Grok, Gemini, Groq, OpenRouter, Ollama, or custom)  

## Develop

```bash
yarn install
yarn tauri:dev
```

Build release DMG:

```bash
yarn tauri:build
```

### Install (unsigned, free)

No Apple Developer Program / notarization required. Users run:

```bash
curl -fsSL https://raw.githubusercontent.com/crstnmac/myna-notes/main/scripts/install.sh | bash
```

Safer (inspect first):

```bash
curl -fsSL https://raw.githubusercontent.com/crstnmac/myna-notes/main/scripts/install.sh -o install.sh
less install.sh
bash install.sh
```

This downloads the latest GitHub Release asset `Myna-Notes-macos-arm64.zip`, installs to `/Applications`, and clears the download quarantine flag. It is a **user-assisted** install, not Gatekeeper approval.

Publish a ZIP after building:

```bash
yarn tauri:build
yarn package:unsigned
# upload dist-release/Myna-Notes-macos-arm64.zip to the GitHub Release
```

If macOS still blocks the app: Finder → right-click **Myna Notes** → **Open** → **Open**, or:

```bash
xattr -dr com.apple.quarantine "/Applications/Myna Notes.app"
```

See **[LAUNCH.md](./LAUNCH.md)** for release packaging and optional paid signing/notarization.

## Local MCP

1. Settings → Meeting → enable **MCP snapshot**  
2. `cd mcp-server && cargo build --release`  
3. Point your MCP client at the binary + `MEETING_NOTES_SNAPSHOT` path (Settings → Share shows the data dir)  

Tools: `list_meetings`, `get_meeting`, `search_meetings`, `list_folders` (tags), `list_open_actions`, `get_brief`, `get_transcript`, `list_people`, `get_meeting_citations`.

## Architecture

```
React UI (Vite)  ◄── events / invokes ──►  Tauri (Rust)
                                              │ stdin/stdout
                                         fluidasr (Swift)
                      mic + system tap → VAD → Parakeet v3 → diarization
```

- `src/` — React app (`components/` views, `lib/` AI, storage, recording logic)  
- `src-tauri/` — shell: sidecar management, stream relay, calendar (EventKit), call detection, embeddings, MCP snapshot  
- `fluid-sidecar/` — Swift binary that owns all audio capture and recognition  
- `mcp-server/` — stdio MCP server over the snapshot file  

Recording flow: the sidecar captures the mic and/or system audio, gates it with a VAD, and streams text back; Rust relays it to the UI as events. After you stop, a session WAV is diarized offline to add `Speaker N:` labels. Details, diagrams and the file map are in **[docs/architecture.md](./docs/architecture.md)**; known gaps are tracked in **[docs/architecture-review.md](./docs/architecture-review.md)**.

## Privacy

| Data | Where |
| --- | --- |
| Audio → text | On-device ASR only |
| Notes, tags, people | Local storage on this Mac, mirrored to an encrypted Stronghold vault |
| API keys | Tauri secure store on this Mac; never written to plain localStorage |
| Enhance / chat | Your AI provider, only with a configured key |

## License

Private / as distributed by the author.
