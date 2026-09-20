import { isIPv4 } from 'node:net';

import type { PlatformConfig } from 'homebridge';

import { MELODY, type Melody } from './protocol/epc.js';

export const SWING_MODES = ['yuragi', 'reverse', 'off'] as const;
export type SwingModeMapping = (typeof SWING_MODES)[number];

export const COMMAND_SOUNDS = ['off', 'beep', '1', '2', '3'] as const;
type CommandSound = (typeof COMMAND_SOUNDS)[number];

export interface DeviceConfig {
  guid: string;
  name?: string;
  /** Per-fan override of the global option. */
  swingMode?: SwingModeMapping;
  /** Per-fan override of the global option. */
  nightModeSwitch?: boolean;
}

export interface KdkAiryConfig {
  /** Poll interval in milliseconds. */
  refreshInterval: number;
  /** Minimum gap between consecutive requests to the same fan, in milliseconds. */
  minRequestInterval: number;
  /** Broadcast addresses to send M-SEARCH to; empty = every local interface. */
  broadcastAddresses: string[];
  /** Beep flag sent with every command (BuzzerSet). */
  buzzer: boolean;
  /** Melody sent with every command. */
  melody: Melody;
  /** Expose the "Night" switch on light models. */
  nightModeSwitch: boolean;
  /** What HomeKit's Swing Mode controls: the 1/f Yuragi fluctuation, the reverse direction or nothing. */
  swingMode: SwingModeMapping;
  allowUnknownModels: boolean;
  devices: DeviceConfig[];
}

/**
 * Defaults and bounds. config.schema.json and the settings page (homebridge-ui/public/settings-model.js) repeat
 * them because neither can import this module; test/config.test.ts checks that all three agree.
 */
export const DEFAULTS = {
  refreshInterval: 5000,
  minRefreshInterval: 1000,
  maxRefreshInterval: 60_000,
  minRequestInterval: 100,
  maxMinRequestInterval: 5000,
  commandSound: 'off',
  swingMode: 'off',
  nightModeSwitch: true,
  allowUnknownModels: false,
} as const;

/** The single `command_sound` option maps onto the fan's two properties. The app always sends the beep flag on. */
const COMMAND_SOUND: Record<CommandSound, { buzzer: boolean; melody: Melody }> = {
  off: { buzzer: false, melody: MELODY.NONE },
  beep: { buzzer: true, melody: MELODY.NONE },
  '1': { buzzer: true, melody: MELODY.MELODY_1 },
  '2': { buzzer: true, melody: MELODY.MELODY_2 },
  '3': { buzzer: true, melody: MELODY.MELODY_3 },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** A missing, null or empty-string value means "use the default", which is what the settings page writes. */
function valueOf(cfg: Record<string, unknown>, key: string, fallback: unknown): unknown {
  const value = cfg[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function integer(cfg: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = valueOf(cfg, key, fallback);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolean(cfg: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = valueOf(cfg, key, fallback);
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${key} must be true or false`);
  }
  return value;
}

function oneOf<T extends string>(cfg: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T, label = key): T {
  const value = valueOf(cfg, key, fallback);
  if (!allowed.includes(value as T)) {
    throw new ConfigError(`${label} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** A comma or space separated string (what the settings page writes) or an array of IPv4 addresses. */
function broadcastList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const list: unknown = typeof value === 'string' ? value.split(/[\s,]+/) : value;
  if (!Array.isArray(list) || !list.every(a => typeof a === 'string')) {
    throw new ConfigError('broadcast_addresses must be a comma-separated string or an array of IPv4 addresses');
  }
  const addresses = list.map(a => a.trim()).filter(a => a.length > 0);
  const bad = addresses.find(a => !isIPv4(a));
  if (bad !== undefined) {
    throw new ConfigError(`broadcast_addresses: "${bad}" is not an IPv4 address`);
  }
  return addresses;
}

function deviceList(value: unknown): DeviceConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError('devices must be an array');
  }
  const devices: DeviceConfig[] = [];
  for (const item of value) {
    const dev: Record<string, unknown> = typeof item === 'object' && item !== null ? item : {};
    if (typeof dev.guid !== 'string' || dev.guid.length === 0) {
      throw new ConfigError('each devices entry needs a guid');
    }
    const entry: DeviceConfig = { guid: dev.guid.toUpperCase() };
    if (devices.some(d => d.guid === entry.guid)) {
      throw new ConfigError(`devices: guid ${entry.guid} appears more than once`);
    }
    if (typeof dev.name === 'string' && dev.name) {
      entry.name = dev.name;
    }
    if (valueOf(dev, 'swing_mode', undefined) !== undefined) {
      entry.swingMode = oneOf(dev, 'swing_mode', SWING_MODES, DEFAULTS.swingMode, `devices[${entry.guid}].swing_mode`);
    }
    // The settings page writes "show" / "hide"; booleans are accepted for hand-written configs.
    const night = valueOf(dev, 'night_mode_switch', undefined);
    if (night === true || night === 'show') {
      entry.nightModeSwitch = true;
    } else if (night === false || night === 'hide') {
      entry.nightModeSwitch = false;
    } else if (night !== undefined) {
      throw new ConfigError(`devices[${entry.guid}].night_mode_switch must be show or hide`);
    }
    devices.push(entry);
  }
  return devices;
}

/** Validate and normalise the raw platform config. Throws ConfigError on anything unusable. */
export function parseConfig(cfg: PlatformConfig): KdkAiryConfig {
  const sound = COMMAND_SOUND[oneOf(cfg, 'command_sound', COMMAND_SOUNDS, DEFAULTS.commandSound)];
  return {
    refreshInterval: integer(cfg, 'refresh_interval', DEFAULTS.refreshInterval, DEFAULTS.minRefreshInterval, DEFAULTS.maxRefreshInterval),
    minRequestInterval: integer(cfg, 'min_request_interval', DEFAULTS.minRequestInterval, 0, DEFAULTS.maxMinRequestInterval),
    broadcastAddresses: broadcastList(cfg.broadcast_addresses),
    buzzer: sound.buzzer,
    melody: sound.melody,
    nightModeSwitch: boolean(cfg, 'night_mode_switch', DEFAULTS.nightModeSwitch),
    swingMode: oneOf(cfg, 'swing_mode', SWING_MODES, DEFAULTS.swingMode),
    allowUnknownModels: boolean(cfg, 'allow_unknown_models', DEFAULTS.allowUnknownModels),
    devices: deviceList(cfg.devices),
  };
}
