import { describe, expect, it } from 'vitest';

import {
  CTL_OPT_SOURCE, decodeProperties, encodeState, EPC, FAN_DIRECTION, LIGHT_MODE, MELODY, mergeState, NIGHTLIGHT_BRIGHTNESS,
  ProtocolError, SWITCH, TIMER, type FanState,
} from '../src/protocol/epc.js';
import { parseFrame } from '../src/protocol/frame.js';

describe('encodeState', () => {
  it('encodes every writable property with the app byte values', () => {
    const props = encodeState({
      ctlOptSource: CTL_OPT_SOURCE.LOCAL,
      buzzer: true,
      melody: MELODY.MELODY_1,
      fanPower: true,
      fanVolume: 0x36,
      fanDirection: FAN_DIRECTION.UP,
      fanFluctuation: false,
      lightPower: true,
      lightMode: LIGHT_MODE.NIGHT,
      lightBrightness: 70,
      lightColour: 100,
      nightlightBrightness: NIGHTLIGHT_BRIGHTNESS.MEDIUM,
      offTimer: { status: TIMER.ON, sleep: TIMER.OFF, hour: 2, minute: 0 },
      onTimer: { status: TIMER.OFF, melody: TIMER.KEEP, hour: TIMER.KEEP, minute: TIMER.KEEP },
    });
    const byEpc = Object.fromEntries(props.map(p => [p.epc, Buffer.from(p.data).toString('hex')]));
    expect(byEpc).toEqual({
      [EPC.CtlOptSource]: '03', [EPC.BuzzerSet]: '30', [EPC.Melody]: '41',
      [EPC.FanPower]: '30', [EPC.FanVolume]: '36', [EPC.FanDirection]: '42', [EPC.FanFluctuation]: '31',
      [EPC.LightPower]: '30', [EPC.LightMode]: '43', [EPC.LightBrightness]: '46', [EPC.LightColour]: '64',
      [EPC.LightNightlightBrightness]: '32', [EPC.OffTimer]: '30310200', [EPC.OnTimer]: '31ffffff',
    });
  });

  it('never encodes read-only properties', () => {
    expect(encodeState({ errorStatus: true, errorCode: 'H21', productCode: 'X', offTimerRemain: { hour: 1, minute: 0 } })).toEqual([]);
  });

  it('validates ranges like the app', () => {
    expect(() => encodeState({ fanVolume: 0x30 })).toThrow(ProtocolError);
    expect(() => encodeState({ fanVolume: 0x3b })).toThrow(ProtocolError);
    expect(() => encodeState({ lightBrightness: 0 })).toThrow(ProtocolError);
    expect(() => encodeState({ lightColour: 101 })).toThrow(ProtocolError);
    expect(() => encodeState({ nightlightBrightness: 51 as 50 })).toThrow(ProtocolError);
    expect(() => encodeState({ lightMode: 0x41 as 0x42 })).toThrow(ProtocolError);
    expect(() => encodeState({ offTimer: { status: TIMER.ON, sleep: TIMER.OFF, hour: 24, minute: 0 } })).toThrow(ProtocolError);
    expect(() => encodeState({ onTimer: { status: TIMER.ON, melody: 0x44, hour: 1, minute: 60 } })).toThrow(ProtocolError);
    expect(() => encodeState({ melody: 0x45 as 0x40 })).toThrow(ProtocolError);
    expect(() => encodeState({ ctlOptSource: 6 as 3 })).toThrow(ProtocolError);
  });
});

describe('decodeProperties', () => {
  it('decodes the app-captured full status reply', () => {
    // Mirrors the full status reply captured from a fan (15 properties, local frame format).
    const frame = parseFrame(Buffer.from(
      '1081000105FF01013A01720F' +
      '800130' + 'F00136' + 'F10141' + 'F20131' +
      'F30130' + 'F40142' + 'F50132' + 'F60164' + 'F70164' +
      'F804FFFFFFFF' + 'F9020000' + 'FA04FFFFFFFF' + 'FB020000' +
      '880142' + '86' + '2E' + '00'.repeat(6) + '303031' + '00'.repeat(37),
      'hex',
    ));
    const s = decodeProperties(frame.properties);
    expect(s).toEqual<FanState>({
      fanPower: true,
      fanVolume: 0x36,
      fanDirection: FAN_DIRECTION.DOWN,
      fanFluctuation: false,
      lightPower: true,
      lightMode: LIGHT_MODE.NORMAL,
      lightBrightness: 50,
      lightColour: 100,
      nightlightBrightness: NIGHTLIGHT_BRIGHTNESS.HIGH,
      offTimer: { status: 0xff, sleep: 0xff, hour: 0xff, minute: 0xff },
      offTimerRemain: { hour: 0, minute: 0 },
      onTimer: { status: 0xff, melody: 0xff, hour: 0xff, minute: 0xff },
      onTimerRemain: { hour: 0, minute: 0 },
      errorStatus: false,
      errorCode: '001',
    });
  });

  it('decodes a real fan\'s padded error code as empty', () => {
    const data = Buffer.from('2A0000FE0100' + '00'.repeat(40), 'hex');
    expect(decodeProperties([{ epc: EPC.ErrorCode, data }]).errorCode).toBe('');
  });

  it('leaves properties undefined when the PDC is wrong (failed GET)', () => {
    const s = decodeProperties([
      { epc: EPC.FanPower, data: new Uint8Array(0) },
      { epc: EPC.OffTimer, data: Uint8Array.of(0x30) },
      { epc: EPC.ErrorCode, data: Uint8Array.of(0x30) },
      { epc: EPC.ProductCode, data: Uint8Array.of(0x30) },
      { epc: 0x99, data: Uint8Array.of(0x30) },
    ]);
    expect(s).toEqual({});
  });

  it('leaves values outside the app tables undefined so they are never written back', () => {
    const s = decodeProperties([
      { epc: EPC.FanPower, data: Uint8Array.of(0x99) },
      { epc: EPC.FanDirection, data: Uint8Array.of(0x43) },
      { epc: EPC.LightMode, data: Uint8Array.of(0x41) },
      { epc: EPC.LightNightlightBrightness, data: Uint8Array.of(0x33) },
      { epc: EPC.LightBrightness, data: Uint8Array.of(0) },
      { epc: EPC.FanVolume, data: Uint8Array.of(0x30) },
      { epc: EPC.ErrorStatus, data: Uint8Array.of(0x40) },
    ]);
    expect(s).toEqual({});
    expect(() => encodeState(s)).not.toThrow();
  });

  it('decodes the control-option properties too', () => {
    const s = decodeProperties([
      { epc: EPC.BuzzerSet, data: Uint8Array.of(SWITCH.OFF) },
      { epc: EPC.Melody, data: Uint8Array.of(MELODY.MELODY_2) },
      { epc: EPC.CtlOptSource, data: Uint8Array.of(3) },
      { epc: EPC.ProductCode, data: Buffer.concat([Buffer.from('FM15GCX'), Buffer.alloc(11)]) },
    ]);
    expect(s).toEqual({ buzzer: false, melody: MELODY.MELODY_2, ctlOptSource: 3, productCode: 'FM15GCX' });
  });
});

describe('mergeState', () => {
  it('overrides defined fields only and returns a new object', () => {
    const base = { fanPower: true, fanVolume: 0x31 };
    const merged = mergeState(base, { fanVolume: 0x35, lightPower: undefined });
    expect(merged).toEqual({ fanPower: true, fanVolume: 0x35 });
    expect(base).toEqual({ fanPower: true, fanVolume: 0x31 });
  });
});
