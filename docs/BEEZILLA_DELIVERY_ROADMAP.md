# BeeZilla: ordered delivery roadmap

Updated 2026-11-13. This is an implementation plan, not a claim that pending features are shipped. Preserve the phase order below. Independent design and test preparation can proceed while an earlier acceptance gate is blocked.

## Current evidence

- Desktop reconciliation is in [draft PR #1](https://github.com/LockedWater305/agent-relay/pull/1), integration commit `b669b1bf119a0aac18d65e3cb0a823e4b2268135`. It brings the local-runtime branch onto current web source and adds targeted hardening. It is not merged, packaged, installed, or accepted as live parity.
- The minimal Honcho privacy hotfix is on main at `3bf15ce27a10e15e2533a5f659c42da07e9cfe36`, [PR #2](https://github.com/LockedWater305/agent-relay/pull/2). Browser hardcoded uploads were removed; server Honcho helpers remain disabled pending authenticated scoped consent. Database-backed history remains. This does not remove earlier remote copies.
- **Live deployment of that privacy fix is unverified.** Railway may belong to the hosting partner. Do not ask the repository owner to connect an account they do not control. Deployment verification needs the authorized service operator and the actual service/repository/commit mapping.
- Targeted checks passed: 27 desktop lifecycle/security, 12 UI parity, 65 runtime/start/assets, recipe boundary checks, endpoint/model-policy checks, and 11 Honcho privacy tests. The unpatched privacy negative control failed as expected. Syntax parsing of 143 TypeScript sources passed; this is not a typecheck.
- Full Node 22 install/typecheck/build/CI and real packaged Electron tests have **not** passed. Source inventory parity is not behavioral parity.

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

Background research reports this fork behind upstream `GumbyEnder/agent-relay` (reported upstream revision prefix `3048d191`). Verify the full current upstream and actual running commit with the authorized hosting operator before declaring hosted parity or deploying. The original reconciliation baseline is this fork's recorded source, not proof of parity with a newer partner deployment. Do not overwrite a newer partner deployment with this fork without resolving that difference.
