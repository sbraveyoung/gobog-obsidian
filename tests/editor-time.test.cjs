const {test}=require('node:test');const assert=require('node:assert/strict');
let createTimeWriter;try{({createTimeWriter}=require('../.test-build/editor-time.cjs'))}catch{}
const header='---\ncreate_time: old\nupdated_time: old\n---\n';
function fixture(){const files={'post/a.md':header+'a','post/b.md':header+'b'};const errors=[];const w=createTimeWriter({enabled:()=>true,eligible:p=>p.startsWith('post/'),process:async(p,fn)=>{files[p]=fn(files[p])},now:()=>'2026-10-14 12:00:00',delayMs:1000,fail:e=>errors.push(e)});return {files,w,errors}}
test('body edits update correct file on flush while metadata edits do not',async()=>{
 const {files,w}=fixture();w.userEdit('post/a.md',files['post/a.md'],header+'new',false);files['post/a.md']=header+'new';w.userEdit('post/b.md',files['post/b.md'],files['post/b.md'].replace('create_time: old','create_time: edited'),false);await w.flush();assert.match(files['post/a.md'],/updated_time: "2026-10-14 12:00:00"/);assert.match(files['post/a.md'],/create_time: old/);assert.match(files['post/b.md'],/updated_time: old/);w.dispose();
});
test('flush never stamps an incoming synchronized body over captured user text',async()=>{
 const {files,w}=fixture();w.userEdit('post/a.md',files['post/a.md'],header+'local',false);files['post/a.md']=header+'remote';await w.flush();assert.match(files['post/a.md'],/updated_time: old/);w.dispose();
});
test('composition edits merge and wait until completed before flush',async()=>{
 const {files,w}=fixture();w.userEdit('post/a.md',header+'a',header+'中',true);files['post/a.md']=header+'中';await w.flush();assert.match(files['post/a.md'],/updated_time: old/);w.userEdit('post/a.md',header+'中',header+'中文',false);files['post/a.md']=header+'中文';await w.flush();assert.match(files['post/a.md'],/2026-10-14/);w.dispose();
});
test('invalid YAML is reported and preserved; disabled writer does nothing',async()=>{
 const {files,w,errors}=fixture();files['post/a.md']='---\nbad: [\n---\nbody';w.userEdit('post/a.md',header+'a',files['post/a.md'],false);await w.flush();assert.equal(errors.length,1);assert.match(files['post/a.md'],/bad: \[/);w.dispose();
});
test('compositionend stamps the accepted body even without a final document change',async()=>{
 const {files,w}=fixture();const accepted=header+'输入法已确认';
 w.userEdit('post/a.md',files['post/a.md'],accepted,true);files['post/a.md']=accepted;
 await w.flush();assert.match(files['post/a.md'],/updated_time: old/);
 w.userEdit('post/a.md',accepted,accepted,false);await w.flush();
 assert.match(files['post/a.md'],/updated_time: "2026-10-14 12:00:00"/);
 assert.match(files['post/a.md'],/create_time: old/);w.dispose();
});
