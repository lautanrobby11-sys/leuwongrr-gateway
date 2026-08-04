import { describe, expect, it } from 'vitest';
import {
  assertPublicEgress,
  assertResolvedPublicEgress,
  forbiddenAddress
} from '../src/policy/egress.js';

describe('literal egress targets', () => {
  it.each([
    'http://example.com',
    'https://user:pass@example.com',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://[fe80::1]/x',
    'https://[::ffff:169.254.169.254]/latest',
    'https://[2001::1]/x',
    'https://[2001:db8::1]/x',
    'https://100.64.0.1',
    'https://192.0.0.1',
    'https://192.0.2.1',
    'https://198.18.0.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://255.255.255.255',
    'https://relay.internal/send',
    'https://relay.home.arpa/send',
    'https://relay.localhost/send'
  ])('refuses %s', (target) => {
    expect(() => assertPublicEgress(target)).toThrow();
  });

  it.each(['https://104.16.0.1/hook', 'https://192.0.0.9/hook', 'https://192.1.1.1/hook'])(
    'admits public literal address %s',
    (target) => {
      expect(assertPublicEgress(target)).toBeInstanceOf(URL);
    }
  );
});

describe('resolved egress targets', () => {
  const target = 'https://relay.example.com/send';

  it('refuses a public name that answers with a private address', async () => {
    await expect(assertResolvedPublicEgress(target, async () => ['10.0.0.7'])).rejects.toThrow(
      'egress_target_forbidden'
    );
  });

  it('refuses when only one answer of several is private', async () => {
    await expect(
      assertResolvedPublicEgress(target, async () => ['104.16.0.1', '169.254.169.254'])
    ).rejects.toThrow('egress_target_forbidden');
  });

  it('refuses an empty answer rather than falling back to the name', async () => {
    await expect(assertResolvedPublicEgress(target, async () => [])).rejects.toThrow(
      'egress_dns_empty'
    );
  });

  it('refuses a lookup failure rather than proceeding blind', async () => {
    await expect(
      assertResolvedPublicEgress(target, async () => {
        throw new Error('nxdomain');
      })
    ).rejects.toThrow('egress_dns_failed');
  });

  it('admits a name that answers only with public unicast', async () => {
    const url = await assertResolvedPublicEgress(target, async () => [
      '104.16.0.1',
      '2606:4700::1111'
    ]);
    expect(url.hostname).toBe('relay.example.com');
  });

  it('does not resolve a target that is already an address', async () => {
    const url = await assertResolvedPublicEgress('https://104.16.0.1/hook', async () => {
      throw new Error('resolver must not be consulted');
    });
    expect(url.hostname).toBe('104.16.0.1');
  });

  it('treats an unreadable answer as forbidden', () => {
    expect(forbiddenAddress('not-an-address')).toBe(true);
  });
});
