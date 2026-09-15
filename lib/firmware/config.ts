/**
 * tablet.ears.cat config wire/persistence layout
 *
 * The identical 24-byte little-endian structure is used by the host protocol,
 * the injected runtime RAM copy, and the persistence record written by SAVE_CONFIG
 */

import { crc32 } from "./crc32";
import { PROTOCOL_VERSION } from "./protocol";

export const CONFIG_MAGIC = 0x31435443;
export const CONFIG_SIZE = 24;
export const CONFIG_CRC_OFFSET = 20;
export const RESERVED_LENGTH = 9;
export const STOCK_EMA_WEIGHT = 64;
export const STOCK_AVERAGE_WINDOW = 4;
export const EMA_WEIGHT_OFF = 255;
export const EMA_WEIGHT_MIN = 1;
export const AVERAGE_WINDOW_MIN = 1;
export const AVERAGE_WINDOW_MAX = 4;

export type TabletConfig = {
  targetRateHz: number;
  emaWeight: number;
  averageWindow: number;
  fastBarrelButtons: boolean;
};

export type RateBounds = {
  minHz: number;
  maxHz: number;
};

export function defaultConfig(bounds: RateBounds): TabletConfig {
  return {
    targetRateHz: bounds.minHz,
    emaWeight: STOCK_EMA_WEIGHT,
    averageWindow: STOCK_AVERAGE_WINDOW,
    fastBarrelButtons: false,
  };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampConfig(config: TabletConfig, bounds: RateBounds): TabletConfig {
  return {
    targetRateHz: clampInt(config.targetRateHz, bounds.minHz, bounds.maxHz, bounds.minHz),
    emaWeight: clampInt(config.emaWeight, EMA_WEIGHT_MIN, EMA_WEIGHT_OFF, STOCK_EMA_WEIGHT),
    averageWindow: clampInt(config.averageWindow, AVERAGE_WINDOW_MIN, AVERAGE_WINDOW_MAX, STOCK_AVERAGE_WINDOW),
    fastBarrelButtons: Boolean(config.fastBarrelButtons),
  };
}

export function encodeConfig(config: TabletConfig, bounds: RateBounds): Uint8Array {
  const clamped = clampConfig(config, bounds);
  const record = new Uint8Array(CONFIG_SIZE);
  const view = new DataView(record.buffer);
  view.setUint32(0, CONFIG_MAGIC, true);
  view.setUint16(4, PROTOCOL_VERSION, true);
  view.setUint16(6, clamped.targetRateHz, true);
  record[8] = clamped.emaWeight;
  record[9] = clamped.averageWindow;
  record[10] = clamped.fastBarrelButtons ? 1 : 0;
  view.setUint32(CONFIG_CRC_OFFSET, crc32(record, 0, CONFIG_CRC_OFFSET), true);
  return record;
}

export type ConfigDecode =
  | { ok: true; config: TabletConfig; clamped: boolean }
  | { ok: false; reason: string };

export function decodeConfig(record: Uint8Array, bounds: RateBounds): ConfigDecode {
  if (record.length < CONFIG_SIZE) {
    return { ok: false, reason: `record is ${record.length} bytes, expected ${CONFIG_SIZE}` };
  }
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== CONFIG_MAGIC) {
    return { ok: false, reason: `magic ${magic.toString(16)} is not CTC1` };
  }
  const version = view.getUint16(4, true);
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, reason: `schema version ${version} is not ${PROTOCOL_VERSION}` };
  }
  const expected = crc32(record, 0, CONFIG_CRC_OFFSET);
  const actual = view.getUint32(CONFIG_CRC_OFFSET, true);
  if (expected !== actual) {
    return { ok: false, reason: `crc ${actual.toString(16)} does not match computed ${expected.toString(16)}` };
  }
  for (let i = 11; i < 11 + RESERVED_LENGTH; i += 1) {
    if (record[i] !== 0) {
      return { ok: false, reason: `reserved byte ${i} is ${record[i]}, expected 0` };
    }
  }
  const raw: TabletConfig = {
    targetRateHz: view.getUint16(6, true),
    emaWeight: record[8],
    averageWindow: record[9],
    fastBarrelButtons: record[10] !== 0,
  };
  const config = clampConfig(raw, bounds);
  const clamped =
    config.targetRateHz !== raw.targetRateHz ||
    config.emaWeight !== raw.emaWeight ||
    config.averageWindow !== raw.averageWindow;
  return { ok: true, config, clamped };
}

export function decodeConfigOrDefaults(
  record: Uint8Array,
  bounds: RateBounds,
): { config: TabletConfig; rejected: boolean; reason?: string } {
  const decoded = decodeConfig(record, bounds);
  if (decoded.ok) return { config: decoded.config, rejected: false };
  return { config: defaultConfig(bounds), rejected: true, reason: decoded.reason };
}
