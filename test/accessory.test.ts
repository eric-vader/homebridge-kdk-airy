/**
 * Drives the HomeKit layer with real HAP services from @homebridge/hap-nodejs against the fake fan.
 */
import * as hapNodeJs from '@homebridge/hap-nodejs';
import { describe, expect, it } from 'vitest';

import {
  brightnessToNightlight, colourToMired, miredToColour, nightlightToBrightness, speedToVolume, volumeToSpeed,
} from '../src/accessory.js';
import { FAN_DIRECTION, LIGHT_MODE, NIGHTLIGHT_BRIGHTNESS } from '../src/protocol/epc.js';
import { ESV } from '../src/protocol/frame.js';
import type { FakeFan } from './fake-fan.js';
import { startAccessory } from './harness.js';

const { Characteristic, Service } = hapNodeJs;

describe('value mappings', () => {
  it('speed <-> volume', () => {
    expect(volumeToSpeed(0x31)).toBe(10);
    expect(volumeToSpeed(0x3a)).toBe(100);
    expect(speedToVolume(10)).toBe(0x31);
    expect(speedToVolume(100)).toBe(0x3a);
    expect(speedToVolume(1)).toBe(0x31);
    expect(speedToVolume(55)).toBe(0x36);
  });

  it('colour <-> mired', () => {
    expect(colourToMired(0)).toBe(500);
    expect(colourToMired(100)).toBe(140);
    expect(miredToColour(500)).toBe(0);
    expect(miredToColour(140)).toBe(100);
    expect(miredToColour(1000)).toBe(0);
    expect(miredToColour(colourToMired(63))).toBe(63);
  });

  it('nightlight <-> brightness', () => {
    expect(nightlightToBrightness(1)).toBe(33);
    expect(nightlightToBrightness(50)).toBe(66);
    expect(nightlightToBrightness(100)).toBe(100);
    expect(brightnessToNightlight(20)).toBe(NIGHTLIGHT_BRIGHTNESS.LOW);
    expect(brightnessToNightlight(60)).toBe(NIGHTLIGHT_BRIGHTNESS.MEDIUM);
    expect(brightnessToNightlight(100)).toBe(NIGHTLIGHT_BRIGHTNESS.HIGH);
  });
});

type CharType = hapNodeJs.WithUUID<{ new (): hapNodeJs.Characteristic }>;
const char = (service: hapNodeJs.Service, c: CharType) => service.getCharacteristic(c);
const get = (service: hapNodeJs.Service, c: CharType) => char(service, c).handleGetRequest();
const set = (service: hapNodeJs.Service, c: CharType, v: hapNodeJs.CharacteristicValue) => char(service, c).handleSetRequest(v);
const COMMUNICATION_FAILURE = hapNodeJs.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
/** Waits for the reload that follows a write, so a later reset() does not race it. */
const settled = (fan: FakeFan) => fan.waitFor(r => r.at(-1)?.esv === ESV.GET);

describe('KdkAiryAccessory', () => {
  it('creates exactly the expected services: one Lightbulb only, night mode as a hidden Switch', async () => {
    const { acc, handler } = await startAccessory();
    const uuids = acc.services.map(s => s.UUID).sort();
    expect(uuids).toEqual(
      [Service.AccessoryInformation.UUID, Service.Fanv2.UUID, Service.Lightbulb.UUID, Service.Switch.UUID].sort(),
    );
    expect(handler.fanService.isPrimaryService).toBe(true);
    expect(acc.getServiceById(Service.Lightbulb, 'light')?.displayName).toBe('Light');
    expect(acc.getServiceById(Service.Switch, 'night')?.displayName).toBe('Night');
    expect(acc.getServiceById(Service.Switch, 'night')?.isHiddenService).toBe(true);
  });

  it('reuses the services of a cached accessory and renames an old night switch', async () => {
    const acc = new hapNodeJs.Accessory('Old Fan', hapNodeJs.uuid.generate('old'));
    acc.addService(Service.Fanv2, 'Fan');
    acc.addService(Service.Switch, 'Night Mode', 'night');
    const { handler } = await startAccessory({ acc });
    expect(acc.services.filter(s => s.UUID === Service.Switch.UUID)).toHaveLength(1);
    expect(handler.nightService?.getCharacteristic(Characteristic.Name).value).toBe('Night');
    expect(handler.fanService.displayName).toBe('Fan');
  });

  it('models without a light get only the fan service', async () => {
    const { acc, handler } = await startAccessory({ fan: { commId: 'FM14EC' } });
    expect(acc.services.map(s => s.UUID)).toEqual([Service.AccessoryInformation.UUID, Service.Fanv2.UUID]);
    expect(handler.lightService).toBeUndefined();
  });

  it('night_mode_switch: false leaves only Fan and Light services and removes a cached switch', async () => {
    const acc = new hapNodeJs.Accessory('Old Fan', hapNodeJs.uuid.generate('old'));
    acc.addService(Service.Switch, 'Night', 'night');
    const { handler, fan } = await startAccessory({ acc, accessory: { nightModeSwitch: false } });
    expect(acc.services.map(s => s.UUID).sort())
      .toEqual([Service.AccessoryInformation.UUID, Service.Fanv2.UUID, Service.Lightbulb.UUID].sort());
    expect(handler.nightService).toBeUndefined();
    await set(handler.lightService!, Characteristic.On, true);
    expect(fan.state.lightPower).toBe(true);
  });

  it('swing_mode: reverse maps Swing Mode onto the fan direction, also for polled changes', async () => {
    const { handler, fan, device } = await startAccessory({ accessory: { swingMode: 'reverse' } });
    await set(handler.fanService, Characteristic.Active, Characteristic.Active.ACTIVE);
    await set(handler.fanService, Characteristic.SwingMode, Characteristic.SwingMode.SWING_ENABLED);
    expect(fan.state.fanDirection).toBe(FAN_DIRECTION.UP);
    expect(fan.state.fanFluctuation).toBe(false);
    expect(await get(handler.fanService, Characteristic.SwingMode)).toBe(Characteristic.SwingMode.SWING_ENABLED);
    expect(await get(handler.fanService, Characteristic.RotationDirection)).toBe(Characteristic.RotationDirection.CLOCKWISE);
    await set(handler.fanService, Characteristic.SwingMode, Characteristic.SwingMode.SWING_DISABLED);
    expect(fan.state.fanDirection).toBe(FAN_DIRECTION.DOWN);
    fan.state = { ...fan.state, fanDirection: FAN_DIRECTION.UP };
    await device.refresh();
    expect(char(handler.fanService, Characteristic.SwingMode).value).toBe(Characteristic.SwingMode.SWING_ENABLED);
  });

  it('swing_mode: off removes the Swing Mode characteristic, also from a cached service', async () => {
    const acc = new hapNodeJs.Accessory('Old Fan', hapNodeJs.uuid.generate('old'));
    acc.addService(Service.Fanv2, 'Fan').getCharacteristic(Characteristic.SwingMode);
    const { handler } = await startAccessory({ acc, accessory: { swingMode: 'off' } });
    expect(handler.fanService.testCharacteristic(Characteristic.SwingMode)).toBe(false);
  });

  it('reads reflect the fan state', async () => {
    const { handler, fan, device } = await startAccessory();
    fan.state = { ...fan.state, fanPower: true, fanVolume: 0x35, fanDirection: FAN_DIRECTION.UP, fanFluctuation: true,
      lightPower: true, lightBrightness: 40, lightColour: 100 };
    await device.refresh();
    const f = handler.fanService;
    expect(await get(f, Characteristic.Active)).toBe(Characteristic.Active.ACTIVE);
    expect(await get(f, Characteristic.RotationSpeed)).toBe(50);
    expect(await get(f, Characteristic.RotationDirection)).toBe(Characteristic.RotationDirection.CLOCKWISE);
    expect(await get(f, Characteristic.SwingMode)).toBe(Characteristic.SwingMode.SWING_ENABLED);
    const l = handler.lightService!;
    expect(await get(l, Characteristic.On)).toBe(true);
    expect(await get(l, Characteristic.Brightness)).toBe(40);
    expect(await get(l, Characteristic.ColorTemperature)).toBe(140);
    expect(await get(handler.nightService!, Characteristic.On)).toBe(false);
  });

  it('reads fail while a property is not known yet, even when the fan is online', async () => {
    const { handler } = await startAccessory({ fan: { initialState: { fanPower: true } } });
    expect(await get(handler.fanService, Characteristic.Active)).toBe(Characteristic.Active.ACTIVE);
    await expect(get(handler.fanService, Characteristic.RotationSpeed)).rejects.toBe(COMMUNICATION_FAILURE);
    await expect(get(handler.fanService, Characteristic.SwingMode)).rejects.toBe(COMMUNICATION_FAILURE);
    await expect(get(handler.lightService!, Characteristic.Brightness)).rejects.toBe(COMMUNICATION_FAILURE);
    await expect(get(handler.nightService!, Characteristic.On)).rejects.toBe(COMMUNICATION_FAILURE);
  });

  it('Active + RotationSpeed written together become one SET', async () => {
    const { handler, fan } = await startAccessory();
    fan.reset();
    await Promise.all([
      set(handler.fanService, Characteristic.Active, Characteristic.Active.ACTIVE),
      set(handler.fanService, Characteristic.RotationSpeed, 70),
    ]);
    expect(fan.frames(ESV.SET)).toHaveLength(1);
    expect(fan.state).toMatchObject({ fanPower: true, fanVolume: 0x37 });
    expect(await get(handler.fanService, Characteristic.RotationSpeed)).toBe(70);
  });

  it('direction, swing mode and speed 0 map to the fan properties', async () => {
    const { handler, fan } = await startAccessory();
    await set(handler.fanService, Characteristic.Active, Characteristic.Active.ACTIVE);
    await set(handler.fanService, Characteristic.RotationDirection, Characteristic.RotationDirection.CLOCKWISE);
    expect(fan.state.fanDirection).toBe(FAN_DIRECTION.UP);
    await set(handler.fanService, Characteristic.RotationDirection, Characteristic.RotationDirection.COUNTER_CLOCKWISE);
    expect(fan.state.fanDirection).toBe(FAN_DIRECTION.DOWN);
    await set(handler.fanService, Characteristic.SwingMode, Characteristic.SwingMode.SWING_ENABLED);
    expect(fan.state.fanFluctuation).toBe(true);
    await set(handler.fanService, Characteristic.RotationSpeed, 0);
    expect(fan.state.fanPower).toBe(false);
  });

  it('light: on/brightness/colour temperature, and off leaves night mode', async () => {
    const { handler, fan } = await startAccessory();
    const l = handler.lightService!;
    await set(l, Characteristic.On, true);
    await set(l, Characteristic.Brightness, 25);
    await set(l, Characteristic.ColorTemperature, 500);
    expect(fan.state).toMatchObject({ lightPower: true, lightMode: LIGHT_MODE.NORMAL, lightBrightness: 25, lightColour: 0 });

    await set(handler.nightService!, Characteristic.On, true);
    expect(fan.state).toMatchObject({ lightPower: true, lightMode: LIGHT_MODE.NIGHT });
    expect(await get(handler.nightService!, Characteristic.On)).toBe(true);
    // in night mode the main bulb's brightness shows the nightlight level and colour writes are ignored
    await set(l, Characteristic.Brightness, 100);
    expect(fan.state.nightlightBrightness).toBe(NIGHTLIGHT_BRIGHTNESS.HIGH);
    await settled(fan);
    fan.reset();
    await set(l, Characteristic.ColorTemperature, 300);
    expect(fan.received).toHaveLength(0);

    await set(l, Characteristic.On, false);
    // only LightPower is sent while off, as in the app, so the fan keeps NIGHT internally
    expect(fan.state).toMatchObject({ lightPower: false, lightMode: LIGHT_MODE.NIGHT });
    expect(await get(handler.nightService!, Characteristic.On)).toBe(false);
    // Brightness 0, colour writes and Night off while the light is off send nothing
    await settled(fan);
    fan.reset();
    await set(l, Characteristic.Brightness, 0);
    await set(l, Characteristic.ColorTemperature, 300);
    await set(handler.nightService!, Characteristic.On, false);
    expect(fan.received).toHaveLength(0);
    // and Light on selects the normal light again
    await set(l, Characteristic.On, true);
    expect(fan.state).toMatchObject({ lightPower: true, lightMode: LIGHT_MODE.NORMAL });
  });

  it('in night mode the Light brightness slider picks LOW / MEDIUM / HIGH', async () => {
    const { handler, fan } = await startAccessory();
    const n = handler.nightService!;
    const l = handler.lightService!;
    await set(n, Characteristic.On, true);
    expect(fan.state).toMatchObject({ lightPower: true, lightMode: LIGHT_MODE.NIGHT, nightlightBrightness: 50 });
    await set(l, Characteristic.Brightness, 10);
    expect(fan.state.nightlightBrightness).toBe(NIGHTLIGHT_BRIGHTNESS.LOW);
    expect(await get(l, Characteristic.Brightness)).toBe(33);
    await set(l, Characteristic.Brightness, 50);
    expect(fan.state.nightlightBrightness).toBe(NIGHTLIGHT_BRIGHTNESS.MEDIUM);
    await set(n, Characteristic.On, false);
    expect(fan.state.lightMode).toBe(LIGHT_MODE.NORMAL);
    expect(fan.state.lightPower).toBe(true);
  });

  it('pushes polled changes into the characteristics and logs a fault once per occurrence', async () => {
    const { handler, fan, device, log } = await startAccessory();
    fan.state = { ...fan.state, fanPower: true, fanVolume: 0x3a, lightPower: true, lightMode: LIGHT_MODE.NIGHT,
      nightlightBrightness: 1, errorStatus: true, errorCode: 'H21' };
    await device.refresh();
    await device.refresh();
    expect(char(handler.fanService, Characteristic.Active).value).toBe(Characteristic.Active.ACTIVE);
    expect(char(handler.fanService, Characteristic.RotationSpeed).value).toBe(100);
    expect(char(handler.lightService!, Characteristic.Brightness).value).toBe(33);
    expect(char(handler.nightService!, Characteristic.On).value).toBe(true);
    expect(log.lines.filter(l => l.includes('error code H21'))).toHaveLength(1);
    fan.state = { ...fan.state, errorStatus: false };
    await device.refresh();
    fan.state = { ...fan.state, errorStatus: true, errorCode: '' };
    await device.refresh();
    expect(log.lines.filter(l => l.includes('error code ?'))).toHaveLength(1);
    // only spec characteristics on the fan service
    expect(handler.fanService.characteristics.map(c => c.UUID)).not.toContain(Characteristic.StatusFault.UUID);
  });

  it('reports SERVICE_COMMUNICATION_FAILURE while offline and on failed writes, and logs the flips', async () => {
    const { handler, fan, device, log } = await startAccessory();
    fan.silent = true;
    for (let i = 0; i < 3; i++) {
      await expect(device.refresh()).rejects.toThrow();
    }
    expect(device.online).toBe(false);
    // HAP turns a HapStatusError thrown by a handler into the numeric status it sends to the controller.
    await expect(get(handler.fanService, Characteristic.Active)).rejects.toBe(COMMUNICATION_FAILURE);
    await expect(set(handler.fanService, Characteristic.Active, 1)).rejects.toBe(COMMUNICATION_FAILURE);
    // a write matching the stale cache is still attempted, and fails, while the fan is offline
    await expect(set(handler.fanService, Characteristic.Active, 0)).rejects.toBe(COMMUNICATION_FAILURE);
    expect(log.lines).toContain('warn: Test Fan: not responding');
    fan.silent = false;
    await device.refresh();
    expect(log.lines).toContain('info: Test Fan: back online');
  });

  it('writes that change nothing send nothing: repeated colour temperature, Light on while in night mode', async () => {
    const { handler, fan } = await startAccessory();
    const l = handler.lightService!;
    await set(handler.nightService!, Characteristic.On, true);
    await settled(fan);
    fan.reset();
    await set(l, Characteristic.On, true); // a scene or "turn everything on" while in night mode
    expect(fan.received).toHaveLength(0);
    expect(fan.state.lightMode).toBe(LIGHT_MODE.NIGHT);
    await set(handler.nightService!, Characteristic.On, false);
    await set(l, Characteristic.ColorTemperature, 300);
    await settled(fan);
    fan.reset();
    await set(l, Characteristic.ColorTemperature, 299); // same fan colour after quantisation
    await set(handler.fanService, Characteristic.Active, Characteristic.Active.INACTIVE); // already off
    expect(fan.received).toHaveLength(0);
  });

  it('dispose() fails a write that has not been sent and stops listening to the device', async () => {
    const { handler, fan, device } = await startAccessory();
    fan.reset();
    const write = set(handler.fanService, Characteristic.Active, Characteristic.Active.ACTIVE);
    handler.dispose();
    await expect(write).rejects.toBe(COMMUNICATION_FAILURE);
    expect(fan.received).toHaveLength(0);
    expect(device.listenerCount('state')).toBe(0);
    expect(device.listenerCount('online')).toBe(0);
  });
});
