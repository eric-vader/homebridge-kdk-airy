/** Shared setup for the tests that drive real UDP against the fake fan. Everything started is stopped after the test. */
import * as hapNodeJs from '@homebridge/hap-nodejs';
import type { HAP, Logging } from 'homebridge';
import { onTestFinished } from 'vitest';

import { KdkAiryAccessory, type AccessoryOptions } from '../src/accessory.js';
import { FanDevice, type FanDeviceOptions } from '../src/device.js';
import { KdkClient, type KdkClientOptions } from '../src/protocol/client.js';
import type { DiscoveredFan } from '../src/protocol/discovery.js';
import { MELODY } from '../src/protocol/epc.js';
import { FakeFan, type FakeFanOptions } from './fake-fan.js';

export const hap = hapNodeJs as unknown as HAP;

export type FakeLog = Logging & { lines: string[] };

/** A Logging that records every line as "<level>: <message>". */
export function fakeLog(): FakeLog {
  const lines: string[] = [];
  const push = (level: string) => (msg: string) => lines.push(`${level}: ${msg}`);
  const log = Object.assign(push('info'), {
    lines, prefix: 'test', info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'),
    log: push('log'), success: push('success'),
  });
  return log as unknown as FakeLog;
}

export interface FanSetup {
  fan?: FakeFanOptions;
  client?: Partial<KdkClientOptions>;
  device?: Partial<FanDeviceOptions>;
}

export interface FanHarness {
  fan: FakeFan;
  client: KdkClient;
  info: DiscoveredFan;
  device: FanDevice;
}

/** A fake fan, a client bound to a free port that has discovered it, and a FanDevice for it. */
export async function startFan(setup: FanSetup = {}): Promise<FanHarness> {
  const fan = new FakeFan(setup.fan);
  await fan.start();
  onTestFinished(() => fan.stop());
  const client = new KdkClient({
    port: 0, fanPort: fan.controlPort, discoveryPort: fan.discoveryPort, bindAddress: '127.0.0.1', requestTimeoutMs: 200,
    ...setup.client,
  });
  await client.start();
  onTestFinished(() => client.stop());
  const [info] = await client.discover(['127.0.0.1'], { bursts: 1, collectMs: 30 });
  if (!info) {
    throw new Error('fake fan did not answer discovery');
  }
  const device = new FanDevice(client, info, { buzzer: false, melody: MELODY.NONE, ...setup.device });
  return { fan, client, info, device };
}

export interface AccessoryHarness extends FanHarness {
  acc: hapNodeJs.Accessory;
  handler: KdkAiryAccessory;
  log: FakeLog;
}

/** startFan() plus a real HAP accessory driven by KdkAiryAccessory, refreshed once. */
export async function startAccessory(
  setup: FanSetup & { accessory?: AccessoryOptions; acc?: hapNodeJs.Accessory } = {},
): Promise<AccessoryHarness> {
  const h = await startFan(setup);
  const acc = setup.acc ?? new hapNodeJs.Accessory('Test Fan', hapNodeJs.uuid.generate(h.info.guid));
  const log = fakeLog();
  const handler = new KdkAiryAccessory(hap, log, acc, h.device, { coalesceMs: 10, swingMode: 'yuragi', ...setup.accessory });
  onTestFinished(() => handler.dispose());
  await h.device.refresh();
  return { ...h, acc, handler, log };
}
