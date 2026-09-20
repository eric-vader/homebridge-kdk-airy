import { RequestError } from '@homebridge/plugin-ui-utils';
import { describe, expect, it, vi } from 'vitest';

// The handler only needs the constants from the built discovery module, so the tests run without a built dist/.
vi.mock('../dist/protocol/discovery.js', () => ({
  DISCOVERY_BURSTS: 3,
  DISCOVERY_BURST_INTERVAL_MS: 1000,
  DISCOVERY_COLLECT_MS: 3000,
  discoverOnce: () => Promise.resolve([]),
  localBroadcastAddresses: () => [],
}));

import { DISCOVER_TIMEOUT_MS, handleDiscover } from '../homebridge-ui/discover.js';

const answer = {
  guid: 'A1B2C3D4', ip: '10.1.254.0', commId: 'FM12GC', partId: 'E48GP', known: true, hasLight: true, extra: 'dropped',
};

const deps = (overrides = {}) => ({
  discover: vi.fn(async (_broadcasts: string[]) => [answer]),
  localBroadcasts: () => ['10.0.0.255'],
  timeoutMs: 500,
  ...overrides,
});

describe('/discover handler', () => {
  it('rejects an address that is not IPv4', async () => {
    await expect(handleDiscover({ broadcasts: '10.0.0.255, 10.0.0.999' }, deps())).rejects.toBeInstanceOf(RequestError);
    await expect(handleDiscover({ broadcasts: 'fans.local' }, deps())).rejects.toThrow('"fans.local" is not an IPv4 address.');
  });

  it('rejects a payload whose broadcasts are not a string', async () => {
    await expect(handleDiscover({ broadcasts: ['10.0.0.255'] }, deps())).rejects.toBeInstanceOf(RequestError);
    await expect(handleDiscover({ broadcasts: 42 }, deps())).rejects.toThrow(/must be a string/);
  });

  it('returns the fields the page shows and nothing else', async () => {
    const d = deps();
    const result = await handleDiscover({ broadcasts: '10.0.0.255' }, d);
    expect(d.discover).toHaveBeenCalledWith(['10.0.0.255']);
    expect(result).toEqual({
      broadcasts: ['10.0.0.255'],
      fans: [{ guid: 'A1B2C3D4', ip: '10.1.254.0', commId: 'FM12GC', partId: 'E48GP', known: true, hasLight: true }],
    });
  });

  it('searches every local network when no address is given', async () => {
    const d = deps();
    expect(await handleDiscover(undefined, d)).toMatchObject({ broadcasts: ['10.0.0.255'] });
    expect(await handleDiscover({}, d)).toMatchObject({ broadcasts: ['10.0.0.255'] });
    await expect(handleDiscover({ broadcasts: '' }, deps({ localBroadcasts: () => [] })))
      .rejects.toThrow(/No network interface to search on/);
  });

  it('searches each address once and at most sixteen of them', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `10.0.${i}.255`).join(', ');
    const d = deps();
    await handleDiscover({ broadcasts: `10.0.0.255, 10.0.0.255, ${many}` }, d);
    const sent = d.discover.mock.calls[0]![0];
    expect(sent).toHaveLength(16);
    expect(new Set(sent).size).toBe(16);
  });

  it('gives up on a search that does not finish', async () => {
    const never = deps({ discover: () => new Promise(() => {}), timeoutMs: 10 });
    await expect(handleDiscover({ broadcasts: '10.0.0.255' }, never)).rejects.toBeInstanceOf(RequestError);
    const failing = deps({ discover: () => Promise.reject(new Error('EACCES')) });
    await expect(handleDiscover({ broadcasts: '10.0.0.255' }, failing)).rejects.toThrow('Search failed: EACCES');
    const odd = deps({ discover: () => Promise.reject('no socket') });
    await expect(handleDiscover({ broadcasts: '10.0.0.255' }, odd)).rejects.toThrow('Search failed: no socket');
  });

  it('allows a full search plus a margin before giving up', () => {
    expect(DISCOVER_TIMEOUT_MS).toBe(3 * 1000 + 3000 + 2000);
  });
});
