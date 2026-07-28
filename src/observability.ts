import pino, { type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: { paths: ['req.headers.authorization','req.headers.cookie','*.api_key','*.token','*.secret','*.prompt','*.messages'], censor: '[REDACTED]' },
    serializers: { err: pino.stdSerializers.err }
  });
}
