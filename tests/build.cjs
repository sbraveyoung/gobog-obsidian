const esbuild=require('esbuild'),fs=require('node:fs'),path=require('node:path');
const apiPlugin={name:'obsidian-test-api',setup(build){build.onResolve({filter:/^obsidian$/},()=>({path:path.resolve('tests/obsidian-stub.cjs'),external:true}));}};
(async()=>{
 for(const file of fs.readdirSync('src').filter(f=>f.endsWith('.ts')))await esbuild.build({entryPoints:[`src/${file}`],bundle:true,platform:'node',format:'cjs',plugins:[apiPlugin],external:['@codemirror/view','@codemirror/state'],outfile:`.test-build/${file.replace(/\.ts$/,'')}.cjs`});
 fs.copyFileSync('.test-build/main.cjs','.test-build/plugin.cjs');
})().catch(e=>{console.error(e);process.exitCode=1});
