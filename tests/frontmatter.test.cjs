const {test}=require('node:test');const assert=require('node:assert/strict');
const {ensureFrontMatter}=require('../.test-build/frontmatter.cjs');
const defaults={title:'Title: with # punctuation',author:'author',id:'abcd',url:'/post/abcd',create_time:'2026-10-12 12:00:00',updated_time:'2026-10-12 12:00:00',draft:true};
test('new metadata quotes YAML-sensitive titles and defaults to draft',()=>{
 const result=ensureFrontMatter('body',defaults);
 assert.ok(result.includes('title: "Title: with # punctuation"'));
 assert.ok(result.includes('draft: true\n'));
});
test('explicit publication and existing custom metadata remain intact',()=>{
 const original='---\ntitle: Existing\npublish: true\ncustom: value\n---\nbody';
 const result=ensureFrontMatter(original,defaults);
 assert.ok(result.includes('publish: true'));assert.ok(result.includes('custom: value'));assert.ok(!result.includes('draft: true'));
});
