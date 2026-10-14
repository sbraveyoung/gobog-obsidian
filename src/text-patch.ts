export function createTextPatch(path:string,before:string,after:string,full:boolean):string {
 if(before===after)return '';
 const a=before.split('\n'),b=after.split('\n');if(a[a.length-1]==='')a.pop();if(b[b.length-1]==='')b.pop();let prefix=0,suffix=0;
 while(prefix<Math.min(a.length,b.length)&&a[prefix]===b[prefix])prefix++;
 while(suffix<Math.min(a.length,b.length)-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 const x=a.slice(prefix,a.length-suffix),y=b.slice(prefix,b.length-suffix);const rows:Array<{kind:string;text:string;old:number;next:number}>=[];let old=1,next=1;
 const append=(kind:string,text:string)=>{rows.push({kind,text,old,next});if(kind!=='+' )old++;if(kind!=='-')next++;};
 a.slice(0,prefix).forEach(t=>append(' ',t));
 if(x.length*y.length<=250000){const width=y.length+1,table=new Uint32Array((x.length+1)*width);
  for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)table[i*width+j]=x[i]===y[j]?table[(i+1)*width+j+1]+1:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
  let i=0,j=0;while(i<x.length||j<y.length){if(i<x.length&&j<y.length&&x[i]===y[j]){append(' ',x[i++]);j++;}else if(i<x.length&&(j===y.length||table[(i+1)*width+j]>=table[i*width+j+1]))append('-',x[i++]);else append('+',y[j++]);}
 }else{x.forEach(t=>append('-',t));y.forEach(t=>append('+',t));}
 a.slice(a.length-suffix).forEach(t=>append(' ',t));const changed=rows.map((r,i)=>r.kind!==' '?i:-1).filter(i=>i>=0);
 // A final newline-only change must still be visible in raw diff.
 if(!changed.length)return `--- a/${path}\n+++ b/${path}\n@@ -${a.length},1 +${b.length},1 @@\n-${a[a.length-1]||''}\n+${b[b.length-1]||''}\n\\ ${before.endsWith('\n')?'新增无末尾换行':'补全末尾换行'}\n`;
 const ranges:Array<[number,number]>=[];for(const i of changed){const start=full?0:Math.max(0,i-3),end=full?rows.length:Math.min(rows.length,i+4),last=ranges[ranges.length-1];if(last&&start<=last[1])last[1]=Math.max(last[1],end);else ranges.push([start,end]);}
 const out=[`--- a/${path}`,`+++ b/${path}`];for(const [start,end]of ranges){const part=rows.slice(start,end),ca=part.filter(r=>r.kind!=='+').length,cb=part.filter(r=>r.kind!=='-').length;out.push(`@@ -${ca?part[0].old:Math.max(0,part[0].old-1)},${ca} +${cb?part[0].next:Math.max(0,part[0].next-1)},${cb} @@`,...part.map(r=>r.kind+r.text));}return out.join('\n')+'\n';
}
