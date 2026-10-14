const {test}=require('node:test'),assert=require('node:assert/strict');const {gitApiFixture}=require('./github-fixture.cjs'),{vaultFixture}=require('./vault-fixture.cjs');let createMobileBackend,planAttachments;try{({createMobileBackend}=require('../.test-build/mobile-sync.cjs'));({planAttachments}=require('../.test-build/attachment-plan.cjs'))}catch{}
const base='---\nid: a\nurl: /a\ndraft: true\npublish: false\n---\nbase\n';
test('preparing attachments is read-only and imports bytes only after reviewed publication',async t=>{
 const f=gitApiFixture(t,{'post/a.md':base}),v=vaultFixture({'blog/post/a.md':base+'![[photo.png]]\n','outside/photo.png':new Uint8Array([0,128,255])});
 const backend=createMobileBackend(v.app,f.config,'blog'),prepared=await backend.prepare();assert.equal(prepared.imported.length,1);assert.equal(v.data.size,2);assert.match(v.text('blog/post/a.md'),/photo.png/);
 const sha=await backend.publish(prepared,'phone');assert.equal(f.git(['rev-parse','master']),sha);const image=prepared.imported[0];assert.ok(v.data.has('blog/'+image.path));assert.match(v.text('blog/post/a.md'),/resource\/image\//);assert.ok(prepared.review.files.some(x=>x.kind==='image'));
});
test('changing a local note after review stops publication',async t=>{
 const f=gitApiFixture(t,{'post/a.md':base}),v=vaultFixture({'blog/post/a.md':base+'edited'}),backend=createMobileBackend(v.app,f.config,'blog'),p=await backend.prepare();v.write('blog/post/a.md',base+'changed during review');await assert.rejects(()=>backend.publish(p,'old'),/改变|changed/);assert.equal(f.calls.some(c=>c.method==='PATCH'),false);
});
test('missing mobile files never delete a remote article or image',async t=>{
 const f=gitApiFixture(t,{'post/a.md':base,'resource/image/a.png':'image'}),v=vaultFixture({'blog/post/a.md':base}),p=await createMobileBackend(v.app,f.config,'blog').prepare();assert.equal(p.changes.length,0);assert.ok(p.warnings.some(w=>w.includes('resource/image/a.png')));
});
test('once baseline exists remote-only content is pulled instead of uploaded',async t=>{
 const f=gitApiFixture(t,{'post/a.md':base}),v=vaultFixture({'blog/post/a.md':base+'local'}),backend=createMobileBackend(v.app,f.config,'blog');await backend.publish(await backend.prepare(),'first');
 const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(f.root,'post/a.md'),base+'remote');f.git(['add','.']);f.git(['commit','-qm','remote edit']);
 const p=await backend.prepare();assert.equal(p.changes.length,0);assert.ok(p.warnings.length);await backend.pull();assert.equal(v.text('blog/post/a.md'),base+'remote');
});
test('three-way conflicting note modifications are preserved',async t=>{
 const f=gitApiFixture(t,{'post/a.md':base}),v=vaultFixture({'blog/post/a.md':base+'local'}),backend=createMobileBackend(v.app,f.config,'blog');await backend.publish(await backend.prepare(),'first');v.write('blog/post/a.md',base+'other local');const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(f.root,'post/a.md'),base+'other remote');f.git(['add','.']);f.git(['commit','-qm','remote']);await assert.rejects(()=>backend.prepare(),/冲突/);await assert.rejects(()=>backend.pull(),/冲突/);assert.equal(v.text('blog/post/a.md'),base+'other local');
});
test('published attachments recover locally after a failed mirror write',async t=>{
 const f=gitApiFixture(t,{'post/a.md':base}),v=vaultFixture({'blog/post/a.md':base+'![[photo.png]]','outside/photo.png':'image'}),backend=createMobileBackend(v.app,f.config,'blog'),p=await backend.prepare(),create=v.app.vault.createBinary;
 v.app.vault.createBinary=async()=>{throw Error('disk unavailable')};await assert.rejects(()=>backend.publish(p,'phone'),/源码已提交/);v.app.vault.createBinary=create;
 await backend.pull();assert.match(v.text('blog/post/a.md'),/blog\/resource\/image\//);assert.ok(v.data.has('blog/'+p.imported[0].path));
});
test('mobile retry reuses pending commit after an unknown response',async t=>{
 const f=gitApiFixture(t,{'post/a.md':base}),v=vaultFixture({'blog/post/a.md':base+'local'}),backend=createMobileBackend(v.app,f.config,'blog'),p=await backend.prepare();global.__gobogRequest=async args=>{if(args.method==='PATCH')throw Error('offline');return f.handler(args)};await assert.rejects(()=>backend.publish(p,'first'));
 global.__gobogRequest=f.handler;await backend.publish(await backend.prepare(),'retry');assert.equal(f.calls.filter(c=>c.method==='POST'&&c.route==='git/commits').length,1);
});
