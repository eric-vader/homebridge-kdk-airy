/**
 * SSDP-style discovery, as the app does it:
 * an M-SEARCH is broadcast to UDP port 50125 and each fan answers with a small HTTP-like text block.
 */
import { createSocket, type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { modelHasLight } from '../models.js';

export const DISCOVERY_PORT = 50125;
export const CONTROL_PORT = 3610;
const SEARCH_TARGET = 'urn:schemas-upnp-org:device:PANA013Adevices:1';

/** App timing: 3 bursts 1 s apart, then 3 s of collecting replies. MX in the M-SEARCH is the collect time. */
export const DISCOVERY_BURSTS = 3;
export const DISCOVERY_BURST_INTERVAL_MS = 1000;
export const DISCOVERY_COLLECT_MS = 3000;

/** Every reply starts with the HTTP status line. */
const SSDP_MAGIC = Buffer.from('HTTP', 'ascii');
const OCTET_MASK = 0xff;

export interface DiscoveredFan {
  /** Fan IP address (the LOCATION header). */
  ip: string;
  /** Unique id of the fan (HASHGUID). */
  guid: string;
  /** Model code, e.g. FM15GC. */
  commId: string;
  /** Firmware/part identifier. */
  partId: string;
  /** Whether the model is in the app's model table. */
  known: boolean;
  /** Whether the model has a light. An unknown model defaults to true so nothing is hidden. */
  hasLight: boolean;
}

export interface DiscoverOptions {
  bursts?: number;
  burstIntervalMs?: number;
  collectMs?: number;
}

export function buildMSearch(broadcast: string): Buffer {
  return Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST:${broadcast}:${DISCOVERY_PORT}\r\n` +
    'MAN:"ssdp:discover"\r\n' +
    `MX:${DISCOVERY_COLLECT_MS / 1000}\r\n` +
    `ST:${SEARCH_TARGET}\r\n` +
    '\r\n',
    'ascii',
  );
}

/** True when a datagram is a discovery reply rather than an ECHONET frame. */
export function looksLikeSsdpReply(buf: Uint8Array): boolean {
  return buf.length >= SSDP_MAGIC.length && SSDP_MAGIC.every((byte, i) => buf[i] === byte);
}

/**
 * Parse a discovery reply. Fans mix separators: `LOCATION:` and `DATE:` use a colon,
 * `HASHGUID=`, `COMMID=` and `PARTID=` an equals sign. The app skips one separator character whichever it is.
 * Returns undefined when the reply carries no HASHGUID. `fromIp` is used when LOCATION is missing or malformed.
 */
export function parseSsdpReply(text: string, fromIp: string): DiscoveredFan | undefined {
  const headers = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const sep = line.search(/[:=]/);
    if (sep <= 0) {
      continue;
    }
    const key = line.slice(0, sep).trim().toUpperCase();
    if (!headers.has(key)) {
      headers.set(key, line.slice(sep + 1).trim());
    }
  }
  const guid = headers.get('HASHGUID');
  if (!guid) {
    return undefined;
  }
  const commId = (headers.get('COMMID') ?? '').toUpperCase();
  const hasLight = modelHasLight(commId);
  const location = headers.get('LOCATION') ?? '';
  return {
    ip: isIPv4(location) ? location : fromIp,
    guid,
    commId,
    partId: headers.get('PARTID') ?? '',
    known: hasLight !== undefined,
    hasLight: hasLight ?? true,
  };
}

/** Directed broadcast address: the host bits of the address set to one. */
function broadcastOf(address: string, netmask: string): string {
  const mask = netmask.split('.').map(Number);
  return address.split('.').map((octet, i) => Number(octet) | (~mask[i]! & OCTET_MASK)).join('.');
}

/** IPv4 directed-broadcast address for every non-internal interface. The app computes it from the DHCP info. */
export function localBroadcastAddresses(): string[] {
  const out = new Set<string>();
  for (const iface of Object.values(networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal && isIPv4(iface.netmask)) {
      out.add(broadcastOf(iface.address, iface.netmask));
    }
  }
  return [...out];
}

/** Bind a UDP socket and enable broadcast; rejects with the bind error. */
export function bindSocket(socket: Socket, port: number, address: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, address, () => {
      socket.off('error', reject);
      socket.setBroadcast(true);
      resolve();
    });
  });
}

/** Send one M-SEARCH to each address. An address that cannot be reached is reported and skipped. */
export function sendMSearch(socket: Socket, broadcasts: readonly string[], port: number, warn: (message: string) => void): void {
  for (const addr of broadcasts) {
    socket.send(buildMSearch(addr), port, addr, err => {
      if (err) {
        warn(`M-SEARCH to ${addr}:${port} failed: ${err.message}`);
      }
    });
  }
}

/** The app's schedule: `bursts` sends spaced `burstIntervalMs` apart, then `collectMs` of listening. */
export async function runBursts(send: () => void, options: DiscoverOptions): Promise<void> {
  const bursts = options.bursts ?? DISCOVERY_BURSTS;
  const interval = options.burstIntervalMs ?? DISCOVERY_BURST_INTERVAL_MS;
  const collect = options.collectMs ?? DISCOVERY_COLLECT_MS;
  for (let i = 0; i < bursts; i++) {
    send();
    await sleep(i === bursts - 1 ? collect : interval);
  }
}

export interface DiscoverOnceOptions extends DiscoverOptions {
  /** Port the fans listen on (tests override it). */
  discoveryPort?: number;
  bindAddress?: string;
}

/**
 * One-off discovery from a temporary socket, used by the settings page. Fans answer to the socket that sent the
 * search, so this does not interfere with a running plugin's socket on port 3610.
 */
export async function discoverOnce(broadcasts: readonly string[], options: DiscoverOnceOptions = {}): Promise<DiscoveredFan[]> {
  const port = options.discoveryPort ?? DISCOVERY_PORT;
  const socket = createSocket('udp4');
  const found = new Map<string, DiscoveredFan>();
  let failure: Error | undefined;
  socket.on('message', (msg, rinfo) => {
    const fan = looksLikeSsdpReply(msg) ? parseSsdpReply(msg.toString('ascii'), rinfo.address) : undefined;
    if (fan) {
      found.set(fan.guid, fan);
    }
  });
  try {
    await bindSocket(socket, 0, options.bindAddress);
    socket.on('error', err => {
      failure = err;
    });
    const sendFailed = (message: string) => {
      failure ??= new Error(message);
    };
    await runBursts(() => sendMSearch(socket, broadcasts, port, sendFailed), options);
  } finally {
    socket.close();
  }
  // A send that fails for one address is not an error while others answer; with no answer at all it is the cause.
  if (failure && found.size === 0) {
    throw failure;
  }
  return [...found.values()];
}
