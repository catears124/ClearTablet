/**
 * tablet.ears.cat live configuration protocol contract
 *
 * Report 0x16 is a 32-byte vendor feature report. Pen input report 0x08 stays
 * unchanged. The device-side telemetry field at bytes 2..3 is an echo of the
 * active target in tenths of a hertz; it is not a physical rate measurement.
 * The UI's actual report rate comes only from host-observed input reports.
 */

import { crc32 } from "./crc32";

export const REPORT_ID = 0x16;
export const FRAME_SIZE = 32;
export const HEADER_SIZE = 4;
export const CRC_OFFSET = 28;
export const PAYLOAD_SIZE = CRC_OFFSET - HEADER_SIZE;
export const PROTOCOL_VERSION = 1;

export enum Command {
  GetInfo = 0x01,
  GetConfig = 0x02,
  SetConfig = 0x03,
  SaveConfig = 0x04,
  FactoryDefaults = 0x05,
  GetTelemetry = 0x06,
}

export enum Status {
  Ok = 0,
  BadCrc = 1,
  BadLength = 2,
  BadCommand = 3,
  BadValue = 4,
  Busy = 5,
  InternalError = 6,
}

export const STATUS_TEXT: Readonly<Record<number, string>> = {
  [Status.Ok]: "ok",
  [Status.BadCrc]: "bad crc",
  [Status.BadLength]: "bad length",
  [Status.BadCommand]: "bad command",
  [Status.BadValue]: "bad value",
  [Status.Busy]: "busy",
  [Status.InternalError]: "internal error",
};

export enum Capability {
  LiveConfig = 1 << 0,
  Persistence = 1 << 1,
  AdaptiveScan = 1 << 2,
  LoopTiming = 1 << 3,
}

export enum TrackingMode {
  FullScan = 0,
  Adaptive = 1,
}

export enum TelemetryFlag {
  Unsaved = 1 << 0,
  SafeBoot = 1 << 1,
  WatchdogTripped = 1 << 2,
}

export type DeviceInfo = {
  protocolVersion: number;
  firmwareVersion: string;
  modelId: number;
  stockFirmwareId: number;
  capabilities: string[];
  minHz: number;
  maxHz: number;
  configSize: number;
  persistence: number;
};

export type Telemetry = {
  requestedHz: number;
  deviceTargetHz: number;
  reportCounter: number;
  fullScanCounter: number;
  trackingLossCounter: number;
  settleProfileUs: [number, number, number, number];
  trackingMode: TrackingMode;
  unsaved: boolean;
  safeBoot: boolean;
  watchdogTripped: boolean;
  loopTimeUs: number;
};

export class ProtocolError extends Error {
  readonly status?: Status;

  constructor(message: string, status?: Status) {
    super(message);
    this.name = "ProtocolError";
    this.status = status;
  }
}

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new ProtocolError(`${label} must be a byte, got ${value}`);
  }
}

export function encodeFrame(
  command: Command,
  sequence: number,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): Uint8Array {
  if (!Object.values(Command).includes(command)) {
    throw new ProtocolError(`unknown command 0x${command.toString(16)}`);
  }
  assertByte(sequence, "sequence");
  if (payload.length > PAYLOAD_SIZE) {
    throw new ProtocolError(`payload is ${payload.length} bytes, maximum is ${PAYLOAD_SIZE}`, Status.BadLength);
  }

  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = command;
  frame[1] = sequence;
  frame[2] = payload.length;
  frame[3] = Status.Ok;
  frame.set(payload, HEADER_SIZE);
  new DataView(frame.buffer).setUint32(CRC_OFFSET, crc32(frame, 0, CRC_OFFSET), true);
  return frame;
}

export type DecodedFrame = {
  command: Command;
  sequence: number;
  status: Status;
  payload: Uint8Array;
};

export function decodeFrame(frame: Uint8Array): DecodedFrame {
  if (frame.length !== FRAME_SIZE) {
    throw new ProtocolError(`frame is ${frame.length} bytes, expected ${FRAME_SIZE}`, Status.BadLength);
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const expected = crc32(frame, 0, CRC_OFFSET);
  const actual = view.getUint32(CRC_OFFSET, true);
  if (actual !== expected) {
    throw new ProtocolError(
      `frame crc ${actual.toString(16)} does not match computed ${expected.toString(16)}`,
      Status.BadCrc,
    );
  }
  const payloadLength = frame[2];
  if (payloadLength > PAYLOAD_SIZE) {
    throw new ProtocolError(`payload length ${payloadLength} exceeds ${PAYLOAD_SIZE}`, Status.BadLength);
  }
  if (!Object.values(Command).includes(frame[0])) {
    throw new ProtocolError(`unknown command 0x${frame[0].toString(16)}`, Status.BadCommand);
  }
  return {
    command: frame[0] as Command,
    sequence: frame[1],
    status: frame[3] as Status,
    payload: frame.slice(HEADER_SIZE, HEADER_SIZE + payloadLength),
  };
}

export function capabilityNames(flags: number): string[] {
  return [
    [Capability.LiveConfig, "LiveConfig"],
    [Capability.Persistence, "Persistence"],
    [Capability.AdaptiveScan, "AdaptiveScan"],
    [Capability.LoopTiming, "LoopTiming"],
  ]
    .filter(([flag]) => (flags & Number(flag)) !== 0)
    .map(([, name]) => String(name));
}

export function decodeInfo(payload: Uint8Array): DeviceInfo {
  if (payload.length < 21) {
    throw new ProtocolError(`GET_INFO payload is ${payload.length} bytes, expected at least 21`, Status.BadLength);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint16(2, true);
  return {
    protocolVersion: view.getUint16(0, true),
    firmwareVersion: `${version >>> 8}.${version & 0xff}`,
    modelId: view.getUint16(4, true),
    stockFirmwareId: view.getUint32(6, true),
    capabilities: capabilityNames(view.getUint32(10, true)),
    minHz: view.getUint16(14, true),
    maxHz: view.getUint16(16, true),
    configSize: view.getUint16(18, true),
    persistence: payload[20],
  };
}

export function decodeTelemetry(payload: Uint8Array): Telemetry {
  if (payload.length < 24) {
    throw new ProtocolError(`GET_TELEMETRY payload is ${payload.length} bytes, expected at least 24`, Status.BadLength);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = payload[21];
  return {
    requestedHz: view.getUint16(0, true),
    deviceTargetHz: view.getUint16(2, true) / 10,
    reportCounter: view.getUint32(4, true),
    fullScanCounter: view.getUint32(8, true),
    trackingLossCounter: view.getUint32(12, true),
    settleProfileUs: [payload[16], payload[17], payload[18], payload[19]],
    trackingMode: payload[20] as TrackingMode,
    unsaved: (flags & TelemetryFlag.Unsaved) !== 0,
    safeBoot: (flags & TelemetryFlag.SafeBoot) !== 0,
    watchdogTripped: (flags & TelemetryFlag.WatchdogTripped) !== 0,
    loopTimeUs: view.getUint16(22, true),
  };
}
