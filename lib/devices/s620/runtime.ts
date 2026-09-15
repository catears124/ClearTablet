import manifest from "./runtime.json";
import type { PatchSite } from "../types";
import type { RuntimeLayer } from "./patches";

function bytesFromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error("runtime manifest contains malformed hex");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

type RuntimeManifest = {
  base: number;
  blob: string;
  hooks: Record<string, string>;
  hookPreimages: Record<string, string>;
};

const runtimeManifest = manifest as unknown as RuntimeManifest;
const manifestHooks = runtimeManifest.hooks;
const manifestPreimages = runtimeManifest.hookPreimages;

const hooks: readonly PatchSite[] = Object.entries(manifestHooks).map(([addressText, after]) => {
  const before = manifestPreimages[addressText];
  if (!before) throw new Error(`runtime manifest is missing the preimage for ${addressText}`);
  return {
    address: Number(addressText),
    before: bytesFromHex(before),
    after: bytesFromHex(after),
    purpose: `live runtime hook at ${addressText}`,
  };
});

export const LIVE_RUNTIME_LAYER: RuntimeLayer = {
  kind: "runtime",
  base: manifest.base,
  blob: bytesFromHex(manifest.blob),
  hooks,
};
