/**
 * HomeKit representation of one fan.
 *
 * Exposure is limited to what fits the standard services:
 *   Fanv2            Active, RotationSpeed, RotationDirection, SwingMode (1/f Yuragi fluctuation, or the reverse
 *                    direction, or absent, per the swing_mode option)
 *   Lightbulb Light  On, Brightness, ColorTemperature (light models only); in night mode Brightness maps to the
 *                    LOW / MEDIUM / HIGH nightlight level
 *   Switch "Night"   On = night mode, hidden from the Home app as in the previous plugin, so it is not part of
 *                    "turn everything on". Night mode is a Switch and not a second Lightbulb because an accessory
 *                    with two Lightbulb services makes the Home app's Adaptive Lighting setup fail.
 * Timers, sleep mode and melodies are supported by FanDevice but not exposed. Fan errors are logged: Fanv2 has no
 * fault characteristic in the HAP specification, and characteristics outside the specification make the Home app
 * fail during setup.
 */
import type { CharacteristicValue, HAP, Logging, PlatformAccessory, Service } from 'homebridge';

import type { SwingModeMapping } from './config.js';
import type { FanDevice } from './device.js';
import {
  FAN_DIRECTION, FAN_VOLUME, LIGHT_BRIGHTNESS, LIGHT_COLOUR, LIGHT_MODE, mergeState, NIGHTLIGHT_BRIGHTNESS, type FanState,
  type NightlightBrightness,
} from './protocol/epc.js';

/** The subset of PlatformAccessory the accessory logic needs. A bare HAP Accessory in tests satisfies it too. */
export type HostAccessory = Pick<PlatformAccessory,
  'displayName' | 'getService' | 'getServiceById' | 'addService' | 'removeService' | 'configureController'>;

export interface AccessoryOptions {
  /** Milliseconds to wait for further HomeKit writes before sending one combined SET. Tests shorten it. */
  coalesceMs?: number;
  /** Expose the Night switch (default true). */
  nightModeSwitch?: boolean;
  /** What Swing Mode controls (default 'off': not exposed). */
  swingMode?: SwingModeMapping;
}

/** A HomeKit write that arrives as several characteristics, such as Active and RotationSpeed, lands within this window. */
const COALESCE_MS = 50;
/** HomeKit colour temperature range in mired; MIN is the coolest value and maps to LightColour 100. */
const MIRED = { MIN: 140, MAX: 500 } as const;
/** HomeKit's RotationSpeed range. */
const SPEED_MAX = 100;
const SPEED_STEPS = FAN_VOLUME.MAX - FAN_VOLUME.MIN + 1;
const SPEED_STEP = SPEED_MAX / SPEED_STEPS;
/** Brightness shown for each nightlight level while in night mode, in ascending order. */
const NIGHTLIGHT_PERCENT: readonly [NightlightBrightness, number][] = [
  [NIGHTLIGHT_BRIGHTNESS.LOW, 33], [NIGHTLIGHT_BRIGHTNESS.MEDIUM, 66], [NIGHTLIGHT_BRIGHTNESS.HIGH, 100],
];

/** LightColour 0..100 (0 warm .. 100 cool) -> mired 500..140 */
export function colourToMired(colour: number): number {
  return Math.round(MIRED.MAX - (colour / LIGHT_COLOUR.MAX) * (MIRED.MAX - MIRED.MIN));
}

export function miredToColour(mired: number): number {
  const clamped = Math.min(MIRED.MAX, Math.max(MIRED.MIN, mired));
  return Math.round(((MIRED.MAX - clamped) / (MIRED.MAX - MIRED.MIN)) * LIGHT_COLOUR.MAX);
}

/** FanVolume 0x31..0x3A -> RotationSpeed 10..100 */
export function volumeToSpeed(volume: number): number {
  return (volume - FAN_VOLUME.MIN + 1) * SPEED_STEP;
}

/** RotationSpeed 1..100 -> FanVolume 0x31..0x3A */
export function speedToVolume(speed: number): number {
  const step = Math.min(SPEED_STEPS, Math.max(1, Math.ceil(speed / SPEED_STEP)));
  return FAN_VOLUME.MIN + step - 1;
}

export function nightlightToBrightness(level: number): number {
  for (const [nightlight, percent] of NIGHTLIGHT_PERCENT) {
    if (level <= nightlight) {
      return percent;
    }
  }
  return LIGHT_BRIGHTNESS.MAX;
}

export function brightnessToNightlight(brightness: number): NightlightBrightness {
  for (const [nightlight, percent] of NIGHTLIGHT_PERCENT) {
    if (brightness <= percent) {
      return nightlight;
    }
  }
  return NIGHTLIGHT_BRIGHTNESS.HIGH;
}

/** Apply `map` to a value the fan may not have reported yet. */
function mapDefined<A, B>(value: A | undefined, map: (value: A) => B): B | undefined {
  return value === undefined ? undefined : map(value);
}

export class KdkAiryAccessory {
  readonly fanService: Service;
  readonly lightService?: Service;
  readonly nightService?: Service;

  private pendingChange: FanState = {};
  private errorLogged = false;
  private readonly swingMode: SwingModeMapping;
  private flushTimer?: NodeJS.Timeout;
  private flush?: Promise<void>;
  /** Rejects the pending batch; set while a batch waits for the coalesce timer. */
  private cancelFlush?: () => void;
  private readonly coalesceMs: number;
  private readonly onState = (state: FanState) => this.push(state);
  private readonly onOnline = (online: boolean) => {
    if (online) {
      this.log.info(`${this.accessory.displayName}: back online`);
    } else {
      this.log.warn(`${this.accessory.displayName}: not responding`);
    }
  };

  constructor(
    private readonly hap: HAP,
    private readonly log: Logging,
    private readonly accessory: HostAccessory,
    readonly device: FanDevice,
    options: AccessoryOptions = {},
  ) {
    this.coalesceMs = options.coalesceMs ?? COALESCE_MS;
    this.swingMode = options.swingMode ?? 'off';
    const { Service, Characteristic } = hap;
    const { Active, RotationDirection, SwingMode } = Characteristic;

    this.fanService = accessory.getService(Service.Fanv2) ?? accessory.addService(Service.Fanv2, 'Fan');
    this.fanService.setPrimaryService(true);
    this.fanService.getCharacteristic(Active)
      .onGet(() => this.read(s => mapDefined(s.fanPower, on => (on ? Active.ACTIVE : Active.INACTIVE))))
      .onSet(v => this.queue({ fanPower: v === Active.ACTIVE }));
    this.fanService.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: SPEED_MAX, minStep: SPEED_STEP })
      .onGet(() => this.read(s => mapDefined(s.fanVolume, v => (s.fanPower ? volumeToSpeed(v) : 0))))
      .onSet(v => this.queue(Number(v) === 0 ? { fanPower: false } : { fanPower: true, fanVolume: speedToVolume(Number(v)) }));
    this.fanService.getCharacteristic(RotationDirection)
      // Verified on a fan: DOWN (0x41) is shown as counter-clockwise in HomeKit.
      .onGet(() => this.read(s => mapDefined(s.fanDirection,
        d => (d === FAN_DIRECTION.UP ? RotationDirection.CLOCKWISE : RotationDirection.COUNTER_CLOCKWISE))))
      .onSet(v => this.queue({ fanDirection: v === RotationDirection.CLOCKWISE ? FAN_DIRECTION.UP : FAN_DIRECTION.DOWN }));
    if (this.swingMode === 'off') {
      if (this.fanService.testCharacteristic(SwingMode)) {
        this.fanService.removeCharacteristic(this.fanService.getCharacteristic(SwingMode));
      }
    } else {
      this.fanService.getCharacteristic(SwingMode)
        .onGet(() => this.read(s => mapDefined(this.swingOn(s), on => (on ? SwingMode.SWING_ENABLED : SwingMode.SWING_DISABLED))))
        .onSet(v => this.queue(this.swingChange(v === SwingMode.SWING_ENABLED)));
    }

    if (device.hasLight) {
      this.lightService = accessory.getServiceById(Service.Lightbulb, 'light')
        ?? accessory.addService(Service.Lightbulb, 'Light', 'light');
      this.lightService.getCharacteristic(Characteristic.On)
        .onGet(() => this.read(s => s.lightPower))
        .onSet(v => this.setLightOn(Boolean(v)));
      this.lightService.getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.read(s => this.brightnessOf(s)))
        .onSet(v => this.setBrightness(Number(v)));
      this.lightService.getCharacteristic(Characteristic.ColorTemperature)
        .setProps({ minValue: MIRED.MIN, maxValue: MIRED.MAX })
        .onGet(() => this.read(s => mapDefined(s.lightColour, colourToMired)))
        .onSet(v => this.setColourTemperature(Number(v)));
      accessory.configureController(new hap.AdaptiveLightingController(this.lightService));

      const existingSwitch = accessory.getServiceById(Service.Switch, 'night');
      if (options.nightModeSwitch ?? true) {
        this.nightService = existingSwitch ?? accessory.addService(Service.Switch, 'Night', 'night');
        this.nightService.updateCharacteristic(Characteristic.Name, 'Night');
        // Hidden, as in the previous plugin: the Home app does not show it or include it when the whole
        // accessory is turned on. Third-party HomeKit apps and automations can still use it.
        this.nightService.setHiddenService(true);
        this.nightService.getCharacteristic(Characteristic.On)
          .onGet(() => this.read(s => this.isNight(s)))
          .onSet(v => this.setNightOn(Boolean(v)));
      } else if (existingSwitch) {
        accessory.removeService(existingSwitch);
      }
    }

    device.on('state', this.onState);
    device.on('online', this.onOnline);
  }

  // ---- reads --------------------------------------------------------------------------------------------------

  /** A characteristic value from the cached state; SERVICE_COMMUNICATION_FAILURE while offline or not yet known. */
  private read<T extends CharacteristicValue>(pick: (s: Readonly<FanState>) => T | undefined): T {
    const value = this.device.online ? pick(this.device.state) : undefined;
    if (value === undefined) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value;
  }

  /** Swing Mode state under the configured mapping; undefined while the fan has not reported it. */
  private swingOn(s: Readonly<FanState>): boolean | undefined {
    return this.swingMode === 'reverse' ? mapDefined(s.fanDirection, d => d === FAN_DIRECTION.UP) : s.fanFluctuation;
  }

  private swingChange(on: boolean): FanState {
    return this.swingMode === 'reverse'
      ? { fanDirection: on ? FAN_DIRECTION.UP : FAN_DIRECTION.DOWN }
      : { fanFluctuation: on };
  }

  /** Night mode is the light on in NIGHT mode; undefined while either is unknown. */
  private isNight(s: Readonly<FanState>): boolean | undefined {
    return s.lightPower === undefined || s.lightMode === undefined ? undefined : s.lightPower && s.lightMode === LIGHT_MODE.NIGHT;
  }

  /** Brightness shown on the main bulb: nightlight level while in night mode, otherwise LightBrightness. */
  private brightnessOf(s: Readonly<FanState>): number | undefined {
    return this.isNight(s) ? mapDefined(s.nightlightBrightness, nightlightToBrightness) : s.lightBrightness;
  }

  /** The cached state plus the writes waiting in the batch, the state a new write builds on. */
  private merged(): FanState {
    return mergeState(this.device.state, this.pendingChange);
  }

  /** Push a fresh device state into the characteristics. Only values that changed trigger HomeKit events. */
  push(s: Readonly<FanState>): void {
    const { Characteristic } = this.hap;
    const { Active, RotationDirection, SwingMode } = Characteristic;
    type Char = Parameters<Service['updateCharacteristic']>[0];
    const update = (service: Service | undefined, characteristic: Char, value: CharacteristicValue | undefined) => {
      if (service && value !== undefined) {
        service.updateCharacteristic(characteristic, value);
      }
    };
    update(this.fanService, Active, mapDefined(s.fanPower, on => (on ? Active.ACTIVE : Active.INACTIVE)));
    update(this.fanService, Characteristic.RotationSpeed, mapDefined(s.fanVolume, v => (s.fanPower ? volumeToSpeed(v) : 0)));
    update(this.fanService, RotationDirection,
      mapDefined(s.fanDirection, d => (d === FAN_DIRECTION.UP ? RotationDirection.CLOCKWISE : RotationDirection.COUNTER_CLOCKWISE)));
    if (this.swingMode !== 'off') {
      update(this.fanService, SwingMode, mapDefined(this.swingOn(s), on => (on ? SwingMode.SWING_ENABLED : SwingMode.SWING_DISABLED)));
    }
    if (s.errorStatus && !this.errorLogged) {
      this.log.warn(`${this.accessory.displayName}: fan reports error code ${s.errorCode || '?'}`);
    }
    this.errorLogged = s.errorStatus === true;
    update(this.lightService, Characteristic.On, s.lightPower);
    update(this.lightService, Characteristic.Brightness, this.brightnessOf(s));
    if (!this.isNight(s)) {
      update(this.lightService, Characteristic.ColorTemperature, mapDefined(s.lightColour, colourToMired));
    }
    update(this.nightService, Characteristic.On, this.isNight(s));
  }

  // ---- writes -------------------------------------------------------------------------------------------------

  private setLightOn(on: boolean): Promise<void> {
    // Light on means the normal light mode, unless the light is already on: a scene or "turn everything on" must
    // not take it out of night mode. When turning off, only LightPower is sent, as the app does.
    if (on && this.merged().lightPower === true) {
      return Promise.resolve();
    }
    return this.queue(on ? { lightPower: true, lightMode: LIGHT_MODE.NORMAL } : { lightPower: false });
  }

  private setBrightness(value: number): Promise<void> {
    if (value === 0) {
      return Promise.resolve(); // HomeKit sends On=false with it, which turns the light off
    }
    if (this.isNight(this.merged())) {
      return this.queue({ lightPower: true, lightMode: LIGHT_MODE.NIGHT, nightlightBrightness: brightnessToNightlight(value) });
    }
    return this.queue({ lightPower: true, lightMode: LIGHT_MODE.NORMAL, lightBrightness: value });
  }

  private setColourTemperature(mired: number): Promise<void> {
    const merged = this.merged();
    if (merged.lightPower === false || this.isNight(merged)) {
      this.log.debug(`${this.accessory.displayName}: ignoring colour temperature while light is off / in night mode`);
      return Promise.resolve();
    }
    return this.queue({ lightColour: miredToColour(mired) });
  }

  private setNightOn(on: boolean): Promise<void> {
    const merged = this.merged();
    if (on) {
      return this.queue({
        lightPower: true, lightMode: LIGHT_MODE.NIGHT, nightlightBrightness: merged.nightlightBrightness ?? NIGHTLIGHT_BRIGHTNESS.MEDIUM,
      });
    }
    if (merged.lightPower === false) {
      return Promise.resolve(); // the mode is pruned while the light is off, so there is nothing to send
    }
    return this.queue({ lightMode: LIGHT_MODE.NORMAL });
  }

  /**
   * Merge a change into the pending batch and flush after a short delay, so a HomeKit write that arrives as
   * several characteristics, such as Active and RotationSpeed, becomes a single SET and a single beep.
   * Values the fan already has are dropped: Adaptive Lighting and scenes repeat writes, and each SET beeps. While
   * the fan is offline the cache cannot be trusted, so everything is sent and fails as a write should.
   */
  queue(change: FanState): Promise<void> {
    const merged = this.device.online ? this.merged() : {};
    const changed = Object.fromEntries(Object.entries(change).filter(([key, value]) => merged[key as keyof FanState] !== value));
    if (Object.keys(changed).length === 0) {
      return this.flush ?? Promise.resolve();
    }
    this.pendingChange = mergeState(this.pendingChange, changed);
    if (!this.flush) {
      this.flush = new Promise<void>((resolve, reject) => {
        const fail = () => reject(new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        this.cancelFlush = fail;
        this.flushTimer = setTimeout(() => {
          const batch = this.pendingChange;
          this.pendingChange = {};
          this.flush = undefined;
          this.cancelFlush = undefined;
          this.log.debug(`${this.accessory.displayName}: set ${JSON.stringify(batch)}`);
          this.device.apply(batch, { awaitReload: false }).then(() => resolve(), (err: Error) => {
            this.log.warn(`${this.accessory.displayName}: set failed: ${err.message}`);
            fail();
          });
        }, this.coalesceMs);
      });
    }
    return this.flush;
  }

  /** Cancel a batch that has not been sent and stop listening to the device. Called on shutdown. */
  dispose(): void {
    clearTimeout(this.flushTimer);
    this.cancelFlush?.();
    this.device.off('state', this.onState);
    this.device.off('online', this.onOnline);
  }
}
