// Outbound HTTP for LLM and webhook calls. Inside the Tauri app the request is
// made by the Rust side (tauri-plugin-http), so the webview's CSP `connect-src`
// can stay at 'self' and there is no browser CORS to work around. Plain
// `vite dev` in a browser falls back to the global fetch.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"

export const httpFetch: typeof fetch = (input, init) => {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  return inTauri ? tauriFetch(input, init) : fetch(input, init)
}
