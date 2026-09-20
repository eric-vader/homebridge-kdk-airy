/** The settings page's `/discover` request: validate the addresses, run one search, return what the page shows. */
import { isIPv4 } from 'node:net';

import { RequestError } from '@homebridge/plugin-ui-utils';

import {
  DISCOVERY_BURST_INTERVAL_MS, DISCOVERY_BURSTS, DISCOVERY_COLLECT_MS, discoverOnce, localBroadcastAddresses,
} from '../dist/protocol/discovery.js';
import { parseBroadcasts } from './public/settings-model.js';

/** Extra time on top of a full search before it is abandoned, so the page does not wait indefinitely. */
const TIMEOUT_MARGIN_MS = 2000;
export const DISCOVER_TIMEOUT_MS = DISCOVERY_BURSTS * DISCOVERY_BURST_INTERVAL_MS + DISCOVERY_COLLECT_MS + TIMEOUT_MARGIN_MS;

/** Maximum number of addresses one search is sent to. */
const MAX_BROADCASTS = 16;

const messageOf = err => (err instanceof Error ? err.message : String(err));

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new RequestError(`The search did not finish within ${ms} ms.`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Validate the page's payload, run one search and return only the fields the page shows. The network calls are
 * injected so the handler can be tested without a network.
 */
export async function handleDiscover(payload, deps = {}) {
  const {
    discover = discoverOnce,
    localBroadcasts = localBroadcastAddresses,
    isAddress = isIPv4,
    timeoutMs = DISCOVER_TIMEOUT_MS,
  } = deps;
  const raw = payload?.broadcasts;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new RequestError('broadcasts must be a string of IPv4 addresses separated by commas.');
  }
  const configured = [...new Set(parseBroadcasts(raw))];
  const bad = configured.find(a => !isAddress(a));
  if (bad !== undefined) {
    throw new RequestError(`"${bad}" is not an IPv4 address.`);
  }
  const broadcasts = (configured.length > 0 ? configured : [...new Set(localBroadcasts())]).slice(0, MAX_BROADCASTS);
  if (broadcasts.length === 0) {
    throw new RequestError('No network interface to search on. Enter the broadcast address of the fans\' network.');
  }
  let fans;
  try {
    fans = await withTimeout(Promise.resolve(discover(broadcasts)), timeoutMs);
  } catch (err) {
    throw err instanceof RequestError ? err : new RequestError(`Search failed: ${messageOf(err)}`);
  }
  return {
    broadcasts,
    fans: fans.map(f => ({ guid: f.guid, ip: f.ip, commId: f.commId, partId: f.partId, known: f.known, hasLight: f.hasLight })),
  };
}
