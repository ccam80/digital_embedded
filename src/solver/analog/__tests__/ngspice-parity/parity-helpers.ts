import { accessSync } from "node:fs";
import type { CaptureSession, IterationSnapshot } from "../harness/types.js";
import { DEVICE_MAPPINGS } from "../harness/device-mappings.js";
import { describe, expect } from "vitest";

export const DLL_PATH = "C:/local_working_projects/digital_in_browser/ref/ngspice/visualc-shared/x64/Release/bin/spice.dll";

let _dllAvailable: boolean | null = null;
export function dllAvailable(): boolean {
  if (_dllAvailable !== null) return _dllAvailable;
  try { accessSync(DLL_PATH); _dllAvailable = true; }
  catch { _dllAvailable = false; }
  return _dllAvailable;
}

export const describeIfDll = dllAvailable() ? describe : describe.skip;

/**
 * Assert that two IterationSnapshots match bit-exact across every observable
 * field the harness publishes. Fields covered (in order- failures surface
 * earliest divergence first):
 *
 *   • Per-iteration scalars: matrixSize, rhsBufSize
 *   • Vector data: prevVoltages (rhsOld), preSolveRhs, voltages, ag[0..1]
 *   • Device state: state0/state1/state2 slots (per-element via DEVICE_MAPPINGS)
 *   • Limit events: per-junction vBefore / vAfter / wasLimited
 *   • Convergence flags: noncon, globalConverged, elemConverged,
 *     convergenceFailedElements
 *   • Mode/order: initMode, method, order, delta
 *   • LTE proposal: diagGmin, srcFact, lteDt
 *   • Matrix: full per-iteration MatrixEntry list (row, col, value)
 *
 * Throws via vitest `expect()` on the FIRST mismatch found. Error messages
 * include step/iter context, field name, both values, and absolute delta.
 *
 * Design notes:
 *  - All numeric comparisons are bit-exact (`absDelta === 0`). Tolerances
 *    are not allowed- see CLAUDE.md "ngspice Parity Vocabulary" ssbanned.
 *  - `limitingEvents.limitType` is INTENTIONALLY NOT compared. ngspice
 *    labels every junction "pnjlim" via the bridge, while our engine
 *    distinguishes "fetlim" / "limvds" / "pnjlim" by call site. The
 *    substantive check is on the {vBefore, vAfter, wasLimited} triple
 *    keyed by junction name.
 *  - `ngspiceConvergenceFailedDevices` is asymmetric (ngspice-only) and
 *    not asserted directly; `convergenceFailedElements` is the symmetric
 *    list both sides populate.
 *  - `ag[2..6]` are zero on the ngspice side (the FFI bridge only
 *    marshals ag0/ag1). Only ag[0] and ag[1] are compared.
 */
export function assertIterationMatch(
  ours: IterationSnapshot,
  ngspice: IterationSnapshot,
  ctx: { stepIndex: number; iterIndex: number },
): void {
  const { stepIndex, iterIndex } = ctx;
  const ctxLabel = `step=${stepIndex} iter=${iterIndex}`;

  // ----- Per-iteration scalars (matrixSize / rhsBufSize) -------------------
  // During ngspice's DCOP-init phase the CKTmatrix is still being sized
  // incrementally (SMPmatSize=1 placeholder); skip the structural-size
  // comparison in that window. Outside it, both sides should report the
  // same N+2 / N+1 conventions.
  const ngspiceInPlaceholderMode = ngspice.rhsBufSize <= 1 && ours.rhsBufSize > 1;
  if (!ngspiceInPlaceholderMode) {
    expect(
      ours.matrixSize,
      `${ctxLabel} matrixSize: ours=${ours.matrixSize} ngspice=${ngspice.matrixSize}`,
    ).toBe(ngspice.matrixSize);
    expect(
      ours.rhsBufSize,
      `${ctxLabel} rhsBufSize: ours=${ours.rhsBufSize} ngspice=${ngspice.rhsBufSize}`,
    ).toBe(ngspice.rhsBufSize);
  }

  // ----- prevVoltages (rhsOld)- exact IEEE-754 ---------------------------
  // Slot 0 is the ground row- always 0 on both engines, safe to compare.
  _assertFloat64ArrayMatch(ours.prevVoltages, ngspice.prevVoltages, `${ctxLabel} rhsOld`);

  // ----- preSolveRhs- exact IEEE-754 -------------------------------------
  // SKIP slot 0 (ground row). ngspice's TrashCan pattern lets devices
  // stamp into the ground row before LU; we don't (architectural choice
  // documented in capture.ts). Comparing slot 0 of preSolveRhs would
  // always flag this asymmetry rather than any real numerical issue.
  _assertFloat64ArrayMatch(
    ours.preSolveRhs,
    ngspice.preSolveRhs,
    `${ctxLabel} preSolveRhs`,
    { skipGroundSlot: true },
  );

  // ----- voltages (post-solve solution)- exact IEEE-754 ------------------
  // Slot 0 (ground voltage) is always 0 after the solve; comparable.
  _assertFloat64ArrayMatch(ours.voltages, ngspice.voltages, `${ctxLabel} voltages`);

  // ----- ag[0..1] integration coefficients --------------------------------
  // ag[2..6] are zero on the ngspice side (FFI bridge marshals ag0/ag1 only),
  // so iterating beyond index 1 would assert 0===0 trivially.
  for (let i = 0; i < 2; i++) {
    const o = ours.ag[i];
    const n = ngspice.ag[i];
    const absDelta = Math.abs(o - n);
    expect(absDelta, `${ctxLabel} ag[${i}]: ours=${o} ngspice=${n} absDelta=${absDelta}`).toBe(0);
  }

  // ----- Device state: state0 / state1 / state2 ---------------------------
  // Build a lookup of ngspice element states by upper-cased label
  // (ngspice instance names round-trip uppercased through the bridge).
  const ngspiceEsByLabel = new Map<string, typeof ngspice.elementStates[number]>();
  for (const es of ngspice.elementStates) {
    ngspiceEsByLabel.set(es.label.toUpperCase(), es);
  }

  for (const ourEs of ours.elementStates) {
    const deviceType = _inferDeviceType(ourEs.label);
    const mapping = deviceType ? DEVICE_MAPPINGS[deviceType] : undefined;
    if (!mapping) continue;

    const ngEs = ngspiceEsByLabel.get(ourEs.label.toUpperCase());
    if (!ngEs) {
      throw new Error(
        `${ctxLabel}: element ${ourEs.label} present in our snapshot but absent from ngspice`,
      );
    }

    // Compare every state band the mapping declares: state0, state1, state2.
    for (const [slotName, ngspiceOffset] of Object.entries(mapping.slotToNgspice)) {
      if (ngspiceOffset === null) continue;
      _assertSlotMatch(ctxLabel, ourEs.label, "state0", slotName, ourEs.slots, ngEs.slots);
      _assertSlotMatch(ctxLabel, ourEs.label, "state1", slotName, ourEs.state1Slots, ngEs.state1Slots);
      _assertSlotMatch(ctxLabel, ourEs.label, "state2", slotName, ourEs.state2Slots, ngEs.state2Slots);
    }
  }

  // ----- Limiting events (pnjlim / fetlim / limvds) -----------------------
  // Pair events by junction name. Each junction limited (or visited) on
  // both sides must agree on {wasLimited, vBefore, vAfter}. limitType
  // labels are NOT compared (see header note).
  _assertLimitingEventsMatch(ours, ngspice, ctxLabel);

  // ----- Convergence flags ------------------------------------------------
  expect(
    ours.noncon,
    `${ctxLabel} noncon: ours=${ours.noncon} ngspice=${ngspice.noncon}`,
  ).toBe(ngspice.noncon);
  expect(
    ours.globalConverged,
    `${ctxLabel} globalConverged: ours=${ours.globalConverged} ngspice=${ngspice.globalConverged}`,
  ).toBe(ngspice.globalConverged);
  expect(
    ours.elemConverged,
    `${ctxLabel} elemConverged: ours=${ours.elemConverged} ngspice=${ngspice.elemConverged}`,
  ).toBe(ngspice.elemConverged);
  _assertStringSetMatch(
    ours.convergenceFailedElements,
    ngspice.convergenceFailedElements,
    `${ctxLabel} convergenceFailedElements`,
  );

  // ----- Mode / order / delta ---------------------------------------------
  expect(
    ours.initMode,
    `${ctxLabel} initMode: ours=${ours.initMode} ngspice=${ngspice.initMode}`,
  ).toBe(ngspice.initMode);
  expect(
    ours.method,
    `${ctxLabel} method: ours=${ours.method} ngspice=${ngspice.method}`,
  ).toBe(ngspice.method);
  expect(
    ours.order,
    `${ctxLabel} order: ours=${ours.order} ngspice=${ngspice.order}`,
  ).toBe(ngspice.order);
  {
    const absDelta = Math.abs(ours.delta - ngspice.delta);
    expect(
      absDelta,
      `${ctxLabel} delta: ours=${ours.delta} ngspice=${ngspice.delta} absDelta=${absDelta}`,
    ).toBe(0);
  }

  // ----- LTE proposal -----------------------------------------------------
  {
    const absDelta = Math.abs(ours.diagGmin - ngspice.diagGmin);
    expect(
      absDelta,
      `${ctxLabel} diagGmin: ours=${ours.diagGmin} ngspice=${ngspice.diagGmin} absDelta=${absDelta}`,
    ).toBe(0);
  }
  {
    const absDelta = Math.abs(ours.srcFact - ngspice.srcFact);
    expect(
      absDelta,
      `${ctxLabel} srcFact: ours=${ours.srcFact} ngspice=${ngspice.srcFact} absDelta=${absDelta}`,
    ).toBe(0);
  }
  if (ours.lteDt !== undefined && ngspice.lteDt !== undefined) {
    const absDelta = Math.abs(ours.lteDt - ngspice.lteDt);
    expect(
      absDelta,
      `${ctxLabel} lteDt: ours=${ours.lteDt} ngspice=${ngspice.lteDt} absDelta=${absDelta}`,
    ).toBe(0);
  }

  // ----- Matrix entries (full per-iteration MatrixEntry list) -------------
  _assertMatrixMatch(ours, ngspice, ctxLabel);
}

// ---------------------------------------------------------------------------
// Internal field-level assertion helpers
// ---------------------------------------------------------------------------

function _assertFloat64ArrayMatch(
  ours: Float64Array,
  ngspice: Float64Array,
  fieldLabel: string,
  opts: { skipGroundSlot?: boolean } = {},
): void {
  // ngspice's bridge reports rhsBufSize=1 (a single-slot placeholder) during
  // DCOP-init iterations because CKTmatrix is sized incrementally- the
  // SMPmatSize used by Float64Array decoding only reaches N+1 once the matrix
  // is fully linked. Skip length parity in that case; the substantive data
  // simply isn't there to compare. Otherwise require exact-length equality.
  const isNgspicePlaceholder = ngspice.length <= 1 && ours.length > 1;
  if (!isNgspicePlaceholder) {
    expect(
      ours.length,
      `${fieldLabel}: length mismatch ours=${ours.length} ngspice=${ngspice.length}`,
    ).toBe(ngspice.length);
  }
  const cmpLen = Math.min(ours.length, ngspice.length);
  const startIdx = opts.skipGroundSlot ? 1 : 0;
  for (let i = startIdx; i < cmpLen; i++) {
    const o = ours[i];
    const n = ngspice[i];
    const absDelta = Math.abs(o - n);
    expect(absDelta, `${fieldLabel}[${i}]: ours=${o} ngspice=${n} absDelta=${absDelta}`).toBe(0);
  }
}

function _assertSlotMatch(
  ctxLabel: string,
  elementLabel: string,
  band: "state0" | "state1" | "state2",
  slotName: string,
  ourSlots: Record<string, number> | undefined,
  ngSlots: Record<string, number> | undefined,
): void {
  const ourVal = ourSlots?.[slotName];
  const ngVal = ngSlots?.[slotName];
  // Only enforce if both sides populate. A slot that's undefined on one
  // side typically means the device or band wasn't instrumented for it
  // (e.g. ngspice never writes some Meyer-cap subterms in DC-OP). We do
  // NOT silently skip when both are populated.
  if (ourVal === undefined || ngVal === undefined) return;
  const absDelta = Math.abs(ourVal - ngVal);
  expect(
    absDelta,
    `${ctxLabel} ${band}[${elementLabel}][${slotName}]: ours=${ourVal} ngspice=${ngVal} absDelta=${absDelta}`,
  ).toBe(0);
}

function _assertLimitingEventsMatch(
  ours: IterationSnapshot,
  ngspice: IterationSnapshot,
  ctxLabel: string,
): void {
  // Index ngspice events by (label.toUpperCase(), junction).
  const ngByKey = new Map<string, typeof ngspice.limitingEvents[number]>();
  for (const ev of ngspice.limitingEvents) {
    ngByKey.set(`${ev.label.toUpperCase()}|${ev.junction}`, ev);
  }
  const ourByKey = new Map<string, typeof ours.limitingEvents[number]>();
  for (const ev of ours.limitingEvents) {
    ourByKey.set(`${ev.label.toUpperCase()}|${ev.junction}`, ev);
  }

  // Symmetric coverage: every junction visited on one side must appear on
  // the other side. This catches structural divergence (e.g. ngspice
  // running fetlim on GD where we run on GS).
  const allKeys = new Set<string>([...ourByKey.keys(), ...ngByKey.keys()]);
  for (const key of allKeys) {
    const ourEv = ourByKey.get(key);
    const ngEv = ngByKey.get(key);
    if (!ourEv) {
      throw new Error(
        `${ctxLabel} limitingEvents: junction ${key} present in ngspice but absent on our side`,
      );
    }
    if (!ngEv) {
      throw new Error(
        `${ctxLabel} limitingEvents: junction ${key} present on our side but absent from ngspice`,
      );
    }
    expect(
      ourEv.wasLimited,
      `${ctxLabel} limit ${key}.wasLimited: ours=${ourEv.wasLimited} ngspice=${ngEv.wasLimited}`,
    ).toBe(ngEv.wasLimited);
    {
      const absDelta = Math.abs(ourEv.vBefore - ngEv.vBefore);
      expect(
        absDelta,
        `${ctxLabel} limit ${key}.vBefore: ours=${ourEv.vBefore} ngspice=${ngEv.vBefore} absDelta=${absDelta}`,
      ).toBe(0);
    }
    {
      const absDelta = Math.abs(ourEv.vAfter - ngEv.vAfter);
      expect(
        absDelta,
        `${ctxLabel} limit ${key}.vAfter: ours=${ourEv.vAfter} ngspice=${ngEv.vAfter} absDelta=${absDelta}`,
      ).toBe(0);
    }
  }
}

function _assertStringSetMatch(
  ours: readonly string[],
  ngspice: readonly string[],
  fieldLabel: string,
): void {
  const ourSet = new Set(ours.map(s => s.toUpperCase()));
  const ngSet = new Set(ngspice.map(s => s.toUpperCase()));
  expect(
    ourSet.size,
    `${fieldLabel}: size mismatch ours=[${[...ourSet].join(",")}] ngspice=[${[...ngSet].join(",")}]`,
  ).toBe(ngSet.size);
  for (const s of ourSet) {
    expect(
      ngSet.has(s),
      `${fieldLabel}: ours has "${s}" but ngspice does not. ours=[${[...ourSet].join(",")}] ngspice=[${[...ngSet].join(",")}]`,
    ).toBe(true);
  }
}

function _assertMatrixMatch(
  ours: IterationSnapshot,
  ngspice: IterationSnapshot,
  ctxLabel: string,
): void {
  // Pair entries by (row, col). SKIP ground row/col (index 0)- ngspice's
  // TrashCan pattern stamps into row 0 / col 0; we don't. This is the
  // documented architectural choice- comparing those cells would always
  // flag a known asymmetry rather than any real divergence.
  const ngByCell = new Map<string, number>();
  for (const e of ngspice.matrix) {
    if (e.row === 0 || e.col === 0) continue;
    ngByCell.set(`${e.row},${e.col}`, e.value);
  }
  const ourByCell = new Map<string, number>();
  for (const e of ours.matrix) {
    if (e.row === 0 || e.col === 0) continue;
    ourByCell.set(`${e.row},${e.col}`, e.value);
  }
  const allCells = new Set<string>([...ourByCell.keys(), ...ngByCell.keys()]);
  for (const cell of allCells) {
    const ourVal = ourByCell.get(cell);
    const ngVal = ngByCell.get(cell);
    if (ourVal === undefined) {
      throw new Error(
        `${ctxLabel} matrix[${cell}]: present in ngspice (value=${ngVal}) but absent on our side`,
      );
    }
    if (ngVal === undefined) {
      throw new Error(
        `${ctxLabel} matrix[${cell}]: present on our side (value=${ourVal}) but absent from ngspice`,
      );
    }
    const absDelta = Math.abs(ourVal - ngVal);
    expect(
      absDelta,
      `${ctxLabel} matrix[${cell}]: ours=${ourVal} ngspice=${ngVal} absDelta=${absDelta}`,
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
