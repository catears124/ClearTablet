/**
 * S620 acquisition timing model.
 *
 * Goal: map a requested report rate onto real acquisition parameters without
 * pretending the relationship is a linear interpolation of four immediates.
 *
 * The stock firmware spends its per-report time in two distinguishable places:
 *
 *   - four analog settle waits, patchable as `MOVS R0,#imm8` microsecond
 *     immediates at the four SETTLE_SITES addresses;
 *   - a fixed remainder (ADC median-of-3 reads, the 13 excitation pulse
 *     routines, coordinate math, packing, USB submission).
 *
 * Fitting `period = fixed + k * settle_sum` by least squares against the five
 * measured anchors below yields fixed = 1869.8 us and k = 6.579, and reproduces
 * every anchor within 2 Hz. k > 1 because the settle set is executed several
 * times per report (per channel/slot), which is why shaving a few microseconds
 * off each immediate moves the rate as much as it does.
 *
 * Two consequences drive the whole design:
 *
 *   1. driving all four immediates to zero yields 1000/1.8698 = 534.8 Hz, so
 *      the requested 600 Hz endpoint is NOT reachable by settle reduction at
 *      all. It requires removing ~203 us from the fixed path.
 *   2. because the fixed path is what gates the top of the range, the firmware
 *      measures its own loop time and the host maps requested Hz through the
 *      *measured* fixed work when telemetry is available, instead of trusting
 *      this calibration on every unit.
 *
 * Nothing here claims a rate. `modelHz` is an estimate; the displayed "actual"
 * rate always comes from host-observed HID report timestamps and device
 * telemetry.
 */

export type AnchorEvidence = "measured-stable" | "measured-aggressive" | "measured-unstable" | "unmeasured";

export type TimingAnchor = {
  hz: number;
  settleSumUs: number;
  evidence: AnchorEvidence;
  note: string;
};

/** Addresses of the four settle-delay immediates inside the application. */
export const SETTLE_SITES = [0x08004d3c, 0x08004d4a, 0x08004d58, 0x08004d9a] as const;

/** Stock microsecond values at SETTLE_SITES. */
export const STOCK_SETTLE_US = [27, 20, 30, 150] as const;

export const STOCK_SETTLE_SUM_US = STOCK_SETTLE_US.reduce((sum, value) => sum + value, 0);

/**
 * Least-squares fit over the measured sweep below (9 points, one device, one
 * propped-pen protocol). Residuals are within +/-2.5 Hz except the 493 Hz
 * capture, whose propping was visibly disturbed.
 */
export const CALIBRATED_FIXED_WORK_US = 1838.5;
export const SETTLE_MULTIPLIER = 6.978;

/**
 * Highest rate actually observed running, at settle sum 6 us.
 *
 * This is a measurement, not a model value: the fit extrapolates 543.9 Hz at
 * zero settle, but that build does not exist as far as the hardware is
 * concerned - see MIN_SAFE_SETTLE_SUM_US.
 */
export const MEASURED_CEILING_HZ = 530;

/**
 * Smallest settle budget observed to produce a *booting* firmware.
 *
 * A zero-settle image (settle [0,0,0,0]) flashes and reads back byte-identical
 * but the tablet then does not enumerate on USB at all - not degraded tracking,
 * no device. So the failure is not a noise cliff, it is the firmware failing to
 * reach USB init, and no requested rate may ever be mapped below this floor.
 */
export const MIN_SAFE_SETTLE_SUM_US = 6;

/**
 * Measured sweep on the reference S620, propped pen in contact, untouched.
 * These are the only rates that may be described as measured.
 */
export const TIMING_ANCHORS: readonly TimingAnchor[] = [
  { hz: 292.6, settleSumUs: 227, evidence: "measured-stable", note: "stock cadence" },
  { hz: 398.4, settleSumUs: 95, evidence: "measured-stable", note: "intermediate timing" },
  { hz: 443.3, settleSumUs: 58, evidence: "measured-stable", note: "validated stable release (v1.1)" },
  { hz: 463.1, settleSumUs: 46, evidence: "measured-stable", note: "intermediate timing" },
  { hz: 471.6, settleSumUs: 39, evidence: "measured-aggressive", note: "validated aggressive release (v1.2)" },
  { hz: 486.1, settleSumUs: 32, evidence: "measured-aggressive", note: "intermediate timing" },
  { hz: 507.6, settleSumUs: 24, evidence: "measured-unstable", note: "highest measured noise, sigma 10.3/10.9" },
  { hz: 503.4, settleSumUs: 20, evidence: "measured-stable", note: "sigma 2.4/4.2" },
  { hz: 530.0, settleSumUs: 6, evidence: "measured-aggressive", note: "measured ceiling; sigma 3.6/3.6, matches 444 Hz noise" },
];

/**
 * Fixed-work reductions the injected extension can apply to reach past the
 * 534.8 Hz settle-only ceiling. `measuredSavingUs` stays null until it has been
 * measured on hardware; the host never uses these numbers to claim a rate,
 * because the achieved rate is read back from the device and the host.
 */
export type FixedWorkOptimization = {
  id: string;
  summary: string;
  measuredSavingUs: number | null;
};

export const FIXED_WORK_OPTIMIZATIONS: readonly FixedWorkOptimization[] = [
  {
    id: "deferred-report-submit",
    summary: "submit the previous report while the next acquisition is already running",
    measuredSavingUs: null,
  },
  {
    id: "adaptive-slot-scan",
    summary: "confidence-gated candidate-slot skipping with immediate full five-slot fallback",
    measuredSavingUs: null,
  },
  {
    id: "redundant-acquisition-elision",
    summary: "drop provably redundant re-acquisitions inside one report interval",
    measuredSavingUs: null,
  },
  {
    id: "conditional-long-settle",
    summary: "run the long 150 us settle path only on reacquisition, not every report",
    measuredSavingUs: null,
  },
];

export function modelPeriodUs(settleSumUs: number, fixedWorkUs = CALIBRATED_FIXED_WORK_US): number {
  return fixedWorkUs + SETTLE_MULTIPLIER * settleSumUs;
}

export function modelHz(settleSumUs: number, fixedWorkUs = CALIBRATED_FIXED_WORK_US): number {
  return 1e6 / modelPeriodUs(settleSumUs, fixedWorkUs);
}

/**
 * Recover the device's own fixed-work figure from telemetry.
 *
 * Telemetry reports the complete loop time and the settle profile actually in
 * force, so the fixed remainder is the loop minus the settle contribution.
 * Feeding this back into `planForHz` is what makes the mapping closed-loop: a
 * unit whose fixed path is faster than the reference unit gets a correspondingly
 * larger settle budget for the same requested rate, instead of inheriting the
 * reference calibration.
 *
 * Returns null when telemetry is implausible (a loop shorter than its own
 * settle contribution), so a bad reading falls back to the calibration rather
 * than producing a negative budget.
 */
export function measuredFixedWorkUs(
  loopTimeUs: number,
  settleProfileUs: readonly number[],
): number | null {
  if (!Number.isFinite(loopTimeUs) || loopTimeUs <= 0) return null;
  const settleSum = settleProfileUs.reduce((sum, value) => sum + value, 0);
  const fixed = loopTimeUs - SETTLE_MULTIPLIER * settleSum;
  return fixed > 0 ? fixed : null;
}

export type SettlePlan = {
  requestedHz: number;
  /** Per-site imm8 values in SETTLE_SITES order. */
  settleUs: [number, number, number, number];
  settleSumUs: number;
  /** Rate the model expects from this settle profile and fixed-work figure. */
  modelHz: number;
  /** True when the request needs fixed-work reduction, not settle reduction. */
  needsFixedWorkReduction: boolean;
  /** Microseconds of fixed work that still have to be removed, 0 when none. */
  fixedWorkDeficitUs: number;
};

/**
 * Distribute a settle budget across the four sites in the stock 27:20:30:150
 * ratio. Proportional scaling is not an arbitrary choice: it reproduces the
 * hardware-validated v1.1 profile (7/5/8/38) exactly from a 58 us budget, which
 * is how the shipped releases were generated.
 */
export function distributeSettle(settleSumUs: number): [number, number, number, number] {
  const scale = Math.max(0, settleSumUs) / STOCK_SETTLE_SUM_US;
  return STOCK_SETTLE_US.map((stock) => Math.min(0xff, Math.round(stock * scale))) as unknown as [
    number,
    number,
    number,
    number,
  ];
}

/**
 * Map a requested rate onto a settle profile.
 *
 * `fixedWorkUs` should be the device's own measured fixed work when telemetry
 * has supplied it, so that a unit whose fixed path is faster or slower than the
 * reference unit still lands near its request.
 */
export function planForHz(requestedHz: number, fixedWorkUs = CALIBRATED_FIXED_WORK_US): SettlePlan {
  const targetPeriodUs = 1e6 / requestedHz;
  const rawSettleSum = (targetPeriodUs - fixedWorkUs) / SETTLE_MULTIPLIER;
  // Clamp to the floor that still boots. A request beyond the measured ceiling
  // does not get a faster image, it gets the fastest *working* one, and the
  // deficit below reports honestly how far short that leaves the request.
  const settleSumUs = Math.min(STOCK_SETTLE_SUM_US, Math.max(MIN_SAFE_SETTLE_SUM_US, rawSettleSum));
  const settleUs = distributeSettle(settleSumUs);
  const achievedSum = Math.max(MIN_SAFE_SETTLE_SUM_US, settleUs.reduce((sum, value) => sum + value, 0));
  const shortfallUs = modelPeriodUs(achievedSum, fixedWorkUs) - targetPeriodUs;
  const fixedWorkDeficitUs = shortfallUs > 0 ? Math.round(shortfallUs * 10) / 10 : 0;
  return {
    requestedHz,
    settleUs,
    settleSumUs: achievedSum,
    modelHz: modelHz(achievedSum, fixedWorkUs),
    // Only the boot floor counts as a physical limit; an integer-rounding
    // shortfall of a few microseconds does not.
    needsFixedWorkReduction: rawSettleSum < MIN_SAFE_SETTLE_SUM_US,
    fixedWorkDeficitUs,
  };
}

/**
 * Rate reachable at the lowest settle budget that still boots.
 *
 * Deliberately not the zero-settle extrapolation: a zero-settle image does not
 * enumerate on USB, so that figure describes a firmware that cannot run.
 */
export function settleOnlyCeilingHz(fixedWorkUs = CALIBRATED_FIXED_WORK_US): number {
  return modelHz(MIN_SAFE_SETTLE_SUM_US, fixedWorkUs);
}
