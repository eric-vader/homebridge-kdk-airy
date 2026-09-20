/**
 * A single fan. Caches the last known state, composes SET commands the way the app does, reloads after each
 * write and tracks whether the fan is reachable.
 */
import { EventEmitter } from 'node:events';

import { buildGetProperties, composeSet, type SetOptions } from './protocol/compose.js';
import { decodeProperties, mergeState, type FanState, type Melody } from './protocol/epc.js';
import { TimeoutError, type FanClient } from './protocol/client.js';
import type { DiscoveredFan } from './protocol/discovery.js';

export interface FanDeviceOptions {
  buzzer: boolean;
  melody: Melody;
  /** Consecutive timeouts before the fan is reported offline. Tests lower it. */
  offlineAfterTimeouts?: number;
}

export interface FanDeviceEvents {
  /** Emitted after every successful GET/reload with the merged state. */
  state: [state: FanState];
  /** Emitted when reachability flips. */
  online: [online: boolean];
}

/** Three missed polls, 15 s at the default interval, before the Home app shows No Response. */
const DEFAULT_OFFLINE_AFTER_TIMEOUTS = 3;

/** Changes accumulated while a SET is in flight, sent as one SET afterwards. */
interface Batch {
  change: FanState;
  /** Cached state from before the first optimistic merge, restored if the SET fails and the fan cannot be read. */
  before: FanState;
  flush: Promise<FanState>;
}

export class FanDevice extends EventEmitter<FanDeviceEvents> {
  readonly guid: string;
  readonly hasLight: boolean;
  private _ip: string;
  private _state: FanState = {};
  private _online = true;
  private timeouts = 0;
  private inflightRefresh?: Promise<FanState>;
  /** Bumped on every write; a GET answered from before the write is stale and must not overwrite the state. */
  private writeSeq = 0;
  private batch?: Batch;
  private writeChain: Promise<unknown> = Promise.resolve();
  private lastReload: Promise<FanState> = Promise.resolve({});
  private readonly offlineAfter: number;

  constructor(
    private readonly client: Pick<FanClient, 'get' | 'set'>,
    fan: Pick<DiscoveredFan, 'guid' | 'ip' | 'hasLight'>,
    private readonly options: FanDeviceOptions,
  ) {
    super();
    this.guid = fan.guid;
    this.hasLight = fan.hasLight;
    this._ip = fan.ip;
    this.offlineAfter = options.offlineAfterTimeouts ?? DEFAULT_OFFLINE_AFTER_TIMEOUTS;
  }

  get ip(): string {
    return this._ip;
  }

  get state(): Readonly<FanState> {
    return this._state;
  }

  get online(): boolean {
    return this._online;
  }

  /** Called when discovery sees the fan again, possibly on a new address. */
  seen(ip: string): void {
    this._ip = ip;
    this.setOnline(true);
  }

  private get setOptions(): SetOptions {
    return { buzzer: this.options.buzzer, melody: this.options.melody, hasLight: this.hasLight };
  }

  /**
   * Poll the app's GET list and merge the answer into the cached state. A refresh that is already in flight is
   * shared, so polls do not queue up behind a fan that has stopped answering.
   */
  refresh(): Promise<FanState> {
    if (!this.inflightRefresh) {
      this.inflightRefresh = this.doRefresh().finally(() => {
        this.inflightRefresh = undefined;
      });
    }
    return this.inflightRefresh;
  }

  private async doRefresh(): Promise<FanState> {
    const seq = this.writeSeq;
    try {
      const frame = await this.client.get(this._ip, buildGetProperties(this.hasLight));
      this.setOnline(true);
      if (seq !== this.writeSeq) {
        // A write was composed while this GET was queued or in flight. Requests to a fan are sent in order, so
        // this answer predates the write. The reload after the write supersedes it.
        return this._state;
      }
      this._state = mergeState(this._state, decodeProperties(frame.properties));
      this.emit('state', this._state);
      return this._state;
    } catch (err) {
      this.noteFailure(err);
      throw err;
    }
  }

  /**
   * Apply a change. The cached state is updated optimistically at once, so reads and later writes build on it.
   * Writes are pipelined: while a SET is in flight, every further change is merged into one pending batch that is
   * sent as a single SET once the current one is acknowledged. Each SET carries the full target state, so only the
   * latest matters. After a successful SET the state is reloaded, as the app does.
   * With `awaitReload: false` the promise resolves on the SET acknowledgement and the reload runs in the background.
   * HomeKit gives a write handler 10 s in total, so a write must not wait for two round trips.
   */
  async apply(change: FanState, { awaitReload = true }: { awaitReload?: boolean } = {}): Promise<FanState> {
    if (Object.keys(this._state).length === 0) {
      // Nothing known yet, for example when Adaptive Lighting writes right after a restart. The pruning rules
      // need the real state and a fan rejects a lone property, so read the state first.
      await this.refresh();
    }
    const before = this._state;
    this._state = mergeState(this._state, change);
    this.writeSeq++;
    if (this.batch) {
      this.batch.change = mergeState(this.batch.change, change);
    } else {
      const batch: Batch = {
        change, before,
        flush: this.writeChain.then(() => {
          this.batch = undefined;
          return this.write(batch.change, batch.before);
        }),
      };
      this.batch = batch;
      this.writeChain = batch.flush.catch(() => undefined);
    }
    await this.batch.flush;
    return awaitReload ? this.lastReload : this._state;
  }

  /** Send one SET for `batch`, retrying once when the reply is lost, then start the reload. */
  private async write(batch: FanState, before: FanState): Promise<FanState> {
    const { properties } = composeSet(this._state, batch, this.setOptions);
    try {
      try {
        await this.client.set(this._ip, properties);
      } catch (err) {
        // Datagrams get lost on Wi-Fi. The SET carries the full target state, so re-sending it is safe.
        if (!(err instanceof TimeoutError)) {
          throw err;
        }
        await this.client.set(this._ip, properties);
      }
    } catch (err) {
      this.noteFailure(err);
      // The optimistic state may be wrong. Read the fan before reporting the failure; if that fails too, go back
      // to the state from before the batch. This GET is queued behind the SET, so it is not the shared poll.
      this.writeSeq++;
      await this.doRefresh().catch(() => {
        this._state = mergeState(before, this.batch?.change ?? {});
        this.emit('state', this._state);
      });
      throw err;
    }
    this.setOnline(true);
    // A fresh GET queued behind the SET, not a shared poll that may predate it. The write succeeded, so a failed
    // reload does not fail it.
    this.lastReload = this.doRefresh().catch(() => this._state);
    return this._state;
  }

  private noteFailure(err: unknown): void {
    if (err instanceof TimeoutError) {
      this.timeouts++;
      if (this.timeouts >= this.offlineAfter) {
        this.setOnline(false);
      }
    }
  }

  private setOnline(online: boolean): void {
    if (online) {
      this.timeouts = 0;
    }
    if (online !== this._online) {
      this._online = online;
      this.emit('online', online);
    }
  }
}
