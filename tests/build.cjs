const esbuild=require('esbuild');
(async()=>{
 for(const file of ['git','frontmatter','preview','review','review-view','editor-time','property-view']) await esbuild.build({entryPoints:[`src/${file}.ts`],bundle:true,platform:'node',format:'cjs',alias:{obsidian:'./tests/obsidian-stub.cjs'},external:['@codemirror/view','@codemirror/state'],outfile:`.test-build/${file}.cjs`});
 await esbuild.build({entryPoints:['src/deploy-status.ts'],bundle:true,platform:'node',format:'cjs',alias:{obsidian:'./tests/obsidian-stub.cjs'},external:['@codemirror/view','@codemirror/state'],outfile:'.test-build/deploy-status.cjs'});
 await esbuild.build({entryPoints:['src/main.ts'],bundle:true,platform:'node',format:'cjs',alias:{obsidian:'./tests/obsidian-stub.cjs'},external:['@codemirror/view','@codemirror/state'],outfile:'.test-build/plugin.cjs'});
})().catch(e=>{console.error(e);process.exitCode=1});
