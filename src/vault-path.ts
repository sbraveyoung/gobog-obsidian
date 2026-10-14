export function normalizeSourcePath(path:string):string {
 if(path.includes('\\')||/[\0\r\n]/.test(path))throw new Error('Invalid source path');
 const parts:string[]=[];for(const p of path.split('/')){if(!p||p==='.')continue;if(p==='..'){if(!parts.length)throw new Error('Path escapes vault');parts.pop();}else parts.push(p);}return parts.join('/');
}
export function within(path:string,folder:string):boolean{return path===folder||path.startsWith(folder+'/');}
export const imagePattern=/\.(?:png|jpe?g|gif|svg|webp|avif|bmp|heic|ico|tiff?)(?:[?#].*)?$/i;
export function isImage(path:string):boolean{return imagePattern.test(path);}
export function sourceContentPath(path:string):boolean {
 return !!path&&!path.split('/').some(p=>p.startsWith('.')||p==='node_modules'||p==='preview'||p==='dist') && !/^(?:main\.js|package(?:-lock)?\.json)$/i.test(path);
}
