import { describe, expect, it } from 'vitest';

import { EPC, FAN_DIRECTION, LIGHT_MODE, TIMER } from '../src/protocol/epc.js';
import { ESV } from '../src/protocol/frame.js';
import { startFan } from './harness.js';

const twoTimeouts = { device: { offlineAfterTimeouts: 2 } };

describe('FanDevice', () => {
  it('refresh() polls the app GET list and caches the state', async () => {
    const { device, fan } = await startFan();
    const states: unknown[] = [];
    device.on('state', s => states.push(s));
    const s = await device.refresh();
    expect(s).toMatchObject({ fanPower: false, fanVolume: 0x31, lightPower: false, errorStatus: false, errorCode: '000' });
    expect(fan.received[0]?.properties.map(p => p.epc)).toContain(EPC.OffTimerRemainTime);
    expect(states).toHaveLength(1);
  });

  it('apply() sends the full composed SET then reloads', async () => {
    const { device, fan } = await startFan();
    await device.refresh();
    fan.reset();
    const s = await device.apply({ fanPower: true, fanVolume: 0x35, fanDirection: FAN_DIRECTION.UP });
    expect(fan.state).toMatchObject({ fanPower: true, fanVolume: 0x35, fanDirection: FAN_DIRECTION.UP });
    expect(s).toMatchObject({ fanPower: true, fanVolume: 0x35 });
    expect(fan.received.map(f => f.esv)).toEqual([ESV.SET, ESV.GET]);
    const set = fan.frames(ESV.SET)[0]!;
    // control options first, buzzer off as configured
    expect(set.properties.slice(0, 3).map(p => [p.epc, p.data[0]]))
      .toEqual([[EPC.CtlOptSource, 3], [EPC.BuzzerSet, 0x31], [EPC.Melody, 0x40]]);
    // fan was turned on -> OnTimer pruned, OffTimer sent with KEEP duration
    expect(set.properties.some(p => p.epc === EPC.OnTimer)).toBe(false);
    expect(Buffer.from(set.properties.find(p => p.epc === EPC.OffTimer)!.data).toString('hex')).toBe('3131ffff');
  });

  it('apply() on an unknown state learns the state first so the SET carries the full picture', async () => {
    const { device, fan } = await startFan();
    fan.state = { ...fan.state, lightPower: true, lightMode: LIGHT_MODE.NORMAL };
    await device.apply({ lightColour: 0 });
    expect(fan.received.map(f => f.esv)).toEqual([ESV.GET, ESV.SET, ESV.GET]);
    const set = fan.frames(ESV.SET)[0]!;
    expect(set.properties.map(p => p.epc)).toContain(EPC.LightPower);
    expect(set.properties.map(p => p.epc)).toContain(EPC.FanPower);
    expect(fan.state.lightColour).toBe(0);
  });

  it('a poll answered from before a write never overwrites the written state (no spring-back)', async () => {
    const { device, fan } = await startFan();
    await device.refresh();
    const speeds: (number | undefined)[] = [];
    device.on('state', st => speeds.push(st.fanVolume));
    fan.getDelayMs = 150;
    const poll = device.refresh(); // in flight, will answer with the old speed
    await fan.nextFrame();
    const written = await device.apply({ fanPower: true, fanVolume: 0x3a });
    await poll;
    expect(written.fanVolume).toBe(0x3a);
    expect(device.state.fanVolume).toBe(0x3a);
    expect(fan.state.fanVolume).toBe(0x3a);
    // the only state event after the write carries the new speed; the stale poll was discarded
    expect(speeds).toEqual([0x3a]);
    // and the reload was a GET after the SET, not the shared poll
    expect(fan.received.map(f => f.esv).slice(-2)).toEqual([ESV.SET, ESV.GET]);
  });

  it('changes made while a SET is in flight are merged into one following SET (only the last state matters)', async () => {
    const { device, fan } = await startFan();
    await device.refresh();
    fan.reset();
    fan.setDelayMs = 100;
    const first = device.apply({ fanPower: true, fanVolume: 0x32 });
    await fan.nextFrame(); // first SET is on the wire
    const second = device.apply({ fanVolume: 0x35 });
    const third = device.apply({ fanVolume: 0x3a, fanDirection: FAN_DIRECTION.UP });
    const fourth = device.apply({ fanFluctuation: true });
    await Promise.all([first, second, third, fourth]);
    const sets = fan.frames(ESV.SET);
    expect(sets).toHaveLength(2);
    expect(fan.state).toMatchObject({ fanPower: true, fanVolume: 0x3a, fanDirection: FAN_DIRECTION.UP, fanFluctuation: true });
    expect(device.state.fanVolume).toBe(0x3a);
    // intermediate speed 0x35 never went on the wire
    const volumes = sets.map(f => f.properties.find(p => p.epc === EPC.FanVolume)?.data[0]);
    expect(volumes).toEqual([0x32, 0x3a]);
  });

  it('a failing first batch does not lose the batch queued behind it', async () => {
    const { device, fan } = await startFan();
    await device.refresh();
    fan.rejectSets = true;
    fan.setDelayMs = 50;
    const first = device.apply({ fanPower: true });
    await fan.nextFrame();
    fan.rejectSets = false;
    const second = device.apply({ fanVolume: 0x33 });
    await expect(first).rejects.toThrow(/rejected SET/);
    await second;
    // the second SET was sent; the fan stayed off, so the app rules dropped the speed from it
    expect(fan.frames(ESV.SET)).toHaveLength(2);
    expect(device.state.fanPower).toBe(false);
  });

  it('apply() with awaitReload:false resolves on the SET ack and reloads in the background', async () => {
    const { device, fan } = await startFan();
    await device.refresh();
    fan.reset();
    const states: unknown[] = [];
    device.on('state', st => states.push(st));
    await device.apply({ fanPower: true }, { awaitReload: false });
    expect(fan.received.map(f => f.esv)).toEqual([ESV.SET]);
    await fan.waitFor(r => r.length === 2);
    expect(fan.received.map(f => f.esv)).toEqual([ESV.SET, ESV.GET]);
    await device.refresh();
    expect(states.length).toBeGreaterThanOrEqual(1);
  });

  it('a write succeeds even when the reload after it is lost', async () => {
    const { device, fan } = await startFan();
    await device.refresh();
    fan.reset();
    const write = device.apply({ fanPower: true });
    await fan.nextFrame(); // the SET arrived and its reply is scheduled
    fan.dropReplies = 1; // swallow the reload GET
    const s = await write;
    expect(s.fanPower).toBe(true);
    expect(fan.received.map(f => f.esv)).toEqual([ESV.SET, ESV.GET]);
    expect(device.online).toBe(true);
  });

  it('light changes follow the night-mode rules', async () => {
    const { device, fan } = await startFan();
    await device.refresh();
    await device.apply({ lightPower: true, lightMode: LIGHT_MODE.NIGHT, nightlightBrightness: 100 });
    expect(fan.state).toMatchObject({ lightPower: true, lightMode: LIGHT_MODE.NIGHT, nightlightBrightness: 100 });
    const set = fan.frames(ESV.SET)[0]!;
    expect(set.properties.some(p => p.epc === EPC.LightBrightness)).toBe(false);
  });

  it('timers are settable through the same path', async () => {
    const { device, fan } = await startFan();
    await device.refresh();
    await device.apply({ offTimer: { status: TIMER.ON, sleep: TIMER.OFF, hour: 1, minute: 15 } });
    // fan is off in the fake's initial state, so the app rules drop the OffTimer; turn on first
    await device.apply({ fanPower: true });
    await device.apply({ offTimer: { status: TIMER.ON, sleep: TIMER.OFF, hour: 1, minute: 15 } });
    expect(fan.state.offTimer).toEqual({ status: TIMER.ON, sleep: TIMER.OFF, hour: 1, minute: 15 });
  });

  it('shares an in-flight refresh instead of queueing polls behind a silent fan', async () => {
    const { device, fan } = await startFan();
    fan.silent = true;
    const a = device.refresh();
    const b = device.refresh();
    await expect(a).rejects.toThrow(/no response/);
    await expect(b).rejects.toThrow(/no response/);
    expect(fan.received).toHaveLength(1);
    fan.silent = false;
    await device.refresh();
    expect(fan.received).toHaveLength(2);
  });

  it('goes offline after consecutive timeouts and back online when it answers or is rediscovered', async () => {
    const { device, fan } = await startFan(twoTimeouts);
    const flips: boolean[] = [];
    device.on('online', o => flips.push(o));
    fan.silent = true;
    await expect(device.refresh()).rejects.toThrow();
    expect(device.online).toBe(true);
    await expect(device.refresh()).rejects.toThrow();
    expect(device.online).toBe(false);
    fan.silent = false;
    await device.refresh();
    expect(device.online).toBe(true);
    fan.silent = true;
    await expect(device.refresh()).rejects.toThrow();
    await expect(device.refresh()).rejects.toThrow();
    expect(device.online).toBe(false);
    device.seen('127.0.0.2');
    expect(device.online).toBe(true);
    expect(device.ip).toBe('127.0.0.2');
    expect(flips).toEqual([false, true, false, true]);
  });

  it('retries a SET once when the reply is lost', async () => {
    const { device, fan } = await startFan(twoTimeouts);
    await device.refresh();
    fan.dropReplies = 1;
    await device.apply({ fanPower: true });
    expect(fan.frames(ESV.SET)).toHaveLength(2);
    expect(fan.state.fanPower).toBe(true);
    expect(device.online).toBe(true);
  });

  it('gives up after the second timeout and resyncs from the fan', async () => {
    const { device, fan } = await startFan(twoTimeouts);
    await device.refresh();
    fan.dropReplies = 2; // the fake fan applies the SET but swallows both replies
    await expect(device.apply({ fanPower: true })).rejects.toThrow(/no response/);
    // the cached state now matches the fan, which did apply the write
    expect(device.state.fanPower).toBe(fan.state.fanPower);
    expect(fan.received.map(f => f.esv).slice(-3)).toEqual([ESV.SET, ESV.SET, ESV.GET]);
  });

  it('falls back to the state from before the write when the fan cannot be read after a failed SET', async () => {
    const { device, fan } = await startFan({ device: { offlineAfterTimeouts: 10 } });
    await device.refresh();
    const states: boolean[] = [];
    device.on('state', s => states.push(s.fanPower === true));
    fan.silent = true;
    await expect(device.apply({ fanPower: true })).rejects.toThrow(/no response/);
    expect(device.state.fanPower).toBe(false);
    expect(states).toEqual([false]); // listeners hear about the rollback
    expect(device.online).toBe(true);
  });

  it('rolls back the optimistic state when a SET is rejected, without retrying', async () => {
    const { device, fan } = await startFan();
    await device.refresh();
    fan.rejectSets = true;
    await expect(device.apply({ fanPower: true })).rejects.toThrow(/rejected SET/);
    expect(device.state.fanPower).toBe(false);
    expect(fan.frames(ESV.SET)).toHaveLength(1);
    expect(device.online).toBe(true);
  });
});
