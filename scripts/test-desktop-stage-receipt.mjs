import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishCheckout, observeCheckout, observeStagedRuntime } from "../desktop/stage-receipt.mjs";

const gitAvailable = spawnSync("git", ["--version"]).status === 0;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding:"utf8", stdio:["ignore","pipe","pipe"] }).trim();
function scratch(t) {
  const dir=mkdtempSync(join(tmpdir(),"bee-stage-receipt-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return dir;
}
function repo(t) {
  const dir=scratch(t);
  git(dir,"init","-q");
  writeFileSync(join(dir,"code"),"original");
  writeFileSync(join(dir,".gitignore"),"generated\n");
  git(dir,"add",".");
  git(dir,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","first");
  return dir;
}
const unknown = state => ({state,commit:null,tree:null,byteVerified:false});

test("exported source without own Git metadata stays usable but unlabeled",t=>{
  const dir=scratch(t);
  assert.deepEqual(observeCheckout(dir),unknown("unavailable"));
});
test("clean Git source records full Git IDs, never an assertion about bytes", {skip:!gitAvailable}, t=>{
  const dir=repo(t);
  writeFileSync(join(dir,"generated"),"ignored non-Git build input");
  const expected={state:"git-clean",commit:git(dir,"rev-parse","HEAD"),tree:git(dir,"rev-parse","HEAD^{tree}"),byteVerified:false};
  const nested=join(dir,"export");
  mkdirSync(nested);
  assert.deepEqual(observeCheckout(nested),unknown("unavailable"));
  assert.deepEqual(finishCheckout(observeCheckout(dir),observeCheckout(dir)),expected);
});
test("untracked or modified source never borrows HEAD's identity", {skip:!gitAvailable}, t=>{
  const dir=repo(t), before=observeCheckout(dir);
  const untracked=join(dir,"different");
  writeFileSync(untracked,"new source");
  assert.deepEqual(observeCheckout(dir),unknown("dirty"));
  rmSync(untracked);
  writeFileSync(join(dir,"code"),"different");
  const observed=observeCheckout(dir);
  assert.deepEqual(observed,unknown("dirty"));
  assert.deepEqual(finishCheckout(before,observed),unknown("dirty"));
  assert.deepEqual(finishCheckout(observed,before),unknown("dirty"));
});
test("HEAD movement between observations nulls provenance even if both ends are clean", {skip:!gitAvailable}, t=>{
  const dir=repo(t), before=observeCheckout(dir);
  git(dir,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-qm","moved");
  const after=observeCheckout(dir);
  assert.equal(after.state,"git-clean");
  assert.equal(before.tree,after.tree);
  assert.deepEqual(finishCheckout(before,after),unknown("changed"));
});
test("staged runtime hash is deterministic, detects same-size changed bytes and is not valid for missing stage",t=>{
  const dir=scratch(t), a=join(dir,"a"), b=join(dir,"b");
  const unavailable=observeStagedRuntime(a);
  assert.equal(unavailable.sha256,null);
  assert.equal(unavailable.bytes,null);
  mkdirSync(a); mkdirSync(b);
  assert.deepEqual(observeStagedRuntime(a),unavailable);
  for (const [folder, names] of [[a,["one","two"]],[b,["two","one"]]]) {
    for (const name of names) writeFileSync(join(folder,name),name);
  }
  const first=observeStagedRuntime(a);
  assert.equal(first.scope,"desktop/stage/app");
  assert.equal(first.algorithm,"sha256-tree-v1");
  assert.equal(first.files,2);
  assert.equal(first.bytes,6);
  assert.match(first.sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(observeStagedRuntime(b),first);
  writeFileSync(join(b,"two"),"new");
  const changed=observeStagedRuntime(b);
  assert.notEqual(changed.sha256,first.sha256);
  assert.equal(changed.bytes,first.bytes);
  writeFileSync(join(b,"two"),"longer");
  assert.equal(observeStagedRuntime(b).bytes,9);
});

test("Git directory and worktree environment do not relabel the local checkout", {skip:!gitAvailable}, t=>{
  const real=repo(t), other=repo(t);
  const expected=observeCheckout(real);
  git(other,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-qm","other");
  assert.notEqual(git(other,"rev-parse","HEAD"),expected.commit);
  const paths={GIT_DIR:join(other,".git"),GIT_WORK_TREE:other,GIT_INDEX_FILE:join(other,".git","index")};
  const previous=Object.fromEntries(Object.keys(paths).map(key=>[key,process.env[key]]));
  try {
    Object.assign(process.env,paths);
    assert.deepEqual(observeCheckout(real),expected);
  } finally {
    for (const [key,value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key]=value;
    }
  }
});
test("runtime link does not bless content outside the stage or return a partial digest", t=>{
  const root=scratch(t), app=join(root,"app");
  mkdirSync(app);
  writeFileSync(join(root,"outside"),"not staged");
  writeFileSync(join(app,"inside"),"staged");
  try { symlinkSync(join(root,"outside"),join(app,"link"),"file"); }
  catch (err) { if (["EPERM","EACCES","ENOSYS"].includes(err.code)) return t.skip("symlinks not supported"); else throw err; }
  const scope=observeStagedRuntime(app);
  assert.equal(scope.sha256,null);
  assert.equal(scope.files,null);
  assert.equal(scope.bytes,null);
});
