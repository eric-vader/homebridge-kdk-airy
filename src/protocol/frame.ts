/**
 * ECHONET Lite frame codec for the KDK ceiling fan, as the app sends them:
 *   10 81 | TID(2) | 05 FF 01 | 01 3A 01 | ESV | OPC | OPC × (EPC PDC data...)
 */
import { ProtocolError, type Property } from './epc.js';

export const ESV = {
  /** SetC: write properties, response expected */
  SET: 0x61,
  /** Get: read properties */
  GET: 0x62,
  /** Set_Res: write succeeded */
  SET_OK: 0x71,
  /** Get_Res: read succeeded */
  GET_OK: 0x72,
  /** SetC_SNA: write failed */
  SET_FAIL: 0x51,
  /** Get_SNA: read failed */
  GET_FAIL: 0x52,
} as const;

/** EHD1 EHD2 as sent by the app (ECHONET Lite, format 1). */
const EHD = [0x10, 0x81] as const;
/** Source object: controller (05 FF 01). */
const SEOJ = [0x05, 0xff, 0x01] as const;
/** Destination object: 01 3A 01 (ECHONET class group 0x01, class 0x3A "ceiling fan", instance 1). */
const DEOJ = [0x01, 0x3a, 0x01] as const;

/** Byte offsets within the frame header. */
const OFFSET = { TID: 2, ESV: 10, OPC: 11, PROPERTIES: 12 } as const;
const MAX_TID = 0xffff;
/** OPC and PDC are single bytes. */
const MAX_BYTE = 0xff;

export interface Frame {
  tid: number;
  esv: number;
  properties: Property[];
}

export function buildFrame(tid: number, esv: number, properties: readonly Property[]): Buffer {
  if (!Number.isInteger(tid) || tid < 0 || tid > MAX_TID) {
    throw new ProtocolError(`TID out of range: ${tid}`);
  }
  if (properties.length > MAX_BYTE) {
    throw new ProtocolError(`too many properties: ${properties.length}`);
  }
  const chunks: number[] = [...EHD, tid >> 8, tid & MAX_BYTE, ...SEOJ, ...DEOJ, esv, properties.length];
  for (const p of properties) {
    if (p.data.length > MAX_BYTE) {
      throw new ProtocolError(`property 0x${p.epc.toString(16)} data too long`);
    }
    chunks.push(p.epc, p.data.length, ...p.data);
  }
  return Buffer.from(chunks);
}

/** Extract the transaction id without fully parsing. */
export function frameTid(buf: Uint8Array): number | undefined {
  const hi = buf[OFFSET.TID];
  const lo = buf[OFFSET.TID + 1];
  return hi === undefined || lo === undefined ? undefined : (hi << 8) | lo;
}

/** True when the datagram looks like an ECHONET Lite frame rather than an SSDP text reply. */
export function looksLikeFrame(buf: Uint8Array): boolean {
  return buf.length >= OFFSET.PROPERTIES && buf[0] === EHD[0] && buf[1] === EHD[1];
}

export function parseFrame(buf: Uint8Array): Frame {
  const tid = frameTid(buf);
  const esv = buf[OFFSET.ESV];
  const count = buf[OFFSET.OPC];
  if (!looksLikeFrame(buf) || tid === undefined || esv === undefined || count === undefined) {
    throw new ProtocolError(`not an ECHONET Lite frame (${toHex(buf)})`);
  }
  const properties: Property[] = [];
  let i = OFFSET.PROPERTIES;
  for (let n = 0; n < count; n++) {
    const epc = buf[i];
    const pdc = buf[i + 1];
    if (epc === undefined || pdc === undefined) {
      throw new ProtocolError(`truncated frame: property ${n} header missing`);
    }
    if (i + 2 + pdc > buf.length) {
      throw new ProtocolError(`truncated frame: property 0x${epc.toString(16)} needs ${pdc} bytes`);
    }
    properties.push({ epc, data: Uint8Array.from(buf.subarray(i + 2, i + 2 + pdc)) });
    i += 2 + pdc;
  }
  return { tid, esv, properties };
}

/** Transaction id allocator: 1..65535 then wraps to 1, as the app does. */
export class TidAllocator {
  private next = 0;

  allocate(): number {
    this.next = this.next >= MAX_TID ? 1 : this.next + 1;
    return this.next;
  }
}

export function toHex(buf: Uint8Array): string {
  return Buffer.from(buf).toString('hex').toUpperCase();
}
