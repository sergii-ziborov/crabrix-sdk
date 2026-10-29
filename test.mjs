import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
const files=(await readdir('test')).filter(x=>x.endsWith('.test.ts'));
await build({entryPoints:files.map(n=>'test/'+n),outdir:'build/tests',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:'import {createRequire as __req} from "node:module"; const require=__req(import.meta.url);'}});
const result=spawnSync(process.execPath,['--test',...files.map(n=>'build/tests/'+n.replace(/\.ts$/,'.mjs'))],{stdio:'inherit'});process.exitCode=result.status??1;
