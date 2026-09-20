import { describe, expect, it } from 'vitest';

import {
  applyFanEdit, DEFAULTS, defaultName, initialConfig, mergeRows, parseBroadcasts, readSettings, removeFan, writeSettings,
} from '../homebridge-ui/public/settings-model.js';

const fan = (ip: string, guid: string, known = true) => ({ guid, ip, commId: 'FM12GC', partId: 'E48GP', known, hasLight: true });

describe('settings page model', () => {
  it('parses broadcast addresses from a comma or space separated string', () => {
    expect(parseBroadcasts(' 10.0.0.255, 192.168.1.255  ,,')).toEqual(['10.0.0.255', '192.168.1.255']);
    expect(parseBroadcasts('')).toEqual([]);
    expect(parseBroadcasts(undefined)).toEqual([]);
  });

  it('names a fan after its ip address, or after the last four characters of its guid', () => {
    expect(defaultName({ ip: '10.1.254.3', guid: 'a1b2c3d4' })).toBe('Fan 10.1.254.3');
    expect(defaultName({ guid: 'a1b2c3d4' })).toBe('Fan C3D4');
    expect(defaultName()).toBe('Fan ');
  });

  it('merges configured entries and discovered fans into sorted rows', () => {
    const rows = mergeRows(
      [{ guid: 'CCC', name: 'Study' }, { guid: 'zzz', name: 'Gone' }],
      [fan('10.1.254.10', 'aaa'), fan('10.1.254.2', 'ccc'), fan('10.1.254.1', 'bbb', false)],
    );
    expect(rows.map(r => [r.name, r.status, r.commId, r.ip])).toEqual([
      ['Fan 10.1.254.1', 'unknown', 'FM12GC', '10.1.254.1'],
      ['Study', 'online', 'FM12GC', '10.1.254.2'],
      ['Fan 10.1.254.10', 'online', 'FM12GC', '10.1.254.10'],
      ['Gone', 'missing', undefined, undefined],
    ]);
    expect(rows.map(r => r.guid)).toEqual(['BBB', 'CCC', 'AAA', 'ZZZ']);
    expect(rows[1]!.entry).toEqual({ guid: 'CCC', name: 'Study' });
    expect(rows[0]!.entry).toBeUndefined();
  });

  it('skips entries without a usable guid', () => {
    const rows = mergeRows([{ name: 'No guid' }, { guid: 42, name: 'Number' }, { guid: '', name: 'Empty' }, null, { guid: 'ok' }], []);
    expect(rows.map(r => r.guid)).toEqual(['OK']);
  });

  it('keeps an empty model code as it is', () => {
    const rows = mergeRows([], [{ ...fan('10.1.254.4', 'abcd'), commId: '' }]);
    expect(rows[0]!.commId).toBe('');
    expect(rows[0]!.status).toBe('online');
  });

  it('breaks an equal ip address and two missing fans by guid', () => {
    const same = mergeRows([], [fan('10.1.254.3', 'bbbb'), fan('10.1.254.3', 'aaaa')]);
    expect(same.map(r => r.guid)).toEqual(['AAAA', 'BBBB']);
    const missing = mergeRows([{ guid: 'c0ffee01' }, { guid: 'a1b2c3d4' }], []);
    expect(missing.map(r => [r.guid, r.name])).toEqual([['A1B2C3D4', 'Fan C3D4'], ['C0FFEE01', 'Fan EE01']]);
  });

  it('edits create entries, empty values clear fields, and bare entries disappear', () => {
    let entries = applyFanEdit([], 'abc', { name: '  Study ' });
    expect(entries).toEqual([{ guid: 'abc', name: 'Study' }]);
    entries = applyFanEdit(entries, 'ABC', { swing_mode: 'reverse', night_mode_switch: 'hide' });
    expect(entries).toEqual([{ guid: 'abc', name: 'Study', swing_mode: 'reverse', night_mode_switch: 'hide' }]);
    entries = applyFanEdit(entries, 'abc', { name: '', swing_mode: '', night_mode_switch: '' });
    expect(entries).toEqual([]);
    expect(applyFanEdit([{ guid: 'x', name: 'Keep' }], 'y', { name: '' })).toEqual([{ guid: 'x', name: 'Keep' }]);
    expect(removeFan([{ guid: 'x', name: 'Keep' }, { guid: 'y', name: 'Go' }], 'Y')).toEqual([{ guid: 'x', name: 'Keep' }]);
  });

  it('keeps a non-string value and treats a blank name as no name', () => {
    expect(applyFanEdit([], 'abc', { night_mode_switch: true })).toEqual([{ guid: 'abc', night_mode_switch: true }]);
    expect(applyFanEdit([{ guid: 'abc', name: 'Study' }], 'abc', { name: '   ' })).toEqual([]);
    expect(applyFanEdit([{ guid: 'abc', name: 'Study', swing_mode: 'off' }], 'abc', { name: '\t' }))
      .toEqual([{ guid: 'abc', swing_mode: 'off' }]);
  });

  it('reads settings with defaults and writes back only non-default values', () => {
    expect(readSettings({})).toEqual({ ...DEFAULTS, broadcast_addresses: '' });
    expect(readSettings()).toEqual({ ...DEFAULTS, broadcast_addresses: '' });
    expect(readSettings({ refresh_interval: null, broadcast_addresses: null })).toEqual({ ...DEFAULTS, broadcast_addresses: '' });
    expect(readSettings({ broadcast_addresses: ['10.0.0.255', '10.1.255.255'], swing_mode: 'reverse' }))
      .toMatchObject({ broadcast_addresses: '10.0.0.255, 10.1.255.255', swing_mode: 'reverse' });
    const written = writeSettings({ platform: 'KDKAiry', name: 'x', refresh_interval: 9000, devices: [] }, {
      ...DEFAULTS, min_request_interval: 250, night_mode_switch: false, broadcast_addresses: ' 10.0.0.255 ,',
    });
    expect(written).toEqual({
      platform: 'KDKAiry', name: 'x', devices: [], min_request_interval: 250, night_mode_switch: false, broadcast_addresses: '10.0.0.255',
    });
  });

  it('drops the broadcast addresses and any empty field when the form is cleared', () => {
    const block = { platform: 'KDKAiry', broadcast_addresses: '10.0.0.255', swing_mode: 'reverse', refresh_interval: 9000 };
    const written = writeSettings(block, { ...DEFAULTS, swing_mode: '', refresh_interval: undefined, broadcast_addresses: '' });
    expect(written).toEqual({ platform: 'KDKAiry' });
    expect(writeSettings({ broadcast_addresses: '10.0.0.255' }, { ...DEFAULTS, broadcast_addresses: '  ,  ' })).toEqual({});
  });

  it('starts from the existing block or a fresh one, and adds no devices of its own', () => {
    expect(initialConfig([])).toEqual({ platform: 'KDKAiry', name: 'KDK Airy' });
    expect(initialConfig(undefined)).toEqual({ platform: 'KDKAiry', name: 'KDK Airy' });
    expect(initialConfig([{ platform: 'KDKAiry', name: '', refresh_interval: 2000 }]))
      .toEqual({ platform: 'KDKAiry', name: 'KDK Airy', refresh_interval: 2000 });
    expect(initialConfig([{ platform: 'KDKAiry', name: 'Fans' }])).not.toHaveProperty('devices');
    expect(initialConfig([{ platform: 'KDKAiry', name: 'Fans', devices: 'no' }])).not.toHaveProperty('devices');
    const block = initialConfig([{ platform: 'KDKAiry', name: 'Fans', devices: [{ guid: 'abc', name: 'Study' }] }]);
    expect(block.devices).toEqual([{ guid: 'abc', name: 'Study' }]);
  });
});
