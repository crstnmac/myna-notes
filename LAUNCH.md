# Myna Notes — Launch checklist (0.1.0)

## Before you build

- [ ] `APP_VERSION` in `src/lib/app-meta.ts` matches `package.json` and `src-tauri/tauri.conf.json` (`0.1.0`)
- [ ] Product name is **Myna Notes** in window title, onboarding, About
- [ ] Icons: `src-tauri/icons/*` and `public/myna-mark.svg`
- [ ] `yarn tsc --noEmit` and `yarn lint` clean
- [ ] Dogfood golden path on your machine (below)

## Golden path (must pass)

1. Fresh launch → onboarding completes (mic optional, ASR ready)  
2. New note → record mic (and optionally system audio) → stop → captions present  
3. Settings → AI key → **Test Connection** (try a non-DeepSeek provider too; see the CSP note in `docs/architecture-review.md`)  
4. **Enhance** → structured notes, toast for tags, action digest if enabled  
5. Home → **Tags** filter → note appears; **Actions** / **People** non-empty when relevant  
6. Quit and reopen → note, tags, actions still there  
7. Settings → Data → Export JSON/Markdown works  
8. Calendar “Up next” shows Allow access if denied (not a silent blank)

## Build release DMG

```bash
yarn tauri:build
```

Artifact typically under `src-tauri/target/release/bundle/dmg/` (and the `.app` under `bundle/macos/`).

## Free distribution (unsigned ZIP + install.sh)

No Apple Developer fee. Best for friends, closed beta, and technical users.

```bash
yarn tauri:build
yarn package:unsigned
```

Upload `dist-release/Myna-Notes-macos-arm64.zip` as a **GitHub Release** asset (keep that exact name; `scripts/install.sh` defaults to it).

Users install with:

```bash
curl -fsSL https://raw.githubusercontent.com/crstnmac/myna-notes/main/scripts/install.sh | bash
```

Overrides:

```bash
MYNA_VERSION=0.1.0 bash scripts/install.sh
MYNA_RELEASE_URL=https://example.com/Myna-Notes-macos-arm64.zip bash scripts/install.sh
MYNA_APP_DIR=~/Applications bash scripts/install.sh
```

What the script does:

1. Downloads the ZIP from GitHub Releases  
2. Installs `Myna Notes.app` to `/Applications` (or `MYNA_APP_DIR`)  
3. Clears `com.apple.quarantine`  
4. Ad-hoc codesigns the app tree (local signature only)

**Limits:** not a Gatekeeper replacement. Non-technical users may still need right-click → Open. This is the free path; paid notarization is the clean public path.

Fallback if still blocked:

```bash
xattr -dr com.apple.quarantine "/Applications/Myna Notes.app"
open "/Applications/Myna Notes.app"
```

Release checklist (unsigned):

- [ ] `yarn tauri:build` succeeds on Apple Silicon  
- [ ] `yarn package:unsigned` produces `dist-release/Myna-Notes-macos-arm64.zip`  
- [ ] GitHub Release tag matches version (`v0.1.0`) and asset name is exact  
- [ ] Fresh Mac / clean user: install.sh works end-to-end  
- [ ] README install blurb points at current repo URL  

## Signing & notarization (optional paid path)

Only needed when you want double-click install for arbitrary users with no terminal:

1. Apple Developer Program membership  
2. Developer ID Application certificate in Keychain  
3. Configure Tauri / `codesign` for the `.app` and nested `fluidasr` binary  
4. `xcrun notarytool submit … --wait` then `stapler staple` the DMG  
5. Test: download DMG on a **different** Mac → open without right-click bypass  

Document your exact team ID and entitlements (`src-tauri/Entitlements.plist`) in a private runbook.

## Closed beta

- [ ] Unsigned ZIP on GitHub Releases + `install.sh` verified, **or** signed + notarized DMG  
- [ ] 5–10 real meetings of use  
- [ ] Support email or form  
- [ ] Short privacy blurb on landing page (copy from Settings → About)  

## Public launch

- [ ] Landing: 3 screenshots + 30s GIF (record → enhance → tags)  
- [ ] Changelog for 0.1.0  
- [ ] “Apple Silicon / macOS 14+” requirements clear  
- [ ] Install path documented (unsigned `install.sh` for free beta, or notarized DMG later)  
- [ ] Plan for updates (manual ZIP/DMG is fine for 0.1; Tauri updater later)  

## Known non-blockers for 0.1

- Package/crate ids may still say `meeting-notes` (storage keys unchanged on purpose)  
- No automated test suite yet (unit or E2E)  
- No auto-updater yet  
- MCP is power-user only  

## Post-launch

- Minimal unit tests: dictionary protect names, tag assign/filter  
- Intel binary only if you expand support  
- Optional crash reporting (privacy review first)  
