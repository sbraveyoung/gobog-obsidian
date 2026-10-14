const {test}=require('node:test');const assert=require('node:assert/strict');const {TFile}=require('./obsidian-stub.cjs');
let scanImages,cleanImages,extractReferences,gitBlobSha;try{({scanImages,cleanImages}=require('../.test-build/asset-audit.cjs'));({extractReferences}=require('../.test-build/asset-references.cjs'));({gitBlobSha}=require('../.test-build/content-hash.cjs'))}catch{}
function fixture(){const data=new Map([['blog/post/draft.md','---\ndraft: true\ncover: resource/image/a.png\n---\n![图][x]\n[x]: ../resource/image/b.png'],['outside.md','![[c.png]]'],['board.canvas','{"nodes":[{"type":"file","file":"blog/resource/image/d.png"}]}'],['blog/resource/image/a.png','a'],['blog/resource/image/b.png','b'],['blog/resource/image/c.png','c'],['blog/resource/image/d.png','d'],['blog/resource/image/unused.png','e']]);const files=()=>[...data].map(([path,body])=>Object.assign(new TFile(),{path,name:path.split('/').pop(),extension:path.split('.').pop(),stat:{size:Buffer.byteLength(body??''),mtime:1}}));const trash=[];const app={vault:{getFiles:files,getAbstractFileByPath:p=>files().find(f=>f.path===p),read:async f=>{if(data.get(f.path)===null)throw Error('offloaded');return data.get(f.path)},readBinary:async f=>new TextEncoder().encode(data.get(f.path)).buffer,trash:async f=>{trash.push(f.path);data.delete(f.path)},configDir:'.obsidian'},metadataCache:{getFirstLinkpathDest:()=>null,getFileCache:()=>({}),resolvedLinks:{}}};return {app,data,trash}}
test('reference parser includes draft cover inline reference HTML and Canvas paths',()=>{
 const text='---\ndraft: true\ncover: resource/image/a.png\n---\n![图][x]\n[x]: ../resource/image/b.png "title"\n<img srcset="a%20b.png 1x, c.png 2x">';
 const links=extractReferences('blog/post/a.md',text).map(x=>x.link);for(const l of ['resource/image/a.png','../resource/image/b.png','a%20b.png','c.png'])assert.ok(links.includes(l),l);
});
test('scan counts all-vault references including unpublished articles',async()=>{
 const {app}=fixture();const a=await scanImages(app,'blog',()=>{},new AbortController().signal);assert.equal(a.complete,true);assert.deepEqual(a.images.filter(x=>x.state==='candidate').map(x=>x.path),['blog/resource/image/unused.png']);assert.equal(a.images.find(x=>x.path.endsWith('c.png')).references[0].source,'outside.md');
});
test('an unreadable reference source disables all image deletions',async()=>{
 const {app,data,trash}=fixture();data.set('outside.md',null);const a=await scanImages(app,'blog',()=>{},new AbortController().signal);assert.equal(a.complete,false);assert.equal(a.images.some(x=>x.state==='candidate'),false);await assert.rejects(()=>cleanImages(app,a,['blog/resource/image/unused.png'],{}));assert.deepEqual(trash,[]);
});
test('new references after human selection prevent trashing',async()=>{
 const {app,data,trash}=fixture();const a=await scanImages(app,'blog',()=>{},new AbortController().signal);data.set('outside.md','![[unused.png]]');await assert.rejects(()=>cleanImages(app,a,['blog/resource/image/unused.png'],{'resource/image/unused.png':'remote'}));assert.deepEqual(trash,[]);
});
test('explicit cleanup trashes only selected image and records version-bound intent',async()=>{
 const {app,trash}=fixture();const a=await scanImages(app,'blog',()=>{},new AbortController().signal);const sha=a.images.find(x=>x.path.endsWith('unused.png')).sha;const result=await cleanImages(app,a,['blog/resource/image/unused.png'],{'resource/image/unused.png':sha});assert.deepEqual(trash,['blog/resource/image/unused.png']);assert.equal(result[0].remoteSha,sha);assert.equal(result[0].path,'resource/image/unused.png');
});
test('hash matches Git blob identity including UTF8 bytes',async()=>{assert.equal(await gitBlobSha(new TextEncoder().encode('hello\n')),'ce013625030ba8dba906f756967f9e9ca394464a');});
test('Obsidian theme/snippet references prevent deleting a blog image',async()=>{
 const {app}=fixture();app.vault.adapter={exists:async p=>p==='.obsidian/snippets',list:async()=>({files:['.obsidian/snippets/blog.css'],folders:[]}),read:async()=>'.hero { background: url("../../blog/resource/image/unused.png"); }'};const a=await scanImages(app,'blog',()=>{},new AbortController().signal);assert.equal(a.images.find(i=>i.path.endsWith('unused.png')).state,'referenced');
});
