/** Git hashes the blob header and exact bytes, including non-ASCII text. */
export async function gitBlobSha(bytes:Uint8Array):Promise<string>{
 const head=new TextEncoder().encode(`blob ${bytes.byteLength}\0`),input=new Uint8Array(head.length+bytes.length);input.set(head);input.set(bytes,head.length);
 if(!globalThis.crypto?.subtle)throw new Error('此设备不支持安全内容校验，请更新 Obsidian。');
 const digest=await crypto.subtle.digest('SHA-1',input);return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
