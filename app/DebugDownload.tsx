"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type TraceEntry = Record<string, unknown> & {
  at: string;
  tMs: number;
};

const startedAt = Date.now();
const usbTrace: TraceEntry[] = [];
const MAX_TRACE = 5000;
let traceInstalled = false;

function pushTrace(entry: Record<string, unknown>) {
  usbTrace.push({
    ...entry,
    at: new Date().toISOString(),
    tMs: Date.now() - startedAt,
  });
  if (usbTrace.length > MAX_TRACE) usbTrace.splice(0, usbTrace.length - MAX_TRACE);
}

function sourceBytes(data: any): Uint8Array | null {
  if (!data) return null;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength ?? data.buffer.byteLength);
  }
  return null;
}

function decodeDfuCommand(request: number, value: number, data: any): Record<string, unknown> {
  if (request !== 1 || value !== 0) return {};
  const bytes = sourceBytes(data);
  if (!bytes || bytes.length === 0) return {};

  if ((bytes[0] === 0x21 || bytes[0] === 0x41) && bytes.length >= 5) {
    const address = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
    return {
      command: bytes[0] === 0x21 ? "SET_ADDRESS" : "ERASE_PAGE",
      address: `0x${address.toString(16).padStart(8, "0")}`,
    };
  }
  if (bytes[0] === 0x41 && bytes.length === 1) return { command: "MASS_ERASE" };
  if (bytes[0] === 0x92 && bytes.length === 1) return { command: "READ_UNPROTECT" };
  return {};
}

function installUsbTrace() {
  if (traceInstalled || typeof window === "undefined") return;
  const usbDeviceCtor = (window as any).USBDevice;
  if (!usbDeviceCtor?.prototype) return;
  traceInstalled = true;

  try {
    const proto = usbDeviceCtor.prototype as any;
    const originalIn = proto.controlTransferIn;
    const originalOut = proto.controlTransferOut;
    if (typeof originalIn !== "function" || typeof originalOut !== "function") return;

    proto.controlTransferIn = async function (setup: any, length: number) {
      const base = {
        direction: "in",
        requestType: setup?.requestType,
        recipient: setup?.recipient,
        request: setup?.request,
        value: setup?.value,
        index: setup?.index,
        length,
      };
      try {
        const result = await originalIn.call(this, setup, length);
        const entry: Record<string, unknown> = {
          ...base,
          usbStatus: result?.status,
          resultLength: result?.data?.byteLength ?? 0,
        };
        if (result?.status === "ok" && result?.data) {
          const raw = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
          if (setup?.request === 3 && raw.length >= 6) {
            entry.dfuStatus = {
              status: raw[0],
              pollTimeoutMs: raw[1] | (raw[2] << 8) | (raw[3] << 16),
              state: raw[4],
              iString: raw[5],
            };
          } else if (setup?.request === 5 && raw.length >= 1) {
            entry.dfuState = raw[0];
          }
        }
        pushTrace(entry);
        return result;
      } catch (error) {
        pushTrace({ ...base, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };

    proto.controlTransferOut = async function (setup: any, data?: any) {
      const bytes = sourceBytes(data);
      const base = {
        direction: "out",
        requestType: setup?.requestType,
        recipient: setup?.recipient,
        request: setup?.request,
        value: setup?.value,
        index: setup?.index,
        length: bytes?.byteLength ?? 0,
        ...decodeDfuCommand(setup?.request, setup?.value, data),
      };
      try {
        const result = data
          ? await originalOut.call(this, setup, data)
          : await originalOut.call(this, setup);
        pushTrace({ ...base, usbStatus: result?.status });
        return result;
      } catch (error) {
        pushTrace({ ...base, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
  } catch {
    // Diagnostics must never interfere with flashing. If a browser prevents
    // instrumentation, the report still includes metadata and the site log.
  }
}

function serializeEndpoint(endpoint: any) {
  return {
    endpointNumber: endpoint?.endpointNumber,
    direction: endpoint?.direction,
    type: endpoint?.type,
    packetSize: endpoint?.packetSize,
  };
}

function serializeAlternate(alternate: any) {
  return {
    alternateSetting: alternate?.alternateSetting,
    interfaceClass: alternate?.interfaceClass,
    interfaceSubclass: alternate?.interfaceSubclass,
    interfaceProtocol: alternate?.interfaceProtocol,
    interfaceName: alternate?.interfaceName,
    endpoints: Array.from(alternate?.endpoints ?? []).map(serializeEndpoint),
  };
}

function serializeUsbDevice(device: any) {
  const configuration = device?.configuration;
  return {
    vendorId: typeof device?.vendorId === "number" ? `0x${device.vendorId.toString(16).padStart(4, "0")}` : null,
    productId: typeof device?.productId === "number" ? `0x${device.productId.toString(16).padStart(4, "0")}` : null,
    manufacturerName: device?.manufacturerName ?? null,
    productName: device?.productName ?? null,
    opened: Boolean(device?.opened),
    configuration: configuration
      ? {
          configurationValue: configuration.configurationValue,
          configurationName: configuration.configurationName,
          interfaces: Array.from(configuration.interfaces ?? []).map((iface: any) => ({
            interfaceNumber: iface?.interfaceNumber,
            claimed: Boolean(iface?.claimed),
            activeAlternate: serializeAlternate(iface?.alternate),
            alternates: Array.from(iface?.alternates ?? []).map(serializeAlternate),
          })),
        }
      : null,
  };
}

function serializeHidDevice(device: any) {
  return {
    vendorId: typeof device?.vendorId === "number" ? `0x${device.vendorId.toString(16).padStart(4, "0")}` : null,
    productId: typeof device?.productId === "number" ? `0x${device.productId.toString(16).padStart(4, "0")}` : null,
    productName: device?.productName ?? null,
    opened: Boolean(device?.opened),
    collections: Array.from(device?.collections ?? []).map((collection: any) => ({
      usagePage: collection?.usagePage,
      usage: collection?.usage,
      inputReports: Array.from(collection?.inputReports ?? []).map((report: any) => report?.reportId),
      outputReports: Array.from(collection?.outputReports ?? []).map((report: any) => report?.reportId),
      featureReports: Array.from(collection?.featureReports ?? []).map((report: any) => report?.reportId),
    })),
  };
}

if (typeof window !== "undefined") installUsbTrace();

export function DebugDownload({ buildSha }: { buildSha: string | null }) {
  const [downloading, setDownloading] = useState(false);
  const [logTarget, setLogTarget] = useState<HTMLElement | null>(null);
  const [backupAvailable, setBackupAvailable] = useState(false);

  useEffect(() => {
    installUsbTrace();

    const tool = document.querySelector<HTMLElement>("#tool");
    if (!tool) return;

    const syncLogActions = () => {
      const log = tool.querySelector<HTMLElement>(".log-lines");
      if (!log) return;

      let host = log.querySelector<HTMLElement>("#log-download-actions");
      if (!host) {
        host = document.createElement("div");
        host.id = "log-download-actions";
        log.prepend(host);
      }

      setLogTarget(host);
      setBackupAvailable(Boolean(tool.querySelector(".backup-link")));
    };

    syncLogActions();
    const observer = new MutationObserver(syncLogActions);
    observer.observe(tool, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const download = async () => {
    setDownloading(true);
    try {
      const tool = document.querySelector<HTMLElement>("#tool");
      const select = tool?.querySelector<HTMLSelectElement>("select");
      const selectedOption = select?.selectedOptions.item(0);
      const nav = navigator as any;

      let usbDevices: unknown = [];
      try {
        usbDevices = nav.usb
          ? Array.from(await nav.usb.getDevices()).map(serializeUsbDevice)
          : "webusb unavailable";
      } catch (error) {
        usbDevices = { error: error instanceof Error ? error.message : String(error) };
      }

      let hidDevices: unknown = [];
      try {
        hidDevices = nav.hid
          ? Array.from(await nav.hid.getDevices()).map(serializeHidDevice)
          : "webhid unavailable";
      } catch (error) {
        hidDevices = { error: error instanceof Error ? error.message : String(error) };
      }

      const report = {
        schema: 1,
        generatedAt: new Date().toISOString(),
        sessionStartedAt: new Date(startedAt).toISOString(),
        build: {
          gitCommitSha: buildSha,
        },
        page: {
          origin: location.origin,
          pathname: location.pathname,
          secureContext: window.isSecureContext,
          visibilityState: document.visibilityState,
        },
        browser: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          languages: navigator.languages,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemoryGiB: nav.deviceMemory ?? null,
          devicePixelRatio: window.devicePixelRatio,
          screen: { width: screen.width, height: screen.height },
        },
        capabilities: {
          webusb: Boolean(nav.usb),
          webhid: Boolean(nav.hid),
        },
        ui: {
          selectedModelValue: select?.value ?? null,
          selectedModelText: selectedOption?.textContent?.trim() ?? null,
          selectedInstallTarget: tool?.querySelector(".install-option.selected strong")?.textContent?.trim() ?? null,
          progress: tool?.querySelector(".operation-progress")?.textContent?.trim() ?? null,
          backupVerified: Boolean(tool?.querySelector(".backup-link")),
          errors: Array.from(tool?.querySelectorAll(".error-line") ?? []).map((node) => node.textContent?.trim() ?? ""),
          logNewestFirst: Array.from(tool?.querySelectorAll(".log-lines > div") ?? []).map((node) => node.textContent ?? ""),
          visibleText: tool?.innerText ?? null,
        },
        usb: {
          devices: usbDevices,
          traceNewestLast: usbTrace.slice(),
          traceTruncated: usbTrace.length >= MAX_TRACE,
          maxTraceEntries: MAX_TRACE,
        },
        hid: {
          devices: hidDevices,
        },
      };

      const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `tablet-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const downloadBackup = () => {
    document.querySelector<HTMLButtonElement>("#tool .backup-link button")?.click();
  };

  return (
    <>
      <style>{`.backup-link { display: none !important; }`}</style>
      {logTarget && createPortal(
        <>
          {backupAvailable && (
            <>
              <button className="text-button" type="button" onClick={downloadBackup}>download backup</button>
              <span> · </span>
            </>
          )}
          <button className="text-button" type="button" onClick={() => void download()} disabled={downloading}>
            {downloading ? "building debug..." : "download debug"}
          </button>
        </>,
        logTarget,
      )}
    </>
  );
}
