import type { TabletConfig, RateBounds } from "../firmware/config";
import { decodeConfig, encodeConfig } from "../firmware/config";
import type { DeviceInfo, Telemetry } from "../firmware/protocol";
import {
  Command,
  FRAME_SIZE,
  ProtocolError,
  STATUS_TEXT,
  Status,
  decodeFrame,
  decodeInfo,
  decodeTelemetry,
  encodeFrame,
} from "../firmware/protocol";
import type { DeviceAdapter } from "../devices/types";

export function webHidSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  return Boolean(navigator.hid);
}

export type PenReportSample = {
  timestampMs: number;
  data: Uint8Array;
};

function matchesCollection(device: HIDDevice, usagePage: number): boolean {
  return device.collections.some((collection) => collection.usagePage === usagePage);
}

function reportPayloadBytes(report: HIDReportInfo): number {
  const bits = (report.items ?? []).reduce(
    (total, item) => total + (item.reportSize ?? 0) * (item.reportCount ?? 0),
    0,
  );
  return Math.ceil(bits / 8);
}

function findFeatureReportBytes(
  collections: readonly HIDCollectionInfo[],
  reportId: number,
): number | null {
  for (const collection of collections) {
    for (const report of collection.featureReports ?? []) {
      if (report.reportId === reportId) return reportPayloadBytes(report);
    }
    const nested = findFeatureReportBytes(collection.children ?? [], reportId);
    if (nested != null) return nested;
  }
  return null;
}

/** tablet.ears.cat protocol client over the normal vendor HID collection */
export class TabletLink {
  readonly adapter: DeviceAdapter;
  private readonly device: HIDDevice;
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private bounds: RateBounds | null = null;
  private penListeners = new Set<(sample: PenReportSample) => void>();
  private attached = false;

  private readonly onInputReport = (event: HIDInputReportEvent) => {
    if (event.reportId !== this.adapter.protocol.penReportId) return;
    if (this.penListeners.size === 0) return;
    const view = event.data;
    const data = new Uint8Array(view.byteLength);
    for (let i = 0; i < view.byteLength; i += 1) data[i] = view.getUint8(i);
    const sample: PenReportSample = { timestampMs: performance.now(), data };
    for (const listener of this.penListeners) listener(sample);
  };

  private constructor(device: HIDDevice, adapter: DeviceAdapter) {
    this.device = device;
    this.adapter = adapter;
  }

  static async request(adapter: DeviceAdapter): Promise<TabletLink> {
    if (!webHidSupported()) {
      throw new ProtocolError("WebHID is not available in this browser. Use desktop Chromium over HTTPS.");
    }
    const devices = await navigator.hid.requestDevice({
      filters: [
        {
          vendorId: adapter.normal.vendorId,
          productId: adapter.normal.productId,
          usagePage: adapter.normal.usagePage,
        },
      ],
    });
    const device =
      devices.find((candidate) => matchesCollection(candidate, adapter.normal.usagePage)) ?? devices[0];
    if (!device) throw new ProtocolError("No compatible tablet was selected.");
    const link = new TabletLink(device, adapter);
    await link.open();
    return link;
  }

  static async getPaired(adapter: DeviceAdapter): Promise<TabletLink | null> {
    if (!webHidSupported()) return null;
    const devices = await navigator.hid.getDevices();
    const device = devices.find(
      (candidate) =>
        candidate.vendorId === adapter.normal.vendorId &&
        candidate.productId === adapter.normal.productId &&
        matchesCollection(candidate, adapter.normal.usagePage),
    );
    if (!device) return null;
    const link = new TabletLink(device, adapter);
    await link.open();
    return link;
  }

  get productName(): string {
    return this.device.productName || this.adapter.displayName;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.attached) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.attached = true;
    }
  }

  async close(): Promise<void> {
    if (this.attached) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.attached = false;
    }
    this.penListeners.clear();
    if (this.device.opened) await this.device.close();
  }

  async hasRuntimeFraming(): Promise<boolean> {
    const { reportId } = this.adapter.protocol;
    return findFeatureReportBytes(this.device.collections, reportId) === FRAME_SIZE;
  }

  onPenReport(listener: (sample: PenReportSample) => void): () => void {
    this.penListeners.add(listener);
    return () => this.penListeners.delete(listener);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async exchangeOnce(command: Command, payload?: Uint8Array): Promise<Uint8Array> {
    this.sequence = (this.sequence + 1) & 0xff;
    const sequence = this.sequence;
    const frame = encodeFrame(command, sequence, payload);
    const { reportId } = this.adapter.protocol;

    try {
      await this.device.sendFeatureReport(reportId, frame as unknown as BufferSource);
    } catch (error) {
      throw new ProtocolError(
        `failed to send feature report: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let received: DataView;
    try {
      received = await this.device.receiveFeatureReport(reportId);
    } catch (error) {
      throw new ProtocolError(
        `failed to receive feature report after request: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const raw = new Uint8Array(received.buffer, received.byteOffset, received.byteLength);

    let body = raw;
    if (raw.length === FRAME_SIZE + 1 && raw[0] === reportId) {
      body = raw.slice(1);
    } else if (raw.length !== FRAME_SIZE) {
      throw new ProtocolError(`feature report is ${raw.length} bytes, expected ${FRAME_SIZE} or ${FRAME_SIZE + 1}`);
    }

    const response = decodeFrame(body);
    if (response.sequence !== sequence) {
      throw new ProtocolError(`response sequence ${response.sequence} does not match request ${sequence}`);
    }
    if (response.command !== command) {
      throw new ProtocolError(`response command ${response.command} does not echo request ${command}`);
    }
    if (response.status !== Status.Ok) {
      throw new ProtocolError(
        `${STATUS_TEXT[response.status] ?? "device reported an error"} (status ${response.status})`,
        response.status,
      );
    }
    return response.payload;
  }

  private exchange(command: Command, payload?: Uint8Array): Promise<Uint8Array> {
    return this.enqueue(async () => {
      try {
        return await this.exchangeOnce(command, payload);
      } catch (error) {
        const retryable =
          error instanceof ProtocolError &&
          (error.status === Status.BadCrc || error.status === undefined);
        if (!retryable) throw error;
        return this.exchangeOnce(command, payload);
      }
    });
  }

  async getInfo(): Promise<DeviceInfo> {
    const info = decodeInfo(await this.exchange(Command.GetInfo));
    this.bounds = { minHz: info.minHz, maxHz: info.maxHz };
    return info;
  }

  private rateBounds(): RateBounds {
    return this.bounds ?? { minHz: this.adapter.rate.minHz, maxHz: this.adapter.rate.maxHz };
  }

  private decodeConfigPayload(payload: Uint8Array): TabletConfig {
    const decoded = decodeConfig(payload, this.rateBounds());
    if (!decoded.ok) throw new ProtocolError(`device returned an invalid config record: ${decoded.reason}`);
    return decoded.config;
  }

  async getConfig(): Promise<TabletConfig> {
    return this.decodeConfigPayload(await this.exchange(Command.GetConfig));
  }

  async setConfig(config: TabletConfig): Promise<TabletConfig> {
    await this.exchange(Command.SetConfig, encodeConfig(config, this.rateBounds()));
    return this.getConfig();
  }

  async saveConfig(): Promise<void> {
    await this.exchange(Command.SaveConfig);
  }

  async factoryDefaults(): Promise<TabletConfig> {
    await this.exchange(Command.FactoryDefaults);
    return this.getConfig();
  }

  async getTelemetry(): Promise<Telemetry> {
    return decodeTelemetry(await this.exchange(Command.GetTelemetry));
  }
}
