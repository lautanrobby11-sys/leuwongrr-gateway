import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const forbidden=/(?:^|[._-])(new|final2?|fix(?:ed)?|hotfix|patch|override|backup|old|temp)(?:[._-]|$)/i;
const ignored=new Set(['.git','node_modules','dist','data','logs','runtime','.release','coverage']);
const canonicalExceptions=new Set(['scripts/backup.sh']);
const violations=[];
/**
 * Per-test inline `timeout` options silently override vitest.config.ts, which is
 * how the release gate stayed red on an operator workstation while the same
 * commit was green on Linux CI. The global budget is the single source of truth.
 */
const inlineTimeout=/\btimeout:\s*\d[\d_]*/;
const timeoutViolations=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(ignored.has(entry.name))continue;const path=join(dir,entry.name);const rel=relative(process.cwd(),path).split(sep).join('/');if(!canonicalExceptions.has(rel)&&(forbidden.test(entry.name)||entry.name==='docker-compose.override.yml'))violations.push(rel);if(entry.isDirectory()){await walk(path);continue;}if(rel.startsWith('tests/')&&rel.endsWith('.ts')){const source=await readFile(path,'utf8');source.split('\n').forEach((line,index)=>{if(inlineTimeout.test(line))timeoutViolations.push(`${rel}:${index+1}: ${line.trim()}`);});}}}
await walk(process.cwd());
if(violations.length){console.error(`Forbidden duplicate/suffix paths:\n${violations.join('\n')}`);process.exit(1);}
if(timeoutViolations.length){console.error(`Inline test timeouts override vitest.config.ts; set the budget globally instead:\n${timeoutViolations.join('\n')}`);process.exit(1);}
console.log('Convention gate passed');
