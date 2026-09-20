import { networkInterfaces } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
  buildMSearch, discoverOnce, localBroadcastAddresses, looksLikeSsdpReply, parseSsdpReply, runBursts,
} from '../src/protocol/discovery.js';
import { FakeFan } from './fake-fan.js';

vi.mock('node:os', async importOriginal => ({ ...(await importOriginal<typeof import('node:os')>()), networkInterfaces: vi.fn() }));

describe('M-SEARCH', () => {
  it('is byte-identical to the app request', () => {
    expect(buildMSearch('192.168.1.255').toString('ascii')).toBe(
      'M-SEARCH * HTTP/1.1\r\nHOST:192.168.1.255:50125\r\nMAN:"ssdp:discover"\r\nMX:3\r\n' +
      'ST:urn:schemas-upnp-org:device:PANA013Adevices:1\r\n\r\n',
    );
  });

  it('follows the app schedule: bursts spaced by the interval, then a collect period', async () => {
    const sends: number[] = [];
    const t0 = Date.now();
    await runBursts(() => sends.push(Date.now() - t0), { bursts: 3, burstIntervalMs: 20, collectMs: 30 });
    expect(sends).toHaveLength(3);
    expect(sends[1]! - sends[0]!).toBeGreaterThanOrEqual(15);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(65);
  });
});

describe('parseSsdpReply', () => {
  // Verbatim reply from an FM12GC with the guid shortened. It mixes ':' and '=' separators.
  const guid = '233d15ecf4b4bf7aca3e2bb5ec40bc73ef1b24d813e3d4cf5b2c9b7d2e406bf3';
  const reply =
    'HTTP/1.1 200 OK\r\nCACHE-CONTROL:max-age = 1800\r\nDATE:Mon, 19 Sep 2026 16:10:40 GMT\r\nEXT:\r\n' +
    'LOCATION:10.1.254.3\r\n' + `HASHGUID=${guid}\r\n` + 'COMMID=FM15GC\r\nPARTID=E48GP\r\n' +
    'SERVER:OS/Version UPnP/1.0 Product/Version\r\nST:urn:schemas-upnp-org:device:PANA013Adevices:1\r\n' +
    'USN:uuid:4D454930-0101-1000-8000-7061bea08d07::urn:schemas-upnp-org:device:PANA013Adevices:1\r\n\r\n';

  it('extracts every header the app reads', () => {
    expect(parseSsdpReply(reply, '10.0.0.1')).toEqual({
      ip: '10.1.254.3', guid, commId: 'FM15GC', partId: 'E48GP', known: true, hasLight: true,
    });
  });

  it('accepts colon separators everywhere, bare newlines, and takes the first of a repeated header', () => {
    const fan = parseSsdpReply('HTTP/1.1 200 OK\nLOCATION:1.2.3.4\nHASHGUID:abc\nHASHGUID:def\nCOMMID:FM14EC\nPARTID:x\n\n', '');
    expect(fan).toMatchObject({ ip: '1.2.3.4', guid: 'abc', commId: 'FM14EC', partId: 'x', hasLight: false });
  });

  it('marks no-light models and unknown models', () => {
    expect(parseSsdpReply(reply.replace('FM15GC', 'fm14ec'), '')).toMatchObject({ commId: 'FM14EC', known: true, hasLight: false });
    expect(parseSsdpReply(reply.replace('FM15GC', 'ZZ99'), '')).toMatchObject({ commId: 'ZZ99', known: false, hasLight: true });
  });

  it('falls back to the sender IP when LOCATION is missing or malformed, and rejects replies without HASHGUID', () => {
    expect(parseSsdpReply(reply.replace('LOCATION:10.1.254.3\r\n', ''), '10.0.0.7')?.ip).toBe('10.0.0.7');
    expect(parseSsdpReply(reply.replace('10.1.254.3', 'http://x'), '10.0.0.7')?.ip).toBe('10.0.0.7');
    expect(parseSsdpReply('HTTP/1.1 200 OK\r\n\r\n', '10.0.0.7')).toBeUndefined();
  });

  it('distinguishes SSDP text from ECHONET frames', () => {
    expect(looksLikeSsdpReply(Buffer.from(reply))).toBe(true);
    expect(looksLikeSsdpReply(Uint8Array.from(Buffer.from(reply)))).toBe(true);
    expect(looksLikeSsdpReply(Buffer.from('1081000105FF01013A017200', 'hex'))).toBe(false);
    expect(looksLikeSsdpReply(Buffer.from('HT'))).toBe(false);
  });
});

describe('localBroadcastAddresses', () => {
  it('computes the directed broadcast of every external IPv4 interface', () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '', cidr: null }],
      en0: [
        { address: '10.1.254.20', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null },
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, mac: '', cidr: null, scopeid: 1 },
      ],
      en1: [{ address: '192.168.4.7', netmask: '255.255.252.0', family: 'IPv4', internal: false, mac: '', cidr: null }],
      bad: [{ address: '1.2.3.4', netmask: 'x', family: 'IPv4', internal: false, mac: '', cidr: null }],
      none: undefined,
    });
    expect(localBroadcastAddresses()).toEqual(['10.1.254.255', '192.168.7.255']);
  });
});

describe('discoverOnce', () => {
  it('finds a fan from a temporary socket, resolves with nothing when none answers, and survives a bad address', async () => {
    const fan = new FakeFan();
    await fan.start();
    try {
      const options = { discoveryPort: fan.discoveryPort, bindAddress: '127.0.0.1', bursts: 2, burstIntervalMs: 20, collectMs: 60 };
      const found = await discoverOnce(['127.0.0.1'], options);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ guid: fan.guid, ip: '127.0.0.1', commId: 'FM15GC' });
      // an unreachable address is skipped, the reachable one still answers
      expect(await discoverOnce(['0.0.0.1', '127.0.0.1'], options)).toHaveLength(1);
      fan.silent = true;
      expect(await discoverOnce(['127.0.0.1'], { ...options, bursts: 1, collectMs: 40 })).toEqual([]);
    } finally {
      fan.stop();
    }
  });

  it('reports the send error when no address could be reached', async () => {
    await expect(discoverOnce(['192.0.2.1'], { bindAddress: '127.0.0.1', bursts: 1, collectMs: 10 })).rejects.toThrow(/M-SEARCH/);
  });

  it('rejects when the socket cannot be bound', async () => {
    await expect(discoverOnce(['127.0.0.1'], { bindAddress: '203.0.113.1', bursts: 1, collectMs: 10 })).rejects.toThrow();
  });
});
