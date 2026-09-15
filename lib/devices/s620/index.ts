/**
 * Gaomon S620 adapter manifest.
 *
 * The single place S620 internals are stated. The app reads this; it does not
 * hardcode S620 addresses or identities anywhere else.
 */

import { FRAME_SIZE, REPORT_ID } from "../../firmware/protocol";
import type { DeviceAdapter, FirmwareRelease, RateControl } from "../types";
import { APP_BASE, APP_LENGTH, S620PatchBuilder } from "./patches";
import { LIVE_RUNTIME_LAYER } from "./runtime";
import { MEASURED_CEILING_HZ, TIMING_ANCHORS } from "./timing";

const FLASH_BASE = 0x08000000;
const FLASH_END = 0x08020000;
const PAGE_SIZE = 0x400;

export const EXTENSION_BASE = 0x0800cc00;
export const PERSISTENCE_BASE = 0x0800f800;
export const STOCK_HZ = 294;
export const EXPERIMENTAL_MAX_HZ = 600;

const rate: RateControl = {
  minHz: STOCK_HZ,
  maxHz: EXPERIMENTAL_MAX_HZ,
  stepHz: 1,
  measuredCeilingHz: MEASURED_CEILING_HZ,
  experimentalMaxHz: EXPERIMENTAL_MAX_HZ,
  experimentalFromHz: 493,
  landmarks: [
    { hz: 294, label: "stock", evidence: "stock", note: "stock cadence, measured 292.6 Hz" },
    { hz: 444, label: "known stable", evidence: "measured-stable", note: "measured 443.3 Hz, sigma 3.0/3.6" },
    { hz: 470, label: "known aggressive", evidence: "measured-aggressive", note: "measured 471.6 Hz, Y noise rises to 9.7" },
    { hz: 493, label: "known noisy", evidence: "measured-unstable", note: "measured 507.6 Hz, highest noise of the sweep" },
    {
      hz: MEASURED_CEILING_HZ,
      label: "measured ceiling",
      evidence: "measured-aggressive",
      note: "530.0 Hz at settle sum 6 us, noise equal to the 444 Hz build; below this the firmware stops booting",
    },
  ],
};

const release: FirmwareRelease = {
  label: "tablet.ears.cat 530",
  settleUs: [1, 0, 1, 4],
  measuredHz: 530.0,
  sigmaX: 3.63,
  sigmaY: 3.63,
  duplicatePct: 0.7,
  stationaryJumps: 0,
  untested: ["pressure range", "barrel buttons", "proximity/reacquisition", "fast motion", "long-run stability"],
};

export const s620: DeviceAdapter = {
  id: "gaomon-s620",
  displayName: "Gaomon S620",
  normal: { vendorId: 0x256c, productId: 0x006f, usagePage: 0xff00 },
  firmware: {
    buildId: "OEM02_T18e_241030",
    versionStringIndex: 0xc9,
    calibrationStringIndex: 0xc8,
    stockAppSha256: "e4fe509d60c40468f7babe52341de59061266d6956e6f87c619112bd075550dd",
    modelId: 0x0620,
    stockFirmwareId: 0x00241030,
  },
  flash: {
    flashBase: FLASH_BASE,
    flashEnd: FLASH_END,
    pageSize: PAGE_SIZE,
    appBase: APP_BASE,
    appLength: APP_LENGTH,
    extensionBase: EXTENSION_BASE,
    persistenceBase: PERSISTENCE_BASE,
    protected: [
      {
        start: FLASH_BASE,
        end: APP_BASE,
        label: "resident bootloader",
        reason: "the DFU bootloader is the only recovery path and is never modified",
      },
      {
        start: 0x0800fc00,
        end: FLASH_END,
        label: "per-device calibration/config",
        reason: "factory per-device calibration data that cannot be regenerated",
      },
    ],
  },
  protocol: {
    reportId: REPORT_ID,
    frameSize: FRAME_SIZE,
    usagePage: 0xff00,
    penReportId: 0x08,
  },
  dfu: {
    kind: "dfuse",
    identity: { vendorId: 0x28e9, productId: 0x0189 },
    interfaceNumber: 0,
    defaultTransferSize: 0x400,
    windowsDeviceName: "GD32 Device in DFU Mode",
  },
  rate,
  release,
  patches: new S620PatchBuilder(LIVE_RUNTIME_LAYER),
};

export { TIMING_ANCHORS };
