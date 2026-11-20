# 07 — Mobile (iOS & Android)

Same renderer bundle as desktop, hosted in Capacitor. Mobile ships in v1, so every core plugin is
built and tested for both from the start (`platforms` in the manifest, CI runs mobile e2e).

## Targets

- iOS 17+ (WKWebView with OPFS sync access handles in workers), iPadOS with split-view layout.
- Android 10+ (Chromium WebView, updated through Play).

## Platform implementation (`platform-capacitor`)

| Concern                  | Approach                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem               | Custom native plugin `PumiceFs` (Swift/Kotlin): bulk `statTree`, `readMany`, atomic write, binary transfer without base64 round-trips. Capacitor's stock Filesystem plugin is too slow for scanning thousands of files. |
| Vault location (iOS)     | App Documents folder (visible in the Files app), iCloud Drive container, or a user-picked folder via document picker + security-scoped bookmark.                                                                        |
| Vault location (Android) | App-specific external storage (visible to file managers) by default; user-picked folders via Storage Access Framework (slower; measure) — avoid `MANAGE_EXTERNAL_STORAGE` (Play policy).                                |
| File watching            | None. Rescan (stat-compare against the index) on app start and resume; iCloud change notifications (`NSFilePresenter`/metadata queries) later.                                                                          |
| Lifecycle                | On pause: flush pending writes and CRDT state (iOS gives a few seconds). On resume: rescan, reconnect sync.                                                                                                             |
| App storage              | OPFS for SQLite index and Yjs state; fallback to native SQLite plugin if spike S4 shows OPFS problems.                                                                                                                  |
| Share                    | Share sheet in (append to daily note / new note / attach file) and out (note as markdown, drawing as PNG/SVG).                                                                                                          |
| Deep links               | `pumice://note/<id>` and universal links (later).                                                                                                                                                                       |

## UI

- `core.workspace` provides a **mobile layout**: one main pane with tab switcher, left/right drawers
  for sidebars (explorer, backlinks, outline), bottom command bar.
- **Editor toolbar** above the keyboard (formatting, `[[`, tag, checklist, undo/redo) —
  a contribution point so plugins can add actions.
- Views must support narrow widths; the plugin API exposes `workspace.layout`
  (`'desktop' | 'tablet' | 'phone'`) and layout change events.
- Touch targets ≥ 44pt, gestures (swipe for drawers, pull-down for quick switcher), haptics.
- CodeMirror 6 on mobile: verify IME/autocorrect, iOS selection handles, and live-preview widgets
  around the cursor (spike S1).

## Performance budget

- Cold start to editable note in < 1.5 s on a 3-year-old mid-range phone with a 5k-note vault
  (warm index).
- Keep at most a few documents loaded; unload views in background tabs.
- Excalidraw chunk loads only when a drawing is opened; embeds use cached SVG.
- iOS may kill the WebView process under memory pressure: workspace state and unsaved buffers
  must be restorable at all times (they are: debounced file writes + persisted CRDT state).

## Plugins on mobile

- Community plugins are loaded as JS into the WebView, same as desktop; plugins declaring
  `platforms: ["desktop"]` are hidden on mobile.
- App Store review: executing downloaded JavaScript in WebKit that doesn't change the app's primary
  purpose is permitted (Guideline 2.5.2 / 4.7 precedent — Obsidian ships community plugins on iOS).
  Still a policy risk to track.

## Collaboration on mobile

- Sync while the app is in the foreground; reconnect on resume. No background sync in v1 (iOS
  background execution limits); push-triggered background fetch later.
- Full replica on device (see [05](05-collaboration.md#replication)); a storage indicator and a
  "keep attachments offline" toggle cover large vaults until partial replicas exist.
