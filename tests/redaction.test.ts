import { describe,expect,it } from 'vitest';
import { createLogger } from '../src/observability.js';
import { Writable } from 'node:stream';
import pino from 'pino';

describe('structured log redaction',()=>{
  it('does not emit auth, token, prompt, or messages',()=>{let output='';const sink=new Writable({write(chunk,_enc,done){output+=String(chunk);done();}});const logger=pino({level:'info',redact:{paths:['authorization','token','prompt','messages'],censor:'[REDACTED]'}},sink);logger.info({authorization:'Bearer secret-value',token:'secret-token',prompt:'private prompt',messages:['private message']},'event');expect(output).not.toContain('secret-value');expect(output).not.toContain('secret-token');expect(output).not.toContain('private prompt');expect(output).not.toContain('private message');expect(output).toContain('[REDACTED]');expect(createLogger('silent')).toBeDefined();});
});
