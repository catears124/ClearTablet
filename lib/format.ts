/** Canonical 32-bit flash address rendering, shared by every UI that shows one. */
export function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

export function hexBytes(data: Uint8Array): string {
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
