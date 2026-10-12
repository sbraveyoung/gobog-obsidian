const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {startPreviewServer}=require('../.test-build/preview.cjs');
test('preview serves root-relative assets and permanent routes only from export directory',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gobog-preview-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const [rel,body] of [['post/id/index.html','post'],['css/main.css','style']]){const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,body)}
 const {server,origin}=await startPreviewServer(root);t.after(()=>new Promise(resolve=>server.close(resolve)));
 assert.equal(await (await fetch(origin+'/post/id/')).text(),'post');
 const css=await fetch(origin+'/css/main.css');assert.equal(css.headers.get('content-type'),'text/css');assert.equal(await css.text(),'style');
 const bad=await fetch(origin+'/%2f..%2foutside');assert.equal(bad.status,403);await bad.text();
 const missing=await fetch(origin+'/missing');assert.equal(missing.status,404);await missing.text();
});
