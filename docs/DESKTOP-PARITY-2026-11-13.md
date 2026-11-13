# Desktop parity integration checkpoint

This integrates public web source `6f38160ec757c47ba350f1434fd0378c6ce91331`
with desktop source `b018ccc1f3d7bec0009b3c71a21de302e94afc49` (merge base
`d1524f408ed4c749c656dc2e3ba4db6d0d617a11`). It is a **source integration**, not
an installed-app release or a claim of verified production parity.

## Scope

- Keep the current shared web navigation/chat, Library, Studio, Sketch, Project,
  schemas and hosted behavior while restoring the Electron/local runtime line.
- Keep local Settings and microphone/recorder behavior.
- Keep commercial recipe code behind the pinned private-module boundary.
- Harden the existing local runtime and privileged desktop boundaries before
  exposing user-selected files or a browser containing untrusted sites.

## Release blockers

1. Locked dependency installation failed with registry HTTP 403. Full
   typechecking, build, production runtime, real PGLite, provider, and packaged
   Electron checks have not run. Focused tests using mocks are not substitutes.
2. The desktop dependency still targets Electron 32, which embeds Node 20;
   the web application requires Node 22 or newer. Upgrade to a supported
   Electron release, regenerate the lockfile normally, and test the packaged
   runtime before release. Electron 32 is end-of-support:
   <https://www.electronjs.org/blog/electron-35-0>.
3. The public build intentionally uses recipe-marketplace stubs. Hosted recipe
   functionality requires the exact authorized private source pin. A public
   stub build must not be presented as commercial-feature parity.
4. No installed desktop or live hosted session was available for end-to-end
   comparison. Signing, publisher pins and release artifacts require current
   verification; older handoff documents are not proof.
5. Six large branding PNGs could not be materialized locally through the
   available source connector. They are preserved unchanged in the repository;
   local visual/package validation is incomplete.

## Verification meaning

`scripts/parity-check.mjs` checks source inventory and declared differences,
not behavior, successful inference, packaging or installation. The register
contains separate verification limits. Any source-inventory PASS must be
reported with those limits.

The dependency-free regression tests added for this integration exercise
page handlers, local database selection, desktop origin/lifecycle boundaries,
recipe boundaries and model-locality classification. Full `npm run verify`,
local runtime suites and packaged-app verification remain mandatory.

## Next phase, after parity validation

User-directed local file access is separate from fully offline AI. Read,
write and command capabilities need explicit, visible grants, revocation,
bounded scopes and clear operation previews. A whole-device grant must be
optional, never implicit. Local content must not silently become public or
leave the machine. Advocate may use the selected cloud provider; Lockdown
must block egress and require an explicit mode change or clearly disclosed
exception before any transmission. Open-mode licensing applies only to work
the user has rights to license, not arbitrary third-party attachments.

## Locality is not yet Lockdown

The chat loop's local-model preference is enforced across its inference calls,
but manual session summaries and runner inference still have separate policy
paths. Transcription, web search, music and image services are also independent
network capabilities. Automatic Honcho cloud-memory synchronization is now
disabled in both browser and server paths pending authenticated, scoped user
consent. Environment configuration or sign-in is not consent. This deliberate
privacy difference from the hosted baseline must not be called feature parity. This integration must not
be labeled an air-gapped or fully egress-blocked Lockdown implementation.
