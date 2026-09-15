/**
 * S620 application patch builder.
 *
 * Fixed-profile builds use the three original hardware-validated feature patches
 * plus four settle immediates. Runtime builds are different: the injected
 * extension owns the filter/button/timing hook sites, so only the runtime hook
 * set is applied. Mixing the old unconditional feature patches with the runtime
 * hooks would either make the live controls unreachable or trip overlapping
 * preimage guards.
 */

import type { BuildResult, PatchBuilder, PatchSite } from "../types";
import { MIN_SAFE_SETTLE_SUM_US, SETTLE_SITES, STOCK_SETTLE_US } from "./timing";

export const APP_BASE = 0x08004000;
export const APP_LENGTH = 35512;

const MOVS_R0 = 0x20;

export const FEATURE_PATCHES: readonly PatchSite[] = [
  {
    address: 0x0800760e,
    before: Uint8Array.from([0x7c, 0x48]),
    after: Uint8Array.from([0xdb, 0xe0]),
    purpose: "bypass the identified XY moving-average, EMA and hold path while retaining the function tail",
  },
  {
    address: 0x08007e58,
    before: Uint8Array.from([0xfe, 0xf7, 0x2c, 0xff]),
    after: Uint8Array.from([0x00, 0xbf, 0x00, 0xbf]),
    purpose: "remove redundant barrel-button five-slot rescan",
  },
  {
    address: 0x08007ed8,
    before: Uint8Array.from([0xfe, 0xf7, 0xec, 0xfe]),
    after: Uint8Array.from([0x00, 0xbf, 0x00, 0xbf]),
    purpose: "remove redundant barrel-button five-slot rescan",
  },
];

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

function offsetOf(address: number, length: number): number {
  const offset = address - APP_BASE;
  if (offset < 0 || offset + length > APP_LENGTH) {
    throw new PatchError(
      `address 0x${address.toString(16)} (+${length}) is outside the pinned application image`,
    );
  }
  return offset;
}

function applySite(image: Uint8Array, site: PatchSite): void {
  const offset = offsetOf(site.address, site.before.length);
  if (site.before.length !== site.after.length) {
    throw new PatchError(`in-place patch at 0x${site.address.toString(16)} must preserve length`);
  }
  for (let i = 0; i < site.before.length; i += 1) {
    if (image[offset + i] !== site.before[i]) {
      const found = [...image.subarray(offset, offset + site.before.length)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const expected = [...site.before].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      throw new PatchError(
        `preimage mismatch at 0x${site.address.toString(16)}: expected ${expected}, found ${found}`,
      );
    }
  }
  image.set(site.after, offset);
}

export function settleSites(settleUs: readonly number[]): PatchSite[] {
  if (settleUs.length !== SETTLE_SITES.length) {
    throw new PatchError(`settle profile has ${settleUs.length} values, expected ${SETTLE_SITES.length}`);
  }
  const sum = settleUs.reduce((total, value) => total + value, 0);
  if (sum < MIN_SAFE_SETTLE_SUM_US) {
    throw new PatchError(
      `settle profile [${settleUs.join(", ")}] sums to ${sum} us, below the ${MIN_SAFE_SETTLE_SUM_US} us floor ` +
        "observed to still boot; a lower budget produces a firmware that does not enumerate",
    );
  }
  return SETTLE_SITES.map((address, index) => {
    const value = settleUs[index];
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new PatchError(`settle value ${value} at 0x${address.toString(16)} is not a byte`);
    }
    return {
      address,
      before: Uint8Array.from([STOCK_SETTLE_US[index], MOVS_R0]),
      after: Uint8Array.from([value, MOVS_R0]),
      purpose: `analog settle wait ${STOCK_SETTLE_US[index]} us -> ${value} us`,
    };
  });
}

export type FixedProfileLayer = {
  kind: "fixed-profile";
  settleUs: readonly number[];
};

export type RuntimeLayer = {
  kind: "runtime";
  base: number;
  blob: Uint8Array;
  hooks: readonly PatchSite[];
};

export type FirmwareLayer = FixedProfileLayer | RuntimeLayer;

export class S620PatchBuilder implements PatchBuilder {
  private readonly layer: FirmwareLayer;

  constructor(layer: FirmwareLayer) {
    this.layer = layer;
  }

  describe(): readonly PatchSite[] {
    if (this.layer.kind === "fixed-profile") {
      return [...FEATURE_PATCHES, ...settleSites(this.layer.settleUs)];
    }
    return this.layer.hooks;
  }

  build(stockApp: Uint8Array): BuildResult {
    if (stockApp.length !== APP_LENGTH) {
      throw new PatchError(`stock application is ${stockApp.length} bytes, expected ${APP_LENGTH}`);
    }
    const sites = this.describe();

    if (this.layer.kind === "fixed-profile") {
      const image = new Uint8Array(stockApp);
      for (const site of sites) applySite(image, site);
      return { app: image, sites, appended: [] };
    }

    const { base, blob } = this.layer;
    if (base < APP_BASE + APP_LENGTH) {
      throw new PatchError(
        `extension base 0x${base.toString(16)} overlaps the stock application, which ends at 0x${(APP_BASE + APP_LENGTH).toString(16)}`,
      );
    }

    const image = new Uint8Array(base - APP_BASE + blob.length);
    image.fill(0xff);
    image.set(stockApp, 0);
    const stockRegion = image.subarray(0, APP_LENGTH);
    for (const site of sites) applySite(stockRegion, site);
    image.set(blob, base - APP_BASE);

    return {
      app: image,
      sites,
      appended: [
        {
          start: base,
          end: base + blob.length,
          label: "tablet.ears.cat extension",
          reason: "injected runtime configuration and protocol code",
        },
      ],
    };
  }
}
