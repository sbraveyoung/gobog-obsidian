import type { ReviewSnapshot } from './review';
export type { DeleteIntent } from './asset-audit';
import type { DeleteIntent } from './asset-audit';
export interface SyncConfig { repoUrl:string;branch:string;githubToken:string;authorName:string;authorEmail:string }
export interface SourceFile { path:string;sha:string;bytes:Uint8Array }
export interface RemoteTree { head:string;tree:string;files:Record<string,string>;modes?:Record<string,string> }
export interface DeviceBaseline { repoKey:string;head:string;files:Record<string,string> }
export interface SyncChange { path:string;beforeSha?:string;after?:SourceFile;explicitDelete?:DeleteIntent }
export interface PreparedPush {
 remote:RemoteTree;changes:SyncChange[];review:ReviewSnapshot;patches:Record<string,{compact:string;full:string}>;
 imported:SourceFile[];replacements:Record<string,{before:string;after:string}>;
 originals:Record<string,string>;stats?:Record<string,{mtime:number;size:number}>;warnings:string[];
}
export interface SyncBackend {prepare():Promise<PreparedPush>;publish(snapshot:PreparedPush,message:string):Promise<string>;pull():Promise<void>;status():Promise<string>;dispose():void}
