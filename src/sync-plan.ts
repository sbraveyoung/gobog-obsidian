export function classifyChange(base:string|undefined,local:string|undefined,remote:string|undefined):'same'|'local'|'remote'|'conflict'|'missing'{
 if(local===remote)return 'same';if(local===undefined)return 'missing';if(base===undefined)return remote===undefined?'local':'conflict';if(local===base)return 'remote';if(remote===base)return 'local';return 'conflict';
}
