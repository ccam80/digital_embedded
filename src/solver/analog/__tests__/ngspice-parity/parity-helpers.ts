import { accessSync } from "node:fs";
import type { CaptureSession, IterationSnapshot } from "../harness/types.js";
import { DEVICE_MAPPINGS } from "../harness/device-mappings.js";
import { describe, expect } from "vitest";

export const DLL_PATH = "C:/local_working_projects/digital_in_browser/third_party/ngspice/bin/ngspice.dll";

let _dllAvailable: boolean | null = null;
export function dllAvailable(): boolean {
  if (_dllAvailable !== null) return _dllAvailable;
  try { accessSync(DLL_PATH); _dllAvailable = true; }
  catch { _dllAvailable = false; }
  return _dllAvailable;
}

export const describeIfDll = dllAvailable() ? describe : describe.skip;

/**
 * Assert that two IterationSnapshots match bit-exact across rhsOld[], state0[],
 * noncon, diagGmin, srcFact, initMode, order, delta, lteDt.
 * Throws via vitest `expect()` on any mismatch. Error message includes
 * step/iter context, field name, ours, ngspice, absDelta.
 */
export function assertIterationMatch(
  ours: IterationSnapshot,
  ngspice: IterationSnapshot,
  ctx: { stepIndex: number; iterIndex: number },
): void {
  const { stepIndex, iterIndex } = ctx;
  const ctxLabel = `step=${stepIndex} iter=${iterIndex}`;

  // Compare rhsOld[] (prevVoltages) — exact IEEE-754
  const ourRhsOld = ours.prevVoltages;
  const ngRhsOld = ngspice.prevVoltages;
  const rhsLen = Math.min(ourRhsOld.length, ngRhsOld.length);
  for (let i = 0; i < rhsLen; i++) {
    const o = ourRhsOld[i];
    const n = ngRhsOld[i];
    const absDelta = Math.abs(o - n);
    expect(absDelta, `${ctxLabel} rhsOld[${i}]: ours=${o} ngspice=${n} absDelta=${absDelta}`).toBe(0);
  }

  // Compare state0[] device-state slots resolved via DEVICE_MAPPINGS
  // Build a lookup of ngspice element states by label for cross-comparison
  const ngspiceStateByLabel = new Map<string, Record<string, number>>();
  for (const es of ngspice.elementStates) {
    ngspiceStateByLabel.set(es.label, es.slots);
  }

  for (const ourEs of ours.elementStates) {
    const deviceType = _inferDeviceType(ourEs.label);
    const mapping = deviceType ? DEVICE_MAPPINGS[deviceType] : undefined;
    if (!mapping) continue;

    const ngEs = ngspiceStateByLabel.get(ourEs.label);
    if (!ngEs) continue;

    // Compare only slots that have a non-null ngspice mapping
    for (const [slotName, ngspiceOffset] of Object.entries(mapping.slotToNgspice)) {
      if (ngspiceOffset === null) continue;
      const ourVal = ourEs.slots[slotName];
      const ngVal = ngEs[slotName];
      if (ourVal === undefined || ngVal === undefined) continue;

      const absDelta = Math.abs(ourVal - ngVal);
      expect(
        absDelta,
        `${ctxLabel} state0[${ourEs.label}][${slotName}]: ours=${ourVal} ngspice=${ngVal} absDelta=${absDelta}`,
      ).toBe(0);
    }

  }

  // Compare noncon
  const nonconDelta = Math.abs(ours.noncon - ngspice.noncon);
  expect(
    nonconDelta,
    `${ctxLabel} noncon: ours=${ours.noncon} ngspice=${ngspice.noncon} absDelta=${nonconDelta}`,
  ).toBe(0);

  // Compare diagGmin (required field — absence of population surfaces here)
  {
    const absDelta = Math.abs(ours.diagGmin - ngspice.diagGmin);
    expect(
      absDelta,
      `${ctxLabel} diagGmin: ours=${ours.diagGmin} ngspice=${ngspice.diagGmin} absDelta=${absDelta}`,
    ).toBe(0);
  }

  // Compare srcFact (required field — absence of population surfaces here)
  {
    const absDelta = Math.abs(ours.srcFact - ngspice.srcFact);
    expect(
      absDelta,
      `${ctxLabel} srcFact: ours=${ours.srcFact} ngspice=${ngspice.srcFact} absDelta=${absDelta}`,
    ).toBe(0);
  }

  // Compare initMode (required field — absence of population surfaces here)
  expect(
    ours.initMode,
    `${ctxLabel} initMode: ours=${ours.initMode} ngspice=${ngspice.initMode}`,
  ).toBe(ngspice.initMode);

  // Compare order (required field — absence of population surfaces here)
  {
    const absDelta = Math.abs(ours.order - ngspice.order);
    expect(
      absDelta,
      `${ctxLabel} order: ours=${ours.order} ngspice=${ngspice.order} absDelta=${absDelta}`,
    ).toBe(0);
  }

  // Compare delta (required field — absence of population surfaces here)
  {
    const absDelta = Math.abs(ours.delta - ngspice.delta);
    expect(
      absDelta,
      `${ctxLabel} delta: ours=${ours.delta} ngspice=${ngspice.delta} absDelta=${absDelta}`,
    ).toBe(0);
  }

  // Compare lteDt if present on both sides (added by task 7.1.2)
  const ourLteDt = ours.lteDt;
  const ngLteDt = ngspice.lteDt;
  if (ourLteDt !== undefined && ngLteDt !== undefined) {
    const absDelta = Math.abs(ourLteDt - ngLteDt);
    expect(
      absDelta,
      `${ctxLabel} lteDt: ours=${ourLteDt} ngspice=${ngLteDt} absDelta=${absDelta}`,
    ).toBe(0);
  }
}

/** Compare the ordered sequence of initMode values across all steps/iterations. */
export function assertModeTransitionMatch(
  ours: CaptureSession,
  ngspice: CaptureSession,
): void {
  const ourModes = _extractModeSequence(ours);
  const ngModes = _extractModeSequence(ngspice);

  expect(
    ourModes.length,
    `Mode transition sequence length mismatch: ours=${ourModes.length} ngspice=${ngModes.length}`,
  ).toBe(ngModes.length);

  for (let i = 0; i < ourModes.length; i++) {
    const o = ourModes[i]!;
    const n = ngModes[i]!;
    expect(
      o.initMode,
      `Mode transition [${i}] (step=${o.stepIndex} iter=${o.iterIndex}): ours=${o.initMode} ngspice=${n.initMode}`,
    ).toBe(n.initMode);
  }
}

/**
 * Compare convergence scalars (noncon, diagGmin, srcFact) at every NR iteration
 * across both sessions. Fields inactive in a circuit are still asserted equal
 * (both engines produce the same zero/unused value).
 */
export function assertConvergenceFlowMatch(
  ours: CaptureSession,
  ngspice: CaptureSession,
): void {
  // Compare noncon at every NR iteration
  const ourIters = _flattenIterations(ours);
  const ngIters = _flattenIterations(ngspice);

  expect(
    ourIters.length,
    `Total NR iteration count mismatch: ours=${ourIters.length} ngspice=${ngIters.length}`,
  ).toBe(ngIters.length);

  for (let i = 0; i < ourIters.length; i++) {
    const o = ourIters[i]!;
    const n = ngIters[i]!;
    const nonconDelta = Math.abs(o.snap.noncon - n.snap.noncon);
    expect(
      nonconDelta,
      `noncon at flat-iter=${i} (step=${o.stepIndex} iter=${o.iterIndex}): ours=${o.snap.noncon} ngspice=${n.snap.noncon} absDelta=${nonconDelta}`,
    ).toBe(0);
  }

  // Compare diagGmin at every gmin-stepping sub-solve
  const ourGminSteps = _flattenGminSteps(ours);
  const ngGminSteps = _flattenGminSteps(ngspice);

  expect(
    ourGminSteps.length,
    `Gmin step count mismatch: ours=${ourGminSteps.length} ngspice=${ngGminSteps.length}`,
  ).toBe(ngGminSteps.length);

  for (let i = 0; i < ourGminSteps.length; i++) {
    const o = ourGminSteps[i]!;
    const n = ngGminSteps[i]!;
    const absDelta = Math.abs(o.diagGmin - n.diagGmin);
    expect(
      absDelta,
      `diagGmin at gmin-step=${i}: ours=${o.diagGmin} ngspice=${n.diagGmin} absDelta=${absDelta}`,
    ).toBe(0);
  }

  // Compare srcFact at every source-stepping step
  const ourSrcSteps = _flattenSrcFactSteps(ours);
  const ngSrcSteps = _flattenSrcFactSteps(ngspice);

  expect(
    ourSrcSteps.length,
    `Source-step count mismatch: ours=${ourSrcSteps.length} ngspice=${ngSrcSteps.length}`,
  ).toBe(ngSrcSteps.length);

  for (let i = 0; i < ourSrcSteps.length; i++) {
    const o = ourSrcSteps[i]!;
    const n = ngSrcSteps[i]!;
    const absDelta = Math.abs(o.srcFact - n.srcFact);
    expect(
      absDelta,
      `srcFact at src-step=${i}: ours=${o.srcFact} ngspice=${n.srcFact} absDelta=${absDelta}`,
    ).toBe(0);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _inferDeviceType(label: string): string | null {
  const upper = label.toUpperCase();
  if (upper.startsWith("Q")) return "bjt";
  if (upper.startsWith("D")) return "diode";
  if (upper.startsWith("M")) return "mosfet";
  if (upper.startsWith("J")) return "jfet";
  if (upper.startsWith("C")) return "capacitor";
  if (upper.startsWith("L")) return "inductor";
  return null;
}

interface ModeEntry {
  stepIndex: number;
  iterIndex: number;
  // W2.3: `initMode` is a human-readable cktMode label from
  // `bitsToName(cktMode)` (cktdefs.h:165-185), e.g. "MODEDCOP|MODEINITJCT".
  initMode: string;
}

function _extractModeSequence(session: CaptureSession): ModeEntry[] {
  const entries: ModeEntry[] = [];
  for (let si = 0; si < session.steps.length; si++) {
    const step = session.steps[si]!;
    for (let ai = 0; ai < step.attempts.length; ai++) {
      const attempt = step.attempts[ai]!;
      for (let ii = 0; ii < attempt.iterations.length; ii++) {
        const snap = attempt.iterations[ii]!;
        entries.push({ stepIndex: si, iterIndex: ii, initMode: snap.initMode });
      }
    }
  }
  return entries;
}

interface IterEntry {
  stepIndex: number;
  iterIndex: number;
  snap: IterationSnapshot;
}

function _flattenIterations(session: CaptureSession): IterEntry[] {
  const entries: IterEntry[] = [];
  for (let si = 0; si < session.steps.length; si++) {
    const step = session.steps[si]!;
    for (const attempt of step.attempts) {
      for (let ii = 0; ii < attempt.iterations.length; ii++) {
        entries.push({ stepIndex: si, iterIndex: ii, snap: attempt.iterations[ii]! });
      }
    }
  }
  return entries;
}

interface GminEntry {
  stepIndex: number;
  attemptIndex: number;
  diagGmin: number;
}

function _flattenGminSteps(session: CaptureSession): GminEntry[] {
  const entries: GminEntry[] = [];
  for (let si = 0; si < session.steps.length; si++) {
    const step = session.steps[si]!;
    for (let ai = 0; ai < step.attempts.length; ai++) {
      const attempt = step.attempts[ai]!;
      const isGmin =
        attempt.phase === "dcopGminDynamic" || attempt.phase === "dcopGminSpice3";
      if (isGmin) {
        const diagGmin =
          attempt.phaseParameter !== undefined
            ? attempt.phaseParameter
            : attempt.iterations[0]?.diagGmin ?? 0;
        entries.push({ stepIndex: si, attemptIndex: ai, diagGmin });
      }
    }
  }
  return entries;
}

interface SrcFactEntry {
  stepIndex: number;
  attemptIndex: number;
  srcFact: number;
}

function _flattenSrcFactSteps(session: CaptureSession): SrcFactEntry[] {
  const entries: SrcFactEntry[] = [];
  for (let si = 0; si < session.steps.length; si++) {
    const step = session.steps[si]!;
    for (let ai = 0; ai < step.attempts.length; ai++) {
      const attempt = step.attempts[ai]!;
      if (attempt.phase === "dcopSrcSweep") {
        const srcFact =
          attempt.phaseParameter !== undefined
            ? attempt.phaseParameter
            : attempt.iterations[0]?.srcFact ?? 0;
        entries.push({ stepIndex: si, attemptIndex: ai, srcFact });
      }
    }
  }
  return entries;
}
