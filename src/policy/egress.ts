import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export class EgressError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'EgressError';
  }
}

/** Names that never belong to a legitimate third-party integration. */
const FORBIDDEN_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data'
]);

const FORBIDDEN_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

export const systemResolver: AddressResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/** Anything that is not routable public IPv4 unicast, including malformed input. */
function privateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

const IPV4_IN_IPV6_DOTTED = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/;
const IPV4_IN_IPV6_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * IPv6 hides IPv4 in two shapes and Node normalises the dotted form into hex,
 * so both are unpacked before judgement. Missing that is how ::ffff:169.254.169.254
 * reaches a cloud metadata service through a check that only reads IPv4.
 */
function privateIpv6(address: string): boolean {
  const value = (address.split('%')[0] ?? '').toLowerCase();
  if (value === '::' || value === '::1') return true;
  const dotted = IPV4_IN_IPV6_DOTTED.exec(value);
  if (dotted?.[1]) return privateIpv4(dotted[1]);
  const hex = IPV4_IN_IPV6_HEX.exec(value);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return privateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (/^f[cd]/.test(value)) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith('ff')) return true;
  if (value.startsWith('64:ff9b')) return true;
  if (value.startsWith('2002:')) return true;
  return false;
}

/** True for every address the gateway must refuse to contact. */
export function forbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family === 6) return privateIpv6(address);
  return true;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

/** Literal inspection of a target: protocol, credentials, name, and address. */
export function assertPublicEgress(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new EgressError('egress_https_required');
  if (url.username !== '' || url.password !== '') {
    throw new EgressError('egress_credentials_forbidden');
  }
  const host = hostnameOf(url);
  if (host === '') throw new EgressError('egress_target_forbidden');
  if (FORBIDDEN_HOSTS.has(host)) throw new EgressError('egress_target_forbidden');
  if (FORBIDDEN_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new EgressError('egress_target_forbidden');
  }
  if (isIP(host) !== 0 && forbiddenAddress(host)) throw new EgressError('egress_target_forbidden');
  return url;
}

/**
 * A name check cannot stop a public hostname that answers with a private
 * address, so operator-supplied targets are resolved and every answer is
 * judged before the request is made. DNS can still change between this check
 * and the connection; that residual window is accepted deliberately and is
 * bounded by the loopback-only bind and the host firewall (ADR-011).
 */
export async function assertResolvedPublicEgress(
  raw: string,
  resolver: AddressResolver = systemResolver
): Promise<URL> {
  const url = assertPublicEgress(raw);
  const host = hostnameOf(url);
  if (isIP(host) !== 0) return url;
  let addresses: readonly string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new EgressError('egress_dns_failed');
  }
  if (addresses.length === 0) throw new EgressError('egress_dns_empty');
  for (const address of addresses) {
    if (forbiddenAddress(address)) throw new EgressError('egress_target_forbidden');
  }
  return url;
}
