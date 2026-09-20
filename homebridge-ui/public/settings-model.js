/**
 * Pure logic of the settings page: merging discovered fans with configured entries, applying edits, and mapping
 * the global settings form to the config block. No DOM, no Homebridge API, so it is unit-tested directly.
 */

export const PLATFORM = 'KDKAiry';

/** Name of the platform block when the plugin has never been configured. */
export const DEFAULT_BLOCK_NAME = 'KDK Airy';

/** Number of trailing guid characters used to name a fan whose ip address is not known. */
export const GUID_SHORT_LENGTH = 4;

/** Width each octet is padded to, so a plain string sort puts ip addresses in numeric order. */
const IP_OCTET_WIDTH = 3;
const IP_OCTET_PAD = '0';

export const DEFAULTS = {
  refresh_interval: 5000,
  min_request_interval: 100,
  command_sound: 'off',
  swing_mode: 'off',
  night_mode_switch: true,
  allow_unknown_models: false,
};

export const SETTING_KEYS = Object.keys(DEFAULTS);

/** "192.168.1.255, 10.0.0.255" -> ["192.168.1.255", "10.0.0.255"] */
export function parseBroadcasts(text) {
  return String(text ?? '').split(/[\s,]+/).map(s => s.trim()).filter(s => s.length > 0);
}

/** Guids are stored and compared in upper case. The plugin's config parser does the same. */
export function key(guid) {
  return String(guid ?? '').toUpperCase();
}

/** Name for a fan that has no name in the config. */
export function defaultName({ ip, guid } = {}) {
  return ip ? `Fan ${ip}` : `Fan ${key(guid).slice(-GUID_SHORT_LENGTH)}`;
}

function ipKey(ip) {
  return String(ip ?? '').split('.').map(o => o.padStart(IP_OCTET_WIDTH, IP_OCTET_PAD)).join('.');
}

/**
 * One row per fan: the union of configured entries and discovered fans, sorted by ip then guid. The fields are
 * values, not sentences; the page turns them into the text it shows.
 * status: 'online' answered the search, 'unknown' answered but is not a known model, 'missing' configured only.
 */
export function mergeRows(entries, discovered) {
  const rows = new Map();
  for (const entry of entries ?? []) {
    if (entry && typeof entry.guid === 'string' && entry.guid) {
      rows.set(key(entry.guid), { guid: key(entry.guid), entry, fan: undefined });
    }
  }
  for (const fan of discovered ?? []) {
    const k = key(fan?.guid);
    rows.set(k, { ...(rows.get(k) ?? { guid: k, entry: undefined }), fan });
  }
  return [...rows.values()]
    .map(({ guid, entry, fan }) => ({
      guid,
      entry,
      name: entry?.name || defaultName({ ip: fan?.ip, guid }),
      commId: fan?.commId,
      partId: fan?.partId,
      ip: fan?.ip,
      hasLight: fan?.hasLight,
      status: fan ? (fan.known ? 'online' : 'unknown') : 'missing',
    }))
    .sort((a, b) => {
      const aFound = a.status !== 'missing';
      const bFound = b.status !== 'missing';
      if (aFound !== bFound) {
        return aFound ? -1 : 1;
      }
      return ipKey(a.ip).localeCompare(ipKey(b.ip)) || a.guid.localeCompare(b.guid);
    });
}

const FAN_FIELDS = ['name', 'swing_mode', 'night_mode_switch'];

/**
 * Apply an edit to the entry for `guid`, creating the entry when there is none. Empty strings clear a field. An
 * entry left with nothing but its guid is dropped, so untouched fans never appear in the config.
 */
export function applyFanEdit(entries, guid, patch) {
  const list = (entries ?? []).map(e => ({ ...e }));
  let entry = list.find(e => key(e.guid) === key(guid));
  if (!entry) {
    entry = { guid };
    list.push(entry);
  }
  for (const field of FAN_FIELDS) {
    if (!(field in patch)) {
      continue;
    }
    const value = patch[field];
    if (value === undefined || value === null || value === '') {
      delete entry[field];
    } else {
      entry[field] = typeof value === 'string' ? value.trim() : value;
      if (entry[field] === '') {
        delete entry[field];
      }
    }
  }
  return list.filter(e => Object.keys(e).some(k => k !== 'guid'));
}

export function removeFan(entries, guid) {
  return (entries ?? []).filter(e => key(e.guid) !== key(guid));
}

/** Values for the global settings form, with defaults filled in. */
export function readSettings(config) {
  const out = {};
  for (const k of SETTING_KEYS) {
    out[k] = config?.[k] === undefined || config?.[k] === null ? DEFAULTS[k] : config[k];
  }
  out.broadcast_addresses = Array.isArray(config?.broadcast_addresses)
    ? config.broadcast_addresses.join(', ')
    : String(config?.broadcast_addresses ?? '');
  return out;
}

/** Write the form back into a copy of the config block, leaving out values that equal the defaults. */
export function writeSettings(config, form) {
  const out = { ...config };
  for (const k of SETTING_KEYS) {
    const value = form[k];
    if (value === undefined || value === '' || value === DEFAULTS[k]) {
      delete out[k];
    } else {
      out[k] = value;
    }
  }
  const broadcasts = parseBroadcasts(form.broadcast_addresses).join(', ');
  if (broadcasts) {
    out.broadcast_addresses = broadcasts;
  } else {
    delete out.broadcast_addresses;
  }
  return out;
}

/**
 * Start from the existing block, or a fresh one when the plugin has never been configured. An existing block is
 * left as it is: `devices` is added by the edit functions when there is an entry to put in it.
 */
export function initialConfig(blocks) {
  const block = Array.isArray(blocks) && blocks.length > 0 ? { ...blocks[0] } : { name: DEFAULT_BLOCK_NAME };
  block.platform = PLATFORM;
  if (!block.name) {
    block.name = DEFAULT_BLOCK_NAME;
  }
  if (Array.isArray(block.devices)) {
    block.devices = block.devices.map(d => ({ ...d }));
  } else {
    delete block.devices;
  }
  return block;
}
