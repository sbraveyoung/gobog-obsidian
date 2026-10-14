const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');
const Plugin=require('../.test-build/plugin.cjs').default;
const {FileSystemAdapter,TFile}=require('./obsidian-stub.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gobog-plugin-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const p=new Plugin();p.settings={blogFolder:'blog',defaultAuthor:'test',urlPattern:'/post/{{id}}',confirmBeforePush:false,gitName:'test',gitEmail:'test@example.com',branch:'master',githubToken:'',deployStatusEnabled:false,commitTemplate:'sync'};p.app={vault:{adapter:new FileSystemAdapter(root),getMarkdownFiles:()=>[]},workspace:{getActiveFile:()=>null}};p.blogFolderAbs=()=>path.join(root,'blog');fs.mkdirSync(path.join(root,'blog'));return {root,p}}
function git(dir,...args){return execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}
test('plugin retries push when worktree is clean but commit is pending',async t=>{
 const {root,p}=fixture(t);const dir=path.join(root,'blog');git(dir,'init','-b','master');git(dir,'config','user.name','test');git(dir,'config','user.email','test@example.com');fs.writeFileSync(path.join(dir,'note.md'),'note');git(dir,'add','.');git(dir,'commit','-m','pending');
 const remote=path.join(root,'remote.git');fs.mkdirSync(remote);git(remote,'init','--bare','-b','master');p.settings.repoUrl=remote;p.requireRepoConfigured=()=>{};
 await p.runPush();assert.equal(git(remote,'rev-parse','master'),git(dir,'rev-parse','HEAD'));
});
test('preview opens permanent front matter route over localhost HTTP',t=>{
 const {root,p}=fixture(t);const note=path.join(root,'blog/post/Chinese note.md');fs.mkdirSync(path.dirname(note),{recursive:true});fs.writeFileSync(note,'---\nurl: /post/stable-id\n---\nbody');
 p.app.workspace.getActiveFile=()=>({path:'blog/post/Chinese note.md'});p.previewOrigin='http://127.0.0.1:45678';
 assert.equal(new (require('../.test-build/desktop-runtime.cjs').DesktopRuntime)(p).previewURL(root),'http://127.0.0.1:45678/post/stable-id/');
});
test('folder control files never receive article front matter',async t=>{
 const {root,p}=fixture(t);const note=path.join(root,'blog/post/_folder.md');fs.mkdirSync(path.dirname(note),{recursive:true});const body='---\nhidden: true\n---\nFolder policy';fs.writeFileSync(note,body);
 const f=new TFile();f.path='blog/post/_folder.md';f.extension='md';p.ready=true;p.settings.autoFrontMatter=true;
 await p.onCreate(f);await p.fillFrontMatterForFile(f,true);assert.equal(fs.readFileSync(note,'utf8'),body);
});
test('folder command changes only policy and preserves article and control body',async t=>{
 const {root,p}=fixture(t);const note=path.join(root,'blog/post/series/note.md');fs.mkdirSync(path.dirname(note),{recursive:true});fs.writeFileSync(note,'article');
 p.app.workspace.getActiveFile=()=>({path:'blog/post/series/note.md'});
 p.app.vault.getAbstractFileByPath=rel=>fs.existsSync(path.join(root,rel))?Object.assign(new TFile(),{path:rel}):null;
 p.app.vault.read=async f=>fs.readFileSync(path.join(root,f.path),'utf8');
 p.app.vault.modify=async(f,s)=>fs.writeFileSync(path.join(root,f.path),s);
 p.app.vault.process=async(f,fn)=>fs.writeFileSync(path.join(root,f.path),fn(fs.readFileSync(path.join(root,f.path),'utf8')));
 p.app.vault.create=async(rel,s)=>fs.writeFileSync(path.join(root,rel),s);
 await p.setActiveFolderHidden(true);assert.match(fs.readFileSync(path.join(root,'blog/post/series/_folder.md'),'utf8'),/hidden: true/);
 await p.setActiveFolderHidden(false);assert.match(fs.readFileSync(path.join(root,'blog/post/series/_folder.md'),'utf8'),/hidden: false/);assert.equal(fs.readFileSync(note,'utf8'),'article');
});

test('preview from a folder control opens the homepage rather than a fake article route',t=>{
 const {p}=fixture(t);p.previewOrigin='http://127.0.0.1:45678';p.app.workspace.getActiveFile=()=>({path:'blog/post/series/_folder.md'});
 assert.equal(new (require('../.test-build/desktop-runtime.cjs').DesktopRuntime)(p).previewURL(''),'http://127.0.0.1:45678/');
});
