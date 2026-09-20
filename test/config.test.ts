import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { COMMAND_SOUNDS, ConfigError, DEFAULTS, parseConfig, SWING_MODES } from '../src/config.js';
import { MELODY } from '../src/protocol/epc.js';
import { DEFAULTS as PAGE_DEFAULTS } from '../homebridge-ui/public/settings-model.js';

const base = { platform: 'KDKAiry', name: 'Fans' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig(base)).toEqual({
      refreshInterval: 5000, minRequestInterval: 100, broadcastAddresses: [], buzzer: false,
      melody: MELODY.NONE, nightModeSwitch: true, swingMode: 'off', allowUnknownModels: false,
      devices: [],
    });
  });

  it('treats null and empty strings, which the settings page writes, as absent', () => {
    expect(parseConfig({
      ...base, refresh_interval: null, min_request_interval: '', broadcast_addresses: null, command_sound: '',
      swing_mode: null, night_mode_switch: null, allow_unknown_models: '',
    })).toEqual(parseConfig(base));
  });

  it('accepts a full config', () => {
    const cfg = parseConfig({
      ...base, refresh_interval: 2000, min_request_interval: 250, broadcast_addresses: ['10.0.0.255'],
      command_sound: '2', night_mode_switch: false, swing_mode: 'reverse', allow_unknown_models: true,
      devices: [{ guid: 'abc', name: 'Study' }, { guid: 'def' }],
    });
    expect(cfg).toEqual({
      refreshInterval: 2000, minRequestInterval: 250, broadcastAddresses: ['10.0.0.255'], buzzer: true,
      melody: MELODY.MELODY_2, nightModeSwitch: false, swingMode: 'reverse', allowUnknownModels: true,
      devices: [{ guid: 'ABC', name: 'Study' }, { guid: 'DEF' }],
    });
  });

  it('accepts broadcast addresses as a comma or space separated string', () => {
    expect(parseConfig({ ...base, broadcast_addresses: '192.168.1.255, 10.0.0.255 ,, ' }).broadcastAddresses)
      .toEqual(['192.168.1.255', '10.0.0.255']);
    expect(parseConfig({ ...base, broadcast_addresses: '' }).broadcastAddresses).toEqual([]);
    expect(parseConfig({ ...base, broadcast_addresses: ['10.1.255.255'] }).broadcastAddresses).toEqual(['10.1.255.255']);
  });

  it('maps command_sound onto the beep flag and melody', () => {
    expect(parseConfig({ ...base, command_sound: 'off' })).toMatchObject({ buzzer: false, melody: MELODY.NONE });
    expect(parseConfig({ ...base, command_sound: 'beep' })).toMatchObject({ buzzer: true, melody: MELODY.NONE });
    expect(parseConfig({ ...base, command_sound: '3' })).toMatchObject({ buzzer: true, melody: MELODY.MELODY_3 });
  });

  it('parses per-fan overrides', () => {
    const cfg = parseConfig({ ...base, devices: [
      { guid: 'a', name: 'Study', swing_mode: 'reverse', night_mode_switch: 'hide' },
      { guid: 'b', night_mode_switch: true, name: '' },
      { guid: 'c', swing_mode: '', night_mode_switch: '' },
      { guid: 'd', swing_mode: null, night_mode_switch: false },
    ] });
    expect(cfg.devices).toEqual([
      { guid: 'A', name: 'Study', swingMode: 'reverse', nightModeSwitch: false },
      { guid: 'B', nightModeSwitch: true },
      { guid: 'C' },
      { guid: 'D', nightModeSwitch: false },
    ]);
    expect(() => parseConfig({ ...base, devices: [{ guid: 'a', swing_mode: 'x' }] })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, devices: [{ guid: 'a', swing_mode: 0 }] })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, devices: [{ guid: 'a', night_mode_switch: 'maybe' }] })).toThrow(ConfigError);
  });

  it('rejects bad values with the option name in the message', () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ refresh_interval: 10 }, /refresh_interval/],
      [{ refresh_interval: 2_147_483_648 }, /refresh_interval/],
      [{ refresh_interval: '2000' }, /refresh_interval/],
      [{ refresh_interval: 1500.5 }, /refresh_interval/],
      [{ min_request_interval: -1 }, /min_request_interval/],
      [{ min_request_interval: 6000 }, /min_request_interval/],
      [{ min_request_interval: 'abc' }, /min_request_interval/],
      [{ broadcast_addresses: ['nope'] }, /"nope" is not/],
      [{ broadcast_addresses: ['1.2.3.256'] }, /broadcast_addresses/],
      [{ broadcast_addresses: '10.0.0.255, x' }, /"x" is not/],
      [{ broadcast_addresses: 5 }, /broadcast_addresses/],
      [{ broadcast_addresses: [5] }, /broadcast_addresses/],
      [{ command_sound: '4' }, /command_sound/],
      [{ command_sound: 1 }, /command_sound/],
      [{ swing_mode: 'spin' }, /swing_mode/],
      [{ night_mode_switch: 'false' }, /night_mode_switch/],
      [{ allow_unknown_models: 'no' }, /allow_unknown_models/],
      [{ devices: {} }, /devices must be an array/],
      [{ devices: [null] }, /needs a guid/],
      [{ devices: [{ name: 'x' }] }, /needs a guid/],
      [{ devices: [{ guid: '' }] }, /needs a guid/],
      [{ devices: [{ guid: 'a' }, { guid: 'A' }] }, /more than once/],
    ];
    for (const [overrides, message] of bad) {
      expect(() => parseConfig({ ...base, ...overrides }), JSON.stringify(overrides)).toThrow(ConfigError);
      expect(() => parseConfig({ ...base, ...overrides }), JSON.stringify(overrides)).toThrow(message);
    }
  });
});

describe('defaults are stated once', () => {
  const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
  const props = schema.schema.properties;

  it('config.schema.json agrees with DEFAULTS and the option lists', () => {
    expect(props.refresh_interval).toMatchObject({
      default: DEFAULTS.refreshInterval, minimum: DEFAULTS.minRefreshInterval, maximum: DEFAULTS.maxRefreshInterval,
    });
    expect(props.min_request_interval)
      .toMatchObject({ default: DEFAULTS.minRequestInterval, minimum: 0, maximum: DEFAULTS.maxMinRequestInterval });
    expect(props.command_sound.default).toBe(DEFAULTS.commandSound);
    expect(props.command_sound.oneOf.flatMap((o: { enum: string[] }) => o.enum)).toEqual([...COMMAND_SOUNDS]);
    expect(props.swing_mode.default).toBe(DEFAULTS.swingMode);
    expect(props.swing_mode.oneOf.flatMap((o: { enum: string[] }) => o.enum)).toEqual([...SWING_MODES]);
    expect(props.night_mode_switch.default).toBe(DEFAULTS.nightModeSwitch);
    expect(props.allow_unknown_models.default).toBe(DEFAULTS.allowUnknownModels);
    expect(props.devices.items.properties.swing_mode.oneOf.flatMap((o: { enum: string[] }) => o.enum)).toEqual([...SWING_MODES]);
  });

  it('the settings page agrees with DEFAULTS', () => {
    expect(PAGE_DEFAULTS).toEqual({
      refresh_interval: DEFAULTS.refreshInterval,
      min_request_interval: DEFAULTS.minRequestInterval,
      command_sound: DEFAULTS.commandSound,
      swing_mode: DEFAULTS.swingMode,
      night_mode_switch: DEFAULTS.nightModeSwitch,
      allow_unknown_models: DEFAULTS.allowUnknownModels,
    });
  });
});
