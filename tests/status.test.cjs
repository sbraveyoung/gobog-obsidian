const {test}=require('node:test');const assert=require('node:assert/strict');const {getLatestDeploy}=require('../.test-build/deploy-status.cjs');
const opts={repo:'public/site',workflow:'deploy.yml',token:'scoped-source-token'};
function run(id,created){return {id,status:'completed',conclusion:'success',html_url:'https://example.com/run/'+id,event:'repository_dispatch',head_commit:{message:'deploy'},created_at:created,updated_at:created}}
test('scoped source token falls back to anonymous read for public deploy status',async t=>{
 t.after(()=>delete global.__gobogRequest);global.__gobogRequest=({headers})=>headers.Authorization?{status:403,text:'Not accessible'}:{status:200,text:JSON.stringify({workflow_runs:[run(2,'2026-10-12T12:00:00Z')]})};
 const r=await getLatestDeploy(opts);assert.equal(r.id,2);
});
test('old successful deployment cannot be reported for a new push',async t=>{
 t.after(()=>delete global.__gobogRequest);global.__gobogRequest=()=>({status:200,text:JSON.stringify({workflow_runs:[run(1,'2026-10-11T12:00:00Z')]})});
 const r=await getLatestDeploy({...opts,createdAfter:'2026-10-12T12:00:00Z'});assert.equal(r,null);
});
