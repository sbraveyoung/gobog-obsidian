const {test}=require('node:test'),assert=require('node:assert/strict');const {gitApiFixture}=require('./github-fixture.cjs');let GitHubSource,classifyChange;try{({GitHubSource}=require('../.test-build/github-source.cjs'));({classifyChange}=require('../.test-build/sync-plan.cjs'))}catch{}
test('API commit changes only reviewed blobs and atomically advances a nonforced ref',async t=>{
 const f=gitApiFixture(t,{'post/a.md':'old','resource/image/keep.png':'keep'}),api=new GitHubSource(f.config),base=await api.readTree();
 const bytes=new TextEncoder().encode('hello\n');const sha=await api.commit(base,[{path:'post/a.md',beforeSha:base.files['post/a.md'],after:{path:'post/a.md',sha:'ce013625030ba8dba906f756967f9e9ca394464a',bytes}}],'reviewed');
 assert.equal(f.git(['show',sha+':post/a.md']),'hello');assert.equal(f.git(['show',sha+':resource/image/keep.png']),'keep');assert.equal(f.calls.filter(x=>x.route==='git/blobs').length,1);const patch=f.calls.find(x=>x.method==='PATCH');assert.equal(patch.body.force,false);
});
test('a remote advance during review prevents publication',async t=>{
 const f=gitApiFixture(t),api=new GitHubSource(f.config),base=await api.readTree();f.git(['commit','--allow-empty','-qm','other device']);await assert.rejects(()=>api.commit(base,[],'old snapshot'),/改变|changed/);assert.equal(f.calls.some(x=>x.method==='PATCH'),false);
});
test('failed tree creation never publishes a partial branch',async t=>{
 const f=gitApiFixture(t),api=new GitHubSource(f.config),base=await api.readTree();global.__gobogRequest=async args=>args.url.endsWith('/git/trees')?{status:403,text:'{"message":"denied"}'}:f.handler(args);
 await assert.rejects(()=>api.commit(base,[{path:'post/a.md',after:{path:'post/a.md',sha:'ce013625030ba8dba906f756967f9e9ca394464a',bytes:new TextEncoder().encode('hello\n')}}],'x'));assert.equal(f.git(['rev-parse','HEAD']),base.head);assert.equal(f.calls.some(x=>x.method==='PATCH'),false);
});
test('truncated trees are never accepted as a deletion baseline',async t=>{
 const f=gitApiFixture(t),api=new GitHubSource(f.config);global.__gobogRequest=async args=>args.url.includes('/git/trees/')?{status:200,text:'{"sha":"abc","truncated":true,"tree":[]}'}:f.handler(args);await assert.rejects(()=>api.readTree(),/完整|truncated/);
});
test('three-way classification preserves incoming changes conflicts and missing mobile files',()=>{
 for(const [base,local,remote,want]of [['a','a','b','remote'],['a','b','a','local'],['a','b','c','conflict'],['a',undefined,'a','missing'],['a','b','b','same']])assert.equal(classifyChange(base,local,remote),want);
});
test('unknown response after applying ref is recognized without a second commit',async t=>{
 const f=gitApiFixture(t,{'post/a.md':'old'}),api=new GitHubSource(f.config),base=await api.readTree();global.__gobogRequest=async args=>{const res=await f.handler(args);if(args.method==='PATCH')throw Error('response lost');return res;};
 const sha=await api.commit(base,[{path:'post/a.md',after:{path:'post/a.md',sha:'ce013625030ba8dba906f756967f9e9ca394464a',bytes:new TextEncoder().encode('hello\n')}}],'one');assert.equal(f.git(['rev-parse','master']),sha);assert.equal(f.calls.filter(c=>c.route==='git/commits'&&c.method==='POST').length,1);
});
test('pending ref retry reuses the already-created commit',async t=>{
 const f=gitApiFixture(t,{'post/a.md':'old'}),api=new GitHubSource(f.config),base=await api.readTree();let pending;
 global.__gobogRequest=async args=>{if(args.method==='PATCH')throw Error('offline');return f.handler(args)};
 await assert.rejects(()=>api.commit(base,[{path:'post/a.md',after:{path:'post/a.md',sha:'ce013625030ba8dba906f756967f9e9ca394464a',bytes:new TextEncoder().encode('hello\n')}}],'one',sha=>pending=sha));
 global.__gobogRequest=f.handler;await api.resumeCommit(pending,base.head);assert.equal(f.git(['rev-parse','master']),pending);assert.equal(f.calls.filter(c=>c.route==='git/commits'&&c.method==='POST').length,1);
});
