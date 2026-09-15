/**
 * Guarded flash write: erase everything, prove it is blank, write, verify.
 *
 * A few GD32 DFU bootloader revisions occasionally acknowledge ERASE_PAGE but
 * leave a page untouched. We therefore treat erase status as advisory and the
 * flash contents as authoritative: after the first erase pass, any dirty pages
 * are retried (still before any write) and the complete span is checked again.
 */

import type { FlashPlan } from "../firmware/flashplan";
import { WebUsbDfuDevice } from "./webusb-dfu";

export type FlashPhase = "erase" | "write" | "verify";

export type FlashProgress = {
  phase: FlashPhase;
  done: number;
  total: number;
};

export class FlashWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlashWriteError";
  }
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function bytesAround(data: Uint8Array, at: number): string {
  return [...data.subarray(Math.max(0, at - 4), at + 4)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

const RECOVER = "Do NOT power-cycle deliberately. Recover with the verified factory image if read-back fails.";
const MAX_ERASE_PASSES = 3;

export type FlashOutcome = {
  base: number;
  bytes: number;
  pages: number;
};

function dirtyPages(blank: Uint8Array, plan: FlashPlan, base: number, pageSize: number) {
  return plan.pages.filter((page) => {
    const offset = page.page - base;
    for (let i = 0; i < pageSize; i += 1) {
      if (blank[offset + i] !== 0xff) return true;
    }
    return false;
  });
}

export async function writeAndVerify(
  device: WebUsbDfuDevice,
  plan: FlashPlan,
  pageSize: number,
  onProgress?: (progress: FlashProgress) => void,
): Promise<FlashOutcome> {
  if (plan.pages.length === 0) {
    throw new FlashWriteError("refusing to write an empty plan");
  }

  const base = plan.pages[0].page;
  plan.pages.forEach((page, index) => {
    const expected = base + index * pageSize;
    if (page.page !== expected) {
      throw new FlashWriteError(
        `plan pages are not contiguous: page ${index} is ${hex(page.page)}, expected ${hex(expected)}`,
      );
    }
  });

  const image = new Uint8Array(plan.pages.length * pageSize);
  for (const page of plan.pages) {
    image.set(page.data, page.page - base);
  }

  let erased = 0;
  for (const page of plan.pages) {
    await device.erasePage(page.page);
    erased += 1;
    onProgress?.({ phase: "erase", done: erased, total: plan.pages.length });
  }

  let blank = await device.read(base, image.length);
  let dirty = dirtyPages(blank, plan, base, pageSize);

  for (let pass = 2; dirty.length > 0 && pass <= MAX_ERASE_PASSES; pass += 1) {
    // Never write around a failed erase. Retry only the pages that read back
    // dirty, then re-read the entire intended write span before proceeding.
    for (const page of dirty) {
      await device.erasePage(page.page);
      onProgress?.({ phase: "erase", done: plan.pages.length, total: plan.pages.length });
    }
    blank = await device.read(base, image.length);
    dirty = dirtyPages(blank, plan, base, pageSize);
  }

  if (dirty.length > 0) {
    const stillSet = blank.findIndex((byte) => byte !== 0xff);
    throw new FlashWriteError(
      `Erase did not take at ${hex(base + stillSet)} after ${MAX_ERASE_PASSES} attempts: ` +
        `read 0x${blank[stillSet].toString(16)} instead of 0xFF.\n` +
        `  on flash: ${bytesAround(blank, stillSet)}\n` +
        "Nothing has been written; the tablet still holds its previous firmware.",
    );
  }

  for (let offset = 0; offset < image.length; offset += device.transferSize) {
    const end = Math.min(offset + device.transferSize, image.length);
    await device.writeBlock(base + offset, image.subarray(offset, end));
    onProgress?.({ phase: "write", done: end, total: image.length });
  }

  const readBack = await device.read(base, image.length, (progress) =>
    onProgress?.({ phase: "verify", done: progress.done, total: progress.total }),
  );
  for (let i = 0; i < image.length; i += 1) {
    if (readBack[i] !== image[i]) {
      throw new FlashWriteError(
        `Read-back mismatch at ${hex(base + i)}: wrote 0x${image[i].toString(16)}, ` +
          `read 0x${readBack[i].toString(16)}.\n` +
          `  intended: ${bytesAround(image, i)}\n` +
          `  on flash: ${bytesAround(readBack, i)}\n` +
          RECOVER,
      );
    }
  }

  return { base, bytes: image.length, pages: plan.pages.length };
}
