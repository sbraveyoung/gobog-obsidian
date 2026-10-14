import { articleBody, patchProperties } from './article-properties';
export interface TimeWriter { userEdit(path:string,before:string,after:string,composing:boolean):void; flush():Promise<void>;dispose():void }
export function createTimeWriter(options:{enabled:()=>boolean;eligible:(path:string)=>boolean;process:(path:string,transform:(text:string)=>string)=>Promise<void>;now:()=>string;delayMs:number;fail:(error:unknown)=>void}):TimeWriter {
 const pending=new Map<string,{body:string;stamp:string;composing:boolean;timer?:ReturnType<typeof setTimeout>}>();const running=new Set<Promise<void>>();let disposed=false;
 function write(path:string):Promise<void> {
  const item=pending.get(path);if(!item||item.composing)return Promise.resolve();
  pending.delete(path);if(item.timer)clearTimeout(item.timer);if(disposed||!options.enabled())return Promise.resolve();
  const task=options.process(path,text=>articleBody(text)===item.body?patchProperties(text,{updated_time:item.stamp}):text).catch(options.fail);
  running.add(task);void task.finally(()=>running.delete(task));return task;
 }
 return {
  userEdit(path,before,after,composing) {
   if(disposed||!options.enabled()||!options.eligible(path))return;
   try {
    const body=articleBody(after),previous=pending.get(path);
    if(articleBody(before)===body&&!(previous?.composing&&!composing&&previous.body===body))return;
    if(previous?.timer)clearTimeout(previous.timer);
    const item={body,stamp:options.now(),composing,timer:undefined as ReturnType<typeof setTimeout>|undefined};pending.set(path,item);
    if(!composing)item.timer=setTimeout(()=>void write(path),options.delayMs);
   }catch(e){options.fail(new Error(`${path}: ${String(e)}`));}
  },
  async flush(){for(const path of [...pending.keys()])await write(path);await Promise.all([...running]);},
  dispose(){disposed=true;for(const item of pending.values())if(item.timer)clearTimeout(item.timer);pending.clear();}
 };
}
