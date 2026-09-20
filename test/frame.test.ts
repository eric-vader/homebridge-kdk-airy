import { describe, expect, it } from 'vitest';

import { EPC, getProperties, ProtocolError, SWITCH } from '../src/protocol/epc.js';
import { buildFrame, ESV, frameTid, looksLikeFrame, parseFrame, TidAllocator, toHex } from '../src/protocol/frame.js';

describe('local ECHONET Lite frame', () => {
  it('builds a GET frame for FanPower and FanVolume', () => {
    const buf = buildFrame(1, ESV.GET, getProperties([EPC.FanPower, EPC.FanVolume]));
    expect(toHex(buf)).toBe('1081000105FF01013A016202' + '8000' + 'F000');
  });

  it('builds the SET frame the app sends for "fan power on" (captured: 1081000005ff01013a016101800130)', () => {
    const buf = buildFrame(0, ESV.SET, [{ epc: EPC.FanPower, data: Uint8Array.of(SWITCH.ON) }]);
    expect(toHex(buf)).toBe('1081000005FF01013A016101800130');
  });

  it('rejects what does not fit in a frame', () => {
    const one = getProperties([EPC.FanPower]);
    expect(() => buildFrame(0x10000, ESV.GET, one)).toThrow(ProtocolError);
    expect(() => buildFrame(-1, ESV.GET, one)).toThrow(ProtocolError);
    expect(() => buildFrame(1, ESV.GET, getProperties(new Array(256).fill(EPC.FanPower)))).toThrow(/too many/);
    expect(() => buildFrame(1, ESV.SET, [{ epc: EPC.FanPower, data: new Uint8Array(256) }])).toThrow(/too long/);
  });

  it('parses a GET response with mixed property sizes', () => {
    // TID 0x0102, Get_Res, 3 props: FanPower=ON, OffTimer(4 bytes), ErrorStatus=NO_ERROR
    const hex = '1081010205FF01013A017203' + '800130' + 'F80431FFFFFF' + '880142';
    const frame = parseFrame(Buffer.from(hex, 'hex'));
    expect(frame.tid).toBe(0x0102);
    expect(frame.esv).toBe(ESV.GET_OK);
    expect(frame.properties).toHaveLength(3);
    expect(frame.properties[1]).toEqual({ epc: EPC.OffTimer, data: Uint8Array.of(0x31, 0xff, 0xff, 0xff) });
  });

  it('parses a failed GET (PDC 0 properties)', () => {
    const frame = parseFrame(Buffer.from('1081000305FF01013A015202' + '8000' + 'F000', 'hex'));
    expect(frame.esv).toBe(ESV.GET_FAIL);
    expect(frame.properties.map(p => p.data.length)).toEqual([0, 0]);
  });

  it('rejects truncated frames and non-frames', () => {
    expect(() => parseFrame(Buffer.from('1081000305FF01013A017201F804', 'hex'))).toThrow(/needs 4 bytes/);
    expect(() => parseFrame(Buffer.from('1081000305FF01013A017202F800', 'hex'))).toThrow(/header missing/);
    expect(() => parseFrame(Buffer.from('HTTP/1.1 200 OK\r\n'))).toThrow(/not an ECHONET/);
    expect(looksLikeFrame(Buffer.from('HTTP/1.1 200 OK\r\n'))).toBe(false);
  });

  it('exposes the transaction id cheaply', () => {
    expect(frameTid(Buffer.from('1081ABCD05FF01013A017200', 'hex'))).toBe(0xabcd);
    expect(frameTid(Buffer.from('10', 'hex'))).toBeUndefined();
  });

  it('allocates TIDs 1..65535 then wraps to 1', () => {
    const tids = new TidAllocator();
    expect(tids.allocate()).toBe(1);
    expect(tids.allocate()).toBe(2);
    for (let i = 3; i <= 0xffff; i++) {
      tids.allocate();
    }
    expect(tids.allocate()).toBe(1);
  });
});
