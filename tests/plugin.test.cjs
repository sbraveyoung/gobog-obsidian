const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');
const Plugin=require('../.test-build/plugin.cjs').default;
const {FileSystemAdapter,TFile}=require('./obsidian-stub.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gobog-plugin-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const p=new Plugin();p.settings={blogFolder:'blog',defaultAuthor:'test',urlPattern:'/post/{{id}}',confirmBeforePush:false,gitName:'test',gitEmail:'test@example.com',branch:'master',githubToken:'',deployStatusEnabled:false,commitTemplate:'sync'};p.app={vault:{adapter:new FileSystemAdapter(root)},workspace:{getActiveFile:()=>null}};p.blogFolderAbs=()=>path.join(root,'blog');fs.mkdirSync(path.join(root,'blog'));return {root,p}}
function git(dir,...args){return execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}
test('plugin retries push when worktree is clean but commit is pending',async t=>{
 const {root,p}=fixture(t);const dir=path.join(root,'blog');git(dir,'init','-b','master');git(dir,'config','user.name','test');git(dir,'config','user.email','test@example.com');fs.writeFileSync(path.join(dir,'note.md'),'note');git(dir,'add','.');git(dir,'commit','-m','pending');
 const remote=path.join(root,'remote.git');fs.mkdirSync(remote);git(remote,'init','--bare','-b','master');p.settings.repoUrl=remote;p.requireRepoConfigured=()=>{};
 await p.runPush();assert.equal(git(remote,'rev-parse','master'),git(dir,'rev-parse','HEAD'));
});
test('preview opens permanent front matter route over localhost HTTP',t=>{
 const {root,p}=fixture(t);const note=path.join(root,'blog/post/Chinese note.md');fs.mkdirSync(path.dirname(note),{recursive:true});fs.writeFileSync(note,'---\nurl: /post/stable-id\n---\nbody');
 p.app.workspace.getActiveFile=()=>({path:'blog/post/Chinese note.md'});p.previewOrigin='http://127.0.0.1:45678';
 assert.equal(p.previewURL(root),'http://127.0.0.1:45678/post/stable-id/');
});
