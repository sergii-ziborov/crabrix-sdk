import assert from 'node:assert/strict';
import {Crabrix} from '../dist/index.mjs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CRABRIX_PLAYWRIGHT_MODULE??'playwright');
const owner=new Crabrix({name:'JavaScript owner'});const children=[];let browser;
async function until(fn,label){const end=Date.now()+30000;while(!await fn()){if(Date.now()>end)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,200));}}
async function reviewer(file,link){const child=spawn(path.resolve(file),[],{stdio:['pipe','pipe','pipe']});children.push(child);child.stderr.on('data',()=>{});const ready=new Promise((resolve,reject)=>{const lines=createInterface({input:child.stdout});const timer=setTimeout(()=>{lines.close();reject(Error('Reviewer timed out'))},30000);lines.once('line',line=>{clearTimeout(timer);lines.close();if(line.length>4096)return reject(Error('Invalid reviewer response'));try{resolve(JSON.parse(line))}catch{reject(Error('Invalid reviewer JSON'))}});child.once('error',reject);child.once('exit',code=>{if(code)reject(Error('Reviewer failed'))});});child.stdin.write(link+'\n');return ready;}
try{const room=await owner.create({name:'JavaScript Rust Go collaboration proof',files:{'main.rs':'fn main(){println!("shared SDK 🦀");}\n'},lifetimeMinutes:15});
 await reviewer('crates/crabrix/target/debug/examples/reviewer',room.link);
 await until(async()=>{const s=await owner.status();return s.selections?.some(x=>x.name==='Rust agent'&&x.anchor===0&&x.head===9)},'Rust selection');
 await reviewer('build/go-reviewer',room.link);
 await until(async()=>{const s=await owner.status();return s.selections?.some(x=>x.name==='Go agent'&&x.anchor===10&&x.head===14)},'Go selection');
 const source=await owner.read('main.rs');assert.match(source.text,/reviewed by Rust/);assert.match(source.text,/reviewed by Go/);
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(room.link);await page.waitForSelector('.cm-content');await until(async()=>{const text=await page.locator('.cm-content').innerText();return text.includes('reviewed by Rust')&&text.includes('reviewed by Go')},'browser shared source');await page.waitForSelector('.cm-ySelection');
 await page.locator('.cm-content').click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('// reviewed by browser\n');await until(async()=>(await owner.read('main.rs')).text.includes('reviewed by browser'),'browser edit returns to SDK');
 await assert.rejects(()=>owner.apply({expectedRevision:source.revision,changes:[{path:'main.rs',text:'stale overwrite'}]}),/Revision conflict/);
 const status=await owner.status();assert.equal(status.participants.length,4);assert.deepEqual(errors,[]);await page.screenshot({path:'build/cross-language-browser.png'});
 await writeFile('build/cross-language-result.json',JSON.stringify({passed:true,participants:4,languages:['JavaScript','Rust','Go'],web:true,sourceEdits:true,unicode:true,selections:true,staleRevisionRejected:true,errors},null,2)+'\n');console.log('PASS JS ↔ Rust ↔ Go ↔ public browser; code, selections and stale revision guard');
}finally{for(const c of children){c.stdin.end();}await new Promise(r=>setTimeout(r,300));try{await owner.endRoom()}catch{}owner.close();for(const c of children)c.kill();if(browser)await browser.close()}
