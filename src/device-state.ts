import type { DeviceBaseline, DeleteIntent } from './sync-types';
export interface DeviceState {baseline?:DeviceBaseline;deletes:DeleteIntent[];pendingCommit?:string;pendingParent?:string;mirrors?:Array<{path:string;sha:string;beforeSha?:string}>}
const fallback=new Map<string,string>();const key=(repo:string)=>'gobog-device-state-v1:'+repo;
export function loadDeviceState(repoKey:string):DeviceState {
 const raw=typeof localStorage==='undefined'?fallback.get(key(repoKey)):localStorage.getItem(key(repoKey));if(!raw)return {deletes:[]};
 try{const value=JSON.parse(raw);if(!value||!Array.isArray(value.deletes)||value.baseline&&value.baseline.repoKey!==repoKey)throw new Error();return value;}catch{return{deletes:[]};}
}
export function saveDeviceState(repoKey:string,state:DeviceState):void {
 const raw=JSON.stringify(state);if(typeof localStorage==='undefined')fallback.set(key(repoKey),raw);else localStorage.setItem(key(repoKey),raw);
}
