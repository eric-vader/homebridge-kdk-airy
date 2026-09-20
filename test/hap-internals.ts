/**
 * The two places the tests reach into HAP-NodeJS internals, written against @homebridge/hap-nodejs 2.2. An upgrade
 * that moves these breaks this file only.
 */
import { uuid, type Accessory } from '@homebridge/hap-nodejs';
import { IdentifierCache } from '@homebridge/hap-nodejs/dist/lib/model/IdentifierCache.js';
import * as tlv from '@homebridge/hap-nodejs/dist/lib/util/tlv.js';

/** Give every service and characteristic an instance id, as pairing would; the transition payload needs them. */
export function assignIds(accessory: Accessory): void {
  (accessory as unknown as { _assignIDs(cache: IdentifierCache): void })._assignIDs(new IdentifierCache('sim'));
}

/** The CharacteristicValueTransitionControl write the Home app sends to enable Adaptive Lighting. */
export function buildEnablePayload(colorTempIid: number, brightnessIid: number): string {
  const startTime = Buffer.alloc(8);
  startTime.writeBigUInt64LE(BigInt(Date.now() - Date.UTC(2001, 0, 1)));
  const f32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    return b;
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  // three-point curve: 500 mired now, 200 after 12 h, back to 500 after 24 h
  const points: [number, number][] = [[500, 0], [200, 12 * 3600 * 1000], [500, 12 * 3600 * 1000]];
  const entries = points.map(([temp, offset]) =>
    tlv.encode(1, f32(0), 2, f32(temp), 3, tlv.writeVariableUIntLE(offset), 4, tlv.writeVariableUIntLE(0)));
  const curve = tlv.encode(1, entries, 2, tlv.writeVariableUIntLE(brightnessIid), 3, tlv.encode(1, u32(1), 2, u32(100)));
  const params = tlv.encode(1, uuid.write(uuid.generate('transition')), 2, startTime);
  const config = tlv.encode(
    1, tlv.writeVariableUIntLE(colorTempIid), 2, params, 3, Buffer.from([1]), 5, curve, 6, u16(60000), 8, u32(600000),
  );
  return tlv.encode(2, tlv.encode(1, config)).toString('base64');
}
