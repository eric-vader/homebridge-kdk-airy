import { describe, expect, it } from 'vitest';

import { FanRejectedError, KdkClient, TimeoutError } from '../src/protocol/client.js';
import { EPC, getProperties, ProtocolError, SWITCH } from '../src/protocol/epc.js';
import { ESV } from '../src/protocol/frame.js';
import { startFan } from './harness.js';

const IP = '127.0.0.1';
const getPower = getProperties([EPC.FanPower]);

describe('KdkClient', () => {
  it('discovers the fan with the app timings scaled down', async () => {
    const { client, fan } = await startFan();
    const found = await client.discover([IP], { bursts: 2, burstIntervalMs: 20, collectMs: 50 });
    expect(found).toEqual([{ ip: IP, guid: fan.guid, commId: 'FM15GC', partId: '1.0.6', known: true, hasLight: true }]);
  });

  it('GETs properties and matches the reply by TID', async () => {
    const { client, fan } = await startFan();
    const frame = await client.get(IP, getProperties([EPC.FanPower, EPC.FanVolume, EPC.ProductCode]));
    expect(frame.esv).toBe(ESV.GET_OK);
    expect(frame.properties.map(p => [p.epc, p.data.length])).toEqual([[EPC.FanPower, 1], [EPC.FanVolume, 1], [EPC.ProductCode, 0]]);
    expect(fan.received[0]?.tid).toBe(frame.tid);
  });

  it('SETs properties and the fan state changes', async () => {
    const { client, fan } = await startFan();
    const frame = await client.set(IP, [{ epc: EPC.FanPower, data: Uint8Array.of(SWITCH.ON) }]);
    expect(frame.esv).toBe(ESV.SET_OK);
    expect(fan.state.fanPower).toBe(true);
  });

  it('rejects with FanRejectedError on SetC_SNA and Get_SNA', async () => {
    const { client, fan } = await startFan();
    fan.rejectSets = true;
    await expect(client.set(IP, [{ epc: EPC.FanPower, data: Uint8Array.of(SWITCH.ON) }])).rejects.toBeInstanceOf(FanRejectedError);
    fan.rejectGets = true;
    await expect(client.get(IP, getPower)).rejects.toBeInstanceOf(FanRejectedError);
  });

  it('times out when the fan does not answer, and ignores replies with an unknown TID', async () => {
    const { client, fan } = await startFan();
    fan.silent = true;
    await expect(client.get(IP, getPower)).rejects.toBeInstanceOf(TimeoutError);
    fan.silent = false;
    fan.corruptTid = true;
    await expect(client.get(IP, getPower)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('rejects a reply that is truncated', async () => {
    const { client, fan } = await startFan();
    fan.malformedReplies = 1;
    await expect(client.get(IP, getProperties([EPC.FanPower, EPC.FanVolume]))).rejects.toBeInstanceOf(ProtocolError);
    expect((await client.get(IP, getPower)).esv).toBe(ESV.GET_OK);
  });

  it('serialises requests to the same fan with distinct increasing TIDs', async () => {
    const { client, fan } = await startFan();
    const frames = await Promise.all([
      client.get(IP, getProperties([EPC.FanPower])),
      client.get(IP, getProperties([EPC.FanVolume])),
      client.get(IP, getProperties([EPC.FanDirection])),
    ]);
    const tids = frames.map(f => f.tid);
    expect(new Set(tids).size).toBe(3);
    expect(tids).toEqual([...tids].sort((a, b) => a - b));
    expect(fan.received.map(f => f.properties[0]?.epc)).toEqual([EPC.FanPower, EPC.FanVolume, EPC.FanDirection]);
  });

  it('spaces requests to one fan by minRequestIntervalMs', async () => {
    const { client, fan } = await startFan({ client: { minRequestIntervalMs: 120 } });
    const arrivals: number[] = [];
    for (let i = 1; i <= 3; i++) {
      void fan.waitFor(r => r.length >= i).then(() => arrivals.push(Date.now()));
    }
    await Promise.all([1, 2, 3].map(() => client.get(IP, getPower)));
    expect(fan.received).toHaveLength(3);
    const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
    expect(gaps).toHaveLength(2);
    expect(gaps.every(g => g >= 100)).toBe(true);
  });

  it('holds control requests while discovery runs, and waits for in-flight ones before starting', async () => {
    const { client, fan } = await startFan();
    fan.getDelayMs = 100;
    const inflight = client.get(IP, getPower);
    await fan.nextFrame(); // the GET is on the wire
    const discovery = client.discover([IP], { bursts: 1, collectMs: 150 });
    const during = client.get(IP, getProperties([EPC.FanVolume]));
    await inflight;
    // discovery waited for the in-flight GET, and the GET issued during discovery is held back
    expect(fan.received).toHaveLength(1);
    await discovery;
    await during;
    expect(fan.received.map(f => f.properties[0]?.epc)).toEqual([EPC.FanPower, EPC.FanVolume]);
  });

  it('runs concurrent discoveries one after the other', async () => {
    const { client } = await startFan();
    const [a, b] = await Promise.all([
      client.discover([IP], { bursts: 1, collectMs: 30 }),
      client.discover([IP], { bursts: 1, collectMs: 30 }),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('rejects everything pending when stopped, and refuses requests before start', async () => {
    const { client, fan } = await startFan();
    fan.silent = true;
    const p = client.get(IP, getPower);
    await fan.nextFrame();
    client.stop();
    await expect(p).rejects.toThrow(/stopped/);
    await expect(client.get(IP, getPower)).rejects.toThrow(/not started/);
    await expect(client.discover([IP])).rejects.toThrow(/not started/);
  });

  it('fails to start when the port is taken', async () => {
    const { client } = await startFan();
    const second = new KdkClient({ port: client.port, bindAddress: '127.0.0.1' });
    await expect(second.start()).rejects.toThrow(/EADDRINUSE/);
    second.stop();
  });
});
