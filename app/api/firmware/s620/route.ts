import { VENDOR_FIRMWARE } from "@/lib/devices/s620/codec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const firmware = VENDOR_FIRMWARE[0];
  try {
    const upstream = await fetch(firmware.url, {
      cache: "no-store",
      redirect: "follow",
      headers: { "User-Agent": "tablet.ears.cat/0.2" },
    });
    if (!upstream.ok) {
      return new Response(`vendor firmware server returned HTTP ${upstream.status}`, { status: 502 });
    }
    if (!upstream.body) {
      return new Response("vendor firmware server returned an empty body", { status: 502 });
    }

    const upstreamLength = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(upstreamLength) && upstreamLength > 0 && upstreamLength !== firmware.bytes) {
      return new Response(
        `vendor firmware length ${upstreamLength} did not match expected ${firmware.bytes}`,
        { status: 502 },
      );
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(firmware.bytes),
        "Cache-Control": "no-store",
        "X-Tablet-Ears-Cat-Expected-SHA256": firmware.vendorSha256,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`could not fetch vendor firmware: ${message}`, { status: 502 });
  }
}
