/**
 * CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320).
 *
 * This is the exact algorithm the injected firmware extension implements, so
 * host and device agree on config integrity. Keep the two in lockstep: the
 * firmware side is a bitwise implementation of the same polynomial, init and
 * final XOR.
 */

const POLY = 0xedb88320;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? POLY ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  if (start < 0 || end > data.length || start > end) {
    throw new RangeError(`crc32 range ${start}..${end} escapes the ${data.length}-byte buffer`);
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
