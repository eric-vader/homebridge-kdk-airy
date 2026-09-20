/**
 * The settings page. It reads the plugin config through the Homebridge UI, merges it with the answers to a
 * discovery search, and stages every edit with updatePluginConfig. Only the UI's Save button writes config.json.
 */
import {
  applyFanEdit, defaultName, initialConfig, mergeRows, readSettings, removeFan, writeSettings,
} from './settings-model.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = paths => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const PENCIL = icon('<path d="M11.3 2.7l2 2L6 12H4v-2z"/><path d="M3 14h10"/>');
const TRASH = icon(`<path d="M2.5 4.5h11"/><path d="M6 4.5V3h4v1.5"/>
  <path d="M4 4.5l.7 8.5h6.6l.7-8.5"/><path d="M6.7 7v4M9.3 7v4"/>`);

const SEPARATOR = ' · ';
const NONE = '—';
const NOT_FOUND = 'Not found on the network';
const UNKNOWN_MODEL = 'Unknown model';
const NO_ANSWER = '<strong>No fans answered.</strong> Only fans on this network answer the search. For fans on '
  + 'another subnet, enter that subnet\'s broadcast address above and search again.';
const SEARCH_FAILED = 'The search failed. Check the broadcast address and try again.';
const STATUS_TEXT = {
  online: 'Answered the search',
  unknown: 'Answered, but the model is not known',
  missing: 'In the config, not found on the network',
};

const editLabel = name => `Edit ${name}`;
const removeLabel = name => `Remove ${name} from the config`;
const detailOf = row => (row.status === 'missing' ? NOT_FOUND : `${row.commId || UNKNOWN_MODEL}${SEPARATOR}${row.ip}`);
const placeholderOf = row => defaultName({ ip: row.ip, guid: row.guid });

const blocks = await homebridge.getPluginConfig();
// A block the page created is staged straight away; an existing one is staged only once it is edited.
const created = !(Array.isArray(blocks) && blocks.length > 0);
let config = initialConfig(blocks);
let discovered = [];
let openGuid;
let lastSearch = '';
let searched = false;
let failed = false;

const publish = () => homebridge.updatePluginConfig([config]);
const relayout = () => homebridge.fixScrollHeight();
/** `devices` is added when there is an entry to put in it, and kept once it is there. */
const setDevices = next => {
  if (next.length > 0 || Array.isArray(config.devices)) {
    config.devices = next;
  }
};

// ---- global settings form ---------------------------------------------------------------------------------
// One row per field, read in both directions. 'number' means an empty or non-numeric input falls back to the
// default, while 0 is a value of its own.
const SETTING_FIELDS = [
  { key: 'broadcast_addresses', id: 'broadcast', kind: 'text' },
  { key: 'refresh_interval', id: 's-refresh', kind: 'number' },
  { key: 'min_request_interval', id: 's-gap', kind: 'number' },
  { key: 'command_sound', id: 's-sound', kind: 'text' },
  { key: 'swing_mode', id: 's-swing', kind: 'text' },
  { key: 'night_mode_switch', id: 's-night', kind: 'bool' },
  { key: 'allow_unknown_models', id: 's-unknown', kind: 'bool' },
];

function loadSettings() {
  const values = readSettings(config);
  for (const field of SETTING_FIELDS) {
    const el = $(field.id);
    if (field.kind === 'bool') {
      el.checked = Boolean(values[field.key]);
    } else {
      el.value = values[field.key];
    }
  }
}

function formValues() {
  const form = {};
  for (const field of SETTING_FIELDS) {
    const el = $(field.id);
    if (field.kind === 'bool') {
      form[field.key] = el.checked;
    } else if (field.kind === 'number') {
      const value = Number(el.value);
      form[field.key] = el.value.trim() === '' || !Number.isFinite(value) ? undefined : value;
    } else {
      form[field.key] = el.value;
    }
  }
  return form;
}

async function saveSettings() {
  config = writeSettings(config, formValues());
  await publish();
}

for (const field of SETTING_FIELDS) {
  $(field.id).addEventListener('change', saveSettings);
}
$('settings').addEventListener('toggle', relayout);

// ---- fan list ---------------------------------------------------------------------------------------------
const removeButton = row =>
  `<button class="btn btn-danger act" type="button" data-act="remove" title="${esc(removeLabel(row.name))}"
     aria-label="${esc(removeLabel(row.name))}">${TRASH}</button>`;
const removeSlot = '<span class="act slot" aria-hidden="true"></span>';

function bindRemove(li, row) {
  li.querySelector('[data-act="remove"]')?.addEventListener('click', async () => {
    config.devices = removeFan(config.devices, row.guid);
    await publish();
    if (row.status === 'missing' && openGuid === row.guid) {
      openGuid = undefined;
    }
    renderList(row.guid);
  });
}

/** Keep the row's name and its buttons in step with an edit, without rebuilding the row and losing focus. */
function setRowName(li, row, name) {
  row.name = name;
  li.querySelector('.name').textContent = name;
  for (const [selector, label] of [['[data-act="edit"]', editLabel(name)], ['[data-act="remove"]', removeLabel(name)]]) {
    const button = li.querySelector(selector);
    if (button) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  }
}

function syncRemoveButton(li, row) {
  const fan = li.querySelector('.fan');
  const button = fan.querySelector('[data-act="remove"]');
  if (row.entry && !button) {
    fan.querySelector('.slot')?.remove();
    fan.insertAdjacentHTML('beforeend', removeButton(row));
    bindRemove(li, row);
  } else if (!row.entry && button) {
    button.remove();
    fan.insertAdjacentHTML('beforeend', removeSlot);
  }
}

function renderList(focusGuid) {
  const rows = mergeRows(config.devices, discovered);
  const list = $('fans');
  list.innerHTML = '';
  $('count').textContent = searched ? `${discovered.length} answered${lastSearch ? ` at ${lastSearch}` : ''}` : '';
  if (rows.length === 0) {
    list.innerHTML = `<li class="empty">${searched ? NO_ANSWER : failed ? SEARCH_FAILED : 'Searching for fans…'}</li>`;
    relayout();
    return;
  }
  let focusTarget;
  for (const row of rows) {
    const open = openGuid === row.guid;
    const li = document.createElement('li');
    li.className = open ? 'open' : '';
    li.innerHTML = `
      <div class="fan">
        <button class="row-toggle" type="button" aria-expanded="${open}">
          <span class="dot ${row.status}"><span class="visually-hidden">${esc(STATUS_TEXT[row.status])}</span></span>
          <span class="who">
            <span class="name">${esc(row.name)}</span>
            <span class="detail">${esc(detailOf(row))}</span>
          </span>
        </button>
        <button class="btn btn-primary act" type="button" data-act="edit" title="${esc(editLabel(row.name))}"
          aria-label="${esc(editLabel(row.name))}">${PENCIL}</button>
        ${row.entry ? removeButton(row) : removeSlot}
      </div>`;
    const toggle = () => {
      openGuid = open ? undefined : row.guid;
      renderList(row.guid);
    };
    li.querySelector('.row-toggle').addEventListener('click', toggle);
    li.querySelector('[data-act="edit"]').addEventListener('click', toggle);
    bindRemove(li, row);
    if (open) {
      li.appendChild(renderPanel(row));
    }
    if (focusGuid === row.guid) {
      focusTarget = li.querySelector('.row-toggle');
    }
    list.appendChild(li);
  }
  focusTarget?.focus();
  relayout();
}

function renderPanel(row) {
  const entry = row.entry ?? {};
  const panel = document.createElement('div');
  panel.className = 'panel';
  const id = field => `f-${field}-${row.guid}`;
  const field = name => panel.querySelector(`[data-field="${name}"]`);
  panel.innerHTML = `
    <div class="grid">
      <div>
        <label for="${esc(id('name'))}">Name</label>
        <input id="${esc(id('name'))}" data-field="name" class="form-control" type="text" autocomplete="off"
          placeholder="${esc(placeholderOf(row))}" value="${esc(entry.name ?? '')}">
      </div>
      <div>
        <label for="${esc(id('swing'))}">Swing Mode controls</label>
        <select id="${esc(id('swing'))}" data-field="swing_mode" class="form-select">
          <option value="">Use the global setting</option>
          <option value="yuragi">1/f Yuragi natural wind</option>
          <option value="reverse">Reverse direction</option>
          <option value="off">Nothing (not shown)</option>
        </select>
      </div>
      <div>
        <label for="${esc(id('night'))}">Night switch</label>
        <select id="${esc(id('night'))}" data-field="night_mode_switch" class="form-select">
          <option value="">Use the global setting</option>
          <option value="show">Shown</option>
          <option value="hide">Hidden</option>
        </select>
      </div>
    </div>
    <dl class="facts">
      <dt>Model</dt><dd>${esc(row.status === 'missing'
    ? NONE
    : `${row.commId || UNKNOWN_MODEL}${SEPARATOR}${row.hasLight ? 'with light' : 'no light'}`)}</dd>
      <dt>Firmware</dt><dd>${esc(row.partId || NONE)}</dd>
      <dt>IP address</dt><dd>${esc(row.ip || NONE)}</dd>
      <dt>HASHGUID</dt><dd><code>${esc(row.guid)}</code></dd>
    </dl>`;
  field('swing_mode').value = entry.swing_mode ?? '';
  field('night_mode_switch').value = entry.night_mode_switch === true
    ? 'show'
    : entry.night_mode_switch === false ? 'hide' : (entry.night_mode_switch ?? '');

  const commit = async patch => {
    setDevices(applyFanEdit(config.devices, row.guid, patch));
    await publish();
    const li = panel.parentElement;
    const fresh = mergeRows(config.devices, discovered).find(r => r.guid === row.guid);
    if (!li || !fresh) {
      return;
    }
    row.entry = fresh.entry;
    setRowName(li, row, fresh.name);
    syncRemoveButton(li, row);
  };
  const name = field('name');
  // The name in the row follows every keystroke; the config is staged when the input is left or Enter is pressed.
  name.addEventListener('input', () => {
    const li = panel.parentElement;
    if (li) {
      setRowName(li, row, name.value.trim() || placeholderOf(row));
    }
  });
  name.addEventListener('change', () => commit({ name: name.value }));
  field('swing_mode').addEventListener('change', e => commit({ swing_mode: e.target.value }));
  field('night_mode_switch').addEventListener('change', e => commit({ night_mode_switch: e.target.value }));
  return panel;
}

// ---- discovery --------------------------------------------------------------------------------------------
async function discover() {
  const btn = $('discover');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.querySelector('span').textContent = 'Searching…';
  try {
    const result = await homebridge.request('/discover', { broadcasts: $('broadcast').value });
    discovered = result.fans;
    lastSearch = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    searched = true;
    failed = false;
  } catch (err) {
    homebridge.toast.error(err instanceof Error ? err.message : String(err), 'Search failed');
    searched = false;
    failed = true;
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.querySelector('span').textContent = 'Discover';
    renderList();
  }
}
$('discover').addEventListener('click', discover);

loadSettings();
if (created) {
  await publish();
}
renderList();
discover();
