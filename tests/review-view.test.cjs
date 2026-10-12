const {test}=require('node:test');const assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');const {mountReviewView}=require('../.test-build/review-view.cjs');const {describeReviewFile}=require('../.test-build/review.cjs');
function root(){const {document}=parseHTML('<html><body><main></main></body></html>');return document.querySelector('main')}
function file(path='post/note.md'){return {path,status:'M',additions:1,deletions:1,binary:false,kind:'article',title:'Note',properties:[],notices:[]}}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function change(el){el.dispatchEvent(new el.ownerDocument.defaultView.Event('change'))}
test('body review excludes raw metadata but exposes it when explicitly requested',async()=>{
 const f=describeReviewFile(file(),'---\ntitle: Note\ndraft: true\n---\nold body\n','---\ntitle: Note\ndraft: false\n---\nnew body\n');const r=root();
 const patch='@@ -1,5 +1,5 @@\n ---\n title: Note\n-draft: true\n+draft: false\n ---\n-old body\n+new body\n';
 mountReviewView(r,{tree:'t',head:'h',files:[f]},'sync',async()=>patch,()=>{},()=>{});await tick();
 assert.match(r.querySelector('.gobog-review-properties').textContent,/drafttruefalse/);const body=r.querySelector('.gobog-review-patch');assert.match(body.textContent,/old body/);assert.match(body.textContent,/new body/);assert.doesNotMatch(body.textContent,/draft:/);
 const mode=r.querySelectorAll('input[type=checkbox]')[0];mode.checked=true;change(mode);await tick();assert.match(body.textContent,/draft: true/);assert.match(body.textContent,/draft: false/);
});
test('long hunks can be fully reviewed without truncation',async()=>{
 const f={...file('notes.txt'),kind:'file'};const r=root();const patch='@@ -0,0 +1,1000 @@\n'+Array.from({length:1000},(_,i)=>`+Line ${i+1}`).join('\n');
 mountReviewView(r,{tree:'t',head:'h',files:[f]},'sync',async()=>patch,()=>{},()=>{});await tick();
 assert.equal(r.querySelectorAll('.gobog-review-line').length,400);const more=r.querySelector('.gobog-review-more');assert.match(more.textContent,/600/);more.click();assert.equal(r.querySelectorAll('.gobog-review-line').length,800);more.click();assert.equal(r.querySelectorAll('.gobog-review-line').length,1000);assert.equal(more.hidden,true);assert.match(r.querySelector('.gobog-review-patch').textContent,/Line 1000/);
});
test('switching files ignores late results and search only filters the file list',async()=>{
 const r=root();const a=file('post/first.md'),b={...file('post/second.md'),title:'Second'};let resolve;
 mountReviewView(r,{tree:'t',head:'h',files:[a,b]},'sync',f=>f===a?new Promise(done=>resolve=done):Promise.resolve('@@ -1 +1 @@\n-old second\n+new second'),()=>{},()=>{});
 const buttons=r.querySelectorAll('.gobog-review-file');buttons[1].click();await tick();resolve('@@ -1 +1 @@\n-old first\n+new first');await tick();assert.match(r.querySelector('.gobog-review-patch').textContent,/new second/);assert.doesNotMatch(r.querySelector('.gobog-review-patch').textContent,/new first/);
 const input=r.querySelector('input[type=search]');input.value='second';input.dispatchEvent(new input.ownerDocument.defaultView.Event('input'));assert.equal(buttons[0].hidden,true);assert.equal(buttons[1].hidden,false);assert.equal(r.querySelectorAll('.gobog-review-file').length,2);
});
test('file text is not interpreted as HTML and footer actions keep confirmation explicit',async()=>{
 const r=root();let yes=0,no=0;mountReviewView(r,{tree:'t',head:'h',files:[{...file(),title:'<img src=x onerror=alert(1)>',binary:true}]},'sync',async()=>'',()=>no++,()=>yes++);
 assert.equal(r.querySelector('img'),null);assert.match(r.querySelector('.gobog-review-title').textContent,/<img/);assert.match(r.querySelector('.gobog-review-patch').textContent,/二进制/);
 r.querySelector('.gobog-review-footer button').click();r.querySelector('.gobog-review-footer .mod-cta').click();assert.equal(no,1);assert.equal(yes,1);
});
