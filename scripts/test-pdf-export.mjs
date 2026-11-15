// Actual client generators and all five shipped PDF handlers, with synthetic
// DOM/download IO only. No provider, server export, print IPC or font download.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = resolve(process.env.BZ_PDF_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'));
const read = path => readFileSync(join(root, path), 'utf8');
const generatorSource = read('public/buzzy/sow-pdf.js');
const business = 'Invoice – Café\nClient: Zoë O’Connor\nAmount: €1,200\nApproved — thank you.';
const ascii = 'Invoice\nClient: Cafe\nAmount: EUR 1200\nApproved - thank you.';
const specials = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const supported = Array.from({length:95}, (_, i) => String.fromCharCode(i + 32)).join('') +
  Array.from({length:95}, (_, i) => String.fromCharCode(i + 161)).filter(c => c !== '\u00ad').join('') + specials;
const unsupported = [
  ['Japanese', '日本語'], ['Arabic', 'العربية'], ['emoji', '🐝'],
  ['decomposed accent', 'Cafe\u0301'], ['tab', 'A\tB'], ['NUL', 'A\0B'],
  ['C0 control', '\u001b'], ['DEL', '\u007f'], ['C1 control', '\u0085'],
  ['nonbreaking space', 'A\u00a0B'], ['soft hyphen', 'A\u00adB'], ['lone CR', 'A\rB'],
];
const invalid = [
  ['lone high surrogate', '\ud800'], ['lone low surrogate', '\udfff'],
  ['high followed by ASCII', '\ud800A'], ['unsupported before invalid', '日本\ud800'],
  ['valid pair before invalid', '🐝\udfff'], ['control before invalid', '\t\ud800'],
];

function loadGenerator(source = generatorSource) {
  const context = vm.createContext({ window: {}, TextEncoder });
  vm.runInContext(source, context, {filename: 'actual-sow-pdf.js'});
  return context.window.beezillaSowPdf;
}
const generate = loadGenerator();

function structure(bytes, {asciiOnly = false} = {}) {
  const buffer = Buffer.from(bytes), pdf = buffer.toString('latin1');
  assert.ok(buffer.subarray(0, 9).equals(Buffer.from('%PDF-1.4\n')));
  if (asciiOnly) assert.ok(buffer.every(byte => byte < 128), 'serialized PDF is byte-countable ASCII');
  const xref = pdf.indexOf('xref\n');
  assert.ok(xref > 0);
  assert.equal(Number(pdf.match(/startxref\n(\d+)\n%%EOF$/)?.[1]), xref, 'startxref is exact byte offset');
  const entries = pdf.slice(xref).match(/^xref\n0 (\d+)\n([\s\S]*?)trailer\n/);
  assert.ok(entries);
  const rows = entries[2].trimEnd().split('\n');
  assert.equal(rows.length, Number(entries[1]));
  assert.equal(rows[0], '0000000000 65535 f ');
  for (let object = 1; object < rows.length; object++) {
    const offset = Number(rows[object].slice(0, 10));
    assert.ok(pdf.slice(offset).startsWith(`${object} 0 obj\n`), `object ${object} offset`);
  }
  const streams = [...pdf.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream/g)];
  assert.ok(streams.length);
  for (const match of streams) assert.equal(Number(match[1]), Buffer.byteLength(match[2], 'latin1'), 'stream byte length');
  return pdf;
}

function decodedLines(bytes) {
  const pdf = structure(bytes, {asciiOnly:true});
  assert.match(pdf, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding \/ToUnicode \d+ 0 R/);
  const cmap = new Map();
  for (const block of pdf.matchAll(/(\d+) beginbfchar\n([\s\S]*?)endbfchar/g)) {
    assert.ok(Number(block[1]) <= 100, 'CMap batches respect PDF bound');
    const pairs = [...block[2].matchAll(/<([0-9A-F]{2})> <([0-9A-F]{4})>/g)];
    assert.equal(pairs.length, Number(block[1]));
    for (const pair of pairs) {
      assert.ok(!cmap.has(pair[1]), 'unique code mapping');
      cmap.set(pair[1], String.fromCharCode(parseInt(pair[2], 16)));
    }
  }
  return [...pdf.matchAll(/BT \/F1 11 Tf 50 (\d+) Td <([0-9A-F]*)> Tj ET/g)].map(match => {
    assert.ok(Number(match[1]) >= 50 && Number(match[1]) <= 750);
    assert.equal(match[2].length % 2, 0);
    return (match[2].match(/../g) || []).map(code => {
      assert.ok(cmap.has(code), `mapped text byte ${code}`);
      return cmap.get(code);
    }).join('');
  });
}

function fn(html, name) {
  const start = html.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, `actual ${name}`);
  const line = html.indexOf('\n', start);
  if (html.slice(start, line).trimEnd().endsWith('}')) return html.slice(start, line);
  const end = html.indexOf('\n    }', start);
  assert.ok(end > start, `end ${name}`);
  return html.slice(start, end + 6);
}

const callers = [
  ['Library viewer', 'public/buzzy/library.html', 'viewer'],
  ['Library legacy draft', 'public/buzzy/library.html', 'legacy'],
  ['Talk draft', 'public/buzzy/talk.html', 'talk'],
  ['Talk legacy draft', 'public/buzzy/talk.html', 'legacy'],
  ['packaged demo', 'packages/beezilla-demo/index.html', 'legacy'],
];
function callerFixture(caller, initialText) {
  const [, path, kind] = caller, html = read(path);
  let text = initialText, blobCount = 0;
  const elements = new Map(), blobs = new Map(), downloads = [], alerts = [], revoked = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {innerHTML:'', textContent:'', onclick:null});
    return elements.get(id);
  }
  const doc = {name:'synthetic.md', md:text, createdAt:1, updatedAt:2};
  const context = vm.createContext({
    window:{}, TextEncoder,
    Blob:class extends Blob { constructor(parts, options) { super(parts, options); blobCount++; } },
    URL:{ createObjectURL(blob) { const url = 'blob:synthetic/' + blobs.size; blobs.set(url, blob); return url; }, revokeObjectURL(url) { revoked.push(url); } },
    document:{ getElementById:element, createElement(tag) { assert.equal(tag, 'a'); return { click() { downloads.push({name:this.download, blob:blobs.get(this.href)}); } }; } },
    navigator:{clipboard:{writeText() { throw Error('clipboard not requested'); }}},
    fetch() { throw Error('network not requested'); }, alert(message) { alerts.push(message); },
    setTimeout(callback) { callback(); }, setPhase() {}, render() {}, syncJobDocs() {}, paintLibrarySync() {}, inWorkspace:()=>true,
    fairnessNotes:()=>[], draftDoc:()=>text, draftBodyEl:()=>({value:text}),
    state:{template:'synthetic'}, chatState:{draftText:text, draftVersion:2},
    jobTitle:job=>job.title, catalog:{jobs:[{id:'job_synthetic',title:'Synthetic folder'}]},
    loadDocs:()=>({job_synthetic:[doc]}), docsOpenFolder:'job_synthetic', docsOpenDoc:doc.name, docsOpenFromLink:null,
  });
  vm.runInContext(path.startsWith('packages/') ? read('packages/beezilla-demo/sow-pdf.js') : generatorSource, context);
  let clickPdf, clickMarkdown, clickWord;
  if (kind === 'viewer') {
    vm.runInContext(['docRef','escHtml','escAttr','downloadText','mdToWordHtml','downloadWord','goDocs'].map(name=>fn(html,name)).join('\n'),context);
    context.goDocs();
    assert.match(element('app').innerHTML, /Download PDF/);
    clickPdf=()=>element('docDlPdf').onclick();
    clickMarkdown=()=>element('docDl').onclick();
    clickWord=()=>element('docDlWord').onclick();
  } else if (kind === 'legacy') {
    vm.runInContext(fn(html,'goResult'),context);
    context.goResult();
    assert.match(element('app').innerHTML, /Download PDF/);
    clickPdf=()=>element('dlpdf').onclick();
    clickMarkdown=()=>element('dl').onclick();
  } else {
    vm.runInContext(['onDownloadPdf','onDownloadDraft','mdToWordHtml','onDownloadWord'].map(name=>fn(html,name)).join('\n'),context);
    clickPdf=()=>context.onDownloadPdf(); clickMarkdown=()=>context.onDownloadDraft(); clickWord=()=>context.onDownloadWord();
  }
  return {context, downloads, alerts, blobs, revoked, clickPdf, clickMarkdown, clickWord,
    setText(value) { text=value; doc.md=value; context.chatState.draftText=value; },
    get blobCount() { return blobCount; }, get text() { return text; }};
}

// These controls pass the published baseline. The preservation/rejection tests
// below are deliberately baseline-red, including actual caller download bytes.
test('ASCII PDF byte offsets and stream lengths remain valid', () => structure(generate(ascii)));
test('demo generator remains byte-identical to public generator', () => assert.equal(read('packages/beezilla-demo/sow-pdf.js'), generatorSource));
test('business text has exact glyph bytes and ToUnicode mappings', () => assert.deepEqual(decodedLines(generate(business)), business.split('\n')));
test('all accepted characters retain exact codepoints through CMap', () => {
  const lines = [...supported].map(c=>'X'+c+'Y');
  assert.deepEqual(decodedLines(generate(lines.join('\n'))), lines);
});
test('PDF-looking literals cannot inject syntax or alter text', () => {
  const text = '(draft) \\ /Name <01> [ ] % EOF\nendstream\ntrailer\nstartxref';
  assert.deepEqual(decodedLines(generate(text)), text.split('\n'));
});
test('blank lines, leading/trailing spaces and CRLF are not trimmed', () => {
  const text='  first  \r\n\r\n last \n';
  assert.deepEqual(decodedLines(generate(text)), ['  first  ','',' last ','']);
});
test('empty document stays a valid one-page PDF', () => {
  const bytes=generate(''); assert.deepEqual(decodedLines(bytes), ['']); assert.match(Buffer.from(bytes).toString(), /\/Count 1/);
});
test('wide long lines paginate with bounded glyph count and no dropped characters', () => {
  const text='@'.repeat(2700)+'W'.repeat(2700), bytes=generate(text), lines=decodedLines(bytes);
  assert.ok(lines.length>46); assert.ok(lines.every(line=>line.length<=45));
  assert.equal(lines.join(''),text); assert.match(Buffer.from(bytes).toString(), /\/Count 3/);
});
for (const [name, value] of unsupported) test(`rejects ${name} with explicit unchanged Markdown option`, () => {
  assert.throws(()=>generate('prefix\n'+value+'\nsuffix'),error=>{
    assert.equal(error.code,'pdf_unsupported_text'); assert.match(error.message,/Markdown/); assert.match(error.message,/no PDF was downloaded/); return true;
  });
});
for (const [name, value] of invalid) test(`rejects ${name} without false lossless fallback promise`, () => {
  assert.throws(()=>generate('prefix\n'+value+'\nsuffix'),error=>{
    assert.equal(error.code,'pdf_invalid_text'); assert.match(error.message,/Fix the text/); assert.doesNotMatch(error.message,/Markdown|lossless|unchanged/); return true;
  });
});
test('non-string input is an explicit invalid-text error', () => {
  for(const value of [null,undefined,42,{},['text']]) assert.throws(()=>generate(value),error=>error.code==='pdf_invalid_text');
});

for (const caller of callers) {
  const [name]=caller;
  test(`${name}: actual ASCII click downloads one PDF`, async()=>{
    const f=callerFixture(caller,ascii); f.clickPdf();
    assert.equal(f.alerts.length,0); assert.equal(f.downloads.length,1); assert.equal(f.blobCount,1);
    assert.match(f.downloads[0].name,/\.pdf$/); assert.equal(f.downloads[0].blob.type,'application/pdf');
    structure(new Uint8Array(await f.downloads[0].blob.arrayBuffer()));
  });
  test(`${name}: actual business click downloads exact supported text`,async()=>{
    const f=callerFixture(caller,business); f.clickPdf();
    assert.equal(f.alerts.length,0); assert.equal(f.downloads.length,1);
    assert.deepEqual(decodedLines(new Uint8Array(await f.downloads[0].blob.arrayBuffer())), business.split('\n'));
    assert.equal(f.text,business);
  });
  test(`${name}: unsupported click is visible, creates no Blob/download and Markdown stays exact`,async()=>{
    const text='日本語 العربية 🐝 e\u0301\n  Original spacing  \r\n', f=callerFixture(caller,text);
    assert.doesNotThrow(()=>f.clickPdf());
    assert.equal(f.alerts.length,1); assert.match(f.alerts[0],/Markdown/);
    assert.equal(f.blobCount,0); assert.equal(f.blobs.size,0); assert.equal(f.downloads.length,0); assert.equal(f.text,text);
    f.clickMarkdown(); assert.equal(f.downloads.length,1); assert.equal(f.downloads[0].blob.type,'text/markdown');
    assert.equal(await f.downloads[0].blob.text(),text);
  });
  test(`${name}: malformed UTF-16 does not suggest a lossy fallback`,()=>{
    const f=callerFixture(caller,'日本\ud800'); assert.doesNotThrow(()=>f.clickPdf());
    assert.equal(f.alerts.length,1); assert.match(f.alerts[0],/invalid Unicode/); assert.doesNotMatch(f.alerts[0],/Markdown/);
    assert.equal(f.blobCount,0); assert.equal(f.downloads.length,0);
  });
  test(`${name}: missing generator is visible, not an automatic alternate download`,()=>{
    const f=callerFixture(caller,ascii); delete f.context.window.beezillaSowPdf;
    assert.doesNotThrow(()=>f.clickPdf()); assert.equal(f.alerts.length,1); assert.match(f.alerts[0],/PDF/);
    assert.equal(f.blobCount,0); assert.equal(f.downloads.length,0);
  });
  test(`${name}: unexpected generation error is visible without leaking details`,()=>{
    const f=callerFixture(caller,ascii); f.context.window.beezillaSowPdf=()=>{throw Error('synthetic private details');};
    assert.doesNotThrow(()=>f.clickPdf()); assert.deepEqual(f.alerts,['PDF export failed. No PDF was downloaded.']);
    assert.equal(f.blobCount,0); assert.equal(f.downloads.length,0);
  });
  test(`${name}: rejected click then valid retry and repeated clicks use current text`,async()=>{
    const f=callerFixture(caller,'🐝'); f.clickPdf(); f.setText(business); f.clickPdf(); f.clickPdf();
    assert.equal(f.alerts.length,1); assert.equal(f.downloads.length,2); assert.equal(f.blobCount,2);
    for (const download of f.downloads) assert.deepEqual(decodedLines(new Uint8Array(await download.blob.arrayBuffer())),business.split('\n'));
  });
  if(caller[2]!=='legacy') test(`${name}: existing Word HTML preserves valid Unicode characters`,async()=>{
    const text='日本語 العربية 🐝\nRésumé: prêt à livrer.', f=callerFixture(caller,text); f.clickWord();
    assert.equal(f.downloads.length,1); assert.equal(f.downloads[0].blob.type,'application/msword');
    const word=await f.downloads[0].blob.text(); for(const line of text.split('\n')) assert.ok(word.includes(line));
  });
}

// Poppler is test-only tooling, not a runtime dependency. Portable CI may skip
// if absent; release/native acceptance MUST install/provide and run these gates.
const poppler = spawnSync('pdftotext',['-v'],{encoding:'utf8'});
const missingPoppler = poppler.error?.code === 'ENOENT';
function withPdf(bytes, operation) {
  const dir=mkdtempSync(join(tmpdir(),'bz-pdf-export-'));
  try { const file=join(dir,'sample.pdf'); writeFileSync(file,bytes); return operation(file,dir); }
  finally { rmSync(dir,{recursive:true,force:true}); }
}
function popplerText(bytes, args=[]) {
  return withPdf(bytes,file=>{
    const result=spawnSync('pdftotext',[...args,file,'-'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.error?.message); assert.equal(result.stderr,'');
    return result.stdout;
  });
}
const normalizedExtraction = text => text.replace(/\f/g,'').trimEnd();
test('Poppler: business PDF extracts every accent, currency and smart punctuation exactly',{skip:missingPoppler&&'pdftotext unavailable; native gate still required'},()=>{
  assert.equal(normalizedExtraction(popplerText(generate(business),['-layout'])),business);
});
test('Poppler: every supported codepoint extracts exactly in content order across multiple pages',{skip:missingPoppler&&'pdftotext unavailable; native gate still required'},()=>{
  const lines=[...supported].map(c=>'X'+c+'Y');
  // -raw reads content order. Layout inference can drop a narrow space between
  // two uppercase glyphs; PDF is not an exact whitespace interchange format.
  const actual=popplerText(generate(lines.join('\n')),['-raw']).replace(/\f/g,'').split('\n').filter(line=>line.length);
  assert.deepEqual(actual,lines);
});
test('Poppler: wide text keeps all glyphs within the content right edge',{skip:missingPoppler&&'pdftotext unavailable; native gate still required'},()=>{
  const text='@'.repeat(2700)+'W'.repeat(2700), bytes=generate(text);
  assert.equal(popplerText(bytes).replace(/[\s\f]/g,''),text);
  const bbox=popplerText(bytes,['-bbox']); const edges=[...bbox.matchAll(/xMax="([0-9.]+)"/g)].map(match=>Number(match[1]));
  assert.ok(edges.length); assert.ok(Math.max(...edges)<=562,`maximum right edge ${Math.max(...edges)}`);
});
test('Poppler: actual Library download bytes render successfully without syntax/font warnings',{skip:missingPoppler&&'Poppler unavailable; native gate still required'},async t=>{
  const rendererCommand=process.env.BZ_PDFTOPPM || 'pdftoppm';
  const renderer=spawnSync(rendererCommand,['-v'],{encoding:'utf8'});
  if(renderer.error?.code==='ENOENT') { t.skip('pdftoppm unavailable; native render gate still required'); return; }
  const f=callerFixture(callers[0],business); f.clickPdf(); assert.equal(f.downloads.length,1);
  withPdf(Buffer.from(await f.downloads[0].blob.arrayBuffer()),(file,dir)=>{
    const result=spawnSync(rendererCommand,['-png','-singlefile','-scale-to','900',file,join(dir,'render')],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.error?.message); assert.equal(result.stderr,'');
    const png=readFileSync(join(dir,'render.png')); assert.ok(png.length>1000); assert.equal(png.subarray(1,4).toString(),'PNG');
  });
});
