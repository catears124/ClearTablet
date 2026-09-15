/**
 * Device adapter contract.
 *
 * Everything model-specific lives behind this interface: USB identities,
 * firmware identity and hashes, the flash map, protected ranges, protocol
 * capabilities, the DFU transport description, rate bounds/landmarks, and the
 * patch builder. A second tablet should be a new adapter, not edits throughout
 * the application.
 */

import type { RateBounds } from "../firmware/config";

export type UsbIdentity = {
  vendorId: number;
  productId: number;
};

export type AddressRange = {
  start: number;
  end: number;
  label: string;
  reason: string;
};

export type FlashMap = {
  flashBase: number;
  flashEnd: number;
  pageSize: number;
  appBase: number;
  appLength: number;
  extensionBase: number;
  persistenceBase: number;
  protected: readonly AddressRange[];
};

export type LandmarkEvidence =
  | "stock"
  | "measured-stable"
  | "measured-aggressive"
  | "measured-unstable"
  | "experimental";

export type RateLandmark = {
  hz: number;
  label: string;
  evidence: LandmarkEvidence;
  note: string;
};

export type RateControl = RateBounds & {
  stepHz: number;
  measuredCeilingHz: number | null;
  experimentalMaxHz: number;
  experimentalFromHz: number;
  landmarks: readonly RateLandmark[];
};

export type ProtocolCapabilities = {
  reportId: number;
  frameSize: number;
  usagePage: number;
  penReportId: number;
};

export type DfuTransport = {
  kind: "dfuse";
  identity: UsbIdentity;
  interfaceNumber: number;
  defaultTransferSize: number;
  windowsDeviceName: string;
};

export type FirmwareIdentity = {
  buildId: string;
  versionStringIndex: number;
  calibrationStringIndex: number;
  stockAppSha256: string;
  modelId: number;
  stockFirmwareId: number;
};

export type PatchSite = {
  address: number;
  before: Uint8Array;
  after: Uint8Array;
  purpose: string;
};

export type BuildResult = {
  /**
   * Bytes starting at `flash.appBase`. Fixed builds are exactly appLength;
   * runtime builds may extend through an injected region after the stock app.
   */
  app: Uint8Array;
  sites: readonly PatchSite[];
  /** Non-stock regions contained in `app`, expressed as absolute addresses. */
  appended: readonly AddressRange[];
};

export type PatchBuilder = {
  build(stockApp: Uint8Array): BuildResult;
  describe(): readonly PatchSite[];
};

/** Measured fixed profile retained as a hardware reference point. */
export type FirmwareRelease = {
  label: string;
  settleUs: readonly number[];
  measuredHz: number;
  sigmaX: number;
  sigmaY: number;
  duplicatePct: number;
  stationaryJumps: number;
  untested: readonly string[];
};

export type DeviceAdapter = {
  id: string;
  displayName: string;
  normal: UsbIdentity & { usagePage: number };
  firmware: FirmwareIdentity;
  flash: FlashMap;
  protocol: ProtocolCapabilities;
  dfu: DfuTransport;
  rate: RateControl;
  release: FirmwareRelease;
  patches: PatchBuilder;
};
