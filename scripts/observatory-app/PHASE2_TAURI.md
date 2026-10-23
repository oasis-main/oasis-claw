# CLAW-126 phase 2: a Tauri app (design note, not built)

Status: proposal. Phase 1 (`main.swift`, a WKWebView window) is the app that
runs today. This note records the phase 2 design so that the work can start
from a decision, not from a blank page.

## Why Tauri

- The observatory page is about 3,900 lines of web code (`scripts/observatory/`).
  Tauri shows the page in the system web view (WKWebView on macOS), so the
  page runs unchanged. Phase 1 uses the same web view, so phase 1 is a test
  of that compatibility.
- Rust is installed. Tauri gives a menu-bar (tray) icon, a single-instance
  lock, and a signed bundle with less custom code than AppKit.
- Not egui: oasis-firmware's desktop app uses Rust + egui, but egui would mean
  a new UI for every observatory view.

## Scope

1. **Child process.** The Tauri core runs `node scripts/claw-observatory.mjs serve`
   (and the port proxy step) as a child, and stops it on quit. This is the
   phase 1 lifecycle, moved into Rust.
2. **Key out of localStorage.** The core reads `observatory-key` from the
   state folder and adds the `x-observatory-token` header to each page
   request. Two ways:
   - a Tauri command `api(path, method, body)` that the page calls in place of
     `fetch`, with a small switch in `app.js` (`window.__TAURI__` present); or
   - a custom URI scheme (`observatory://`) that the core serves by a proxy to
     127.0.0.1:18780 and that adds the header.
   The first way changes less. Either way, the page never holds the key, and
   no new loopback port opens.
3. **Menu-bar fleet status.** A tray icon shows the count of bots that run,
   the bots with a health problem, and new change requests. The core reads
   `GET /api/fleet` every 30 s with the key. The tray menu has: Open
   Observatory, one item for each bot (opens its Control UI in the default
   browser), Start or Stop Observatory, Quit.
4. **Persistent page settings.** The page settings (last view, selected bots,
   change-request draft) go to a file in the state folder through a Tauri
   command, not to `localStorage`. This removes the phase 1 limit where the
   settings reset at each start.

## Rules to keep

- The CLAW-108 trust model in `scripts/claw-observatory.mjs` applies: no new
  loopback port, no unauthenticated route, no token in a log or in a file
  outside the state folder.
- The Tauri IPC allowlist permits only the commands above. The web view loads
  only the observatory origin. Other addresses open in the default browser.
- A Developer ID signature (if Mike gets one) keeps the Documents access grant
  across builds. Phase 1 has an ad hoc signature, so macOS can ask again.

## Open questions for Mike

1. Install a Rust toolchain target for a universal binary (arm64 + x86_64), or
   arm64 only?
2. Should the tray icon also run the observatory at login (a launch agent),
   or only when Mike opens the app?
