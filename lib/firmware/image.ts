/**
 * Backup and stock-image validation.
 *
 * These are the checks that stand between a user and a brick, ported from the
 * Python flasher's invariants:
 *
 *   - a backup is two independent full-flash reads that must be byte-identical;
 *   - the installed application region is identified only inside the pinned
 *     stock application range;
 *   - the decoded factory application must hash to the pinned stock build;
 *   - a restore image must come from a backup of the same length and base.
 *
 * Hashing uses WebCrypto.
 */

import type { DeviceAdapter } from "../devices/types";
import { ERASED_BYTE } from "./flashplan";

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const view = new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", view.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type BackupPair = {
  first: Uint8Array;
  second: Uint8Array;
};

export type BackupVerdict =
  | { ok: true; image: Uint8Array; firstMismatchAt: null }
  | { ok: false; reason: string; firstMismatchAt: number | null };

/** Require two byte-identical full-flash reads before any write is allowed. */
export function verifyBackupPair(adapter: DeviceAdapter, pair: BackupPair): BackupVerdict {
  const expectedLength = adapter.flash.flashEnd - adapter.flash.flashBase;
  if (pair.first.length !== expectedLength || pair.second.length !== expectedLength) {
    return {
      ok: false,
      firstMismatchAt: null,
      reason: `backup reads are ${pair.first.length} and ${pair.second.length} bytes, expected ${expectedLength}`,
    };
  }
  for (let i = 0; i < expectedLength; i += 1) {
    if (pair.first[i] !== pair.second[i]) {
      return {
        ok: false,
        firstMismatchAt: i,
        reason: `the two flash reads differ at offset 0x${i.toString(16)} (${pair.first[i]} vs ${pair.second[i]}); flashing is blocked`,
      };
    }
  }
  return { ok: true, image: pair.first, firstMismatchAt: null };
}

export function extractStockApp(adapter: DeviceAdapter, fullFlash: Uint8Array): Uint8Array {
  const expectedLength = adapter.flash.flashEnd - adapter.flash.flashBase;
  if (fullFlash.length !== expectedLength) {
    throw new ImageError(`flash image is ${fullFlash.length} bytes, expected ${expectedLength}`);
  }
  const offset = adapter.flash.appBase - adapter.flash.flashBase;
  return fullFlash.slice(offset, offset + adapter.flash.appLength);
}

function bytesEqualAt(data: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (offset < 0 || offset + expected.length > data.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (data[offset + i] !== expected[i]) return false;
  }
  return true;
}

function findUtf16LeBuildId(app: Uint8Array, buildId: string): string | null {
  const match = /^(.*_)(\d{6})$/.exec(buildId);
  if (!match) return null;
  const prefix = match[1];

  for (let offset = 0; offset + (prefix.length + 6) * 2 <= app.length; offset += 1) {
    let prefixMatches = true;
    for (let i = 0; i < prefix.length; i += 1) {
      if (app[offset + i * 2] !== prefix.charCodeAt(i) || app[offset + i * 2 + 1] !== 0) {
        prefixMatches = false;
        break;
      }
    }
    if (!prefixMatches) continue;

    let suffix = "";
    let valid = true;
    for (let i = 0; i < 6; i += 1) {
      const value = app[offset + (prefix.length + i) * 2];
      const zero = app[offset + (prefix.length + i) * 2 + 1];
      if (zero !== 0 || value < 0x30 || value > 0x39) {
        valid = false;
        break;
      }
      suffix += String.fromCharCode(value);
    }
    if (valid) return `${prefix}${suffix}`;
  }
  return null;
}

export type InstalledApplicationVerdict =
  | { status: "stock"; sha256: string; buildId: string }
  | { status: "patched"; sha256: string; buildId: string }
  | { status: "legacy"; sha256: string; buildId: string }
  | { status: "unsupported"; sha256: string; buildId: string | null; reason: string };

/**
 * Identify only the installed application bytes that belong to the pinned
 * current stock image. Bytes after appLength are deliberately ignored: older
 * official builds can leave inert tail data there after GAOMON's updater writes
 * the shorter current application.
 *
 * A legacy image is eligible for the in-site factory update only when it
 * contains the same firmware-family build string and an older YYMMDD suffix.
 * Unknown or newer images are refused rather than being force-downgraded.
 */
export async function inspectInstalledApplication(
  adapter: DeviceAdapter,
  fullFlash: Uint8Array,
): Promise<InstalledApplicationVerdict> {
  const installedApp = extractStockApp(adapter, fullFlash);
  const sha256 = await sha256Hex(installedApp);
  if (sha256 === adapter.firmware.stockAppSha256) {
    return { status: "stock", sha256, buildId: adapter.firmware.buildId };
  }

  const normalized = installedApp.slice();
  let normalizedAny = false;
  for (const site of adapter.patches.describe()) {
    if (site.before.length !== site.after.length) continue;
    const offset = site.address - adapter.flash.appBase;
    if (!bytesEqualAt(normalized, offset, site.after)) continue;
    normalized.set(site.before, offset);
    normalizedAny = true;
  }
  if (normalizedAny && await sha256Hex(normalized) === adapter.firmware.stockAppSha256) {
    return { status: "patched", sha256, buildId: adapter.firmware.buildId };
  }

  const detectedBuildId = findUtf16LeBuildId(installedApp, adapter.firmware.buildId);
  const expected = /^(.*_)(\d{6})$/.exec(adapter.firmware.buildId);
  const detected = detectedBuildId ? /^(.*_)(\d{6})$/.exec(detectedBuildId) : null;
  if (expected && detected && expected[1] === detected[1] && Number(detected[2]) < Number(expected[2])) {
    return { status: "legacy", sha256, buildId: detectedBuildId! };
  }

  return {
    status: "unsupported",
    sha256,
    buildId: detectedBuildId,
    reason: detectedBuildId
      ? `unsupported firmware ${detectedBuildId} (application sha-256 ${sha256}); supported firmware is ${adapter.firmware.buildId}`
      : `unsupported firmware: application sha-256 ${sha256}; supported firmware is ${adapter.firmware.buildId}`,
  };
}

export type StockVerdict =
  | { ok: true; sha256: string }
  | { ok: false; sha256: string; reason: string };

/** Reject anything that is not the exact pinned factory application. */
export async function verifyStockApp(adapter: DeviceAdapter, app: Uint8Array): Promise<StockVerdict> {
  if (app.length !== adapter.flash.appLength) {
    const sha256 = await sha256Hex(app);
    return {
      ok: false,
      sha256,
      reason: `application region is ${app.length} bytes, expected ${adapter.flash.appLength}`,
    };
  }
  const sha256 = await sha256Hex(app);
  if (sha256 !== adapter.firmware.stockAppSha256) {
    return {
      ok: false,
      sha256,
      reason: `application hash ${sha256} is not the supported ${adapter.firmware.buildId} build (${adapter.firmware.stockAppSha256})`,
    };
  }
  return { ok: true, sha256 };
}

export type BlankVerdict =
  | { ok: true; length: number }
  | { ok: false; firstUsedAt: number; value: number };

/** Retained for callers that need an explicit erased-range assertion. */
export function verifyBlank(fullFlash: Uint8Array, flashBase: number, start: number, end: number): BlankVerdict {
  for (let address = start; address < end; address += 1) {
    const byte = fullFlash[address - flashBase];
    if (byte !== ERASED_BYTE) {
      return { ok: false, firstUsedAt: address, value: byte };
    }
  }
  return { ok: true, length: end - start };
}
