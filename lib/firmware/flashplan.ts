/**
 * Flash-plan generation and address guards.
 *
 * Every erase and every write in the browser installer goes through `planFlash`.
 * The plan is computed and validated before the device is touched at all, so an
 * out-of-range region is a refusal at planning time rather than a half-written
 * flash. The guards are deliberately redundant with the adapter's protected
 * ranges: a region is rejected if it falls below the application base, if it
 * intersects any protected range, or if it leaves the device's flash window.
 */

import type { AddressRange, DeviceAdapter } from "../devices/types";

export const ERASED_BYTE = 0xff;

export class FlashGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlashGuardError";
  }
}

export type WriteRegion = {
  address: number;
  data: Uint8Array;
  label: string;
};

export type FlashPagePlan = {
  /** Page-aligned erase/write address. */
  page: number;
  /** Exactly one page of data, padded with 0xFF where a region ends early. */
  data: Uint8Array;
  /** Regions contributing bytes to this page. */
  labels: readonly string[];
};

export type FlashPlan = {
  pages: readonly FlashPagePlan[];
  ranges: readonly AddressRange[];
  totalBytes: number;
  /** Address span that will be read back and compared after writing. */
  verifyRanges: readonly AddressRange[];
};

/**
 * Reject any span that is not writable on this device. Exported because the
 * installer, the restore flow and the plan builder all have to agree, and
 * because it is the single place the protected-range policy is enforced.
 */
export function assertWritable(adapter: DeviceAdapter, start: number, end: number, label: string): void {
  const { flash } = adapter;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new FlashGuardError(`${label}: non-integer address range ${start}..${end}`);
  }
  if (end <= start) {
    throw new FlashGuardError(`${label}: empty or inverted range ${hex(start)}..${hex(end)}`);
  }
  if (start < flash.appBase) {
    throw new FlashGuardError(
      `${label}: ${hex(start)} is below the application base ${hex(flash.appBase)}; the resident bootloader is never written`,
    );
  }
  if (end > flash.flashEnd) {
    throw new FlashGuardError(`${label}: ${hex(end)} is past the end of flash ${hex(flash.flashEnd)}`);
  }
  for (const range of flash.protected) {
    if (start < range.end && end > range.start) {
      throw new FlashGuardError(
        `${label}: ${hex(start)}..${hex(end)} intersects protected ${range.label} (${hex(range.start)}..${hex(range.end)}): ${range.reason}`,
      );
    }
  }
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

/**
 * Build a page-aligned erase/write plan for a set of regions.
 *
 * A page that is only partially covered by a region is still erased, so the
 * plan pads the remainder with 0xFF and the caller's readback comparison uses
 * the same padded bytes. Regions may not overlap: overlapping regions would
 * make the padded page content ambiguous.
 */
export function planFlash(adapter: DeviceAdapter, regions: readonly WriteRegion[]): FlashPlan {
  if (regions.length === 0) {
    throw new FlashGuardError("refusing to build an empty flash plan");
  }
  const pageSize = adapter.flash.pageSize;
  const sorted = [...regions].sort((a, b) => a.address - b.address);

  let previousEnd = -1;
  const ranges: AddressRange[] = [];
  for (const region of sorted) {
    if (region.data.length === 0) {
      throw new FlashGuardError(`${region.label}: empty region`);
    }
    const end = region.address + region.data.length;
    assertWritable(adapter, region.address, end, region.label);
    if (region.address < previousEnd) {
      throw new FlashGuardError(`${region.label}: overlaps the preceding region at ${hex(region.address)}`);
    }
    previousEnd = end;
    ranges.push({ start: region.address, end, label: region.label, reason: "requested write" });
  }

  const pages = new Map<number, { data: Uint8Array; labels: Set<string> }>();
  for (const region of sorted) {
    for (let offset = 0; offset < region.data.length; offset += 1) {
      const address = region.address + offset;
      const page = address - (address % pageSize);
      let entry = pages.get(page);
      if (!entry) {
        entry = { data: new Uint8Array(pageSize).fill(ERASED_BYTE), labels: new Set<string>() };
        pages.set(page, entry);
      }
      entry.data[address - page] = region.data[offset];
      entry.labels.add(region.label);
    }
  }

  const pagePlans = [...pages.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, entry]) => {
      assertWritable(adapter, page, page + pageSize, `erase page ${hex(page)}`);
      return { page, data: entry.data, labels: [...entry.labels] };
    });

  return {
    pages: pagePlans,
    ranges,
    totalBytes: pagePlans.length * pageSize,
    verifyRanges: pagePlans.map((plan) => ({
      start: plan.page,
      end: plan.page + pageSize,
      label: plan.labels.join(", "),
      reason: "readback verification",
    })),
  };
}
