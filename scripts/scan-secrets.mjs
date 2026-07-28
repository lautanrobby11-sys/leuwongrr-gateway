import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ignoredDirs=new Set(['.git','node_modules','dist','data','logs','runtime','.release','coverage']);
const binary=/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|age|db|wasm)$/i;
const patterns=[
  {name:'live gateway key',regex:/lwrr_live_[A-Za-z0-9_-]{20,}/},
  {name:'private key block',regex:/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/},
  {name:'aws access key id',regex:/\bAKIA[0-9A-Z]{16}\b/},
  {name:'github token',regex:/\bgh[pousr]_[A-Za-z0-9]{30,}\b/},
  {name:'slack token',regex:/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/},
  {name:'openai style key',regex:/\bsk-[A-Za-z0-9]{32,}\b/},
  {name:'anthropic style key',regex:/\bsk-ant-[A-Za-z0-9_-]{20,}\b/},
  {name:'google api key',regex:/\bAIza[0-9A-Za-z_-]{35}\b/},
  {name:'cloudflare tunnel token',regex:/\beyJhIjoi[A-Za-z0-9_-]{40,}/}
];
const allowSelf=new Set(['scripts/scan-secrets.mjs']);
const findings=[];

async function walk(dir){
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(ignoredDirs.has(entry.name))continue;
    const path=join(dir,entry.name);
    if(entry.isDirectory()){await walk(path);continue;}
    const rel=relative(process.cwd(),path);
    if(allowSelf.has(rel)||binary.test(entry.name))continue;
    const content=await readFile(path,'utf8').catch(()=>null);
    if(content===null)continue;
    content.split('\n').forEach((line,index)=>{
      for(const pattern of patterns) if(pattern.regex.test(line)) findings.push(`${rel}:${index+1} ${pattern.name}`);
    });
  }
}

await walk(process.cwd());
if(findings.length){console.error(`Potential secrets detected:\n${findings.join('\n')}`);process.exit(1);}
console.log('Secret scan passed');
