/**
 * Drives KdkAiryPlatform with a fake Homebridge API (real HAP accessories from @homebridge/hap-nodejs) and a fake
 * client, so registration, cache restoration, naming, per-fan overrides, polling and shutdown run without a network.
 */
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';

import * as hapNodeJs from '@homebridge/hap-nodejs';
import type { API, PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import plugin from '../src/index.js';
import { KdkAiryPlatform, type FanContext } from '../src/platform.js';
import { TimeoutError, type FanClient } from '../src/protocol/client.js';
import type { DiscoveredFan } from '../src/protocol/discovery.js';
import { decodeProperties, mergeState, type FanState, type Property } from '../src/protocol/epc.js';
import { ESV } from '../src/protocol/frame.js';
import { DEFAULT_FAN_STATE, replyToGet } from './fake-fan.js';
import { fakeLog } from './harness.js';

const { Service, Characteristic } = hapNodeJs;

vi.mock('node:os', async importOriginal => ({
  ...(await importOriginal<typeof import('node:os')>()), networkInterfaces: vi.fn(() => ({})),
}));

/** Stands in for KdkClient: scripted discovery results and an in-memory fan per address. */
class FakeClient {
  fans: DiscoveredFan[] = [];
  states = new Map<string, FanState>();
  offline = new Set<string>();
  started = false;
  discoveries = 0;
  gets: string[] = [];

  async start(): Promise<void> {
    this.started = true;
  }

  stop(): void {
    this.started = false;
  }

  async discover(): Promise<DiscoveredFan[]> {
    this.discoveries++;
    return this.fans;
  }

  async get(ip: string, properties: readonly Property[]) {
    this.gets.push(ip);
    if (this.offline.has(ip)) {
      throw new TimeoutError(`${ip}: no response`);
    }
    return { tid: 1, esv: ESV.GET_OK, properties: replyToGet(this.states.get(ip) ?? DEFAULT_FAN_STATE, properties) };
  }

  async set(ip: string, properties: readonly Property[]) {
    this.states.set(ip, mergeState(this.states.get(ip) ?? DEFAULT_FAN_STATE, decodeProperties(properties)));
    return { tid: 1, esv: ESV.SET_OK, properties: [] };
  }
}

class FakeAccessory extends hapNodeJs.Accessory {
  context: Partial<FanContext> = {};

  constructor(name: string, uuid: string, _category?: number) {
    super(name, uuid);
  }
}

function fakeApi() {
  const events = new EventEmitter();
  const calls = { registered: [] as FakeAccessory[], updated: [] as FakeAccessory[], unregistered: [] as FakeAccessory[] };
  const api = {
    hap: hapNodeJs,
    platformAccessory: FakeAccessory,
    on: (event: string, listener: () => void) => events.on(event, listener),
    registerPlatform: vi.fn(),
    registerPlatformAccessories: (_p: string, _n: string, a: FakeAccessory[]) => calls.registered.push(...a),
    updatePlatformAccessories: (a: FakeAccessory[]) => calls.updated.push(...a),
    unregisterPlatformAccessories: (_p: string, _n: string, a: FakeAccessory[]) => calls.unregistered.push(...a),
  } as unknown as API;
  return { api, calls, launch: () => events.emit('didFinishLaunching'), shutdown: () => events.emit('shutdown') };
}

const fan = (overrides: Partial<DiscoveredFan> = {}): DiscoveredFan => ({
  guid: 'GUID1', ip: '10.0.0.5', commId: 'FM15GC', partId: 'E48GP', known: true, hasLight: true, ...overrides,
});
const flush = () => vi.advanceTimersByTimeAsync(0);
const start = (config: Record<string, unknown>, api: API, log = fakeLog()) => {
  const client = new FakeClient();
  const raw = { platform: 'KDKAiry', broadcast_addresses: '10.0.0.255', ...config };
  const platform = new KdkAiryPlatform(log, raw, api, client as unknown as FanClient);
  return { client, platform };
};
const cached = (name: string, context: Partial<FanContext>): FakeAccessory => {
  const acc = new FakeAccessory(name, hapNodeJs.uuid.generate(context.guid ?? name));
  acc.context = context;
  return acc;
};

describe('KdkAiryPlatform', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('registers with Homebridge under the platform name', () => {
    const { api } = fakeApi();
    plugin(api);
    expect(api.registerPlatform).toHaveBeenCalledWith('KDKAiry', KdkAiryPlatform);
  });

  it('refuses to start on an invalid configuration', () => {
    const { api } = fakeApi();
    expect(() => new KdkAiryPlatform(fakeLog(), { platform: 'KDKAiry', refresh_interval: 10 }, api)).toThrow(/refresh_interval/);
  });

  it('registers a new fan with its configured name and per-fan overrides, and names the rest by address', async () => {
    const { api, calls, launch } = fakeApi();
    const { client } = start({
      swing_mode: 'off', devices: [{ guid: 'guid1', name: 'Study', swing_mode: 'reverse', night_mode_switch: 'hide' }],
    }, api);
    client.fans = [fan(), fan({ guid: 'GUID2', ip: '10.0.0.6', commId: 'FM14EC', hasLight: false })];
    launch();
    await flush();
    expect(client.started).toBe(true);
    expect(calls.registered.map(a => a.displayName)).toEqual(['Study', 'Fan 10.0.0.6']);
    const [study, other] = calls.registered as [FakeAccessory, FakeAccessory];
    expect(study.context).toEqual({ guid: 'GUID1', ip: '10.0.0.5', commId: 'FM15GC', partId: 'E48GP', hasLight: true });
    const info = study.getService(Service.AccessoryInformation)!;
    expect(info.getCharacteristic(Characteristic.Model).value).toBe('FM15GC');
    expect(info.getCharacteristic(Characteristic.SerialNumber).value).toBe('GUID1');
    expect(info.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('E48GP');
    expect(study.getServiceById(Service.Switch, 'night')).toBeUndefined(); // per-fan hide
    expect(study.getService(Service.Fanv2)!.testCharacteristic(Characteristic.SwingMode)).toBe(true); // per-fan reverse beats global off
    expect(other.getService(Service.Fanv2)!.testCharacteristic(Characteristic.SwingMode)).toBe(false);
    expect(other.getService(Service.Lightbulb)).toBeUndefined();
    // every fan was polled once on attach
    expect(client.gets).toEqual(['10.0.0.5', '10.0.0.6']);
  });

  it('brings a cached fan up before discovery, then applies the discovered address and a rename', async () => {
    const { api, calls, launch } = fakeApi();
    const { client, platform } = start({ devices: [{ guid: 'GUID1', name: 'Study' }] }, api);
    const acc = cached('Fan 10.0.0.5', { guid: 'GUID1', ip: '10.0.0.5', commId: 'FM15GC', partId: 'E48GP', hasLight: true });
    platform.configureAccessory(acc as unknown as PlatformAccessory);
    client.fans = [fan({ ip: '10.0.0.9' })];
    launch();
    await flush();
    expect(acc.getService(Service.Fanv2)).toBeDefined();
    expect(acc.displayName).toBe('Study');
    expect(acc.context.ip).toBe('10.0.0.9');
    // a later discovery with new firmware refreshes the cached context and the accessory information
    client.fans = [fan({ ip: '10.0.0.9', partId: 'E49GP' })];
    await platform.discover();
    expect(acc.context.partId).toBe('E49GP');
    expect(acc.getService(Service.AccessoryInformation)!.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('E49GP');
    expect(calls.registered).toHaveLength(0);
    expect(calls.updated).toContain(acc);
    // the fan is polled at its new address from now on
    client.gets.length = 0;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.gets).toEqual(['10.0.0.9']);
  });

  it('a cached accessory without context is removed, and discovering that fan later registers it afresh', async () => {
    const { api, calls, launch } = fakeApi();
    const { client, platform } = start({}, api);
    const ghost = cached('GUID1', {});
    platform.configureAccessory(ghost as unknown as PlatformAccessory);
    client.fans = [fan()];
    launch();
    await flush();
    expect(calls.unregistered).toEqual([ghost]);
    expect(calls.registered).toHaveLength(1);
    expect(calls.registered[0]).not.toBe(ghost);
  });

  it('a cached accessory that discovery finds unchanged is neither registered again nor updated', async () => {
    const { api, calls, launch } = fakeApi();
    const { client, platform } = start({}, api);
    const acc = cached('Fan 10.0.0.5', { guid: 'GUID1', ip: '10.0.0.5', commId: 'FM15GC', partId: 'E48GP', hasLight: true });
    platform.configureAccessory(acc as unknown as PlatformAccessory);
    client.fans = [fan()];
    launch();
    await flush();
    expect(calls.registered).toHaveLength(0);
    expect(calls.updated).toHaveLength(0);
    expect(client.gets).toEqual(['10.0.0.5']);
  });

  it('ignores unknown models unless allow_unknown_models is set', async () => {
    const zz = fan({ guid: 'G2', commId: 'ZZ99', known: false });
    const first = fakeApi();
    const log = fakeLog();
    start({}, first.api, log).client.fans = [zz];
    first.launch();
    await flush();
    expect(first.calls.registered).toHaveLength(0);
    expect(log.lines.some(l => l.includes('unknown model "ZZ99"'))).toBe(true);

    const second = fakeApi();
    start({ allow_unknown_models: true }, second.api).client.fans = [zz];
    second.launch();
    await flush();
    expect(second.calls.registered).toHaveLength(1);
    expect(second.calls.registered[0]!.getService(Service.Lightbulb)).toBeDefined();
  });

  it('polls every fan, and an offline fan triggers one rediscovery per minute', async () => {
    const { api, launch } = fakeApi();
    const { client } = start({ refresh_interval: 1000 }, api);
    client.fans = [fan()];
    launch();
    await flush();
    expect(client.discoveries).toBe(1);
    client.offline.add('10.0.0.5');
    await vi.advanceTimersByTimeAsync(3000); // three failed polls: offline, but inside the 60 s window
    expect(client.discoveries).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.discoveries).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000); // still offline, still throttled
    expect(client.discoveries).toBe(2);
    client.offline.clear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.gets.filter(ip => ip === '10.0.0.5').length).toBeGreaterThan(70);
  });

  it('warns and does nothing when there is no interface to broadcast on', async () => {
    const { api, launch } = fakeApi();
    const log = fakeLog();
    const { client } = start({ broadcast_addresses: '' }, api, log);
    launch();
    await flush();
    expect(networkInterfaces).toHaveBeenCalled();
    expect(client.discoveries).toBe(0);
    expect(log.lines.some(l => l.includes('No IPv4 interface'))).toBe(true);
  });

  it('shutdown stops polling and the client, and discovery afterwards is a no-op', async () => {
    const { api, launch, shutdown } = fakeApi();
    const { client, platform } = start({ refresh_interval: 1000 }, api);
    client.fans = [fan()];
    launch();
    await flush();
    shutdown();
    expect(client.started).toBe(false);
    const polls = client.gets.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.gets).toHaveLength(polls);
    await platform.discover();
    expect(client.discoveries).toBe(1);
  });

  it('shutdown before launch does not throw', () => {
    const { api, shutdown } = fakeApi();
    start({}, api);
    expect(() => shutdown()).not.toThrow();
  });
});
