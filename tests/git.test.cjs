const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {gitPushAll}=require('../.test-build/git.cjs');
function git(dir,...args){return execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gobog-git-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const remote=path.join(root,'remote.git');fs.mkdirSync(remote);git(remote,'init','--bare','-b','master');
 const dir=path.join(root,'source');fs.mkdirSync(dir);git(dir,'init','-b','master');git(dir,'config','user.name','test');git(dir,'config','user.email','test@example.com');
 fs.writeFileSync(path.join(dir,'note.md'),'body');git(dir,'add','.');git(dir,'commit','-m','initial');git(dir,'remote','add','origin',remote);git(dir,'push','origin','master');
 const opts={branch:'master',remoteUrl:remote,token:'',authorName:'test',authorEmail:'test@example.com',commitMessage:'sync'};
 return {root,remote,dir,opts};
}
test('retry pushes an already committed change after a failed push',async t=>{
 const {dir,remote,opts,root}=setup(t);fs.writeFileSync(path.join(dir,'note.md'),'updated');
 await assert.rejects(gitPushAll(dir,{...opts,remoteUrl:path.join(root,'unavailable.git')}));
 assert.equal(git(dir,'status','--porcelain'),'');
 await gitPushAll(dir,opts);
 assert.equal(git(remote,'rev-parse','master'),git(dir,'rev-parse','HEAD'));
});
test('a fresh active git lock older than 30 seconds is never deleted',async t=>{
 const {dir,opts}=setup(t);fs.writeFileSync(path.join(dir,'note.md'),'updated');
 const lock=path.join(dir,'.git/index.lock');fs.writeFileSync(lock,'active');const old=new Date(Date.now()-60000);fs.utimesSync(lock,old,old);
 await assert.rejects(gitPushAll(dir,opts));assert.equal(fs.readFileSync(lock,'utf8'),'active');
});

test('sync supports Git metadata stored outside the iCloud vault',async t=>{
 const {root,dir,remote,opts}=setup(t);
 const metadata=path.join(root,'external.git');fs.renameSync(path.join(dir,'.git'),metadata);fs.writeFileSync(path.join(dir,'.git'),`gitdir: ${metadata}\n`);
 fs.writeFileSync(path.join(dir,'note.md'),'external metadata works');
 await gitPushAll(dir,opts);assert.equal(git(remote,'rev-parse','master'),git(dir,'rev-parse','HEAD'));
});
test('iCloud mirror of incoming commit fast-forwards without losing staged draft',async t=>{
 const {dir,remote,root,opts}=setup(t),phone=path.join(root,'phone');git(root,'clone',remote,phone);git(phone,'config','user.name','test');git(phone,'config','user.email','test@example.com');fs.writeFileSync(path.join(phone,'note.md'),'phone');git(phone,'add','.');git(phone,'commit','-m','phone');git(phone,'push','origin','master');
 fs.writeFileSync(path.join(dir,'note.md'),'phone');fs.writeFileSync(path.join(dir,'draft.md'),'draft');git(dir,'add','draft.md');
 const {reconcileIncoming}=require('../.test-build/git.cjs');await reconcileIncoming(dir,'master',remote,'');assert.equal(git(dir,'rev-parse','HEAD'),git(remote,'rev-parse','master'));assert.equal(git(dir,'diff','--cached','--name-only'),'draft.md');assert.equal(fs.readFileSync(path.join(dir,'draft.md'),'utf8'),'draft');
});
test('review cancellation restores prior index without discarding unstaged work',async t=>{
 const {dir}=setup(t);fs.writeFileSync(path.join(dir,'staged.md'),'staged');git(dir,'add','staged.md');fs.writeFileSync(path.join(dir,'note.md'),'unstaged');
 const {captureIndex,restoreIndex,gitStageForReview}=require('../.test-build/git.cjs');const before=await captureIndex(dir),review=await gitStageForReview(dir,'test','test@example.com');await restoreIndex(dir,before,review.tree);assert.equal(git(dir,'diff','--cached','--name-only'),'staged.md');assert.equal(fs.readFileSync(path.join(dir,'note.md'),'utf8'),'unstaged');
});
test('edits made to reviewed working file cannot silently push a stale staged snapshot',async t=>{
 const {dir,opts}=setup(t);fs.writeFileSync(path.join(dir,'note.md'),'reviewed');const {gitStageForReview,gitCommitAndPush}=require('../.test-build/git.cjs');const review=await gitStageForReview(dir,'test','test@example.com');fs.writeFileSync(path.join(dir,'note.md'),'newer');await assert.rejects(()=>gitCommitAndPush(dir,{...opts,reviewTree:review.tree}),/改变|changed/);
});
test('failed reconciliation restores index after earlier matching paths were staged',async t=>{
 const {dir,remote,root}=setup(t);fs.writeFileSync(path.join(dir,'z.md'),'base');git(dir,'add','.');git(dir,'commit','-m','z base');git(dir,'push','origin','master');const phone=path.join(root,'phone');git(root,'clone',remote,phone);git(phone,'config','user.name','test');git(phone,'config','user.email','test@example.com');fs.writeFileSync(path.join(phone,'note.md'),'incoming');fs.writeFileSync(path.join(phone,'z.md'),'incoming z');git(phone,'add','.');git(phone,'commit','-m','phone');git(phone,'push','origin','master');
 fs.writeFileSync(path.join(dir,'note.md'),'incoming');fs.writeFileSync(path.join(dir,'z.md'),'own staged');git(dir,'add','z.md');const before=git(dir,'write-tree');await assert.rejects(()=>require('../.test-build/git.cjs').reconcileIncoming(dir,'master',remote,''));assert.equal(git(dir,'write-tree'),before);assert.equal(fs.readFileSync(path.join(dir,'z.md'),'utf8'),'own staged');
});
