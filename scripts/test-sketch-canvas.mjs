/**
 * Canvas sizing contract + exact production resize/redraw/pt functions.
 * The Node geometry adapter is deliberately NOT a browser layout engine.
 * --write-fixture PATH emits an offline, CSP-hashed real-browser fixture using
 * the same source CSS/functions; native/browser measurements remain required.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = process.env.BZ_CANVAS_ROOT || new URL('..', import.meta.url);
const sourcePath = root instanceof URL ? new URL('public/buzzy/sketch.html', root) : resolve(root, 'public/buzzy/sketch.html');
const html = readFileSync(sourcePath, 'utf8');
const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
assert.ok(style, 'use actual source stylesheet');
function productionFunction(name) {
  const match = html.match(new RegExp('^    function ' + name + '\\([^]*?^    }', 'm'));
  assert.ok(match, `actual ${name} function exists`);
  return match[0];
}
const functionNames = ['resize', 'pt', 'redraw', 'drawStroke', 'anchorPoint'];
const functions = functionNames.map(productionFunction).join('\n');
const boardRule = style.match(/#board\s*\{([^}]+)\}/)?.[1];
assert.ok(boardRule, 'actual canvas CSS rule');
const properties = Object.fromEntries(boardRule.split(';').filter(part => part.includes(':')).map(part => part.split(':').map(v => v.trim())));
const seed = [
  { id: 'seed_line', tool: 'line', color: '#ffd40d', width: 3, x1: 80, y1: 90, x2: 300, y2: 160 },
  { id: 'seed_note', tool: 'text', color: '#ffffff', x1: 85, y1: 65, text: 'Synthetic saved note' },
];
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');

function model(dpr, rect) {
  const state = { rect: { ...rect }, transform: null, paths: [] };
  const stage = { getBoundingClientRect: () => ({ ...state.rect }) };
  const canvas = {
    width: 300, height: 150,
    getBoundingClientRect() {
      // Explicitly model only the two contracts being compared: responsive
      // percentage dimensions, or the inherited auto/intrinsic replaced size.
      const width = properties.width === '100%' ? state.rect.width : this.width;
      const height = properties.height === '100%' ? state.rect.height : this.height;
      return { left: state.rect.left, top: state.rect.top, width, height, right: state.rect.left + width, bottom: state.rect.top + height };
    },
  };
  const ctx = new Proxy({
    setTransform: (...values) => { state.transform = values; },
    moveTo: (x, y) => state.paths.push(['move', x, y]),
    lineTo: (x, y) => state.paths.push(['line', x, y]),
  }, { get: (object, key) => object[key] || (() => {}) });
  const context = vm.createContext({ canvas, stage, ctx, window: { devicePixelRatio: dpr }, scale: 1, strokes: clone(seed), draft: null, selectedStroke: null, color: '#ffd40d' });
  vm.runInContext(functions, context, { filename: 'actual-sketch-canvas-functions.js' });
  return { context, canvas, stage, state, resize: () => vm.runInContext('resize()', context), point: e => context.pt(e) };
}

function browserFixture() {
  const script = `
${functions}
var stage = document.getElementById('stage'), canvas = document.getElementById('board');
var ctx = canvas.getContext('2d'), scale = 1, strokes = ${JSON.stringify(seed)}, draft = null, selectedStroke = null, color = '#ffd40d';
var samples = [], errors = [], sourceIdentity = ${JSON.stringify({ style_sha256: hash(style), functions_sha256: hash(functions) })};
window.addEventListener('error', function(e) { errors.push(e.message); });
window.addEventListener('securitypolicyviolation', function(e) { errors.push('CSP: ' + e.violatedDirective); });
function rectOf(el) { var r = el.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; }
function measure(label) {
 var stageRect=rectOf(stage), canvasRect=rectOf(canvas), css=getComputedStyle(canvas), transform=ctx.getTransform();
 var client={clientX:stageRect.left+stageRect.width*0.7,clientY:stageRect.top+stageRect.height*0.75};
 var point=pt(client); strokes.push({id:'fixture_'+label,tool:'pen',color:'#6ee7a8',width:4,points:[point,{x:point.x+12,y:point.y+8}]}); redraw();
 return {label:label,dpr:devicePixelRatio,viewport:{innerWidth:innerWidth,innerHeight:innerHeight,outerWidth:outerWidth,outerHeight:outerHeight,visual:visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}:null},stage:stageRect,canvas:canvasRect,bitmap:{width:canvas.width,height:canvas.height},computed:{width:css.width,height:css.height,position:css.position,inset:css.inset,transform:css.transform,zoom:css.zoom},contextTransform:{a:transform.a,d:transform.d,e:transform.e,f:transform.f},pointer:{client:client,logical:point},strokes:JSON.parse(JSON.stringify(strokes))};
}
function next() { return new Promise(function(resolve) { requestAnimationFrame(function() { requestAnimationFrame(resolve); }); }); }
(async function() {
 resize(); if(window.ResizeObserver) new ResizeObserver(function() { resize(); }).observe(stage);
 await next(); samples.push(measure('initial'));
 var initial=rectOf(stage); stage.style.flex='none'; stage.style.width=(initial.width*0.73)+'px'; stage.style.height=(initial.height*0.67)+'px';
 await next(); samples.push(measure('resized'));
 stage.style.flex=''; stage.style.width=''; stage.style.height='';
 await next(); samples.push(measure('restored'));
 document.getElementById('canvasEvidence').textContent=JSON.stringify({kind:'actual browser CSS/canvas measurements; synthetic fixture input, not native trusted UI or persistence',source:sourceIdentity,samples:samples,errors:errors});
 document.documentElement.dataset.canvasReady='true';
})().catch(function(e) { errors.push(String(e)); document.getElementById('canvasEvidence').textContent=JSON.stringify({errors:errors}); document.documentElement.dataset.canvasReady='error'; });
`;
  const digest = value => createHash('sha256').update(value).digest('base64');
  const csp = `default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'sha256-${digest(style)}'; script-src 'sha256-${digest(script)}'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Offline Sketch canvas sizing fixture</title><style>${style}</style></head><body><header>Offline Sketch canvas sizing fixture. Synthetic marks only.</header><div id="stage"><canvas id="board"></canvas><div id="layers"></div></div><footer>Actual canvas CSS and drawing functions; no API, provider or media requests.</footer><pre id="canvasEvidence" hidden></pre><script>${script}</script></body></html>`;
}

const emit = process.argv.indexOf('--write-fixture');
if (emit >= 0) {
  assert.ok(process.argv[emit + 1], 'supply an output HTML path');
  const target = resolve(process.argv[emit + 1]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, browserFixture());
  console.log(JSON.stringify({ output: target, bytes: Buffer.byteLength(browserFixture()), sha256: hash(browserFixture()), sourcePath: String(sourcePath) }));
} else {
  test('canvas CSS explicitly separates responsive display size from bitmap size', () => {
    assert.equal(properties.position, 'absolute');
    assert.equal(properties.inset, '0');
    assert.equal(properties.width, '100%', 'inset alone does not stretch an auto-sized replaced canvas');
    assert.equal(properties.height, '100%', 'CSS height must not follow the DPR-sized bitmap');
    assert.match(style, /#stage\s*\{[^}]*overflow:hidden/);
  });
  for (const dpr of [1, 1.25, 1.5, 2]) {
    test(`actual backing-store and transform at DPR ${dpr} keep stored logical coordinates unchanged`, () => {
      const m = model(dpr, { left: 0, top: 155, width: 1168, height: 442.5 });
      for (const size of [[1168, 442.5], [919.5, 380.25], [1042.75, 509.5]]) {
        [m.state.rect.width, m.state.rect.height] = size;
        m.resize();
        assert.equal(m.canvas.width, Math.max(1, Math.round(size[0] * dpr)));
        assert.equal(m.canvas.height, Math.max(1, Math.round(size[1] * dpr)));
        assert.deepEqual(m.state.transform, [dpr, 0, 0, dpr, 0, 0]);
        assert.deepEqual(clone(m.context.strokes), seed);
      }
    });
    test(`DPR ${dpr}: canvas follows stage through fractional resize with no CSS overflow`, () => {
      const m = model(dpr, { left: 0, top: 155, width: 1168, height: 442.5 });
      for (const size of [[1168, 442.5], [919.5, 380.25], [1042.75, 509.5]]) {
        [m.state.rect.width, m.state.rect.height] = size;
        m.resize();
        const rect = m.canvas.getBoundingClientRect();
        assert.equal(rect.width, size[0]);
        assert.equal(rect.height, size[1]);
        assert.equal(rect.right, m.state.rect.left + size[0]);
        assert.equal(rect.bottom, m.state.rect.top + size[1]);
      }
    });
    test(`DPR ${dpr}: actual pointer mapping remains logical CSS pixels near the visible bottom edge`, () => {
      const m = model(dpr, { left: 17.25, top: 155, width: 919.5, height: 380.25 });
      m.resize();
      const expected = { x: 700.25, y: 350.5 };
      const point = m.point({ clientX: expected.x + 17.25, clientY: expected.y + 155 });
      assert.deepEqual(clone(point), expected, 'do not divide or migrate logical points by DPR');
      const rect = m.canvas.getBoundingClientRect();
      const displayed = { x: point.x * dpr * rect.width / m.canvas.width, y: point.y * dpr * rect.height / m.canvas.height };
      assert.ok(Math.abs(displayed.x - expected.x) < 0.75, 'rounding is bounded below one CSS pixel');
      assert.ok(Math.abs(displayed.y - expected.y) < 0.75, 'the pointer is not visually multiplied by DPR');
      assert.ok(displayed.x < m.state.rect.width && displayed.y < m.state.rect.height, 'completed edge mark is inside the stage clip');
    });
  }
  test('offline browser fixture contains exact source CSS/functions and no external resource or API execution', () => {
    const fixture = browserFixture();
    assert.ok(fixture.includes(`<style>${style}</style>`));
    for (const name of functionNames) assert.ok(fixture.includes(productionFunction(name)));
    assert.doesNotMatch(fixture, /\bfetch\s*\(|\bXMLHttpRequest\b|\bsrc\s*=/);
    assert.ok(fixture.includes("default-src 'none'"));
    assert.ok(fixture.includes('visualViewport.scale'));
    assert.ok(fixture.includes('contextTransform'));
    assert.ok(fixture.includes("measure('resized')"));
  });
}
