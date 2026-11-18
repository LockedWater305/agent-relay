# Desktop parity acceptance checkpoint

Updated 2026-11-18. The owner’s priority is **local Electron parity with the
hosted UI first**, **optional user-directed local/device access next**, and
the broader UI/orchestration roadmap later. The initial integration combined
web source `6f38160ec757c47ba350f1434fd0378c6ce91331` with desktop source
`b018ccc1f3d7bec0009b3c71a21de302e94afc49`.

The current published desktop source is
`d297b6f1f137c081412fa35d8ec262fe4595b932`, tree
`c7e41162902a2e370041e3a1aeda67da296dc9bd`, on
[`beezilla/desktop-parity-20261113`, draft PR #1](https://github.com/LockedWater305/agent-relay/pull/1).
The branch and PR head were read back on 2026-11-18. This is a source checkpoint;
current installed-app parity and the live hosted revision remain unverified.

The [machine-readable inventory](parity/phase-one-acceptance.json) records exact
identities, evidence locators, gate dependencies and acceptance criteria. Its
private-packet references identify retained receipts; this update did not rerun
their tests or their full source/build/package hash comparisons.

## Phase-one scope

Preserve the shared navigation/chat, Talk approval flow, Library, Studio, Sketch,
Project, schemas and hosted behavior while validating the Electron local runtime.
Include local Settings, microphone/recorder behavior, original-file denial and
document export in the eventual applicable UI matrix. Match the actual pinned
hosted revision when comparison becomes permitted; source inventory and page
markers alone do not establish behavior or successful inference.

## Current parity matrix

| ID | Area | Retained evidence | Current limit / next gate |
|---|---|---|---|
| M01 | Published server/export | Exact `d297b6f1` source accepted. The retained run has 96 signed-session HTTP cases, 104 passing assertions, complete 73-table deltas and exact final/reopen equality. | Acceptance is limited to the frozen source/build/fixtures, not installed Library/Talk behavior. Preserve it; review changed bytes before choosing extra proof. |
| M02 | Hosted source CI | [Run 44113981765](https://github.com/LockedWater305/agent-relay/actions/runs/44113981765) checked out `d297b6f1`: install, typecheck, build and required tests passed on Ubuntu 26.04 / Node 22.23.4 / npm 10.9.9. | 1,912 passed, four PDF-tool-dependent skips, zero failures. Advisory lint exited 1: 70 errors, 115 warnings. This result does not cover unpublished candidates or native/endpoint acceptance. |
| M03 | Electron / embedded Node | Published lock: Electron 45.3.2, electron-builder 26.18.0; root engine remains Node >=22. Retained old native log: Electron 45.3.2 / Node 24.22.2. | The Electron 32 / Node 20 warning is obsolete. A future package must record its own binary/version/architecture receipt; no new version upgrade is implied. |
| M04 | Retained shell/package | Earlier tree `5685a005` has 179/179 accepted finite native checks. All 12 retained ASAR shell modules were independently matched to `d297b6f1`. | Generated ASAR metadata and the complete current runtime/package have not been accepted. Old native checks stay attached to the old artifact. |
| M05 | Current build versus old package | Of 180 accepted current build paths: 166 identical, 13 changed, one missing; one old extra path. Ten SSR changes are comments; other metadata differences include build date and manifest references/paths. | `server/index.mjs` has newer canonical-export/decision handlers. Preserve every exact hash and the matching manifest graph. Metadata classification is not byte equality or current package acceptance. |
| M06 | Package inputs | Audit found 92 source public files, 67 migrations, eight runtime scripts and 475 installed package metadata records: no required metadata misses, 31 legitimate optional omissions. | Generated public-stub inputs, complete isolated dependency/tool/cache custody and a new staged package remain missing. Counts are historical observations, not a future package allowlist. |
| M07 | Resolver/staging repair | Unpublished tree `7831d6c8` has source review PASS. It anchors money-check assets to the module layout and fails closed on required metadata, partial copies and missing PGlite payloads. Its 63 pure fixture tests passed on Node 24.22.1. | The static audit did not establish an installed-package failure. Exact-candidate Node22 CI, emitted-loader integration and package/native acceptance remain open. |
| M08 | Disabled emitted-money proposal | Separate tree `b0be7c53` has static/pure-control review PASS; 18 pure controls passed on Node 24.22.1. Workflow remains literally disabled. | No endpoint execution. The proposal covers only missing/wrong token and authenticated wrong amount. Match, emitted missing/deceptive assets and the broader integration gate remain open. |
| M09 | Honcho privacy stream | Separate unpublished reconciliation tree `34dcfdc3` has source review PASS and 15 privacy controls passing on Node 24.22.1. | This is a separate upstream integration, not a package or served-revision receipt. Future publication needs fresh refs and permitted final-commit CI. It does not replace the desktop gates. |
| M10 | Current installed UI/lifecycle | Retained native receipts are finite and belong to the old package; no complete current-head native/hosted comparison has been accepted. | Current package custody, permitted ownership/lifecycle preflight, normal start/Quit/closed reopen and changed-function UI evidence remain required. |

The 2026-11-18 pure lane totaled **96/96** (63 resolver/staging + 18 proposal
controls + 15 Honcho). Both old money-loader negative controls failed their two
selected cases as expected; the guard recorded zero forbidden-operation attempts.
These are Node **24.22.1** results, separate from the historical hosted Node22 run.
The three unpublished trees are independent freezes, not one integrated candidate:

| Candidate | Exact tree |
|---|---|
| Resolver/staging | `7831d6c81581c94494974a0ee1b6430b82db974e` |
| Disabled emitted proposal | `b0be7c53f1464720fd4098bd22ee4c9420f39423` |
| Honcho reconciliation | `34dcfdc39cca076fbc8f9d5250de73ee1101494e` |

## Remaining gates and executable work

1. **Review/preparation now (`G01`).** Review this docs diff and inventory;
   prepare a bounded changed-byte-to-case specification from retained receipts.
   Read-only source/ref inspection and pure synthetic checks remain permitted
   when they answer a new question. Do not replay completed 179/96 campaigns
   or hash all retained artifacts again just to refresh timestamps.
2. **Runtime and CI prerequisites (`G02`–`G04`).** The official Node22.23.5
   acquisition stopped on `curl: (6) Could not resolve host: nodejs.org`, before
   any checksum/archive bytes or execution. Do not retry through another route.
   Runtime acquisition needs the external capability resolved and a permitted
   next action. The reviewed successor still needs exact-candidate typecheck,
   build and full required tests on Node22. Historical Node26 partial validation
   and Node24 pure tests do not close that gate. Resolve operational scope before
   any push/dispatch: normal CI includes listeners, child processes, timeout
   signals and native PDF probes. For the normal hosted branch route, resolve
   scope (`G03`), review and publish the exact source (`G16`), then collect its
   final-commit CI receipts (`G04`). Emitted endpoint acceptance remains `G05`;
   neither future receipt is a prerequisite for that guarded source publication.
   Do not relocate a denied host operation.
3. **Emitted-loader integration (`G05`).** After separately permitted build and
   execution, bind actual output, dependencies and `import.meta.url` layout.
   The disabled three-request proposal is limited preliminary coverage. A
   separately reviewed plan must account for matching amounts and missing or
   deceptive emitted assets under unrelated CWD. No CWD/ancestor-search fallback
   or disabling the frozen guard is authorized by this document.
4. **Package closure and preflight (`G06`–`G08`).** Freeze the chosen reviewed
   source, generated stub inputs, complete build/module graph, dependencies,
   three PGlite payloads, public assets/migrations/scripts, CSP, ASAR including
   generated `package.json`, native distribution/cache and package metadata.
   Do not rely on the unsupported `sync-private --public` flag or silently
   discover private source. The earlier pilot plan predates the resolver repair;
   its source identity must be explicitly reconciled before a future pilot.
   The denied `/bin/ps` preflight produced no process inventory; loopback listen
   also returned EPERM. Their enforcement layer/scope is unknown. The build-only
   pilot needs an externally resolved contract for its isolated namespace,
   build-tool child processes and normal completion, alongside its input and
   validation gates. Native current-host ownership/live-process preflight is
   separately `G07`, required before native execution (`G09`). These denials do
   not establish a universal build/CI prohibition; this assignment still permits
   no build, package or launch. No retry, substitute inspection, escalation,
   settings change or moved execution is authorized here. A bounded, reviewed
   offline unsigned package pilot requires its own permitted build-only contract;
   it does not close the native preflight.
5. **Native and hosted comparison (`G09`–`G10`).** Bind the resulting package
   to its exact bytes and test normal startup, applicable local UI/read-only
   behavior, normal Quit and closed reopen under a reviewed finite contract.
   Add functional cases based on changed package bytes and observed gaps.
   Compare against an identified hosted revision and record deliberate privacy
   differences. No live session, device permission or provider credential is
   required merely to finish the static preparation now.
6. **Conditional claims (`G11`–`G15`).** Windows, real-provider/media paths,
   private commercial modules, PDF-tool-dependent cases, hosted PostgreSQL
   multi-session concurrency and signing/publisher trust require their own
   evidence before the corresponding claims or release. They are not satisfied
   by a Mac public-stub pilot. Scope private/provider access only when that gate
   is reached. Ordinary source-publication authorization already exists; no
   duplicate approval is needed, but unresolved automatic-CI effects still block
   a push (`G16`). The separate Honcho integration remains `G17`.

The initial registry HTTP403 and six-PNG connector materialization failures are
historical: later retained source custody and exact-commit CI superseded those
blanket “full checks have not run” statements. Local visual validation and a new
complete package still need proof. Neither source CI nor a package-only result
proves the currently served hosted revision.

## Acceptance boundaries

The accepted export fixtures exercise md/pdf/docx/csv, permitted account roles,
refusals, version/null behavior and original-file denial. DOCX normalization is
limited to the reviewed bounded timestamps; other ZIP payloads remain exact.
Transaction-local single-PGlite probes and their restoration do not establish
hosted multi-session concurrency. Raw credentials, DB snapshots and private
runtime logs stay in retained evidence, not this repository proposal.

`scripts/parity-check.mjs` and the [function register](parity/PARITY.md) remain
source-inventory tools. Their historical totals cannot certify present UI,
inference, installation, release or deployment. The public build uses recipe
stubs; commercial parity needs the exact authorized private pin. No current
package failure or native parity is inferred solely from the static defects.

## Later phases

After phase-one parity, optional local file/device access needs explicit visible
grants, bounded scopes, operation previews and revocation. Whole-device access
must remain optional. The later UI/orchestration roadmap is deferred (`G18`–`G19`).

Local-model preference is not a complete Lockdown policy: summaries, runners,
transcription, search, music and image providers have separate paths. Automatic
Honcho synchronization is disabled in the desktop source pending authenticated,
scoped consent; environment configuration or sign-in is not consent. DB-backed
history remains legitimate. This deliberate privacy difference must be recorded
when comparing hosted behavior, and does not imply deletion of transmitted
copies or fully blocked egress. Licensing applies only to work the user has
rights to license, not arbitrary third-party attachments.
