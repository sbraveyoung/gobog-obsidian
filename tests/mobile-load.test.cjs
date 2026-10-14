const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('production mobile bundle loads without evaluating any Node or Electron dependency',()=>{
 const code=fs.readFileSync('main.js','utf8');const obsidian={...require('./obsidian-stub.cjs'),Platform:{isMobile:true,isDesktop:false},editorInfoField:{}};
 const context={module:{exports:{}},exports:{},require:name=>{if(name==='obsidian')return obsidian;if(name==='@codemirror/state')return {Transaction:{remote:{}}};if(name==='@codemirror/view')return {EditorView:{updateListener:{of:fn=>fn},domEventHandlers:fn=>fn}};throw Error('Node dependency evaluated: '+name)},TextEncoder,TextDecoder,crypto:globalThis.crypto,URL,Uint8Array,setTimeout,clearTimeout,console};context.exports=context.module.exports;
 vm.runInNewContext(code,context);assert.equal(typeof context.module.exports.default,'function');
});
