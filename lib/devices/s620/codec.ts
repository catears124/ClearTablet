/**
 * Vendor firmware codec for the S620 update files.
 *
 * Gaomon's updater ships the application as a byte-substituted image. Decoding
 * is a fixed 256-byte permutation recovered from the updater. No vendor binary
 * is stored in this repository.
 */

const ENCODE_HEX =
  "0008020509030604010778797a7b7c7d7e7f808112100c0d0e0f0b110a13f0f1f2f3" +
  "f4f5f6f7f8f917151b141c1d1a161819c4c0c1c2bebfc3c5c6c76465696a6c6d6b6667" +
  "681e1f2324252627202122d2d3d4d9dadbd5d6d7d89697989e9f999a9b9c9d2c2d2e2f" +
  "3028292a2b31dcdddee3e4e5dfe0e1e282838485868788898a8b3c3d3e3f4041424344" +
  "45cdcecfd0d1c8c9cacbccaaabacadaeafb0b1b2b3535455565758595051528c8d8e8f" +
  "9091929394955a5b5c5d5e5f60616263eee6e7ece8eaedefebe9707176727374776f6e" +
  "754b4748494c4d464e4f4ab7b8b4b5b6b9babbbcbd37383932333435363a3ba0a6a7a8" +
  "a9a1a2a3a4a5fefafcfbfdff";

const ENCODE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) table[i] = Number.parseInt(ENCODE_HEX.slice(i * 2, i * 2 + 2), 16);
  if (new Set(table).size !== 256) throw new Error("vendor codec table is not a permutation");
  return table;
})();

const DECODE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) table[ENCODE[i]] = i;
  return table;
})();

export function decodeVendorImage(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = DECODE[data[i]];
  return out;
}

export function encodeVendorImage(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = ENCODE[data[i]];
  return out;
}

export type VendorFirmware = {
  build: string;
  /** Vendor's canonical upstream URL. */
  url: string;
  /** Same-origin download endpoint used by the web app. */
  downloadPath: string;
  vendorSha256: string;
  decodedSha256: string;
  bytes: number;
};

/**
 * The upstream server is HTTP-only and does not expose CORS headers. The web
 * app therefore fetches through a tiny same-origin Next.js streaming route.
 * The browser verifies the pinned encoded SHA-256 and decoded application
 * SHA-256 before the image can be used for flashing.
 */
export const VENDOR_FIRMWARE: readonly VendorFirmware[] = [
  {
    build: "OEM02_T18e_241030",
    url: "http://firmware.gaomon.cn/api/upload/2024-12-11/6705fd777e461414a839a5ded9a25144.bin",
    downloadPath: "/api/firmware/s620",
    vendorSha256: "b030153f5ba1c1f5e44366ec53b33da97f77998a7ce5b7a79b99b626c48d1157",
    decodedSha256: "e4fe509d60c40468f7babe52341de59061266d6956e6f87c619112bd075550dd",
    bytes: 35512,
  },
];
