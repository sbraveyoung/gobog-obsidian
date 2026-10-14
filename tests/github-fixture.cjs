const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
function gitApiFixture(t,initial={'post/a.md':'---\nid: a\nurl: /a\ndraft: true\npublish: false\n---\nbase\n'}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gobog-api-'));t.after(()=>{delete global.__gobogRequest;fs.rmSync(root,{recursive:true,force:true})});
 const git=(args,input,env={})=>execFileSync('git',args,{cwd:root,input,env:{...process.env,...env},encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 git(['init','-q','-b','master']);git(['config','user.name','test']);git(['config','user.email','test@example.com']);for(const [p,text]of Object.entries(initial)){fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),text)}git(['add','.']);git(['commit','-qm','initial']);
 const calls=[];const response=(status,data)=>({status,text:JSON.stringify(data),json:data});const handler=async args=>{
  const u=new URL(args.url),route=u.pathname.replace(/^\/repos\/owner\/blog\//,'');const body=args.body?JSON.parse(args.body):{};const method=args.method||'GET';calls.push({method,route,body});
  if(method==='GET'&&route.startsWith('git/ref/heads/'))return response(200,{ref:'refs/heads/master',object:{type:'commit',sha:git(['rev-parse','master'])}});
  if(method==='GET'&&route.startsWith('git/commits/')){const sha=route.split('/').pop();return response(200,{sha,tree:{sha:git(['rev-parse',sha+'^{tree}'])},parents:[]})}
  if(method==='GET'&&route.startsWith('git/trees/')){const sha=route.split('/').pop();const raw=execFileSync('git',['ls-tree','-r','-z','--long',sha],{cwd:root,encoding:'utf8'});const tree=raw.split('\0').filter(Boolean).map(line=>{const [info,p]=line.split('\t');const [mode,type,blob,size]=info.trim().split(/\s+/);return{path:p,mode,type,sha:blob,size:Number(size)}});return response(200,{sha,tree,truncated:false})}
  if(method==='GET'&&route.startsWith('git/blobs/')){const bytes=execFileSync('git',['cat-file','blob',route.split('/').pop()],{cwd:root});return response(200,{sha:route.split('/').pop(),content:bytes.toString('base64'),encoding:'base64',size:bytes.length})}
  if(method==='POST'&&route==='git/blobs')return response(201,{sha:git(['hash-object','-w','--stdin'],Buffer.from(body.content,body.encoding))});
  if(method==='POST'&&route==='git/trees'){const index=path.join(root,'api-index-'+calls.length);const env={GIT_INDEX_FILE:index};git(['read-tree',body.base_tree],undefined,env);for(const e of body.tree){if(e.sha===null)git(['update-index','--force-remove','--',e.path],undefined,env);else git(['update-index','--add','--cacheinfo',e.mode,e.sha,e.path],undefined,env)}return response(201,{sha:git(['write-tree'],undefined,env)})}
  if(method==='POST'&&route==='git/commits')return response(201,{sha:git(['commit-tree',body.tree,...body.parents.flatMap(p=>['-p',p]),'-m',body.message])});
  if(method==='PATCH'&&route.startsWith('git/refs/heads/')){try{git(['merge-base','--is-ancestor',git(['rev-parse','master']),body.sha])}catch{return response(422,{message:'not fast forward'})}git(['update-ref','refs/heads/master',body.sha]);return response(200,{ref:'refs/heads/master',object:{sha:body.sha,type:'commit'}})}
  if(method==='GET'&&route.startsWith('compare/')){const [base,head]=route.slice('compare/'.length).split('...');try{git(['merge-base','--is-ancestor',base,head]);return response(200,{status:base===head?'identical':'ahead'})}catch{return response(200,{status:'diverged'})}}
  throw Error('unexpected route '+method+' '+route);
 };
 global.__gobogRequest=handler;return {root,git,calls,handler,config:{repoUrl:'https://github.com/owner/blog.git',branch:'master',githubToken:'test-secret',authorName:'test',authorEmail:'test@example.com'}};
}
module.exports={gitApiFixture};
