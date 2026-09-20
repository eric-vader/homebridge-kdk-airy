import { describe, expect, it } from 'vitest';

import { buildGetProperties, composeSet, getListFor } from '../src/protocol/compose.js';
import { EPC, FAN_DIRECTION, LIGHT_MODE, MELODY, NIGHTLIGHT_BRIGHTNESS, TIMER, type FanState } from '../src/protocol/epc.js';

const fullState: FanState = {
  fanPower: true,
  fanVolume: 0x36,
  fanDirection: FAN_DIRECTION.DOWN,
  fanFluctuation: false,
  lightPower: true,
  lightMode: LIGHT_MODE.NORMAL,
  lightBrightness: 50,
  lightColour: 100,
  nightlightBrightness: NIGHTLIGHT_BRIGHTNESS.HIGH,
  offTimer: { status: TIMER.OFF, sleep: TIMER.OFF, hour: 2, minute: 0 },
  offTimerRemain: { hour: 0, minute: 0 },
  onTimer: { status: TIMER.OFF, melody: MELODY.NONE, hour: 2, minute: 0 },
  onTimerRemain: { hour: 0, minute: 0 },
  errorStatus: false,
  errorCode: '000',
};

const opts = { buzzer: false, melody: MELODY.NONE, hasLight: true } as const;
const epcs = (props: { epc: number }[]) => props.map(p => p.epc);
const dataOf = (props: { epc: number; data: Uint8Array }[], epc: number) =>
  Buffer.from(props.find(p => p.epc === epc)?.data ?? []).toString('hex');

describe('GET list', () => {
  it('matches the app GET list for a light model', () => {
    expect(getListFor(true)).toEqual([
      0x80, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0x86, 0x88,
    ]);
    expect(buildGetProperties(true).every(p => p.data.length === 0)).toBe(true);
  });

  it('omits light properties for a model without a light', () => {
    expect(getListFor(false)).toEqual([0x80, 0xf0, 0xf1, 0xf2, 0xf8, 0xf9, 0xfa, 0xfb, 0x86, 0x88]);
  });
});

describe('composeSet', () => {
  it('prepends CtlOptSource=LOCAL, BuzzerSet, Melody and sends the full writable state', () => {
    const { properties, state } = composeSet(fullState, { fanVolume: 0x3a }, { ...opts, buzzer: true });
    expect(epcs(properties).slice(0, 3)).toEqual([EPC.CtlOptSource, EPC.BuzzerSet, EPC.Melody]);
    expect(dataOf(properties, EPC.CtlOptSource)).toBe('03');
    expect(dataOf(properties, EPC.BuzzerSet)).toBe('30');
    expect(dataOf(properties, EPC.Melody)).toBe('40');
    // fan on + light on/normal: volume, direction, fluctuation, light power/mode/brightness/colour, off timer
    expect(epcs(properties).slice(3)).toEqual([
      EPC.FanPower, EPC.FanVolume, EPC.FanDirection, EPC.FanFluctuation,
      EPC.LightPower, EPC.LightMode, EPC.LightBrightness, EPC.LightColour, EPC.OffTimer,
    ]);
    expect(state.fanVolume).toBe(0x3a);
    // read-only properties never go on the wire
    expect(epcs(properties)).not.toContain(EPC.ErrorStatus);
    expect(epcs(properties)).not.toContain(EPC.OffTimerRemainTime);
  });

  it('sends untouched timers with hour/minute = KEEP', () => {
    const { properties } = composeSet(fullState, { fanPower: false }, opts);
    // fan off -> OffTimer dropped, OnTimer kept with KEEP duration
    expect(dataOf(properties, EPC.OnTimer)).toBe('3140ffff');
    expect(epcs(properties)).not.toContain(EPC.OffTimer);
  });

  it('keeps the explicit duration when the timer is the thing being changed', () => {
    const change: FanState = { onTimer: { status: TIMER.ON, melody: MELODY.MELODY_1, hour: 1, minute: 30 } };
    const { properties } = composeSet({ ...fullState, fanPower: false }, change, opts);
    expect(dataOf(properties, EPC.OnTimer)).toBe('3041011e');
  });

  it('drops light properties for models without a light', () => {
    const { properties } = composeSet(fullState, { fanPower: true }, { ...opts, hasLight: false });
    expect(epcs(properties).some(e => e >= EPC.LightPower && e <= EPC.LightNightlightBrightness)).toBe(false);
  });

  it('turning the light off drops mode/brightness/colour/nightlight', () => {
    const { properties } = composeSet(fullState, { lightPower: false }, opts);
    expect(epcs(properties).filter(e => e >= EPC.LightPower && e <= EPC.LightNightlightBrightness)).toEqual([EPC.LightPower]);
  });

  it('night mode sends nightlight brightness instead of brightness/colour', () => {
    const { properties } = composeSet(fullState, { lightMode: LIGHT_MODE.NIGHT, nightlightBrightness: 1 }, opts);
    expect(epcs(properties).filter(e => e >= EPC.LightPower && e <= EPC.LightNightlightBrightness))
      .toEqual([EPC.LightPower, EPC.LightMode, EPC.LightNightlightBrightness]);
  });

  it('fan off drops the fan settings and the off timer; fan on drops the on timer', () => {
    const off = composeSet(fullState, { fanPower: false }, opts).properties;
    expect(epcs(off)).not.toContain(EPC.FanVolume);
    expect(epcs(off)).not.toContain(EPC.FanDirection);
    expect(epcs(off)).not.toContain(EPC.FanFluctuation);
    expect(epcs(off)).toContain(EPC.OnTimer);
    const on = composeSet({ ...fullState, fanPower: false }, { fanPower: true }, opts).properties;
    expect(epcs(on)).toContain(EPC.FanVolume);
    expect(epcs(on)).not.toContain(EPC.OnTimer);
  });

  it('sleep mode on: fan settings are dropped, off timer carries sleep=ON with KEEP duration', () => {
    const sleep: FanState = { offTimer: { status: TIMER.ON, sleep: TIMER.ON, hour: TIMER.KEEP, minute: TIMER.KEEP } };
    const { properties } = composeSet(fullState, sleep, opts);
    expect(epcs(properties)).not.toContain(EPC.FanVolume);
    expect(epcs(properties)).not.toContain(EPC.FanDirection);
    expect(epcs(properties)).not.toContain(EPC.OnTimer);
    expect(dataOf(properties, EPC.OffTimer)).toBe('3030ffff');
  });

  it('validates the merged state (invalid change is rejected before sending)', () => {
    expect(() => composeSet(fullState, { fanVolume: 0x99 }, opts)).toThrow(/fanVolume/);
  });

  it('starts from an empty known state without crashing', () => {
    const { properties } = composeSet({}, { fanPower: true }, opts);
    expect(epcs(properties)).toEqual([EPC.CtlOptSource, EPC.BuzzerSet, EPC.Melody, EPC.FanPower]);
  });
});
