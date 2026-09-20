/**
 * Reproduces what the Home app does when it enables Adaptive Lighting: a write to
 * CharacteristicValueTransitionControl carrying a transition curve, then reads of the light's characteristics.
 */
import * as hapNodeJs from '@homebridge/hap-nodejs';
import { describe, expect, it } from 'vitest';

import { ESV } from '../src/protocol/frame.js';
import { assignIds, buildEnablePayload } from './hap-internals.js';
import { startAccessory } from './harness.js';

const { Characteristic } = hapNodeJs;

describe('Adaptive Lighting enable (as the Home app does it)', () => {
  it('accepts the enable write before the SET is answered, pushes the first colour, and stays enabled through polls', async () => {
    const { handler, fan, device, log, acc } = await startAccessory({
      fan: { initialState: { fanPower: false, fanVolume: 0x31, lightPower: true, lightMode: 0x42, lightBrightness: 80, lightColour: 50 } },
      client: { requestTimeoutMs: 1000 },
    });
    assignIds(acc);
    const light = handler.lightService!;
    const brightness = light.getCharacteristic(Characteristic.Brightness);
    const colorTemp = light.getCharacteristic(Characteristic.ColorTemperature);
    const control = light.getCharacteristic(Characteristic.CharacteristicValueTransitionControl);
    const count = light.getCharacteristic(Characteristic.CharacteristicValueActiveTransitionCount);
    expect(brightness.iid).toBeGreaterThan(0);
    expect(colorTemp.iid).toBeGreaterThan(0);

    const supported = await light.getCharacteristic(Characteristic.SupportedCharacteristicValueTransitionConfiguration).handleGetRequest();
    expect(typeof supported).toBe('string');

    fan.reset();
    fan.setDelayMs = 100;
    const response = await control.handleSetRequest(buildEnablePayload(colorTemp.iid!, brightness.iid!), undefined);
    // the write handler returned before the fan acknowledged the SET (the SET is answered 100 ms after it arrives)
    expect(fan.frames(ESV.SET)).toHaveLength(0);
    expect(typeof response).toBe('string');
    expect(count.value).toBe(1);

    // the controller immediately applied the curve's current point (500 mired = warmest = colour 0)
    await fan.waitFor(r => r.some(f => f.esv === ESV.GET));
    expect(fan.state.lightColour).toBe(0);
    expect(colorTemp.value).toBe(500);

    // Home reads the light right after enabling
    expect(await light.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(true);
    expect(await brightness.handleGetRequest()).toBe(80);
    expect(await colorTemp.handleGetRequest()).toBe(500);

    // polls (updateCharacteristic) must not be mistaken for manual writes
    await device.refresh();
    await device.refresh();
    expect(count.value).toBe(1);

    // a real user write to ColorTemperature disables it, as HomeKit expects
    await colorTemp.handleSetRequest(300, undefined);
    expect(count.value).toBe(0);
    expect(log.lines.filter(l => l.startsWith('warn') || l.startsWith('error'))).toEqual([]);
  });
});
