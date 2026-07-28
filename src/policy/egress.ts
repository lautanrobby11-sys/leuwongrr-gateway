import { isIP } from 'node:net';

const forbiddenHosts = new Set(['localhost','metadata.google.internal']);
function forbiddenIpv4(host: string): boolean {
  const p = host.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && (p[1] ?? 0) >= 16 && (p[1] ?? 0) <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 0;
}
export function assertPublicEgress(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('egress_https_required');
  const host = url.hostname.toLowerCase();
  if (forbiddenHosts.has(host) || host.endsWith('.local') || host === '::1' || (isIP(host) === 4 && forbiddenIpv4(host))) throw new Error('egress_target_forbidden');
  return url;
}
