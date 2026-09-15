"use client";

import { useEffect, useState } from "react";
import { webHidSupported } from "./transport/webhid";
import { webUsbSupported } from "./transport/webusb-dfu";

export type DeviceApiSupport = {
  hid: boolean;
  usb: boolean;
  /** False until detection has run on the client. */
  ready: boolean;
};

/**
 * Detect WebHID/WebUSB availability on the client only.
 *
 * Calling the detectors during render would report "unsupported" while
 * server-rendering and "supported" after hydration, which is a real hydration
 * mismatch. Components therefore render their normal content until `ready` is
 * true and only then fall back to the unsupported-browser message.
 */
export function useDeviceApis(): DeviceApiSupport {
  const [support, setSupport] = useState<DeviceApiSupport>({ hid: false, usb: false, ready: false });

  useEffect(() => {
    setSupport({ hid: webHidSupported(), usb: webUsbSupported(), ready: true });
  }, []);

  return support;
}
