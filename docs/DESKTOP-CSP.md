# Desktop script policy

The Electron product windows receive an enforced Content Security Policy. The
shared hosted web renderer and HTTP server do not change. The account-connect
window uses a separate session and does not receive the desktop policy.

## What is allowed

- Only the exact bundled `/buzzy/*.js` files referenced by the app, at the current
  loopback runtime's origin. There is no script `'self'`, directory, wildcard,
  `https:`, `data:` or `blob:` allowance.
- SHA-256 hashes of the bundled inline scripts and the exact batches generated
  by the existing soft-navigation shell. Arbitrary inline scripts, inline event
  handlers, `eval`, string timers and `Function` are not authorized.
- Existing CSS, image, font, audio and connection behavior is intentionally
  unchanged. This patch does not introduce `default-src`, `style-src` or
  `connect-src`. Inline CSS is **not** an inline-JavaScript exception.
- Objects, frames, embedding the app, and changing its base URL are blocked.

The same approved script hashes are available across the app's pages because
soft navigation keeps one document alive. This is defense in depth, not a claim
that the app is immune to XSS or that every resource now has an allowlist.

## Build and packaged layout

`npm run build` creates `.output/desktop-csp.json` after Vite finishes. The
desktop staging command invokes the same generator explicitly, because it runs
Vite directly rather than through npm's lifecycle hooks. The manifest is copied
inside the staged runtime's `.output`; the runtime policy module ships in
`app.asar`. The generator and its VM are build/test-only and do not ship in the
shell.

The generator reads the known app pages and exact external scripts from both
`public/buzzy` and `.output/public/buzzy`. Both copies must be byte-identical:
extensionless pages and static `.html` aliases can use different serving paths.
It records their digests. HTML newline normalization is applied when hashing
inline script text, so CRLF checkouts produce the hashes Chromium evaluates.

To avoid maintaining a second batching algorithm, the generator extracts the
existing `nav.js` `runScripts` function and runs **that function only** against
an inert DOM adapter. The adapter captures emitted script strings, never
executes them or fetches external scripts. The bounded HTML tokenizer rejects
unsupported script/parser states. Changes to its assumptions must be reviewed,
not worked around by allowing unsafe script execution.

`nav.js` must be trusted repository build input. This `node:vm` adapter is
**not a security sandbox**: its host callbacks can expose host capabilities to
modified navigation code despite disabled string code generation. Never run
untrusted or user-supplied navigation code through it.

At desktop startup both served file trees are checked against the manifest.
A missing/stale manifest or source mismatch stops startup with a rebuild or
reinstall message. It never falls back to no policy. Run `npm run build` after
changing bundled HTML/JS; a bare `npx vite build` does not run npm's postbuild.
These checks prevent accidental source/build drift, not malicious modification
of an installation. They are not a substitute for release signing.

## Response boundary

The response hook operates only on registered product windows, known app-page
main frames, and exact runtime origins established at the request-auth boundary.
Each document request is bound to its request id, URL, registered window, and
runtime token generation. A response is canceled if that runtime stops or is
replaced, including a same-port restart. Product documents at previously
authenticated origins are canceled if no matching current authorization exists;
the stop/restart gap never accepts them without CSP. Arbitrary other loopback
ports are not treated as product origins. Completion/error events discard
request records. API responses, downloaded assets (including their existing
sandbox CSP), subframes, remote requests and synthetic file-based test pages
are untouched. Existing enforced CSP values are retained and the desktop
policy is appended, so policies intersect rather than replacing one another.
No Electron security warning is suppressed.

## Verification

Run `node --test scripts/test-desktop-csp.mjs` for portable checks covering
manifest generation, real shell batching, source/build drift, policy contents,
GET/HEAD and `.html` routes, existing headers, window/frame/origin scope,
runtime restarts, and build/package wiring. This suite is included in
`test:desktop-boundaries`.

Portable tests do not prove Chromium enforcement or native UI parity. Before
shipping, build the exact candidate and test it in native Electron:

1. Inspect the final Talk and Settings main-document response headers, including
   a fresh loopback port after restart. Check `.html` aliases as well.
2. Verify hard loads, repeated Talk → Library → Memory → Talk navigation,
   Back/Forward, the Ask panel, Settings, and cached Talk state. Collect
   `securitypolicyviolation` events and unexpected console errors.
3. In a disposable test profile, prove that unapproved inline scripts, inline
   event handlers and `eval` are blocked, while approved scripts still execute.
4. Confirm asset downloads keep their sandbox policy and account-connect
   responses are not rewritten. Do not use real credentials/provider calls for
   these security probes.

Absence of Electron's development warning alone is not a passing security test.
