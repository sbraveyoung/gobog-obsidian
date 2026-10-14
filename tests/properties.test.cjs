const {test}=require('node:test');const assert=require('node:assert/strict');
const {patchProperties,articleBody,readProperties,checkArticles,publicationState}=require('../.test-build/frontmatter.cjs');
test('date patch preserves BOM CRLF comments custom values and body',()=>{
 const original='\uFEFF---\r\n"updated_time": "2020-01-01 00:00:00" # keep\r\ncustom: [x]\r\n---\r\n正文\r\n';
 const result=patchProperties(original,{updated_time:'2026-10-14 12:00:00'});
 assert.equal(result,'\uFEFF---\r\n"updated_time": "2026-10-14 12:00:00" # keep\r\ncustom: [x]\r\n---\r\n正文\r\n');assert.equal(articleBody(result),'正文\r\n');
});
test('nested keys are untouched and multiline values replace only selected field',()=>{
 const s='---\ncustom:\n  title: nested\ndescription: |\n  old summary\ntags: [old]\n...\nbody';
 const out=patchProperties(s,{description:'new summary',tags:['a','b'],pin:true});
 assert.match(out,/custom:\n  title: nested/);assert.equal(readProperties(out).description,'new summary');assert.deepEqual(readProperties(out).tags,['a','b']);assert.equal(articleBody(out),'body');
});
test('invalid duplicate YAML and alias editing fail without changing original',()=>{
 for(const s of ['---\na: [\n---\nx','---\na: 1\na: 2\n---\nx','---\nupdated_time: &clock old\ncustom: *clock\n---\nx']) assert.throws(()=>patchProperties(s,{updated_time:'new'}));
});
test('preparing publication never bypasses ancestor or private veto',()=>{
 const s=publicationState({draft:false,publish:true,private:true},[{path:'post/series/_folder.md',hidden:true}]);assert.equal(s.public,false);assert.match(s.reasons.join(' '),/series/);assert.match(s.reasons.join(' '),/private/);
 assert.equal(publicationState({publish:'',draft:false},[]).public,true);
});
test('duplicate permanent routes and unsafe URLs stop publishing; legacy booleans warn',()=>{
 const n=(path,id,url,extra='')=>({path,text:`---\nid: ${id}\nurl: ${url}\n${extra}---\nbody`});
 const issues=checkArticles([n('post/a.md','a','/same','pin: yes\n'),n('post/b.md','b','/same'),n('pages/c.md','c','/../escape')]);
 assert.ok(issues.some(x=>x.level==='error'&&x.field==='url'));assert.ok(issues.some(x=>x.level==='warning'&&x.field==='pin'));
});
test('folder policy rejects nonboolean hidden; ordered series metadata stays valid',()=>{
 const issues=checkArticles([{path:'post/_folder.md',text:'---\nhidden: yes\n---\n'}, {path:'post/a.md',text:'---\nid: a\nurl: /a\norder: 2\ntags: [go]\ncreate_time: "2026-10-14 12:00:00"\n---\nbody'}]);assert.equal(issues.filter(x=>x.level==='error').length,1);
});
test('minified production YAML does not bypass alias safety checks',()=>{
 const output=require('esbuild').buildSync({entryPoints:['src/frontmatter.ts'],bundle:true,minify:true,platform:'browser',format:'cjs',write:false}).outputFiles[0].text;const module={exports:{}};require('node:vm').runInNewContext(output,{module,exports:module.exports,crypto:globalThis.crypto});assert.throws(()=>module.exports.patchProperties('---\nclock: &clock old\nupdated_time: *clock\n---\nbody',{updated_time:'new'}));
});
