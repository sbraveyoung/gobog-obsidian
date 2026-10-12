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
