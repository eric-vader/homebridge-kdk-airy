/**
 * Builds the property lists the KDK app sends: the GET list and the SET list.
 */
import {
  CTL_OPT_SOURCE, EPC, encodeState, getProperties, LIGHT_MODE, mergeState, TIMER, type FanState, type Melody, type Property,
} from './epc.js';

/** Properties the app polls on every GET / reload. */
export function getListFor(hasLight: boolean): number[] {
  return [
    EPC.FanPower,
    EPC.FanVolume,
    EPC.FanDirection,
    EPC.FanFluctuation,
    ...(hasLight
      ? [EPC.LightPower, EPC.LightMode, EPC.LightBrightness, EPC.LightColour, EPC.LightNightlightBrightness]
      : []),
    EPC.OffTimer,
    EPC.OffTimerRemainTime,
    EPC.OnTimer,
    EPC.OnTimerRemainTime,
    EPC.ErrorCode,
    EPC.ErrorStatus,
  ];
}

export function buildGetProperties(hasLight: boolean): Property[] {
  return getProperties(getListFor(hasLight));
}

export interface SetOptions {
  /** Beep on the fan when the command is applied. The app always sends ON. */
  buzzer: boolean;
  /** Melody played with the command; the app always sends MELODY.NONE. */
  melody: Melody;
  /** Model has a light; light properties are dropped otherwise, as the app does. */
  hasLight: boolean;
}

type Key = keyof FanState;

/** Settings that only apply while the fan runs. */
const FAN_SETTINGS: readonly Key[] = ['fanVolume', 'fanDirection', 'fanFluctuation'];
/** Settings that only apply while the light is on. */
const LIGHT_SETTINGS: readonly Key[] = ['lightMode', 'lightBrightness', 'lightColour', 'nightlightBrightness'];
const LIGHT_KEYS: readonly Key[] = ['lightPower', ...LIGHT_SETTINGS];
const WRITABLE_KEYS: readonly Key[] = ['fanPower', ...FAN_SETTINGS, ...LIGHT_KEYS, 'offTimer', 'onTimer'];

/**
 * Compose the full SET property list for a change, as the app does:
 *  1. merge the change into the last known state,
 *  2. keep only writable properties (drop control + read-only ones),
 *  3. timers the caller did not touch are sent with hour/minute = KEEP,
 *  4. prune by state,
 *  5. prepend CtlOptSource=LOCAL, BuzzerSet, Melody.
 *
 * Returns the merged state, which is the expected state of the fan, and the wire properties.
 */
export function composeSet(known: FanState, change: FanState, opts: SetOptions): { state: FanState; properties: Property[] } {
  const merged = mergeState(known, change);

  const keep = (key: Key) => merged[key] !== undefined && (opts.hasLight || !LIGHT_KEYS.includes(key));
  const toSend = Object.fromEntries(WRITABLE_KEYS.filter(keep).map(key => [key, merged[key]])) as FanState;

  // Timers not part of this change keep their remaining time, as the app does.
  if (toSend.offTimer && change.offTimer === undefined) {
    toSend.offTimer = { ...toSend.offTimer, hour: TIMER.KEEP, minute: TIMER.KEEP };
  }
  if (toSend.onTimer && change.onTimer === undefined) {
    toSend.onTimer = { ...toSend.onTimer, hour: TIMER.KEEP, minute: TIMER.KEEP };
  }

  pruneByState(toSend);

  const properties: Property[] = [
    ...encodeState({ ctlOptSource: CTL_OPT_SOURCE.LOCAL, buzzer: opts.buzzer, melody: opts.melody }),
    ...encodeState(toSend),
  ];
  return { state: merged, properties };
}

/** Drop properties the fan would reject given the power/mode it is being put into, as the app does. */
function pruneByState(s: FanState): void {
  const drop = (keys: readonly Key[]) => keys.forEach(key => delete s[key]);
  const sleepOn = s.offTimer?.sleep === TIMER.ON;

  if (s.fanPower === false) {
    drop([...FAN_SETTINGS, 'offTimer']);
  }
  if (s.fanPower === true) {
    drop(sleepOn ? [...FAN_SETTINGS, 'onTimer'] : ['onTimer']);
  }
  if (s.lightPower === false) {
    drop(LIGHT_SETTINGS);
  }
  if (s.lightPower === true && s.lightMode === LIGHT_MODE.NORMAL) {
    drop(['nightlightBrightness']);
  }
  if (s.lightPower === true && s.lightMode === LIGHT_MODE.NIGHT) {
    drop(['lightBrightness', 'lightColour']);
  }
}
