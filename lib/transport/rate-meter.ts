/**
 * Host-observed HID report-rate meter.
 *
 * This is the only source of the "Actual" rate the UI shows. It counts real
 * `inputreport` events; it never derives a rate from the requested target, and
 * it never infers reports that did not arrive.
 *
 * `duplicateRatio` is a genuine byte comparison against the previous report,
 * which is what makes it able to catch a firmware that hits a rate by emitting
 * repeated identical packets instead of performing real acquisitions.
 */

export type RateSnapshot = {
  /** Null until at least two reports are inside the window. */
  hz: number | null;
  sampleCount: number;
  /** Null when no report payloads were supplied. */
  duplicateRatio: number | null;
  windowMs: number;
};

type Sample = {
  timestampMs: number;
  /** True when this report's bytes were identical to its predecessor. */
  duplicate: boolean;
  /** Whether a payload was supplied, so duplicate stats stay honest. */
  compared: boolean;
};

export class RateMeter {
  private readonly windowMs: number;
  private samples: Sample[] = [];
  private previous: Uint8Array | null = null;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  push(timestampMs: number, data?: Uint8Array): void {
    let duplicate = false;
    let compared = false;
    if (data) {
      compared = true;
      const previous = this.previous;
      if (previous && previous.length === data.length) {
        duplicate = true;
        for (let i = 0; i < data.length; i += 1) {
          if (previous[i] !== data[i]) {
            duplicate = false;
            break;
          }
        }
      }
      this.previous = data;
    }
    this.samples.push({ timestampMs, duplicate, compared });
  }

  snapshot(nowMs: number): RateSnapshot {
    const cutoff = nowMs - this.windowMs;
    let firstLive = 0;
    while (firstLive < this.samples.length && this.samples[firstLive].timestampMs < cutoff) {
      firstLive += 1;
    }
    if (firstLive > 0) {
      this.samples = this.samples.slice(firstLive);
    }

    const count = this.samples.length;
    let hz: number | null = null;
    if (count >= 2) {
      const span = this.samples[count - 1].timestampMs - this.samples[0].timestampMs;
      // Intervals, not samples: dividing the count by the nominal window would
      // under-report while the window is still filling.
      hz = span > 0 ? ((count - 1) * 1000) / span : null;
    }

    let compared = 0;
    let duplicates = 0;
    for (const sample of this.samples) {
      if (!sample.compared) continue;
      compared += 1;
      if (sample.duplicate) duplicates += 1;
    }

    return {
      hz,
      sampleCount: count,
      duplicateRatio: compared > 0 ? duplicates / compared : null,
      windowMs: this.windowMs,
    };
  }

  reset(): void {
    this.samples = [];
    this.previous = null;
  }
}
