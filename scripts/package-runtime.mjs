import {mkdirSync,existsSync,copyFileSync,readFileSync} from 'node:fs';import {resolve} from 'node:path';
const destination=process.argv[2];if(!destination)throw new Error('Usage: node scripts/package-runtime.mjs NEW_OUTPUT_DIRECTORY');
const target=resolve(destination);if(existsSync(target))throw new Error('Destination already exists; choose an empty new directory.');
const manifest=JSON.parse(readFileSync('manifest.json','utf8'));if(!existsSync('main.js')||!manifest.version)throw new Error('Run npm run build first.');
mkdirSync(target,{recursive:true});for(const file of ['main.js','manifest.json','styles.css'])copyFileSync(file,resolve(target,file));console.log(`Runtime ${manifest.version}: ${target}`);
