# 08 — Roadmap, risks & open questions

v1 = desktop + mobile + collaboration + Excalidraw. That's a large scope, so the order below
builds the architecture for everything early (Yjs documents, platform abstraction, codecs) and
delivers features in layers. Each milestone ends with something usable on **both** desktop and
mobile.

## Phase 0 — Spikes (de-risk before committing)

Each spike produces a short write-up in `docs/spikes/` and either confirms or changes a decision.

| #   | Spike                     | Question                                                                                                         | Pass criteria                                                                                                                     |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Engine performance        | Do CM6 live preview and Excalidraw perform on Electron (Linux/macOS/Windows), iOS WKWebView and Android WebView? | 1 MB note: typing latency < 16 ms p95; Excalidraw 5k elements: pan/zoom ≥ 45 fps on target phones; IME and selection work on iOS. |
| S2  | File ↔ Yjs reconciliation | Does the FileProvider three-way merge stay correct under concurrent editor, external and remote edits?           | Fuzz test (random edits from editor, disk, 2 remote peers) converges with no lost edits over 100k iterations.                     |
| S3  | Dual-parser parity        | Can Lezer and micromark extensions for wikilinks/ID links/embeds/callouts/comments/highlights agree?             | Conformance runner green on CommonMark + GFM + 200 dialect cases.                                                                 |
| S4  | Mobile fs + index         | How fast are scan and index with `PumiceFs` + SQLite-WASM/OPFS?                                                  | 10k files: warm open < 1 s, cold index < 30 s on a mid-range phone; no OPFS persistence issues in Capacitor.                      |
| S5  | Excalidraw on Yjs         | Does element-level LWW + fractional index merge well? Does `.excalidraw.md` round-trip?                          | Two clients + offline edits converge; fixtures from the Obsidian plugin round-trip byte-identical.                                |
| S6  | Plugin host               | Is the kernel/service/activation model ergonomic?                                                                | Kernel + 3 plugins (one replacing another's service), lazy activation, hot reload.                                                |

## Milestones

> Status (2026-11-01): M0–M6 implemented; see the root README for what was verified and the
> remaining gaps (mobile native builds, store submission, signing, SMTP/OIDC, E2EE).

| Milestone                  | Contents                                                                                                                                                                                                                    | Exit criteria                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 Foundations**         | Monorepo, CI (lint, typecheck, unit, conformance, desktop e2e, mobile e2e on simulators/emulators), kernel, `@pumice/api` skeleton, `platform-*` impls, spikes done                                                         | Empty app boots on all platforms through the plugin host; spike decisions recorded.                                                                        |
| **M1 Editing core**        | core.vault, core.documents (FileProvider + markdown codec), core.markdown (CommonMark/GFM/frontmatter), core.editor (live preview), core.workspace (desktop + mobile layouts), explorer, switcher, palette, settings, theme | Usable for plain notes on desktop and phone; external edits merge correctly.                                                                               |
| **M2 Linking & knowledge** | Full dialect, ID links + suggester, IDs & move detection, core.index, backlinks, outline, tags, properties, search, reader view, embeds, rename handling                                                                    | Conformance suite green; a real Obsidian vault (≥ 5k notes) opens and renders correctly; perf targets from [04](04-vault-identity-index.md#lifecycle) met. |
| **M3 Excalidraw**          | core.excalidraw local: view/edit, both formats, embeds, links, index integration, export                                                                                                                                    | Obsidian Excalidraw vault drawings open, edit and round-trip.                                                                                              |
| **M4 Ecosystem**           | plugin-cli, API docs, example plugins, install from folder/URL, templates, daily notes, graph, CSS snippets                                                                                                                 | A third-party developer builds a plugin from the docs alone.                                                                                               |
| **M5 Collaboration**       | Server, accounts, shared vaults (manifest, docs, blobs), presence, history, Excalidraw collab, E2EE decision implemented                                                                                                    | Two users edit the same notes and drawings live across desktop and mobile, including offline periods, with no data loss.                                   |
| **M6 Beta hardening**      | 50k-note perf, Obsidian import report, accessibility, packaging/signing/auto-update, App Store and Play submission, crash reporting (opt-in)                                                                                | Public beta.                                                                                                                                               |

Post-v1: Obsidian compatibility shim, plugin registry with signatures, sandboxed plugins, partial
replicas, per-folder sharing, web client, publishing.

## Testing strategy

- **Unit**: Vitest across packages; kernel and services tested against `platform-memory`.
- **Conformance**: markdown fixtures, both parsers ([03](03-markdown-dialect.md#conformance-suite-packagesmarkdown-spec)).
- **Property / fuzz tests**: CRDT convergence, file reconciliation, link resolution, ID duplicate
  handling, path-collision resolution — simulated multi-client runs in CI.
- **E2E desktop**: Playwright driving Electron.
- **E2E mobile**: WebdriverIO + Appium on iOS simulator and Android emulator (Playwright can't
  drive WKWebView).
- **Performance**: generated fixture vaults (1k / 10k / 50k notes, large drawings); startup, index,
  typing latency and memory tracked per commit with regression alerts.
- **Compatibility**: corpus of real-world Obsidian vaults (with permission / generated) opened in
  CI; diffs in rendering reviewed.

## Risks

| Risk                                                      | Impact                           | Mitigation                                                                                                                  |
| --------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Scope (desktop + mobile + collab in v1)                   | Late or shallow v1               | Layered milestones; collab architecture early, features late; cut partial replicas, per-folder sharing, sandboxing from v1. |
| Files + CRDT as dual representation                       | Lost or duplicated edits         | Spike S2 fuzzing; conflict copies instead of silent overwrite; history on server.                                           |
| Parser drift between Lezer and micromark                  | Editor and reading view disagree | Paired syntax registration; conformance suite in CI.                                                                        |
| Mobile filesystem and WebView limits                      | Slow startup, killed processes   | Native `PumiceFs`; index cache; restorable state; S4.                                                                       |
| Excalidraw API/format churn (library and Obsidian plugin) | Breakage on upgrade              | Pinned version, adapter module, fixture round-trip tests.                                                                   |
| App Store policy on downloaded plugin code                | Mobile plugins blocked           | Follow Obsidian precedent; feature-flag community plugins on iOS.                                                           |
| Plugin API locked in too early                            | Painful breaking changes         | `@pumice/api` 0.x until M4; core plugins as API dogfooding.                                                                 |
| E2EE complexity                                           | Delays M5                        | Decide early; envelope designed for it from M0.                                                                             |

## Open questions

1. **E2EE** for collaboration: required from day one or after the first beta? ([05](05-collaboration.md#end-to-end-encryption))
2. **Hosting model**: self-host only, an official hosted service, or both? Affects accounts, billing, ops.
3. **License**: open source (which license?) or source-available? Affects plugin ecosystem and contributions.
4. **Note title**: filename only (Obsidian) or optional `title` property overriding it? (Plan assumes filename, with optional `title`.)
5. **Sharing granularity** after v1: per-folder shares, per-note links, public read-only publishing?
6. **Obsidian compat shim** depth: which top-N community plugins must run?
7. **Accessibility and i18n** targets for v1.
