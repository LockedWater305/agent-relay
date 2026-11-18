/** NEW reconstruction after cloud rollback, NOT the original 4da86e0b... probe.
 * Event-model test, NOT native Electron input or navigation proof.
 * Run only after a separately frozen replacement supplies the documented
 * desktop/Sketch fixture APIs. No missing-fixture skips or baseline identity claim.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// CI integration of the NEW reconstructed scenario; the archived recovery file
// remains byte-identical. Root defaults to this source tree, never a lost tree.
const root = process.env.BZ_REVIEW_CANDIDATE_ROOT || fileURLToPath(new URL('..', import.meta.url));
process.env.BZ_SKETCH_ROOT = resolve(root);
const { desktop } = await import(pathToFileURL(resolve(root, 'scripts/test-desktop-sketch-transition.mjs')));
const { fixture, drain } = await import(pathToFileURL(resolve(root, 'scripts/test-sketch-save.mjs')));
const { createDocumentTransition } = await import(pathToFileURL(resolve(root, 'desktop/document-transition.mjs')));
const { createLibraryTransition } = await import(pathToFileURL(resolve(root, 'desktop/library-vault.mjs')));
assert.equal(typeof desktop, 'function'); assert.equal(typeof fixture, 'function'); assert.equal(typeof drain, 'function');
const clone = x => JSON.parse(JSON.stringify(x));
const gate = () => Promise.withResolvers();
async function bounded(p, label) {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 3000); })]); }
  finally { clearTimeout(timer); }
}
function mouse(wc, type, action, deliveries) {
  let prevented = false;
  wc.emit('before-mouse-event', { preventDefault(){ prevented = true; } }, { type });
  deliveries.push({ type, prevented });
  if (!prevented) action();
}
async function modeledMouseDraw(wc, p, deliveries) {
  mouse(wc, 'mouseDown', () => p.tools.find(el => el.getAttribute('data-tool') === 'rect').click(), deliveries);
  mouse(wc, 'mouseDown', () => p.el('board').dispatch('pointerdown', { clientX:25, clientY:30, pointerId:1 }), deliveries);
  mouse(wc, 'mouseMove', () => p.el('board').dispatch('pointermove', { clientX:160, clientY:170, pointerId:1 }), deliveries);
  mouse(wc, 'mouseUp', () => p.el('board').dispatch('pointerup', { pointerId:1 }), deliveries);
  await drain();
}

for (const sameFrame of [false, true]) for (const admittedBody of [false, true]) {
  test(`RECONSTRUCTED: retirement cannot exit with a fresh unsaved document (same frame=${sameFrame}, admitted body=${admittedBody})`, async t => {
    const f = await fixture(t), p = await f.mount(), d = await desktop(t, [f]);
    // A saved third mark isolates lifetime protection from initial drain. The
    // separate mandatory normal-Quit test must also omit this explicit Save.
    await p.draw(); await p.save();
    assert.equal(f.data().board.strokes.length, 3);
    assert.equal(f.posts().length, 1);
    const oldContext = f.h.context, oldDocument = f.h.document;
    const fresh = await fixture(t, clone(f.data().board));
    assert.notEqual(fresh.h.context, oldContext); assert.notEqual(fresh.h.document, oldDocument);
    const wc = d.main.webContents, originalFrame = wc.mainFrame, originalRuntime = d.runtime();
    const stopEntered = gate(), stopReleased = gate(), bodyReady = gate(), bodyReleased = gate();
    t.after(() => { stopReleased.resolve(); bodyReleased.resolve(); });
    const reads = [], input = [];
    fresh.transport = async req => {
      const policy = d.api.auth({
        url: `http://127.0.0.1:${originalRuntime.port}${req.url}`,
        webContentsId: wc.id, webContents: wc, frame: wc.mainFrame,
        resourceType: 'xhr', requestHeaders: {},
      });
      const authorized = !policy.cancel && policy.requestHeaders?.Authorization === `Bearer ${originalRuntime.token}`;
      reads.push({ method:req.method, allowed:authorized });
      if (!authorized) throw Error('Synthetic transport obeyed actual main auth/request rejection');
      // ONE authoritative SQL fixture: never let a new document silently use
      // the fresh fixture's independent seeded DB instead of the original.
      const response = await f.api(req.url, { method:req.method, ...(req.body ? {body:JSON.stringify(req.body)} : {}) });
      if (admittedBody && req.method === 'GET') {
        bodyReady.resolve();
        return { ok:response.ok, status:response.status, json:async () => { await bodyReleased.promise; return response.json(); } };
      }
      return response;
    };
    let page;
    if (admittedBody) {
      // Declared adapter seam: response admitted under the old live document,
      // held before body adoption; not a real browser navigation observation.
      page = await fresh.mount('job_board', {wait:false});
      await bounded(bodyReady.promise, 'Fresh response was not admitted before retirement');
      assert.equal(reads[0]?.allowed, true);
    }
    const supervisor = d.api.supervisor(), originalStop = supervisor.stop.bind(supervisor);
    supervisor.stop = async () => { stopEntered.resolve(); await stopReleased.promise; return originalStop(); };
    const quitting = d.quit();
    await bounded(stopEntered.promise, 'Quit did not reach the post-acquire runtime-retirement interval');
    assert.equal(d.didExit(), false); assert.equal(d.runtime(), originalRuntime);
    assert.equal(typeof d.main.useDocument, 'function', 'Fixture must replace the entire VM/document, not delete one nonce');
    d.main.useDocument(fresh, {sameFrame});
    assert.equal(wc.mainFrame === originalFrame, sameFrame);
    if (admittedBody) { bodyReleased.resolve(); await drain(); }
    else page = await fresh.mount();
    assert.equal(d.main.context, fresh.h.context);
    await modeledMouseDraw(wc, page, input);
    const unsaved = /Unsaved changes/.test(page.el('savedFlag').textContent);
    stopReleased.resolve(); await bounded(quitting, 'Quit did not finish after runtime release');
    const result = {sameFrame,admittedBody,reads,input,unsaved,exited:d.didExit(),stored:f.data().board.strokes.length,posts:f.posts().length};
    console.log(JSON.stringify(result));
    assert.equal(unsaved && d.didExit(), false, 'Retirement lost a reachable fresh-document draft');
    assert.equal(f.data().board.strokes.length, 3, 'No synthetic new input should be accepted while held');
    assert.equal(f.posts().length, 1, 'Retirement must not create a duplicate board save');
    if (admittedBody) assert.ok(input.every(x => x.prevented), 'Already-admitted body requires lifetime input protection');
    else assert.equal(reads[0]?.allowed, false, 'Fresh GET must be denied by the post-drain request seal');
  });
}

test('actual shell navigation/Back recovers a rejected late begin, then keeps the valid retry owned until release', async t => {
  const f = await fixture(t), page = await f.mount(), d = await desktop(t, [f]), wc = d.main.webContents;
  const execute = wc.executeJavaScript.bind(wc), admission = gate(); let delayed, first = true;
  wc.executeJavaScript = source => {
    if (first && source.includes('hook?.begin(nonce)')) {
      first = false; delayed = admission.promise.then(() => execute(source)); return delayed;
    }
    return execute(source);
  };
  t.after(() => { admission.resolve(); wc.executeJavaScript = execute; });
  const deps = { getContents: () => [wc], getBase: () => d.api.runtimeBase(), getRuntime: () => d.runtime() };
  const acquire = createDocumentTransition({ ...deps, timeoutMs: 10,
    acquireLibrary: createLibraryTransition({ ...deps, fetchImpl: () => { throw Error('No Library network expected'); } }) });
  await assert.rejects(acquire(), /timed out/); assert.equal(acquire.held(), false);
  assert.equal(vm.runInContext('Boolean(window.__bzDesktopDocumentLease)', f.h.context), false);
  f.h.heldFetches.add('/buzzy/sketch?job=job_other');
  const navigating = f.h.shell.go('/buzzy/sketch?job=job_other'); await drain();
  assert.equal(f.h.location.search, '?job=job_other'); assert.equal(page.stage.isConnected, true);
  admission.resolve(); await assert.rejects(delayed, /Sketch owner changed/); await drain();
  f.h.history.back(); await f.h.idle();
  f.h.requests.find(r => r.key === '/buzzy/sketch?job=job_other').resolve();
  assert.equal(await navigating, false); await drain(); assert.equal(f.h.location.search, '?job=job_board');
  // Measure expiration BEFORE retry: a successful retry must itself hold a new
  // nonce, not satisfy an oracle that accidentally forbids valid ownership.
  assert.equal(vm.runInContext('Boolean(window.__bzDesktopDocumentLease)', f.h.context), false);
  assert.equal(f.posts().length, 0); assert.equal(f.data().board.strokes.length, 2);
  const retry = await acquire();
  assert.equal(acquire.held(), true); assert.equal(page.el('save').disabled, true);
  const nonce = vm.runInContext('window.__bzDesktopDocumentLease.nonce', f.h.context);
  await drain(); assert.equal(vm.runInContext('window.__bzDesktopDocumentLease.nonce', f.h.context), nonce);
  await retry.release();
  assert.equal(acquire.held(), false); assert.equal(page.el('save').disabled, false);
  assert.equal(vm.runInContext('Boolean(window.__bzDesktopDocumentLease)', f.h.context), false);
  await page.draw(); await page.save();
  assert.equal(f.posts().length, 1); assert.equal(f.data().board.strokes.length, 3);
});
