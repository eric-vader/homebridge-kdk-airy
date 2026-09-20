/**
 * ECHONET Lite property (EPC) definitions for KDK / Panasonic Wi-Fi ceiling fans.
 *
 * Every constant here matches what the KDK Ceiling Fan app sends and accepts. See docs/protocol.md for the
 * byte-level description.
 */

/** Property codes (EPC byte). */
export const EPC = {
  FanPower: 0x80,
  ErrorCode: 0x86,
  ErrorStatus: 0x88,
  ProductCode: 0x8c,
  RemoteCtlSetting: 0x93,
  FanVolume: 0xf0,
  FanDirection: 0xf1,
  FanFluctuation: 0xf2,
  LightPower: 0xf3,
  LightMode: 0xf4,
  LightBrightness: 0xf5,
  LightColour: 0xf6,
  LightNightlightBrightness: 0xf7,
  OffTimer: 0xf8,
  OffTimerRemainTime: 0xf9,
  OnTimer: 0xfa,
  OnTimerRemainTime: 0xfb,
  BuzzerSet: 0xfc,
  CtlOptSource: 0xfd,
  Melody: 0xfe,
} as const;

/** Generic on/off encoding shared by FanPower, FanFluctuation, LightPower, BuzzerSet. */
export const SWITCH = { ON: 0x30, OFF: 0x31 } as const;

export const FAN_VOLUME = { MIN: 0x31, MAX: 0x3a } as const;
export const FAN_DIRECTION = { DOWN: 0x41, UP: 0x42 } as const;
export const LIGHT_MODE = { NORMAL: 0x42, NIGHT: 0x43 } as const;
export const LIGHT_BRIGHTNESS = { MIN: 1, MAX: 100 } as const;
export const LIGHT_COLOUR = { MIN: 0, MAX: 100 } as const; // 0 = warm, 100 = cool
export const NIGHTLIGHT_BRIGHTNESS = { LOW: 1, MEDIUM: 50, HIGH: 100 } as const;
export const TIMER = { ON: 0x30, OFF: 0x31, KEEP: 0xff } as const;
export const MELODY = { NONE: 0x40, MELODY_1: 0x41, MELODY_2: 0x42, MELODY_3: 0x43 } as const;
export const ERROR_STATUS = { ERROR: 0x41, NO_ERROR: 0x42 } as const;
/** The app sends 3 for commands from the phone on the LAN; other values belong to control paths the plugin does not use. */
export const CTL_OPT_SOURCE = { LOCAL: 3 } as const;

/** Timer durations are hours and minutes of a day. */
const MAX_HOUR = 23;
const MAX_MINUTE = 59;

/** Payload sizes (PDC) of the multi-byte properties. */
const PDC = { BYTE: 1, REMAIN_TIME: 2, TIMER: 4, PRODUCT_CODE: 18, ERROR_CODE: 46 } as const;
/** The app reads the 3 ASCII characters at offset 6 of the ErrorCode payload. */
const ERROR_CODE = { OFFSET: 6, LENGTH: 3 } as const;
/** The app reads the first 7 ASCII characters of the ProductCode payload. */
const PRODUCT_CODE_LENGTH = 7;

export type FanDirection = (typeof FAN_DIRECTION)[keyof typeof FAN_DIRECTION];
export type LightMode = (typeof LIGHT_MODE)[keyof typeof LIGHT_MODE];
export type NightlightBrightness = (typeof NIGHTLIGHT_BRIGHTNESS)[keyof typeof NIGHTLIGHT_BRIGHTNESS];
export type Melody = (typeof MELODY)[keyof typeof MELODY];
export type CtlOptSource = (typeof CTL_OPT_SOURCE)[keyof typeof CTL_OPT_SOURCE];

/** Off timer: hour/minute are a duration; 0xff on any field means "keep current value". */
export interface OffTimer {
  status: number; // TIMER.ON | TIMER.OFF | TIMER.KEEP
  sleep: number; // TIMER.ON | TIMER.OFF | TIMER.KEEP
  hour: number; // 0..23 | TIMER.KEEP
  minute: number; // 0..59 | TIMER.KEEP
}

/** On timer: hour/minute are a duration; melody plays when the timer fires. */
export interface OnTimer {
  status: number;
  melody: number; // MELODY.* | TIMER.KEEP
  hour: number;
  minute: number;
}

export interface RemainTime {
  hour: number;
  minute: number;
}

/**
 * Decoded state of a fan. Every field is optional because the fan only reports what was asked for,
 * and models without a light never report the light properties.
 */
export interface FanState {
  fanPower?: boolean;
  fanVolume?: number; // FAN_VOLUME.MIN..MAX
  fanDirection?: FanDirection;
  fanFluctuation?: boolean;
  lightPower?: boolean;
  lightMode?: LightMode;
  lightBrightness?: number;
  lightColour?: number;
  nightlightBrightness?: NightlightBrightness;
  offTimer?: OffTimer;
  offTimerRemain?: RemainTime;
  onTimer?: OnTimer;
  onTimerRemain?: RemainTime;
  errorStatus?: boolean; // true = error occurred
  errorCode?: string; // 3 ASCII chars
  productCode?: string; // 7 ASCII chars
  buzzer?: boolean;
  melody?: Melody;
  ctlOptSource?: CtlOptSource;
}

/** A raw property as it travels on the wire. `data` is empty for a GET request. */
export interface Property {
  epc: number;
  data: Uint8Array;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const bool = (on: boolean): Uint8Array => Uint8Array.of(on ? SWITCH.ON : SWITCH.OFF);

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError(`${name} must be an integer in ${min}..${max}, got ${value}`);
  }
}

function assertOneOf(name: string, value: number, allowed: readonly number[]): void {
  if (!allowed.includes(value)) {
    throw new ProtocolError(`${name} must be one of ${allowed.map(v => '0x' + v.toString(16)).join(', ')}, got ${value}`);
  }
}

function assertTimerField(name: string, value: number, max: number): void {
  if (value !== TIMER.KEEP) {
    assertRange(name, value, 0, max);
  }
}

/**
 * Encode the writable fields of a FanState into wire properties, validating every value as the
 * app does. Fields that are undefined and read-only fields are skipped.
 */
export function encodeState(state: FanState): Property[] {
  const out: Property[] = [];
  const push = (epc: number, ...data: number[]) => out.push({ epc, data: Uint8Array.from(data) });

  if (state.ctlOptSource !== undefined) {
    assertOneOf('ctlOptSource', state.ctlOptSource, Object.values(CTL_OPT_SOURCE));
    push(EPC.CtlOptSource, state.ctlOptSource);
  }
  if (state.buzzer !== undefined) {
    out.push({ epc: EPC.BuzzerSet, data: bool(state.buzzer) });
  }
  if (state.melody !== undefined) {
    assertOneOf('melody', state.melody, Object.values(MELODY));
    push(EPC.Melody, state.melody);
  }
  if (state.fanPower !== undefined) {
    out.push({ epc: EPC.FanPower, data: bool(state.fanPower) });
  }
  if (state.fanVolume !== undefined) {
    assertRange('fanVolume', state.fanVolume, FAN_VOLUME.MIN, FAN_VOLUME.MAX);
    push(EPC.FanVolume, state.fanVolume);
  }
  if (state.fanDirection !== undefined) {
    assertOneOf('fanDirection', state.fanDirection, Object.values(FAN_DIRECTION));
    push(EPC.FanDirection, state.fanDirection);
  }
  if (state.fanFluctuation !== undefined) {
    out.push({ epc: EPC.FanFluctuation, data: bool(state.fanFluctuation) });
  }
  if (state.lightPower !== undefined) {
    out.push({ epc: EPC.LightPower, data: bool(state.lightPower) });
  }
  if (state.lightMode !== undefined) {
    assertOneOf('lightMode', state.lightMode, Object.values(LIGHT_MODE));
    push(EPC.LightMode, state.lightMode);
  }
  if (state.lightBrightness !== undefined) {
    assertRange('lightBrightness', state.lightBrightness, LIGHT_BRIGHTNESS.MIN, LIGHT_BRIGHTNESS.MAX);
    push(EPC.LightBrightness, state.lightBrightness);
  }
  if (state.lightColour !== undefined) {
    assertRange('lightColour', state.lightColour, LIGHT_COLOUR.MIN, LIGHT_COLOUR.MAX);
    push(EPC.LightColour, state.lightColour);
  }
  if (state.nightlightBrightness !== undefined) {
    assertOneOf('nightlightBrightness', state.nightlightBrightness, Object.values(NIGHTLIGHT_BRIGHTNESS));
    push(EPC.LightNightlightBrightness, state.nightlightBrightness);
  }
  if (state.offTimer !== undefined) {
    const t = state.offTimer;
    assertOneOf('offTimer.status', t.status, Object.values(TIMER));
    assertOneOf('offTimer.sleep', t.sleep, Object.values(TIMER));
    assertTimerField('offTimer.hour', t.hour, MAX_HOUR);
    assertTimerField('offTimer.minute', t.minute, MAX_MINUTE);
    push(EPC.OffTimer, t.status, t.sleep, t.hour, t.minute);
  }
  if (state.onTimer !== undefined) {
    const t = state.onTimer;
    assertOneOf('onTimer.status', t.status, Object.values(TIMER));
    assertOneOf('onTimer.melody', t.melody, [...Object.values(MELODY), TIMER.KEEP]);
    assertTimerField('onTimer.hour', t.hour, MAX_HOUR);
    assertTimerField('onTimer.minute', t.minute, MAX_MINUTE);
    push(EPC.OnTimer, t.status, t.melody, t.hour, t.minute);
  }
  return out;
}

/** Build GET (data-less) properties for the given EPC codes. */
export function getProperties(codes: readonly number[]): Property[] {
  return codes.map(epc => ({ epc, data: new Uint8Array(0) }));
}

/** A one-byte value that must be one of `allowed`; anything else, including PDC 0, is unknown. */
function decodeOneOf<T extends number>(data: Uint8Array, allowed: readonly T[]): T | undefined {
  const byte = data.length === PDC.BYTE ? data[0] : undefined;
  return allowed.includes(byte as T) ? (byte as T) : undefined;
}

/** A one-byte value that must lie in `min..max`; anything else is unknown. */
function decodeRange(data: Uint8Array, min: number, max: number): number | undefined {
  const byte = data.length === PDC.BYTE ? data[0] : undefined;
  return byte !== undefined && byte >= min && byte <= max ? byte : undefined;
}

function decodeSwitch(data: Uint8Array): boolean | undefined {
  const byte = decodeOneOf(data, Object.values(SWITCH));
  return byte === undefined ? undefined : byte === SWITCH.ON;
}

function decodeTimer(data: Uint8Array): [number, number, number, number] | undefined {
  return data.length === PDC.TIMER ? [data[0]!, data[1]!, data[2]!, data[3]!] : undefined;
}

function decodeRemainTime(data: Uint8Array): RemainTime | undefined {
  return data.length === PDC.REMAIN_TIME ? { hour: data[0]!, minute: data[1]! } : undefined;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return Buffer.from(data.subarray(offset, offset + length)).toString('ascii').replaceAll('\0', '');
}

/**
 * Decode wire properties into a FanState the way the app does. A property is left undefined
 * when its payload does not match the expected size, such as PDC 0 in a failed GET, or carries a value outside
 * the app's tables. An undefined property is never written back.
 */
export function decodeProperties(props: readonly Property[]): FanState {
  const s: FanState = {};
  for (const { epc, data } of props) {
    switch (epc) {
      case EPC.FanPower: s.fanPower = decodeSwitch(data); break;
      case EPC.FanVolume: s.fanVolume = decodeRange(data, FAN_VOLUME.MIN, FAN_VOLUME.MAX); break;
      case EPC.FanDirection: s.fanDirection = decodeOneOf(data, Object.values(FAN_DIRECTION)); break;
      case EPC.FanFluctuation: s.fanFluctuation = decodeSwitch(data); break;
      case EPC.LightPower: s.lightPower = decodeSwitch(data); break;
      case EPC.LightMode: s.lightMode = decodeOneOf(data, Object.values(LIGHT_MODE)); break;
      case EPC.LightBrightness: s.lightBrightness = decodeRange(data, LIGHT_BRIGHTNESS.MIN, LIGHT_BRIGHTNESS.MAX); break;
      case EPC.LightColour: s.lightColour = decodeRange(data, LIGHT_COLOUR.MIN, LIGHT_COLOUR.MAX); break;
      case EPC.LightNightlightBrightness:
        s.nightlightBrightness = decodeOneOf(data, Object.values(NIGHTLIGHT_BRIGHTNESS));
        break;
      case EPC.OffTimer: {
        const t = decodeTimer(data);
        s.offTimer = t && { status: t[0], sleep: t[1], hour: t[2], minute: t[3] };
        break;
      }
      case EPC.OnTimer: {
        const t = decodeTimer(data);
        s.onTimer = t && { status: t[0], melody: t[1], hour: t[2], minute: t[3] };
        break;
      }
      case EPC.OffTimerRemainTime: s.offTimerRemain = decodeRemainTime(data); break;
      case EPC.OnTimerRemainTime: s.onTimerRemain = decodeRemainTime(data); break;
      case EPC.ErrorStatus: {
        const status = decodeOneOf(data, Object.values(ERROR_STATUS));
        s.errorStatus = status === undefined ? undefined : status === ERROR_STATUS.ERROR;
        break;
      }
      case EPC.ErrorCode:
        // A fan without an error pads the code with NUL bytes, reported here as an empty string.
        s.errorCode = data.length === PDC.ERROR_CODE ? ascii(data, ERROR_CODE.OFFSET, ERROR_CODE.LENGTH) : undefined;
        break;
      case EPC.ProductCode:
        s.productCode = data.length === PDC.PRODUCT_CODE ? ascii(data, 0, PRODUCT_CODE_LENGTH) : undefined;
        break;
      case EPC.BuzzerSet: s.buzzer = decodeSwitch(data); break;
      case EPC.Melody: s.melody = decodeOneOf(data, Object.values(MELODY)); break;
      case EPC.CtlOptSource: s.ctlOptSource = decodeOneOf(data, Object.values(CTL_OPT_SOURCE)); break;
      default:
        // Unknown property, ignored as the app does.
        break;
    }
  }
  return s;
}

/** Merge `update` into `base`, skipping undefined fields, as the app does. Returns a new object. */
export function mergeState(base: FanState, update: FanState): FanState {
  return Object.fromEntries(
    [...Object.entries(base), ...Object.entries(update)].filter(([, value]) => value !== undefined),
  ) as FanState;
}
