/**
 * A minimal KDK fan simulator for tests: answers M-SEARCH on its discovery port and ECHONET Lite GET/SET on its
 * control port, keeping a FanState. Both sockets bind to a free port on 127.0.0.1. Replies go back to the sender's
 * address and port, which is what a real fan does when the requester sends from port 3610.
 */
import { createSocket, type Socket } from 'node:dgram';

import { decodeProperties, encodeState, EPC, ERROR_STATUS, mergeState, type FanState, type Property } from '../src/protocol/epc.js';
import { buildFrame, ESV, parseFrame, type Frame } from '../src/protocol/frame.js';

export interface FakeFanOptions {
  guid?: string;
  commId?: string;
  partId?: string;
  initialState?: FanState;
}

/** ErrorCode payload: 46 bytes with the 3 character code at offset 6, as the fans send it. */
const ERROR_CODE_PDC = 46;
const ERROR_CODE_OFFSET = 6;

/** The reply to a GET: every requested property the state knows, PDC 0 for the rest. */
export function replyToGet(state: FanState, requested: readonly Property[]): Property[] {
  const available = new Map(encodeState(state).map(p => [p.epc, p.data]));
  if (state.errorStatus !== undefined) {
    available.set(EPC.ErrorStatus, Uint8Array.of(state.errorStatus ? ERROR_STATUS.ERROR : ERROR_STATUS.NO_ERROR));
  }
  if (state.offTimerRemain) {
    available.set(EPC.OffTimerRemainTime, Uint8Array.of(state.offTimerRemain.hour, state.offTimerRemain.minute));
  }
  if (state.onTimerRemain) {
    available.set(EPC.OnTimerRemainTime, Uint8Array.of(state.onTimerRemain.hour, state.onTimerRemain.minute));
  }
  if (state.errorCode !== undefined) {
    const errorCode = new Uint8Array(ERROR_CODE_PDC);
    errorCode.set(Buffer.from(state.errorCode, 'ascii'), ERROR_CODE_OFFSET);
    available.set(EPC.ErrorCode, errorCode);
  }
  return requested.map(p => ({ epc: p.epc, data: available.get(p.epc) ?? new Uint8Array(0) }));
}

export const DEFAULT_FAN_STATE: FanState = {
  fanPower: false, fanVolume: 0x31, fanDirection: 0x41, fanFluctuation: false,
  lightPower: false, lightMode: 0x42, lightBrightness: 100, lightColour: 50, nightlightBrightness: 50,
  offTimer: { status: 0x31, sleep: 0x31, hour: 2, minute: 0 },
  offTimerRemain: { hour: 0, minute: 0 },
  onTimer: { status: 0x31, melody: 0x40, hour: 2, minute: 0 },
  onTimerRemain: { hour: 0, minute: 0 },
  errorStatus: false,
  errorCode: '000',
};

export class FakeFan {
  readonly control: Socket;
  readonly discovery: Socket;
  state: FanState;
  /** Every frame received since the last reset(), for assertions. */
  readonly received: Frame[] = [];
  /** When true, requests are swallowed, simulating an unreachable fan. */
  silent = false;
  /** Number of upcoming control requests to apply but not answer, simulating a lost reply. */
  dropReplies = 0;
  /** Number of upcoming GET requests to answer with a truncated frame. */
  malformedReplies = 0;
  /** Delay before answering GET requests, in ms, simulating a slow fan so a write can race a poll. */
  getDelayMs = 0;
  /** Delay before answering SET requests, in ms. */
  setDelayMs = 0;
  /** When true, the reply carries a bogus TID, simulating a stray packet. */
  corruptTid = false;
  /** When true, SETs are answered with SetC_SNA. */
  rejectSets = false;
  /** When true, GETs are answered with Get_SNA. */
  rejectGets = false;
  readonly guid: string;
  readonly commId: string;
  readonly partId: string;
  private waiters: { test: () => boolean; resolve: () => void }[] = [];
  private stopped = false;

  constructor(opts: FakeFanOptions = {}) {
    this.guid = opts.guid ?? '00112233445566778899AABBCCDDEEFF';
    this.commId = opts.commId ?? 'FM15GC';
    this.partId = opts.partId ?? '1.0.6';
    this.state = opts.initialState ?? DEFAULT_FAN_STATE;
    this.control = createSocket('udp4');
    this.discovery = createSocket('udp4');
    this.control.on('message', (msg, rinfo) => this.onControl(msg, rinfo.address, rinfo.port));
    this.discovery.on('message', (msg, rinfo) => this.onDiscovery(msg, rinfo.address, rinfo.port));
  }

  get controlPort(): number {
    return this.control.address().port;
  }

  get discoveryPort(): number {
    return this.discovery.address().port;
  }

  async start(): Promise<void> {
    await Promise.all([
      new Promise<void>(r => this.control.bind(0, '127.0.0.1', r)),
      new Promise<void>(r => this.discovery.bind(0, '127.0.0.1', r)),
    ]);
  }

  stop(): void {
    this.stopped = true;
    this.control.close();
    this.discovery.close();
  }

  reset(): void {
    this.received.length = 0;
  }

  /** Frames received with the given service code. */
  frames(esv: number): Frame[] {
    return this.received.filter(f => f.esv === esv);
  }

  /** Resolves as soon as `test` holds for the received frames (checked now and after every frame). */
  waitFor(test: (received: Frame[]) => boolean): Promise<void> {
    if (test(this.received)) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiters.push({ test: () => test(this.received), resolve }));
  }

  /** Resolves when one more frame than now has arrived. */
  nextFrame(): Promise<void> {
    const count = this.received.length;
    return this.waitFor(r => r.length > count);
  }

  private onDiscovery(msg: Buffer, address: string, port: number): void {
    if (this.silent || !msg.toString('ascii').startsWith('M-SEARCH')) {
      return;
    }
    const reply =
      'HTTP/1.1 200 OK\r\n' +
      'DATE: Fri, 19 Sep 2026 12:00:00 GMT\r\n' +
      'LOCATION:127.0.0.1\r\n' +
      `HASHGUID=${this.guid}\r\n` +
      `COMMID=${this.commId}\r\n` +
      `PARTID=${this.partId}\r\n\r\n`;
    this.discovery.send(Buffer.from(reply, 'ascii'), port, address);
  }

  private onControl(msg: Buffer, address: string, port: number): void {
    let frame: Frame;
    try {
      frame = parseFrame(msg);
    } catch {
      return;
    }
    this.received.push(frame);
    this.waiters = this.waiters.filter(w => !w.test() || (w.resolve(), false));
    if (this.silent) {
      return;
    }
    const drop = this.dropReplies > 0;
    if (drop) {
      this.dropReplies--;
    }
    const tid = this.corruptTid ? (frame.tid + 1) & 0xffff : frame.tid;
    const acknowledge = frame.properties.map(p => ({ epc: p.epc, data: new Uint8Array(0) }));
    let reply: Buffer;
    if (frame.esv === ESV.GET) {
      if (this.malformedReplies > 0) {
        this.malformedReplies--;
        reply = buildFrame(tid, ESV.GET_OK, replyToGet(this.state, frame.properties)).subarray(0, 14);
      } else {
        reply = this.rejectGets
          ? buildFrame(tid, ESV.GET_FAIL, acknowledge)
          : buildFrame(tid, ESV.GET_OK, replyToGet(this.state, frame.properties));
      }
    } else if (frame.esv === ESV.SET) {
      if (this.rejectSets) {
        reply = buildFrame(tid, ESV.SET_FAIL, acknowledge);
      } else {
        this.state = mergeState(this.state, decodeProperties(frame.properties));
        reply = buildFrame(tid, ESV.SET_OK, acknowledge);
      }
    } else {
      return;
    }
    if (!drop) {
      const delay = frame.esv === ESV.GET ? this.getDelayMs : this.setDelayMs;
      setTimeout(() => {
        if (!this.stopped) {
          this.control.send(reply, port, address);
        }
      }, delay);
    }
  }
}
