# BeeZilla: ordered delivery roadmap

Updated 2026-11-13. This is an implementation plan, not a claim that pending features are shipped. Preserve the phase order below. Independent design and test preparation can proceed while an earlier acceptance gate is blocked.

## Current evidence

- Desktop reconciliation is in [draft PR #1](https://github.com/LockedWater305/agent-relay/pull/1), integration commit `b669b1bf119a0aac18d65e3cb0a823e4b2268135`. It brings the local-runtime branch onto current web source and adds targeted hardening. It is not merged, packaged, installed, or accepted as live parity.
- The minimal Honcho privacy hotfix is on main at `3bf15ce27a10e15e2533a5f659c42da07e9cfe36`, [PR #2](https://github.com/LockedWater305/agent-relay/pull/2). Browser hardcoded uploads were removed; server Honcho helpers remain disabled pending authenticated scoped consent. Database-backed history remains. This does not remove earlier remote copies.
- **Live deployment of that privacy fix is unverified.** Railway may belong to the hosting partner. Do not ask the repository owner to connect an account they do not control. Deployment verification needs the authorized service operator and the actual service/repository/commit mapping.
- Targeted checks passed: 27 desktop lifecycle/security, 12 UI parity, 65 runtime/start/assets, recipe boundary checks, endpoint/model-policy checks, and 11 Honcho privacy tests. The unpatched privacy negative control failed as expected. Syntax parsing of 143 TypeScript sources passed; this is not a typecheck.
- Full Node 22 install/typecheck/build/CI and real packaged Electron tests have **not** passed. Source inventory parity is not behavioral parity.

## Verified gates — 2026-11-13 (local Mac run)

Environment: macOS (Darwin 25.6.0, arm64), Node v26.7.0, npm 11.19.0 — **not** Node 22 and **not** GitHub CI; private recipe modules were stubbed (`STUB BUILD`), so these are public-build results. Statuses stay separate:

| Status | Desktop branch `beezilla/desktop-parity-20261113` |
|---|---|
| Source pushed | `6e246da` — packaging: `npm run pack:dir` (local unpacked, unsigned test build, `79b7770`) and an electron-builder `afterPack` hook that puts the runtime's production `node_modules` into every packaged build, the Windows installer included (`6e246da`); on top of `15ca075` — Electron 45.3.2 (bundled Node 24.22.2, verified from the binary) and electron-builder 26.18.0 on top of `d75d581` — integration `b669b1b` + fixes `a334acc`, `495cef6` + merge of GumbyEnder/agent-relay `main` at `3048d19` (79 newer web commits) + mailer typecheck fix + updated desktop tests |
| Checks on this Mac | `npm ci`, `npm run typecheck`, `npm run build`, `npm run test:desktop-boundaries` (parity 12/12, local boundary 65/65, LLM 7/7, private split 12, recipe boundary 41, desktop node tests 42/42) and `npm run test:ci` — all exit 0 on `d75d581` |
| GitHub CI | not run: Actions are enabled on the fork but no workflow run exists for this branch yet |
| Artifact built | local test builds only — `npm run pack:dir` writes an unpacked, unsigned `BeeZilla.app` (macOS arm64, 687 MB); `electron-builder --win dir --x64` cross-built on the Mac writes `win-unpacked` with the same 34,057 runtime library files. `npm run dist` (the signed Windows installer) still stops by design at the empty `publishers.json` (needs the production publisher key set). Found on the way: electron-builder's `extraResources` drops a top-level `node_modules`, so every earlier packaged build would have shipped a runtime that could not start — fixed by the hook. The Windows build uses the default Electron icon (no app icon set yet). |
| Installed behaviour | packaged smoke launch (macOS, `6e246da` unpacked app run directly): `packaged: true`, the runtime starts from `Contents/Resources/app` on 127.0.0.1:7331, `/buzzy/talk` and first-run `/buzzy/settings` load, clean exit 0 with no process or port left. Not yet tested: the Windows installer on Windows, chat with a real model, settings saves, runtime restart, a signed/notarised Mac build (the unsigned bundle's seal is broken by design, so a downloaded copy would be blocked by Gatekeeper) |
| Live | not applicable |

Found and fixed on the way: `desktop/package-lock.json` was missing 32 electron-builder entries (desktop `npm ci` failed with EUSAGE); `dist.mjs` measured size with GNU-only `du -sb` (macOS recorded 0 MB); the desktop lifecycle tests were flaky when run concurrently under load (now `--test-concurrency=1`); after the upstream merge the parity test followed upstream's renames (`index.html` → `library.html`, `/buzzy` redirect, nav rebuilt by `nav.js`) and the web build no longer prints voice diagnostics to every visitor's console.

Electron (phase 1, step 3) — **done in source** (`a7e632d`, `15ca075`): Electron 45.3.2 with Node 24.22.2; desktop-boundaries 42/42 and test:ci pass on it; the only code change the 33→45 breaking changes required was the `console-message` event object. Still to do before Electron 46: move the four `safeStorage.encryptString/decryptString` calls to the async API. Background: the old pin, Electron 32.3.3, bundled **Node 20.18.1** (read from the binary). From releases.electronjs.org: Electron 35 is the first major with Node 22 (22.16.0); 40+ bundle Node 24. The supported majors today are 43–45; the upgrade target is **45.3.2 (Node 24.22.2)**. npm 11 skips Electron's postinstall unless `allowScripts` permits it, and `extract-zip` stalls under Node 26 — use Node 22/24 for desktop installs or unzip the cached binary.

Phase 2 groundwork — **core done, not wired**: `desktop/capability-broker.mjs` (branch `beezilla/desktop-capability-broker`, draft PR LockedWater305/agent-relay#4): read-only per-folder grants that start switched off, activate/pause/resume/revoke, list/read/search confined to the granted folder (realpath containment, pinned root identity, `O_NOFOLLOW` reads), an activity log without search text; 33 tests, run inside `test:desktop-boundaries`. Known limits are listed in the file (hard links and mounted volumes inside a granted folder; Windows has no `O_NOFOLLOW`). The native folder picker, IPC and Settings controls are being built on top.

The hosted site's equivalent changes are separate pull requests into GumbyEnder/agent-relay (#288 music/3D auto-detect, #300 the roadmap's Talk workspace — now with the share dialog: Selected team vs Public link with QR code, a reading page for shared links and a join page for team invitations — and #301 the privacy hotfix); all pass the `verify` check and wait for the code owner's review; none is merged or live yet.

## 1. Finish Electron/web parity and establish a release baseline

1. Run the existing Node 22 CI on the exact integration commit; fix failures and repeat against each replacement commit.
2. Reconcile current web navigation, chat, Library, Studio, Sketch, Project, migrations and settings without restoring stale commercial modules or losing private-module boundaries.
3. Resolve Electron 32's embedded Node 20 versus the application's Node >=22 requirement through a supported dependency update and normal lockfile generation.
4. Test the packaged application on supported operating systems: startup, first-run settings, login interruptions, migration/data isolation, navigation, microphone repeated start/stop, runtime replacement, shutdown and failure recovery.
5. Compare the installed desktop against the actual current hosted build; record intentional differences. Public recipe stubs returning 503 are not commercial-feature parity.
6. Merge/release only after exact-commit checks and packaged acceptance. Verify the published artifact and running version separately from source publication.

**Dependencies/blockers:** This execution environment received HTTP 403 for npm tarballs, including https://registry.npmjs.org/zustand/-/zustand-5.0.14.tgz, and for shell Git checkout. The owner can open the npm URL; that does not resolve this environment's access. GitHub connector source operations work. Last Actions observations showed no runs; enablement/run evidence is pending. Only the cloud execution environment is connected, with no installed Electron test desktop. Private recipe source is `GumbyEnder/beezilla-recipes`, pinned at revision prefix `77724e64`; access must be authorized, not bypassed.

## 2. User-controlled offline local work

Depends on phase 1 acceptance. Design and test planning are prepared; implementation is pending.

1. Native selected-folder picker, read-only grants, explicit session activation, local list/search/read, visible activity, pause and revoke.
2. A main-process capability broker owns authority. Neither a model, webpage, recipe, file, AGENTS.md nor tool output can grant access. Prevent path traversal, symlink escapes, stale grants and time-of-check/time-of-use races.
3. Add optional whole-device scope only as an explicit choice with clear coverage and exclusions. It is not implicit credential access, privilege escalation, network-volume access or permission to upload.
4. Add edits with preview, content/version checks, atomic writes, conflict handling and undo.
5. Add commands with visible controls, platform-appropriate process containment, cancellation and descendant tracking. A working directory or timeout alone is not a sandbox.
6. Local files remain readable offline. Cloud AI is optional; sending selected content requires the selected mode and appropriate consent. Do not silently upload local attachments when sharing.

**Acceptance:** synthetic permission/adversarial tests, revoke during in-flight work, restart/stale-generation tests, real packaged filesystem tests, edit conflicts/undo and command cancellation. Never claim whole-device or network containment beyond tested platform behavior.

## 3. Three-bar workspace and Voice & Board

Depends on phase 2 capability foundation.

- Top voice/chat workspace, search bar, then Talk / Library / Memory / Experts / Recipes navigation.
- Prominent docked Talk to BeeZilla button in one-line input; no plus button; typing and file/image drag-and-drop.
- Active voice expands the workspace with live volume/transcription and a side-by-side whiteboard. Second click collapses it.
- Whiteboard supports file cards with type/title, four linking corners, node connections and search-to-attach on empty canvas.
- Every pop-up has close and minimize controls. Cover keyboard navigation, focus, accessibility, cancel/reopen and repeated interactions.
- Keep prompting/building above and browsing/inspiration below; validate light/dark layouts against the owner's visual references.

## 4. Search, browser, sharing and teams

- Built-in browser: Home, Back, breadcrumbs, URL and QR controls. Search replaces the bottom feed; Back returns to inspiration.
- Remember browser sign-ins and support operating sites on the user's behalf, subject to site/session scope and consequential-action permissions.
- Isolate remote pages from Node, file/command IPC and privileged sessions; test navigation and permission boundaries.
- Sharing presents an explicit **Public** versus **Selected team** choice. Creating team members and team editing are required. A share action must not automatically open private work to everyone.
- Define authenticated team access, edit roles, revocation, collaboration conflicts and URL/QR behavior. QR copying needs truthful clipboard success/failure feedback.
- Warn before changing a private work item's visibility. robots.txt/noindex is supplemental search indexing control, never private access control.

## 5. Privacy modes and inspiration

These boundaries apply throughout earlier phases, not only when this UI ships.

- Advocate is the local default and may send appropriately scoped content to the explicitly selected cloud model.
- Lockdown blocks egress where technically enforceable. Selecting cloud must require an explicit mode change or clearly disclosed exception; never silently transmit while claiming blocked. Cover runtime, renderer, model proxy, subprocess and cloud-mounted-file routes.
- Open is the cloud default and automatically publishes eligible user-owned session work under MIT. This is distinct from the sharing dialog's public/team choice. Do not silently relicense or publish imported/third-party material. Exact public fields, publication destination and revision behavior remain to be defined.
- Default inspiration is a Pinterest-style wall of finished work, tailored to explicit preferences. Private/Lockdown disables it.
- Cards drag by default, highlight board drop targets, and have separate similar-work and expand controls. Avoid inferring sensitive viewpoints without deliberate user choice.

## 6. Personal understanding, internal knowledge and live interface piloting

- Build rich understanding of individual circumstances so help fits the person, not generic defaults. Keep the local personal profile and learning on-device by default, with explicit distinction between local storage/processing and optional cloud transmission.
- Learn preferences, including willingness to spend, from interaction without requiring manual settings for everything. Mark inferred preferences as tentative, make them visible/correctable/deletable, and never turn them into purchase authorization or a higher spending limit.
- Income/circumstances require deliberate user choice, a clear helpful purpose, correction/deletion and privacy-mode controls. Do not covertly infer actual income, force disclosure or surveil third parties.
- Advocate's optional cloud model must disclose what selected profile/context leaves the device. Do not claim every local-mode configuration is fully offline. Lockdown blocks egress; retention and deletion behavior must be testable.


- Generate and verify a 200-question BeeZilla answer base from actual product/source behavior, with version/source references and limitations.
- Package it as a default skill; do not fabricate capabilities, active models or deployment status.
- Build observable UI actions so work mode actually executes authorized tasks rather than merely answering as chat.
- Show what is happening, teach through visible steps, and support cancellation, failure recovery and permission checks.

## 7. Whiteboard orchestration engine

- Node graph for explicit sequences: agent instructions, skill, model, execution, independent review and revision.
- Model selectors support exact versions and proposed latest/category/frontier policies. Evaluate the requested Arena source and its data/terms before relying on it.
- Support different-provider reviewers and comparable frontier-position selection, with reproducible selection evidence.
- Pinning a selected latest model for each run is a **recommendation, not yet an owner-final decision**.
- No imposed universal review-loop limit. Each workflow can configure its own stopping conditions, rounds and budgets according to context; display active usage and allow cancellation. Do not silently invent unlimited paid authority.
- Signed recipes establish integrity, not authority. Model selection must not override privacy, grants or data-sharing boundaries.
- Persist run state, provenance, resumability and audit evidence; test review disagreement, model unavailability, stale versions and interrupted runs.

## Delivery operating model

Requested structure: six Astra/max engineering lanes plus a coordinating project-manager lane. Keep responsibilities disjoint: desktop/security, runtime/storage, UI/accessibility, privacy/model routing, recipes/orchestration, and validation/release. The coordinator tracks phase dependencies, owner decisions, approvals, blockers and exact commits.

This structure is a target, not a claim that seven workers run continuously. A scheduled heartbeat can resume supported work; it cannot guarantee uninterrupted model execution. Do not duplicate workers or repeatedly retry unchanged access failures. Keep every checkpoint evidence-based.

## Remaining decisions and external handoffs

- Actual hosting partner/service operator must verify live deployment and source mapping; no assumption that this fork deploys the existing site.
- Supported desktop operating systems and packaged release acceptance environment.
- Public Open-mode artifact fields/destination/revision policy; third-party material exclusion behavior.
- Exact handling of local-file attachments when a board is shared.
- Model latest-version policy, including mid-run upgrades, remains open.
- Workflow-specific review stopping conditions are configurable, not universal.

Update this document when a gate is verified. Keep source pushed, CI passed, artifact released, installed behavior tested and live deployment verified as separate statuses.


## Owner-supplied visual references

[Four original images and inspected descriptions](references/beezilla/README.md) are now included. Originals were supplied as attachments after Imgur returned403; bytes are preserved and hashes recorded. The first image contains the active whiteboard and inspiration wall; the fourth is an existing Talk interface screenshot, not the inspiration mockup. Written requirements and later owner decisions take precedence over image labels.

## Hosted parity verification dependency

Verified read-only GitHub comparison on 2026-11-13: upstream `GumbyEnder/agent-relay` at `b7e8646ad2b55d80214ac28acdb521f1893d539d` is **80 commits ahead**, while fork main `3bf15ce27a10e15e2533a5f659c42da07e9cfe36` has **one unique commit**, the privacy hotfix. Common ancestor: `6f38160ec757c47ba350f1434fd0378c6ce91331`. This supersedes the earlier reported 79-commit/3048d191 observation. [Comparison](https://github.com/GumbyEnder/agent-relay/compare/LockedWater305:3bf15ce27a10e15e2533a5f659c42da07e9cfe36...GumbyEnder:b7e8646ad2b55d80214ac28acdb521f1893d539d).

Upstream changes include shared chat/navigation and multiple product pages, plus migrations 0055 and 0056. The desktop reconciliation's original fork baseline is therefore not proof of parity with upstream or a newer partner deployment.

The upstream `src/lib/buzzy/honcho.ts` at that exact revision still enables message synchronization solely when BZ_HONCHO_URL and BZ_HONCHO_KEY are configured; the fork's disabled-pending-consent implementation is not present there. This is a verified source distinction, **not evidence of what is currently running or configured in production**.

Before retargeting parity or deploying, reconcile the newer upstream changes and preserve the fork privacy fix, then obtain the actual running commit/service mapping from the authorized hosting operator. Do not overwrite partner work or deploy the older fork over a newer service. No upstream source was modified during this investigation.

## Desktop reconciliation checkpoint: 2026-11-13

PR #1 now includes partner updates through `6e246da19a3c118c56fdb6a6677635a3bb7c2cad` (including upstream through 3048d191, Electron 45.3.2, lockfile and packaged-runtime dependency fixes). Earlier Electron32/source-gap observations above are historical, not the current dependency state. Partner commit messages describe local builds; those claims are not substituted for independent acceptance here.

Verified source commit [9441642](https://github.com/LockedWater305/agent-relay/commit/94416422214ccf7568ca60f0cfbabb460a12de00) reconciles the remaining upstream b7e8646 speech-fallback change and fixes two reproduced lifecycle risks: pending transcription entering a different job after Stop/navigation, and overlapping diagnostic microphone requests leaking a stream. Exactly four files changed; partner packaging was preserved with an expected-head, non-force update. Portable regression suites are imported into the existing UI parity gate.

**84/84 focused Node/VM checks independently passed.** These use synthetic handlers, streams and requests, not real microphone/device/browser validation. Uploaded blob hashes match reviewed local bytes. Exact-head Actions query returned no runs. Full current-repository parity/privacy/build/typecheck and packaged acceptance remain unverified; the older local checkout lacks current surrounding assets. No deployment performed, and the actual hosted commit/configuration remains unknown. Upstream source was not modified.
