const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');
const api=require('../.test-build/git.cjs');
function git(d,...a){return execFileSync('git',a,{cwd:d,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}
function fixture(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'gobog-review-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));git(d,'init','-b','master');git(d,'config','user.name','test');git(d,'config','user.email','test@example.com');fs.mkdirSync(path.join(d,'post'));return d}
const before='---\ntitle: 我的文章\ndraft: true\npublish: false\ntags: [写作]\n---\n原来的正文\n尾部\n';
const after='---\ntitle: 我的文章\ndraft: false\npublish: true\ntags: [写作, Obsidian]\n---\n改好的正文\n尾部\n';
test('review separates publication metadata from body and handles Chinese quoted paths',async t=>{
 assert.equal(typeof api.gitStageForReview,'function','structured review API missing');
 const d=fixture(t);const name='post/文章 "草稿".md';fs.writeFileSync(path.join(d,name),before);git(d,'add','.');git(d,'commit','-m','initial');fs.writeFileSync(path.join(d,name),after);
 const review=await api.gitStageForReview(d,'test','test@example.com');
 assert.equal(review.files.length,1);const f=review.files[0];assert.equal(f.path,name);assert.equal(f.title,'我的文章');assert.equal(f.kind,'article');
 assert.deepEqual(f.properties.map(p=>[p.key,p.before,p.after]),[['draft','true','false'],['publish','false','true'],['tags','[写作]','[写作, Obsidian]']]);
 assert.match(f.notices.join(' '),/准备发表/);assert.equal(f.beforeBody,'原来的正文\n尾部\n');assert.equal(f.afterBody,'改好的正文\n尾部\n');
 const patch=await api.gitReviewPatch(d,review,f);assert.match(patch,/^-原来的正文$/m);assert.match(patch,/^\+改好的正文$/m);
 fs.writeFileSync(path.join(d,name),'edited while reviewing');const again=await api.gitReviewPatch(d,review,f);assert.equal(again,patch);
});
test('review distinguishes folder policies, binary files, deletion, rename and first commit',async t=>{
 assert.equal(typeof api.gitStageForReview,'function','structured review API missing');const d=fixture(t);
 fs.writeFileSync(path.join(d,'_folder.md'),'---\nhidden: true\n---\n暂不公开\n');fs.writeFileSync(path.join(d,'cover.png'),Buffer.from([0,1,2,3]));
 let r=await api.gitStageForReview(d,'test','test@example.com');assert.equal(r.files.find(f=>f.path==='cover.png').binary,true);const policy=r.files.find(f=>f.path==='_folder.md');assert.equal(policy.kind,'folder');assert.match(policy.notices.join(' '),/隐藏.*文件夹/);
 git(d,'commit','-m','initial');fs.renameSync(path.join(d,'_folder.md'),path.join(d,'控制.md'));fs.unlinkSync(path.join(d,'cover.png'));
 r=await api.gitStageForReview(d,'test','test@example.com');assert.equal(r.files.find(f=>f.path==='控制.md').oldPath,'_folder.md');assert.equal(r.files.find(f=>f.path==='cover.png').status,'D');
});
test('review refuses to commit a different staged tree than the one approved',async t=>{
 assert.equal(typeof api.gitStageForReview,'function','structured review API missing');const d=fixture(t);fs.writeFileSync(path.join(d,'post/note.md'),before);const r=await api.gitStageForReview(d,'test','test@example.com');fs.writeFileSync(path.join(d,'other.md'),'unexpected');git(d,'add','.');
 await assert.rejects(api.gitCommitAndPush(d,{branch:'master',remoteUrl:d,token:'',authorName:'test',authorEmail:'test@example.com',commitMessage:'test',reviewTree:r.tree}),/review|重新检查/i);
 assert.throws(()=>git(d,'rev-parse','HEAD'));
});

test('invalid YAML never produces a publication claim and large markdown is explicitly marked',async t=>{
 const d=fixture(t);fs.writeFileSync(path.join(d,'broken.md'),'---\ntitle: [broken\npublish: true\n---\nbody');fs.writeFileSync(path.join(d,'large.md'),'---\ntitle: large\n---\n'+'a'.repeat(2*1024*1024));
 const r=await api.gitStageForReview(d,'test','test@example.com');const broken=r.files.find(f=>f.path==='broken.md');assert.equal(broken.metadataError,true);assert.match(broken.notices.join(' '),/解析失败/);assert.doesNotMatch(broken.notices.join(' '),/准备发表/);assert.equal(r.files.find(f=>f.path==='large.md').contentSkipped,true);
});
test('whitespace truthy flags and empty publish match renderer compatibility',async t=>{
 const d=fixture(t);fs.writeFileSync(path.join(d,'post/note.md'),'---\ndraft: true\n---\nbody');git(d,'add','.');git(d,'commit','-m','initial');fs.writeFileSync(path.join(d,'post/note.md'),'---\ndraft: false\npublish: ""\nhidden: " true "\n---\nbody');
 let r=await api.gitStageForReview(d,'test','test@example.com');assert.doesNotMatch(r.files[0].notices.join(' '),/准备发表/);
 fs.writeFileSync(path.join(d,'post/note.md'),'---\ndraft: false\npublish: ""\nhidden: false\n---\nbody');r=await api.gitStageForReview(d,'test','test@example.com');assert.match(r.files[0].notices.join(' '),/准备发表/);
});

test('new drafts are not reported as a published article being withdrawn',async t=>{
 const d=fixture(t);fs.writeFileSync(path.join(d,'post/draft.md'),'---\ndraft: true\npublish: false\n---\nbody');const r=await api.gitStageForReview(d,'test','test@example.com');assert.doesNotMatch(r.files[0].notices.join(' '),/移除页面|转为未发表/);assert.match(r.files[0].notices.join(' '),/新增.*未发表/);
});
test('moving a hidden folder policy explains both old and new folder effects',async t=>{
 const d=fixture(t);fs.mkdirSync(path.join(d,'a'));fs.mkdirSync(path.join(d,'b'));fs.writeFileSync(path.join(d,'a/_folder.md'),'---\nhidden: true\n---\n');git(d,'add','.');git(d,'commit','-m','initial');fs.renameSync(path.join(d,'a/_folder.md'),path.join(d,'b/_folder.md'));const r=await api.gitStageForReview(d,'test','test@example.com');assert.match(r.files[0].notices.join(' '),/移动目录开关/);
});

test('root documentation changes never claim to publish an article',async t=>{
 const d=fixture(t);fs.writeFileSync(path.join(d,'README.md'),'---\ntitle: Guide\n---\nDocumentation');const r=await api.gitStageForReview(d,'test','test@example.com');assert.equal(r.files[0].kind,'file');assert.doesNotMatch(r.files[0].notices.join(' '),/发表|页面/);
});
