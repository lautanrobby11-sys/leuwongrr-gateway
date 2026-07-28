import { describe,expect,it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolveRoute } from '../src/policy/allowlist.js';
import { requireModel,PolicyError } from '../src/policy/capabilities.js';
import { assertPublicEgress } from '../src/policy/egress.js';
import { BoundedSemaphore,OverloadError } from '../src/policy/semaphore.js';

const base={API_KEY_PEPPER:'x'.repeat(32),INTERNAL_READY_TOKEN:'y'.repeat(32)};
describe('configuration guardrails',()=>{
  it('accepts canonical loopback values',()=>expect(loadConfig(base)).toMatchObject({GATEWAY_HOST:'127.0.0.1',GATEWAY_PORT:2080,OMNIROUTE_URL:'http://127.0.0.1:20128'}));
  it('rejects public bind',()=>expect(()=>loadConfig({...base,GATEWAY_HOST:'0.0.0.0'})).toThrow());
  it('rejects non-loopback upstream',()=>expect(()=>loadConfig({...base,OMNIROUTE_URL:'https://router.example.com'})).toThrow());
});
describe('explicit route and capability policy',()=>{
  it('allows only registered method/path',()=>{expect(resolveRoute('POST','/v1/chat/completions')).toBe('chat.completions');expect(resolveRoute('POST','/v1/unknown')).toBeNull();expect(resolveRoute('GET','/admin')).toBeNull();});
  it('rejects capability mismatch before upstream',()=>expect(()=>requireModel('lwrr-text',['tools'])).toThrow(PolicyError));
});
describe('egress policy',()=>{
  it.each(['http://example.com','https://127.0.0.1/x','https://169.254.169.254/latest','https://10.0.0.1','https://metadata.google.internal'])('rejects %s',(url)=>expect(()=>assertPublicEgress(url)).toThrow());
  it('accepts public HTTPS hostname',()=>expect(assertPublicEgress('https://hooks.example.com/event').hostname).toBe('hooks.example.com'));
});
describe('bounded concurrency',()=>{
  it('fails fast rather than queueing',async()=>{const gate=new BoundedSemaphore(1);let release!:()=>void;const first=gate.run(()=>new Promise<void>(r=>{release=r;}));await Promise.resolve();await expect(gate.run(async()=>undefined)).rejects.toBeInstanceOf(OverloadError);release();await first;});
});
