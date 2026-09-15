/**
 * DfuSe client over WebUSB.
 *
 * The browser transport intentionally follows the same state-machine shape as
 * dfu-util/DfuSe: explicitly select alternate setting 0, force dfuIDLE before
 * special commands, honour bwPollTimeout, and never trust an erase until the
 * caller has read it back.
 */

import type { DeviceAdapter } from "../devices/types";

const INTERFACE_REQUEST_IN = "class" as const;

const REQ_DNLOAD = 1;
const REQ_UPLOAD = 2;
const REQ_GETSTATUS = 3;
const REQ_CLRSTATUS = 4;
const REQ_GETSTATE = 5;
const REQ_ABORT = 6;

const CMD_SET_ADDRESS = 0x21;
const CMD_ERASE_PAGE = 0x41;
const BLOCK_DATA = 2;

const DFU_FUNCTIONAL_DESCRIPTOR = 0x21;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const ERASE_TIMEOUT_MS = 20_000;

export const DFU_STATE: Record<"dfuIdle" | "dfuDnloadSync" | "dfuDnbusy" | "dfuDnloadIdle" | "dfuError", number> = {
  dfuIdle: 2,
  dfuDnloadSync: 3,
  dfuDnbusy: 4,
  dfuDnloadIdle: 5,
  dfuError: 10,
};

export class DfuError extends Error {
  readonly state?: number;
  readonly status?: number;

  constructor(message: string, detail?: { state?: number; status?: number }) {
    super(message);
    this.name = "DfuError";
    this.state = detail?.state;
    this.status = detail?.status;
  }
}

export type DfuStatus = {
  status: number;
  pollTimeoutMs: number;
  state: number;
};

export type DfuProgress = {
  phase: "erase" | "write" | "read";
  address: number;
  done: number;
  total: number;
};

export function buildSetAddressPayload(address: number): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = CMD_SET_ADDRESS;
  new DataView(payload.buffer).setUint32(1, address, true);
  return payload;
}

export function buildErasePayload(address: number): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = CMD_ERASE_PAGE;
  new DataView(payload.buffer).setUint32(1, address, true);
  return payload;
}

export function webUsbSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  return Boolean(navigator.usb);
}

export class WebUsbDfuDevice {
  private readonly device: USBDevice;
  private readonly interfaceNumber: number;
  private readonly fallbackTransferSize: number;
  private resolvedTransferSize: number;

  private constructor(device: USBDevice, adapter: DeviceAdapter) {
    this.device = device;
    this.interfaceNumber = adapter.dfu.interfaceNumber;
    this.fallbackTransferSize = adapter.dfu.defaultTransferSize;
    this.resolvedTransferSize = adapter.dfu.defaultTransferSize;
  }

  static async request(adapter: DeviceAdapter): Promise<WebUsbDfuDevice> {
    if (!webUsbSupported()) {
      throw new DfuError("WebUSB is not available in this browser. Use desktop Chromium over HTTPS.");
    }
    const device = await navigator.usb.requestDevice({
      filters: [
        {
          vendorId: adapter.dfu.identity.vendorId,
          productId: adapter.dfu.identity.productId,
        },
      ],
    });
    return new WebUsbDfuDevice(device, adapter);
  }

  static async getPaired(adapter: DeviceAdapter): Promise<WebUsbDfuDevice | null> {
    if (!webUsbSupported()) return null;
    const devices = await navigator.usb.getDevices();
    const match = devices.find(
      (device) =>
        device.vendorId === adapter.dfu.identity.vendorId &&
        device.productId === adapter.dfu.identity.productId,
    );
    return match ? new WebUsbDfuDevice(match, adapter) : null;
  }

  get transferSize(): number {
    return this.resolvedTransferSize;
  }

  get productName(): string {
    return this.device.productName ?? "DFU device";
  }

  async open(): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }
    try {
      await this.device.claimInterface(this.interfaceNumber);
      // DfuSe internal flash is alternate setting 0. Being explicit here
      // avoids relying on whichever alternate a host/previous tool left active.
      await this.device.selectAlternateInterface(this.interfaceNumber, 0);
    } catch (error) {
      throw new DfuError(
        `Cannot claim the DFU interface: ${error instanceof Error ? error.message : String(error)}. ` +
          "On Windows the DFU-mode identity must have the inbox WinUSB driver bound before the browser can " +
          "talk to it. This affects only the separate DFU identity; the tablet's normal HID mode keeps the " +
          "standard Windows HID driver and must not be rebound.",
      );
    }
    this.resolvedTransferSize = await this.readFunctionalTransferSize();
    await this.toIdle();
  }

  async close(): Promise<void> {
    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } catch {
      // Device may already have been power-cycled into normal mode.
    }
    if (this.device.opened) {
      await this.device.close();
    }
  }

  private async readFunctionalTransferSize(): Promise<number> {
    let raw: Uint8Array;
    try {
      const result = await this.device.controlTransferIn(
        { requestType: "standard", recipient: "device", request: 6, value: (0x02 << 8) | 0, index: 0 },
        255,
      );
      if (result.status !== "ok" || !result.data) return this.fallbackTransferSize;
      raw = new Uint8Array(result.data.buffer);
    } catch {
      return this.fallbackTransferSize;
    }
    let offset = 0;
    while (offset + 1 < raw.length) {
      const length = raw[offset];
      const kind = raw[offset + 1];
      if (length === 0) break;
      if (kind === DFU_FUNCTIONAL_DESCRIPTOR && offset + 7 <= raw.length) {
        const size = raw[offset + 5] | (raw[offset + 6] << 8);
        if (size > 0) return size;
      }
      offset += length;
    }
    return this.fallbackTransferSize;
  }

  private async controlOut(request: number, value: number, data?: Uint8Array): Promise<void> {
    const setup: USBControlTransferParameters = {
      requestType: INTERFACE_REQUEST_IN,
      recipient: "interface",
      request,
      value,
      index: this.interfaceNumber,
    };
    const result = data
      ? await this.device.controlTransferOut(setup, data as unknown as BufferSource)
      : await this.device.controlTransferOut(setup);
    if (result.status !== "ok") {
      throw new DfuError(`DFU request ${request} failed with USB status "${result.status}"`);
    }
  }

  private async controlIn(request: number, value: number, length: number): Promise<Uint8Array> {
    const result = await this.device.controlTransferIn(
      {
        requestType: INTERFACE_REQUEST_IN,
        recipient: "interface",
        request,
        value,
        index: this.interfaceNumber,
      },
      length,
    );
    if (result.status !== "ok" || !result.data) {
      throw new DfuError(`DFU request ${request} failed with USB status "${result.status}"`);
    }
    return new Uint8Array(result.data.buffer);
  }

  async getStatus(): Promise<DfuStatus> {
    const raw = await this.controlIn(REQ_GETSTATUS, 0, 6);
    if (raw.length < 6) {
      throw new DfuError(`DFU_GETSTATUS returned ${raw.length} bytes, expected 6`);
    }
    return {
      status: raw[0],
      pollTimeoutMs: raw[1] | (raw[2] << 8) | (raw[3] << 16),
      state: raw[4],
    };
  }

  async getState(): Promise<number> {
    const raw = await this.controlIn(REQ_GETSTATE, 0, 1);
    if (raw.length < 1) {
      throw new DfuError("DFU_GETSTATE returned no data");
    }
    return raw[0];
  }

  async clearStatus(): Promise<void> {
    await this.controlOut(REQ_CLRSTATUS, 0);
  }

  async abort(): Promise<void> {
    await this.controlOut(REQ_ABORT, 0);
  }

  async toIdle(): Promise<void> {
    let state = await this.getState();
    if (state === DFU_STATE.dfuError) {
      await this.clearStatus();
      state = await this.getState();
    }
    if (state !== DFU_STATE.dfuIdle) {
      await this.abort();
      state = await this.getState();
    }
    if (state !== DFU_STATE.dfuIdle) {
      throw new DfuError(`Cannot reach dfuIDLE; device is in state ${state}`, { state });
    }
  }

  /** Poll until a DfuSe download/special command has actually completed. */
  private async finish(timeoutMs: number): Promise<DfuStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.getStatus();
      if (status.status !== 0) {
        throw new DfuError(`DFU error status ${status.status} in state ${status.state}`, {
          state: status.state,
          status: status.status,
        });
      }
      if (status.state === DFU_STATE.dfuDnloadIdle || status.state === DFU_STATE.dfuIdle) {
        return status;
      }
      if (status.state !== DFU_STATE.dfuDnbusy && status.state !== DFU_STATE.dfuDnloadSync) {
        throw new DfuError(`Unexpected DFU state ${status.state}`, { state: status.state });
      }

      const wait = status.pollTimeoutMs || 5;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || wait > remaining) {
        throw new DfuError(
          `Timed out waiting for the DFU operation to complete (device requested ${wait} ms poll delay)`,
          { state: status.state },
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }

  private async command(payload: Uint8Array, timeoutMs: number): Promise<void> {
    await this.controlOut(REQ_DNLOAD, 0, payload);
    await this.finish(timeoutMs);
  }

  async setAddress(address: number): Promise<void> {
    await this.command(buildSetAddressPayload(address), DOWNLOAD_TIMEOUT_MS);
  }

  async erasePage(address: number): Promise<void> {
    if (address % 0x400 !== 0) {
      throw new DfuError(`Erase address 0x${address.toString(16)} is not page aligned`);
    }
    // Some GD32 DFU implementations report a successful no-op when a special
    // command is issued from dfuDNLOAD-IDLE. Normalize state before every erase.
    await this.toIdle();
    await this.command(buildErasePayload(address), ERASE_TIMEOUT_MS);
  }

  async read(address: number, length: number, onProgress?: (progress: DfuProgress) => void): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      await this.toIdle();
      await this.setAddress(address + done);
      await this.toIdle();
      const chunk = Math.min(this.resolvedTransferSize, length - done);
      const data = await this.controlIn(REQ_UPLOAD, BLOCK_DATA, chunk);
      if (data.length === 0) {
        throw new DfuError(`Empty DFU upload at 0x${(address + done).toString(16)}`);
      }
      if (data.length !== chunk) {
        throw new DfuError(
          `Short DFU read at 0x${(address + done).toString(16)}: got ${data.length}, expected ${chunk}`,
        );
      }
      out.set(data, done);
      done += data.length;
      onProgress?.({ phase: "read", address: address + done, done, total: length });
    }
    await this.toIdle();
    return out;
  }

  async writeBlock(address: number, data: Uint8Array): Promise<void> {
    if (data.length === 0 || data.length > this.resolvedTransferSize) {
      throw new DfuError(`Invalid DFU write length ${data.length} (transfer size ${this.resolvedTransferSize})`);
    }
    await this.toIdle();
    await this.setAddress(address);
    await this.toIdle();
    await this.controlOut(REQ_DNLOAD, BLOCK_DATA, data);
    await this.finish(DOWNLOAD_TIMEOUT_MS);
    await this.toIdle();
  }
}
