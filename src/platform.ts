import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { KdkAiryAccessory } from './accessory.js';
import { parseConfig, type DeviceConfig, type KdkAiryConfig } from './config.js';
import { FanDevice } from './device.js';
import { modelHasLight } from './models.js';
import { KdkClient, type FanClient } from './protocol/client.js';
import { localBroadcastAddresses, type DiscoveredFan } from './protocol/discovery.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/** Persisted in accessory.context so a cached fan works before discovery answers. */
export interface FanContext {
  guid: string;
  ip: string;
  commId: string;
  partId: string;
  hasLight: boolean;
}

/** Minimum gap between discoveries triggered by an offline fan, so an unplugged fan does not cause repeated broadcasts. */
const OFFLINE_REDISCOVERY_MS = 60_000;

interface Entry {
  accessory: PlatformAccessory<FanContext>;
  device: FanDevice;
  handler: KdkAiryAccessory;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const contextOf = (fan: DiscoveredFan): FanContext => ({
  guid: fan.guid, ip: fan.ip, commId: fan.commId, partId: fan.partId, hasLight: fan.hasLight,
});

export class KdkAiryPlatform implements DynamicPlatformPlugin {
  private readonly config: KdkAiryConfig;
  private readonly client: FanClient;
  /** Accessories Homebridge holds for this platform, by UUID: restored from its cache, plus those registered since. */
  private readonly known = new Map<string, PlatformAccessory<FanContext>>();
  /** Running fans, by guid. */
  private readonly entries = new Map<string, Entry>();
  private pollTimer?: NodeJS.Timeout;
  private discovering = false;
  private lastDiscovery = 0;
  private stopped = false;

  /**
   * Throws ConfigError on an unusable config; Homebridge logs it and skips the platform.
   * `client` is only passed by tests, which substitute a fake transport.
   */
  constructor(
    public readonly log: Logging,
    rawConfig: PlatformConfig,
    public readonly api: API,
    client?: FanClient,
  ) {
    this.config = parseConfig(rawConfig);
    this.client = client ?? new KdkClient({ minRequestIntervalMs: this.config.minRequestInterval, log });
    api.on('didFinishLaunching', () => {
      this.start().catch(err => log.error(`Failed to start: ${describe(err)}`));
    });
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.known.set(accessory.UUID, accessory as PlatformAccessory<FanContext>);
  }

  private async start(): Promise<void> {
    await this.client.start();

    // Bring cached fans up immediately; discovery refreshes their addresses afterwards.
    for (const accessory of this.known.values()) {
      const ctx: Partial<FanContext> = accessory.context;
      if (ctx.guid && ctx.ip) {
        const fan: DiscoveredFan = {
          guid: ctx.guid, ip: ctx.ip, commId: ctx.commId ?? '', partId: ctx.partId ?? '',
          known: modelHasLight(ctx.commId) !== undefined, hasLight: ctx.hasLight ?? true,
        };
        if (this.applyName(accessory, fan)) {
          this.api.updatePlatformAccessories([accessory]);
        }
        this.attach(accessory, fan);
      } else {
        this.log.warn(`Cached accessory ${accessory.displayName} has no device context; removing it`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.known.delete(accessory.UUID);
      }
    }

    await this.discover();
    this.pollTimer = setInterval(() => this.pollAll(), this.config.refreshInterval);
  }

  private stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    for (const e of this.entries.values()) {
      e.handler.dispose();
    }
    this.client.stop();
  }

  /** Broadcast M-SEARCH and register / update every fan that answers. */
  async discover(): Promise<void> {
    if (this.discovering || this.stopped) {
      return;
    }
    this.discovering = true;
    this.lastDiscovery = Date.now();
    try {
      const broadcasts = this.config.broadcastAddresses.length ? this.config.broadcastAddresses : localBroadcastAddresses();
      if (broadcasts.length === 0) {
        this.log.warn('No IPv4 interface found to broadcast on; set broadcast_addresses in the config');
        return;
      }
      this.log.debug(`Discovering fans via ${broadcasts.join(', ')}`);
      const fans = await this.client.discover(broadcasts);
      this.log.info(`Discovery finished: ${fans.length} fan(s) answered`);
      for (const fan of fans) {
        this.onDiscovered(fan);
      }
    } catch (err) {
      this.log.error(`Discovery failed: ${describe(err)}`);
    } finally {
      this.discovering = false;
    }
  }

  private onDiscovered(fan: DiscoveredFan): void {
    if (!fan.known && !this.config.allowUnknownModels) {
      this.log.warn(`Ignoring fan ${fan.guid} at ${fan.ip}: unknown model "${fan.commId}" (set allow_unknown_models to use it)`);
      return;
    }
    const existing = this.entries.get(fan.guid);
    if (existing) {
      if (existing.device.ip !== fan.ip) {
        this.log.info(`${existing.accessory.displayName}: address changed ${existing.device.ip} -> ${fan.ip}`);
      }
      const renamed = this.applyName(existing.accessory, fan);
      // The light services are fixed at attach time, so hasLight keeps the value the accessory was built with.
      const context = { ...contextOf(fan), hasLight: existing.device.hasLight };
      const changed = (Object.keys(context) as (keyof FanContext)[]).some(k => existing.accessory.context[k] !== context[k]);
      if (changed) {
        existing.accessory.context = context;
        this.setInformation(existing.accessory, fan);
      }
      if (renamed || changed) {
        this.api.updatePlatformAccessories([existing.accessory]);
      }
      existing.device.seen(fan.ip);
      return;
    }

    const uuid = this.api.hap.uuid.generate(fan.guid);
    const cached = this.known.get(uuid);
    const accessory = cached ?? new this.api.platformAccessory<FanContext>(this.nameFor(fan), uuid, this.api.hap.Categories.FAN);
    accessory.context = contextOf(fan);
    this.applyName(accessory, fan);
    this.attach(accessory, fan);
    if (cached) {
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info(`Adding new fan "${accessory.displayName}": model ${fan.commId}, guid ${fan.guid}, ip ${fan.ip}`);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  private deviceConfig(guid: string): DeviceConfig | undefined {
    return this.config.devices.find(d => d.guid === guid.toUpperCase());
  }

  /** The name configured for the fan's guid, or "Fan <ip>" so the address is visible in the Home app. */
  private nameFor(fan: DiscoveredFan): string {
    return this.deviceConfig(fan.guid)?.name ?? `Fan ${fan.ip}`;
  }

  /**
   * Keep the accessory name in step with its address. HomeKit controllers keep their own copy of the name after
   * pairing, so this affects new pairings and the Homebridge side. Returns true when the name changed.
   */
  private applyName(accessory: PlatformAccessory<FanContext>, fan: DiscoveredFan): boolean {
    const name = this.nameFor(fan);
    if (accessory.displayName === name) {
      return false;
    }
    accessory.displayName = name;
    accessory.getService(this.api.hap.Service.AccessoryInformation)
      ?.updateCharacteristic(this.api.hap.Characteristic.Name, name);
    return true;
  }

  private setInformation(accessory: PlatformAccessory<FanContext>, fan: DiscoveredFan): void {
    const { Characteristic, Service } = this.api.hap;
    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'KDK')
      .setCharacteristic(Characteristic.Model, fan.commId || 'Unknown')
      .setCharacteristic(Characteristic.SerialNumber, fan.guid)
      .setCharacteristic(Characteristic.FirmwareRevision, fan.partId || '0');
  }

  private attach(accessory: PlatformAccessory<FanContext>, fan: DiscoveredFan): void {
    const overrides = this.deviceConfig(fan.guid);
    this.setInformation(accessory, fan);
    const device = new FanDevice(this.client, fan, { buzzer: this.config.buzzer, melody: this.config.melody });
    const handler = new KdkAiryAccessory(this.api.hap, this.log, accessory, device, {
      nightModeSwitch: overrides?.nightModeSwitch ?? this.config.nightModeSwitch,
      swingMode: overrides?.swingMode ?? this.config.swingMode,
    });
    this.entries.set(fan.guid, { accessory, device, handler });
    this.known.set(accessory.UUID, accessory);
    device.refresh().catch(err => this.log.debug(`${accessory.displayName}: initial refresh failed: ${describe(err)}`));
  }

  private async pollAll(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await Promise.all([...this.entries.values()].map(async e => {
      try {
        await e.device.refresh();
      } catch (err) {
        this.log.debug(`${e.accessory.displayName}: poll failed: ${describe(err)}`);
        if (!e.device.online && Date.now() - this.lastDiscovery >= OFFLINE_REDISCOVERY_MS) {
          void this.discover();
        }
      }
    }));
  }
}
