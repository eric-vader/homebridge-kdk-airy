/**
 * UDP transport for KDK fans.
 *
 * One socket bound to the control port (3610) does everything the app does with its sockets: M-SEARCH goes out
 * from it, discovery replies come back to it, ECHONET requests go out from it and the fan answers to port 3610 of
 * the requester.
 */
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { setTimeout as sleep } from 'node:timers/promises';

import { ProtocolError, type Property } from './epc.js';
import {
  bindSocket, CONTROL_PORT, DISCOVERY_PORT, looksLikeSsdpReply, parseSsdpReply, runBursts, sendMSearch,
  type DiscoveredFan, type DiscoverOptions,
} from './discovery.js';
import { buildFrame, ESV, frameTid, looksLikeFrame, parseFrame, TidAllocator, toHex, type Frame } from './frame.js';

export interface ClientLogger {
  debug(message: string): void;
  warn(message: string): void;
}

/**
 * HAP answers a controller with OPERATION_TIMED_OUT if a write handler takes 10 s. A SET may be retried once, so
 * each attempt gets less than half of that. The fans answer within a second on a healthy network; the app waits 10 s.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 4000;
const ANY_ADDRESS = '0.0.0.0';

export interface KdkClientOptions {
  /** Port to bind (the fan answers to this port). Default 3610. */
  port?: number;
  /** Port the fan listens on for ECHONET frames. Default: same as `port`; only tests need to split them. */
  fanPort?: number;
  /** Port fans listen on for M-SEARCH. Default 50125. */
  discoveryPort?: number;
  /** How long to wait for a response with a matching TID. */
  requestTimeoutMs?: number;
  /**
   * Minimum gap between consecutive requests to the same fan, in ms. Default 0 sends the next request as soon as
   * the previous one has finished.
   */
  minRequestIntervalMs?: number;
  /** Address to bind. Default 0.0.0.0. */
  bindAddress?: string;
  log?: ClientLogger;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** The fan answered with SetC_SNA / Get_SNA. */
export class FanRejectedError extends Error {
  constructor(message: string, public readonly frame: Frame) {
    super(message);
    this.name = 'FanRejectedError';
  }
}

interface Pending {
  tid: number;
  ip: string;
  resolve(frame: Frame): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const silentLog: ClientLogger = { debug: () => {}, warn: () => {} };

/** What the platform and FanDevice need from the transport. */
export type FanClient = Pick<KdkClient, 'start' | 'stop' | 'discover' | 'get' | 'set'>;

export class KdkClient {
  private socket?: Socket;
  private readonly tids = new TidAllocator();
  private readonly pending = new Map<number, Pending>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly lastRequest = new Map<string, number>();
  /** Requests that have started and not yet finished (all fans). */
  private readonly active = new Set<Promise<unknown>>();
  /** While set, no request may start: discovery is broadcasting and collecting replies. */
  private discoveryGate?: Promise<void>;
  /** Replies collected while a discovery runs. */
  private found?: Map<string, DiscoveredFan>;

  private readonly requestedPort: number;
  readonly fanPort: number;
  readonly discoveryPort: number;
  readonly requestTimeoutMs: number;
  readonly minRequestIntervalMs: number;
  private readonly bindAddress: string;
  private readonly log: ClientLogger;

  constructor(options: KdkClientOptions = {}) {
    this.requestedPort = options.port ?? CONTROL_PORT;
    this.fanPort = options.fanPort ?? this.requestedPort;
    this.discoveryPort = options.discoveryPort ?? DISCOVERY_PORT;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.minRequestIntervalMs = Math.max(0, options.minRequestIntervalMs ?? 0);
    this.bindAddress = options.bindAddress ?? ANY_ADDRESS;
    this.log = options.log ?? silentLog;
  }

  /** The bound port once started, otherwise the port that will be requested. */
  get port(): number {
    return this.socket?.address().port ?? this.requestedPort;
  }

  /** Bind the socket. Rejects when the port is taken, so a second instance fails visibly instead of sharing replies. */
  async start(): Promise<void> {
    if (this.socket) {
      return;
    }
    const socket = createSocket('udp4');
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    try {
      await bindSocket(socket, this.requestedPort, this.bindAddress);
    } catch (err) {
      socket.close();
      throw err;
    }
    socket.on('error', err => this.log.warn(`socket error: ${err.message}`));
    this.socket = socket;
    this.log.debug(`listening on udp ${this.bindAddress}:${this.port}`);
  }

  stop(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('client stopped'));
    }
    this.pending.clear();
    this.queues.clear();
    this.lastRequest.clear();
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * Broadcast M-SEARCH as the app does, 3 bursts 1 s apart followed by 3 s of listening, and resolve with every
   * fan that replied, de-duplicated by HASHGUID.
   *
   * Discovery shares the request pipeline. It waits for requests already in flight to finish and holds every new
   * GET and SET until it is done, so fans do not receive control traffic and broadcasts at the same time.
   */
  async discover(broadcasts: readonly string[], options: DiscoverOptions = {}): Promise<DiscoveredFan[]> {
    while (this.discoveryGate) {
      await this.discoveryGate; // a discovery is already running, run after it
    }
    let release!: () => void;
    this.discoveryGate = new Promise<void>(resolve => {
      release = resolve;
    });
    try {
      await Promise.allSettled([...this.active]);
      const socket = this.requireSocket();
      this.found = new Map();
      await runBursts(() => sendMSearch(socket, broadcasts, this.discoveryPort, m => this.log.warn(m)), options);
      return [...this.found.values()];
    } finally {
      this.found = undefined;
      this.discoveryGate = undefined;
      release();
    }
  }

  /**
   * Send one request and wait for the frame with the same TID. Requests to the same IP are serialised and, when
   * configured, spaced at least `minRequestIntervalMs` apart.
   */
  request(ip: string, esv: number, properties: readonly Property[]): Promise<Frame> {
    return this.enqueue(ip, async () => {
      const wait = (this.lastRequest.get(ip) ?? 0) + this.minRequestIntervalMs - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      this.lastRequest.set(ip, Date.now());
      return this.send(ip, esv, properties);
    });
  }

  /** GET the given EPCs. Resolves with the response frame. A property with PDC 0 was not available. */
  async get(ip: string, properties: readonly Property[]): Promise<Frame> {
    const frame = await this.request(ip, ESV.GET, properties);
    if (frame.esv === ESV.GET_FAIL) {
      throw new FanRejectedError(`${ip} rejected GET (Get_SNA)`, frame);
    }
    return frame;
  }

  /** SET the given properties. Rejects with FanRejectedError on SetC_SNA. */
  async set(ip: string, properties: readonly Property[]): Promise<Frame> {
    const frame = await this.request(ip, ESV.SET, properties);
    if (frame.esv === ESV.SET_FAIL) {
      throw new FanRejectedError(`${ip} rejected SET (SetC_SNA)`, frame);
    }
    return frame;
  }

  private enqueue<T>(ip: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(ip) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      while (this.discoveryGate) {
        await this.discoveryGate;
      }
      const run = task();
      this.active.add(run);
      run.finally(() => this.active.delete(run)).catch(() => undefined);
      return run;
    });
    this.queues.set(ip, next);
    next.finally(() => {
      if (this.queues.get(ip) === next) {
        this.queues.delete(ip);
      }
    }).catch(() => undefined);
    return next;
  }

  private send(ip: string, esv: number, properties: readonly Property[]): Promise<Frame> {
    const socket = this.requireSocket();
    const tid = this.tids.allocate();
    const buf = buildFrame(tid, esv, properties);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tid);
        reject(new TimeoutError(`${ip}: no response to TID ${tid} within ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(tid, { tid, ip, resolve, reject, timer });
      socket.send(buf, this.fanPort, ip, err => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(tid);
          reject(err);
          return;
        }
        this.log.debug(`>>> ${ip}:${this.fanPort} ${toHex(buf)}`);
      });
    });
  }

  private onMessage(msg: Buffer, rinfo: RemoteInfo): void {
    if (looksLikeSsdpReply(msg)) {
      const fan = parseSsdpReply(msg.toString('ascii'), rinfo.address);
      if (!fan) {
        this.log.debug(`ignoring discovery reply without HASHGUID from ${rinfo.address}`);
        return;
      }
      this.log.debug(`discovery reply from ${rinfo.address}: ${fan.commId} ${fan.guid}`);
      this.found?.set(fan.guid, fan);
      return;
    }
    if (!looksLikeFrame(msg)) {
      this.log.debug(`ignoring ${msg.length} byte datagram from ${rinfo.address}:${rinfo.port}`);
      return;
    }
    this.log.debug(`<<< ${rinfo.address}:${rinfo.port} ${toHex(msg)}`);
    const tid = frameTid(msg);
    const pending = tid === undefined ? undefined : this.pending.get(tid);
    if (!pending || pending.ip !== rinfo.address) {
      this.log.debug(`no pending request for TID ${tid} from ${rinfo.address}`);
      return;
    }
    this.pending.delete(pending.tid);
    clearTimeout(pending.timer);
    try {
      pending.resolve(parseFrame(msg));
    } catch (err) {
      pending.reject(err instanceof Error ? err : new ProtocolError(String(err)));
    }
  }

  private requireSocket(): Socket {
    if (!this.socket) {
      throw new Error('KdkClient not started');
    }
    return this.socket;
  }
}
