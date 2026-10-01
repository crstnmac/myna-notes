# Architecture Review — Gaps & Findings

> **Status update (re-checked against the current tree).** This review was written against an earlier version of the code. Since then:
>
> | # | Finding | Status |
> |---|---------|--------|
> | 1 | Hardcoded vault password | **Fixed** — random password generated on first launch, kept in the plugin-store (`stronghold.ts`) |
> | 2 | API key falls back to plaintext localStorage | **Fixed** — `saveApiKey` fails closed; legacy keys are migrated and removed |
> | 4 | `needsReindex` always true | **Fixed** — compares against `MemoryEntry.contentHash` |
> | 6 | Unbounded audio buffer | **Obsolete** — cpal capture removed; audio is captured in the Swift sidecar |
> | 7 | `Relaxed` atomic ordering | **Obsolete** — capture stop flag uses `Acquire`/`Release` |
> | 17 | `FLUID_SIDECAR_BIN` arbitrary code execution | **Mitigated** — honored in debug builds only (`fluid.rs`) |
> | 18 | No request timeouts/retries | **Fixed** — `llm-client.ts` has a 120 s timeout and 2 retries with backoff |
> | 19 | SSE parsing duplicated | **Fixed** — shared `sse-parser.ts` |
> | 21 | `buildMeetingContent` defined twice | **Fixed** — single `meeting-content.ts` |
> | 13 | CSP | **Partly fixed** — LLM and webhook calls now go through `tauri-plugin-http` (Rust side), so webview `connect-src` stays `'self'`; the plugin's scope in `capabilities/default.json` allows any `https://` host plus localhost (needed for custom endpoints and Ollama). `style-src` still has `'unsafe-inline'` |
> | 9 (partial) | Error boundary | **Added** — `error-boundary.tsx` |
>
> Findings not listed above were not re-verified and should be treated as open. Line numbers and file references below are from the original review and may have shifted; references to `cpal`, `whisper`, and DeepSeek-only transport are historical.

## Severity Legend

| Label | Meaning |
|-------|---------|
| 🔴 CRITICAL | Data loss, security breach, or crash — must fix |
| 🟠 HIGH | Resource leak, race condition, or silent corruption |
| 🟡 MEDIUM | Design flaw, UX gap, or maintenance risk |
| 🟢 LOW | Code quality, polish, or edge case |

---

## 🔴 Critical Issues

### 1. Vault Password Hardcoded in Source
**File:** `src/lib/stronghold.ts:5`
```ts
const VAULT_PASSWORD = "meeting-notes-vault-key-2026"
```
The Stronghold encryption vault password is **plaintext in the frontend source bundle**. Anyone with access to the binary or a debugger can extract it. The entire encrypted storage layer provides zero security benefit.

**Impact:** All locally stored meeting data is effectively unencrypted. The vault is security theater.

**Fix:** Use the macOS Keychain (via `security` framework FFI in Rust) or prompt the user for a password on first launch.

---

### 2. API Key Falls Back to Plaintext localStorage
**File:** `src/lib/storage.ts:115-121`
```ts
export async function saveApiKey(apiKey: string): Promise<void> {
  try {
    const store = await getSecureStore()
    await store.set(SECURE_API_KEY_KEY, apiKey)
  } catch {
    localStorage.setItem(SECURE_API_KEY_KEY, apiKey)  // fallback to unencrypted
  }
}
```
When the Tauri secure store is unavailable, the DeepSeek API key is saved to **unencrypted localStorage**. Any XSS or local script can exfiltrate it.

**Impact:** API key exfiltration risk.

**Fix:** Do not fall back to localStorage. Show an error to the user and refuse to save.

---

### 3. Temp WAV Files Leak on Transcription Errors
**File:** `src-tauri/src/fluid.rs:411-434`
```rust
let tmp = tempfile::Builder::new()...;  // line 395
let path = tmp.into_temp_path().keep()...;  // line 403 (persisted)
tokio::fs::write(&path, &audio_data).await?;  // line 406
let result = { ... spawn_sidecar().await? }.await;  // line 415 — early ? return
let _ = tokio::fs::remove_file(&path).await;  // line 433 — NOT REACHED on error
```
If `spawn_sidecar().await?` returns `Err`, the `?` propagates past the cleanup at line 433. The WAV file **permanently leaks** to the app data directory on disk.

**Impact:** Disk space accumulates leaked WAV files on every transcription failure. No cleanup path.

**Fix:** Use a `defer!`-style guard or wrap the entire block in `tokio::fs::remove_file` in a `finally`-like pattern. Better: don't persist temp files. Pass the audio directly over stdin (the sidecar already supports this via frames).

---

### 4. Memory Index `needsReindex` Always Returns True
**File:** `src/lib/context-memory.ts:184-188`
```ts
export function needsReindex(meeting: Meeting): boolean {
  if (!meeting.memoryDigest || !meeting.memoryIndexedAt) return true
  const currentHash = contentHash(meeting)      // numeric hash string
  return currentHash !== meeting.memoryDigest    // compared to AI digest text
}
```
`meeting.memoryDigest` stores the **AI-generated semantic digest text** (set by `generateMeetingDigest`), not the content hash. `contentHash()` returns a numeric hash string. These will **never** match, so `needsReindex` always returns `true`, triggering unnecessary AI calls and re-indexing on every comparison.

**Impact:** Every call that checks `needsReindex` triggers a fresh DeepSeek API call to regenerate the digest, wasting API credits.

**Fix:** Either store the content hash separately (e.g., `memoryContentHash` field) or repurpose `memoryDigest` to store the hash.

---

### 5. Global Chat Synthetic Meeting Self-Matches in Search
**File:** `src/lib/ai-service.ts:603-610`
```ts
const queryMeeting: Meeting = {
  id: "__global__",
  title: query.slice(0, 100),
  transcript: query,
  notes: query,  // query text used as both transcript AND notes
  ...
}
const related = findRelatedMeetings(queryMeeting, allMeetings, 10)
```
A synthetic meeting is constructed from the user query, with the query text duplicated into both `transcript` and `notes`. `findRelatedMeetings` includes this in the TF-IDF corpus. The query creates term-frequency vectors for itself, and then is scored against all meetings **and itself** (filtered by ID only at line 137 of `context-memory.ts`). Since the `__global__` id won't match any real meeting, it doesn't self-match — but the IDF computation in `computeIDF([queryTF, ...documents])` at line 134 adds the query terms to the document-frequency calculation, inflating IDF weights for terms that appear in the query.

**Impact:** Skewed relevance scores for global chat queries. Terms in the query itself get artificially high weight.

**Fix:** Exclude the synthetic meeting from the IDF corpus, or pre-filter document set.

---

## 🟠 High Issues

### 6. Unbounded Audio Buffer Growth
**Files:** `src-tauri/src/capture.rs:95`, `339`
```rust
let shared = Arc::new(Mutex::new(Vec::<f32>::new()));  // line 95
// ...
let chunk: Vec<f32> = shared.lock().map(|mut b| std::mem::take(&mut *b))  // line 339
```
Audio samples accumulate in a `Vec<f32>` at the capture rate (16kHz mono = 64 KB/s). If the sidecar feed loop stalls (e.g., sidecar crashes, network/disk contention), the buffer grows without bound. At 48kHz stereo with a 10-second stall: 48000 * 2 * 4 * 10 = 3.8 MB. At 60 seconds: 23 MB. The Tokio worker thread holding the `std::sync::Mutex` blocks while draining this buffer.

**Impact:** Memory exhaustion under sustained sidecar stalls. Potential UI freeze if the Tokio worker thread is blocked.

**Fix:** Use a bounded ring buffer (`ringbuf` crate) with backpressure. Drop samples if the buffer exceeds a high-water mark rather than growing unboundedly.

---

### 7. Atomic Ordering `Relaxed` on Apple Silicon
**File:** `src-tauri/src/capture.rs:62, 68, 213, 266, 337`
```rust
stop: Arc<AtomicBool>
self.stop.store(true, Ordering::Relaxed)  // stored by Drop/setup thread
stop.load(Ordering::Relaxed)              // loaded by capture thread + async task
```
On ARM (Apple Silicon), `Relaxed` ordering provides no cross-thread visibility guarantees. The capture thread may continue reading audio for milliseconds (or indefinitely under heavy contention) after the stop flag is set. While this usually works in practice due to cache coherency, it is formally undefined behavior per the C++/Rust memory model.

**Impact:** Delayed or missed stop signals on Apple Silicon under heavy CPU load.

**Fix:** Use `Ordering::Release` on `store` and `Ordering::Acquire` on `load`.

---

### 8. Reader JoinHandle Abandoned on Timeout
**File:** `src-tauri/src/capture.rs:355-357`
```rust
sidecar.finish().await;
let _ = tokio::time::timeout(Duration::from_secs(6), reader).await;
```
The `reader` task (stdout line parser) is joined with a 6-second timeout. On timeout, the `JoinHandle` is **dropped**, but the underlying Tokio task continues running. It holds references to `reader_app` (an `AppHandle`), preventing app cleanup, and continues reading from the sidecar's stdout (which was already closed by `finish`). The task leaks.

**Impact:** Accumulating leaked Tokio tasks over repeated start/stop cycles. Each leaked task holds an `AppHandle` clone and sidecar stdout reader.

**Fix:** Use `tokio::select!` with an abort handle. Abort the reader task explicitly on timeout.

---

### 9. Child Processes Killed Without `wait()` → Zombie Processes
**Files:** `src-tauri/src/fluid.rs:20-25`, `268-271`, `111`, `373`
```rust
impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        // NO wait() — process becomes a zombie
    }
}
```
`start_kill()` sends SIGKILL but does not wait for the process to exit. The child process becomes a **zombie** until the parent process exits or is reaped. On macOS, zombies consume a process table slot and appear in `ps aux` as `(fluidasr)` entries. Over repeated start/stop cycles, dozens of zombie processes can accumulate.

**Impact:** System process table pollution. On macOS, the per-user process limit is ~2666 (sysctl `kern.maxprocperuid`). Under extreme cycles (e.g., rapid start/stop during testing), this could prevent new process creation.

**Fix:** Call `self.child.wait()` (or `try_wait()`) after `start_kill()`, or use `tokio::process::Child::wait()` before drop.

---

### 10. `app.exit(0)` with Zero Cleanup
**File:** `src-tauri/src/lib.rs:69`
```rust
"quit" => {
    app.exit(0);  // immediate hard exit
}
```
The tray "Quit" action calls `app.exit(0)`, which terminates the process immediately. No capture thread is stopped, no sidecar is killed (with wait), no audio buffer is flushed, no `Drop` implementations on statics are guaranteed to run.

**Impact:** Sidecar process may persist as an orphan after the app exits. Audio device may be left in an inconsistent state.

**Fix:** Gracefully shut down: stop capture, kill sidecar with wait, flush settings, then exit.

---

### 11. `setup_fluid` Failure Silently Ignored on Startup
**File:** `src-tauri/src/lib.rs:96`
```rust
tauri::async_runtime::spawn(async move {
    let _ = fluid::setup_fluid(handle).await;  // failure silently dropped
});
```
If the sidecar binary is missing or fails to start at app launch, the user receives **no notification**. The first transcription attempt will fail with a long timeout, confusing the user about what went wrong.

**Impact:** Poor UX on first transcription attempt when sidecar is not installed.

**Fix:** Emit a `fluid-status` event on failure. The frontend should display a persistent warning in the UI.

---

### 12. Global Sidecar Mutex + Concurrent Request Race
**File:** `src-tauri/src/fluid.rs:27, 117-169`
```rust
fn slot() -> &'static Mutex<Option<Sidecar>> { ... }  // single global sidecar

async fn request(sc: &mut Sidecar, wav_path: &str, language: &str) -> Result<String, String> {
    sc.stdin.write_all(...).await?;   // line 124
    // ... read response from sc.stdout ...
}
```
The sidecar uses a **line-based request/response protocol** over shared stdin/stdout. If two `transcribe_audio_fluid` calls interleave — even though they serialize on the mutex — the sidecar's response ordering must match request ordering. The mutex ensures serial access, so this is safe... **but** the respawn-on-failure path at lines 423-428 acquires the mutex again inside the same function, creating a narrow window of re-entrancy risk if refactored.

**Impact:** Currently safe due to mutex serialization, but fragile. Any future code that reads stdout outside the mutex will mix up responses.

**Fix:** Use the **per-request temp file passing** design instead of shared stdin/stdout, or run a dedicated sidecar per request.

---

## 🟡 Medium Issues

### 13. CSP Allows Unsafe Inline + Arbitrary HTTPS
**File:** `src-tauri/tauri.conf.json:27`
```
"script-src 'self' 'unsafe-inline'; connect-src 'self' https:"
```
`'unsafe-inline'` allows inline `<script>` tags, defeating XSS protection. `connect-src https:` allows the webview to connect to any HTTPS endpoint — an XSS could exfiltrate data to any server.

**Impact:** Reduced XSS protection in the Tauri webview.

**Fix:** Remove `'unsafe-inline'` (use hashes/nonces via Vite if needed). Restrict `connect-src` to `https://api.deepseek.com`.

---

### 14. TF-IDF Implementation Has Multiple Design Flaws
**File:** `src/lib/context-memory.ts`
- **IDF formula non-standard (L53):** `Log((N+1)/(df+1)) + 1` adds trailing `+1`, inflating scores for common terms
- **Query pollutes IDF corpus (L134):** Query terms included in document-frequency, inflating own relevance
- **No stemming/lemmatization:** `"running"` ≠ `"runs"` ≠ `"ran"` — no semantic overlap
- **Stop word list minimal (~85 words):** Missing `"meeting"`, `"discuss"`, `"said"`, `"think"`, `"know"`, `"actually"`, etc.
- **Tokenization regex `/[^a-z0-9]+/`** destroys hyphenated compounds (`"high-level"` → `["high","level"]`), Unicode names (`"José"` → `["jos"]`), contractions (`"don't"` → `["don"]`)

**Impact:** Poor relevance ranking. Semantically identical meetings with different wording get zero similarity score.

**Fix:** Consider adding a lightweight embedding model (e.g., `all-MiniLM-L6-v2` via ONNX) as an alternative indexing path. At minimum, add stemming (Porter stemmer), expand stop words, and fix the IDF query pollution.

---

### 15. O(n²) Memory Search for 1000+ Meetings
**Files:** `src/lib/context-memory.ts:121`, `ai-service.ts:372,414,457,611`
Every AI operation (`generateBrief`, `streamChatResponse`, `executeQuickAction`, `streamGlobalChat`) calls `findRelatedMeetings`, which:
1. Loads ALL `MemoryEntry` objects from localStorage
2. Recomputes IDF on the entire corpus
3. Computes cosine similarity for every entry (O(n))
4. Nested `allMeetings.find()` per entry (another O(n))

At 1000 meetings, each query scans 1000 entries × 1000-meeting find = 1,000,000 iterations + deserialization + TF-IDF computation.

**Impact:** UI freeze on every AI call if the meeting corpus exceeds ~500 entries.

**Fix:** Cache memory entries in memory. Precompute IDF. Use an approximate nearest-neighbor approach. Add a meeting count limit with a user-visible warning.

---

### 16. Full Meeting Content Sent to External API
**Files:** `src/lib/ai-service.ts` (all functions)
Every AI function sends `transcript`, `notes`, `structuredNotes`, `enhancedNotes`, and `brief` text to `api.deepseek.com`. No PII redaction, no per-meeting opt-out, no local-only mode.

**Impact:** Confidential meeting data (names, budgets, strategies, decisions) transmitted to a third-party API.

**Fix:** Add a "local only" flag per meeting. Add PII detection/redaction before sending. Document the data flow in privacy settings. Consider on-device models for summarization (the app already bundles CoreML for ASR).

---

### 17. `FLUID_SIDECAR_BIN` Environment Variable = Arbitrary Code Execution
**File:** `src-tauri/src/fluid.rs:32-37`
```rust
if let Ok(p) = std::env::var("FLUID_SIDECAR_BIN") {
    let pb = PathBuf::from(&p);
    if std::fs::metadata(&pb).map(|m| m.len() > 1000).unwrap_or(false) {
        return pb;  // uses attacker-controlled path
    }
}
```
An environment variable can override the sidecar binary path. The only validation is file size > 1000 bytes. A malicious process or LaunchAgent could set this to an arbitrary binary that runs with the app's permissions.

**Impact:** Privilege escalation via environment variable injection.

**Fix:** Remove the env var override in production builds (or gate it behind a debug-only `#[cfg(debug_assertions)]`). Validate code signature of the binary before execution.

---

### 18. No API Request Timeouts or Retry Logic
**File:** `src/lib/ai-service.ts` — all `fetch()` calls
Not a single `fetch()` call uses `AbortSignal.timeout()` or any timeout mechanism. A hung TCP connection blocks the caller indefinitely. No retry logic for `429 Too Many Requests`, `503 Service Unavailable`, or transient network errors.

**Impact:** UI hangs on network issues. API failures are immediately surfaced to the user with no automatic recovery.

**Fix:** Add `signal: AbortSignal.timeout(60_000)` to all fetch calls. Add exponential backoff retry for 5xx and 429 responses (max 3 retries).

---

### 19. SSE Stream Parsing Duplicated 5 Times + Buffer Bug
**File:** `src/lib/ai-service.ts:60-77, 207-225, 286-306, 507-522, 663-674`
Identical SSE stream parsing logic (buffer, split, `data:`, JSON.parse, delta extraction) appears 5 times. The non-stream `callDeepSeek` version (L60-77) uses `decoder.decode(value, { stream: true })` without a buffer, so multi-byte UTF-8 characters split across chunks are decoded incorrectly.

**Impact:** Maintenance burden (any fix must be applied in 5 places). Potential garbled text in streaming responses.

**Fix:** Extract a shared `parseSSEStream()` utility function. All callers should use the buffered variant from lines 207-225.

---

### 20. Missing Graceful Shutdown Path
**Files:** `src-tauri/src/lib.rs`, `capture.rs`, `fluid.rs`
- Tray Quit = immediate `app.exit(0)` (no cleanup)
- No `on_window_event` handler for close → hide to tray
- No SIGTERM/SIGINT handler
- `Capture::Drop` joins capture thread but has no timeout
- `Sidecar::Drop` kills child but doesn't wait

**Impact:** On app quit, sidecar processes may persist. Audio device may be left in capture state.

---

### 21. `buildMeetingContent` Defined Twice
**Files:** `src/lib/ai-service.ts:550-562`, `src/lib/context-memory.ts:77-89`
Identical 13-line function in two files. Divergence would produce inconsistent behavior between AI digest generation and memory search.

**Fix:** Move to `src/lib/utils.ts` or create a shared module. Export once, import in both places.

---

## 🟢 Low Issues

### Storage Layer
- **`updateMeeting` / `upsertMemoryEntry`**: Read-modify-write without locking — concurrent webview instances (if Tauri multi-window is ever enabled) will clobber each other
- **`loadMeetings` / `loadSettings` etc.**: All silently return defaults on JSON parse failure — corrupted data is silently discarded with no user notification
- **`hydrateFromVault`**: Individual key failures silently skipped — partial corruption produces inconsistent state
- **Double-write to localStorage + Stronghold**: If vault write fails after localStorage write, data diverges with no reconciliation mechanism

### Frontend
- **4× duplicated utility functions**: `formatDate`, `formatTime`, `formatDuration` each defined in 4 different component files
- **3× duplicated `SUGGESTED_QUESTIONS`**: Identical array in `ai-chat-panel.tsx`, `chat-page.tsx`, `note-editor.tsx`
- **No keyboard navigation on meeting cards**: `<Card onClick>` without `role="button"`, `tabIndex`, or `onKeyDown`
- **No `role="menu"` / `role="menuitem"`** on AI context menu and selection actions
- **Animate pulse has no `prefers-reduced-motion` check**: Recording badges and streaming indicators flash continuously
- **Waveform Oklch-to-canvas color conversion runs every animation frame** — should be memoized

### Rust Backend
- **`let _ =` error swallowing everywhere**: ~15 instances across `capture.rs` and `fluid.rs` where `emit`, `remove_file`, `join`, `kill` failures are silently dropped
- **stderr piped for streaming sidecar but nulled for batch sidecar**: CoreML errors during batch transcription are invisible
- **`tempfile::Builder.keep()` in `transcribe_audio_fluid`**: Uses `.keep()` which disables auto-cleanup — manual cleanup at line 433 can be skipped by early returns
- **No chunk size enforcement on audio feed**: `samples_to_le_bytes` allocates proportional to the full accumulated buffer

---

## Architecture Gaps

### 1. No Offline Mode
The app requires a network connection for all AI features. There is no local-model fallback for summarization, title generation, or chat — despite the app already bundling CoreML for on-device ASR. The DeepSeek API is the only AI path.

**Recommendation:** Investigate local LLM inference via CoreML (MLX, `llama.cpp`, or Apple's `MLX` framework) for basic summarization and title generation as a fallback.

---

### 2. No Meeting Search Beyond TF-IDF
The only search mechanism is the TF-IDF cosine similarity used for AI context injection. There is **no full-text search** — users cannot search their own meeting transcripts and notes by keyword. The dashboard search bar searches only meeting titles.

**Recommendation:** Add full-text search over transcript and notes content. A simple inverted index (or Fuse.js for small datasets) would cover this.

---

### 3. No Export Granularity Controls
Export always includes the full `Meeting` object (transcript, notes, structured notes, AI-enhanced notes, chat history, brief, memory digest). There is no option to export only notes, only transcripts, or exclude AI-generated content.

**Recommendation:** Add export options: "Notes only", "Transcript only", "Structured notes", "Exclude AI content".

---

### 4. No Data Backup / Import
There is no backup mechanism beyond manual export. No import from JSON/markdown. If the vault is corrupted or the user switches devices, there is no recovery path.

**Recommendation:** Add export → JSON and import ← JSON round-trip support. Consider iCloud sync for the vault file.

---

### 5. No Concurrency in AI Operations
All AI functions are sequential — `enhanceNotes` generates sections one at a time despite being able to run them in parallel. `generateMeetingDigest` and `generateTitle` could run concurrently but run sequentially.

**Recommendation:** Use `Promise.all` for independent AI calls (section generation, title + digest generation).

---

### 6. No Rate Limiting or Usage Tracking
The AI service has no rate limiting. A user can trigger unlimited API calls rapidly (e.g., repeatedly clicking "Enhance" or changing templates). No usage dashboard or cost estimation.

**Recommendation:** Add a cooldown on the enhance/title generation buttons. Track API call count per session. Show estimated token usage before executing.

---

### 7. No Input Validation or Token Counting
Prompts are constructed with raw user input truncated at arbitrary character counts (`slice(0, 3000)`). No token-count estimation. A meeting transcript of 20,000 words may silently exceed the model's context window, causing truncated responses.

**Recommendation:** Implement a simple token estimator (≈ chars/4 for English). Warn when input exceeds model context limits.

---

### 8. No Testing Infrastructure
No test files exist anywhere in the repo (no `*.test.ts`, no `*.spec.ts`, no `tests/` directory, no Rust `#[cfg(test)]` modules). The TF-IDF engine, storage layer, and AI service have zero automated test coverage.

**Recommendation:** Add Vitest for frontend unit tests. Add `#[cfg(test)]` modules in Rust. Prioritize: storage read/write round-trips, TF-IDF similarity edge cases, SSE parsing.

---

### 9. No Error Boundary in React
The entire React tree is unprotected. Any unhandled exception in a component crashes the full app (white screen in Tauri webview). There is no `<ErrorBoundary>` wrapper.

**Recommendation:** Add an error boundary component wrapping each view (`Dashboard`, `Editor`, `Settings`).

---

### 10. No Multi-Window Support
`tauri.conf.json` defines a single window. There is no support for opening a meeting in a separate window, or having the dashboard and editor visible simultaneously.

**Recommendation:** Consider Tauri multi-webview support for detaching the editor into its own window.

---

## Cross-Cutting Code Quality Patterns

### Massive Duplication

| Pattern | Occurrences | Lines Each |
|---------|-------------|------------|
| SSE stream parsing (buffer + lines + `data:` + JSON.parse + delta) | 5 | ~25 |
| API error block (`res.ok` + 401 + status) | 5 | ~6 |
| JSON code-fence cleaning regex | 4 | ~3 |
| `fetch` body construction (model + messages + stream + temp + tokens) | 5 | ~12 |
| Tauri save + browser Blob fallback | 3 | ~22 |
| `formatDate` | 4 | ~5 |
| `formatTime` | 4 | ~4 |
| `formatDuration` | 4 | ~6 |
| `SUGGESTED_QUESTIONS` | 3 | ~10 |
| `buildMeetingContent` | 2 | ~14 |

**Recommendation:** Extract shared utilities into `src/lib/`:
- `src/lib/stream-parser.ts` — unified SSE parser
- `src/lib/api-client.ts` — DeepSeek fetch wrapper
- `src/lib/format.ts` — date/time/duration formatters
- `src/lib/constants.ts` — suggested questions, stop words

### Silent Error Swallowing

**Rust:** ~15 `let _ =` on fallible operations (`emit`, `remove_file`, `join`, `kill`, `set_tooltip`, `set_focus`)
**TypeScript:** Silent `catch(() => {})` in `onboarding.ts:14`, `settings-page.tsx` permission checks, `markdown-view.tsx:70`

### Stale Closure / Ref Patterns
Multiple components use `ref.current = value` in render + read refs in callbacks to avoid stale closures. This pattern is error-prone and bypasses React's dependency tracking. Example: `note-editor.tsx`, `ProseMirrorEditor.tsx`.

---

## Summary

| Category | Count |
|----------|-------|
| Critical | 5 |
| High | 7 |
| Medium | 9 |
| Low | ~30 |
| Architecture Gaps | 10 |
| Code Duplication Patterns | 10 |

### Top 5 Fixes (Highest Impact / Lowest Effort)

1. **Fix `needsReindex` bug** (`context-memory.ts:184`): Change the comparison to use a new `contentHash` field — prevents wasted AI API calls
2. **Fix temp file leak** (`fluid.rs:411-434`): Add a guard or use stdin instead of temp files
3. **Remove vault password from source** (`stronghold.ts:5`): Generate a random password on first launch and store in Keychain
4. **Extract SSE parser** (`ai-service.ts`): Replace 5 copies with one shared function
5. **Extract shared utilities** (`formatDate`, `formatTime`, `formatDuration`, `SUGGESTED_QUESTIONS`): Move to `src/lib/` — eliminates 15+ duplicated definitions
