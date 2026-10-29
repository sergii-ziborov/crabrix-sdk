import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {Crabrix,PLAYGROUND_LIMITS} from '../src/index';
test('ESM and CommonJS expose a real library without launching a compiler or MCP',async()=>{
 for(const format of ['esm','commonjs']) { const entry=path.resolve('dist/index.'+(format==='esm'?'mjs':'cjs'));const code=format==='esm'?`const {Crabrix}=await import(${JSON.stringify('file://'+entry)});const c=new Crabrix();console.log(JSON.stringify(await c.status()));c.close();`:`const {Crabrix}=require(${JSON.stringify(entry)});(async()=>{const c=new Crabrix();console.log(JSON.stringify(await c.status()));c.close()})()`;const r=spawnSync(process.execPath,['--input-type='+(format==='esm'?'module':'commonjs'),'-e',code],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).connected,false);assert.equal(r.stderr,''); }
 const client=new Crabrix({name:'Library agent'});assert.equal((await client.status()).connected,false);client.close();await assert.rejects(()=>client.status(),/closed/);
 assert.equal(PLAYGROUND_LIMITS.maximumLifetimeSeconds,86400);
});
test('participant labels are bounded and cannot inject controls or malformed Unicode',()=>{for(const name of ['', '\nagent', 'a'.repeat(41),'\ud800'])assert.throws(()=>new Crabrix({name}));});
test('bounded operation queue refuses overload and close cancels pending calls',async()=>{const client=new Crabrix();const requests=Array.from({length:60},()=>client.status());client.close();const result=await Promise.allSettled(requests);assert(result.every(x=>x.status==='rejected'));});
