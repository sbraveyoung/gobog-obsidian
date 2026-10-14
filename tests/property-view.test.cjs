const {test}=require('node:test');const assert=require('node:assert/strict');const {parseHTML}=require('linkedom');
let mountPropertyView;try{({mountPropertyView}=require('../.test-build/property-view.cjs'))}catch{}
test('property editor validates selected fields and prepares publication without clearing hidden',async()=>{
 const {document}=parseHTML('<html><body><main></main></body></html>');const root=document.querySelector('main');let saved,cancelled=false;
 mountPropertyView(root,{title:'draft',id:'stable',url:'/stable',draft:true,publish:false,hidden:true,tags:['go']},{public:false,reasons:['hidden: true']},async v=>{saved=v},()=>cancelled=true);
 assert.match(root.textContent,/hidden/);root.querySelector('[data-action="publish"]').click();await Promise.resolve();assert.equal(saved.draft,false);assert.equal(saved.publish,true);assert.equal(saved.hidden,undefined);assert.equal(saved.id,undefined);root.querySelector('[data-action="cancel"]').click();assert.equal(cancelled,true);
});
