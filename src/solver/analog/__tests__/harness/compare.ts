/**
 * Comparison engine: diffs our CaptureSession against ngspice's
 * CaptureSession and produces ComparisonResult objects.
 */

import type {
  CaptureSession,
  ComparisonResult,
  Tolerance,
  DeviceMapping,
} from "./types.js";
import { DEFAULT_TOLERANCE } from "./types.js";
import { DEVICE_MAPPINGS } from "./device-mappings.js";

// ---------------------------------------------------------------------------
// Tolerance check helpers
// ---------------------------------------------------------------------------

function withinTol(ours: number, theirs: number, absTol: number, relTol: number): boolean {
  const absDelta = Math.abs(ours - theirs);
  const refMag = Math.max(Math.abs(ours), Math.abs(theirs));
  return absDelta <= absTol + relTol * refMag;
}

// ---------------------------------------------------------------------------
// Snapshot comparison
// ---------------------------------------------------------------------------

/**
 * Compare two capture sessions iteration-by-iteration.
 *
 * Steps are paired by index. When one side has more steps than the other,
 * the unpaired steps emit a sentinel ComparisonResult with iterationIndex: -1
 * and presence set to "oursOnly" or "ngspiceOnly". Within each paired step,
 * iterations are compared pairwise up to the minimum count.
 *
 * @param ours     - Our engine's capture session
 * @param ref      - ngspice reference capture session
 * @param tolerance - Comparison tolerances
 * @returns Array of ComparisonResult, one per compared iteration (or sentinel for asymmetric steps)
 */
export function compareSnapshots(
  ours: CaptureSession,
  ref:  CaptureSession,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
  matrixMaps?: {
    ngRowToOurRow: ReadonlyMap<number, number>;
    ngColToOurCol: ReadonlyMap<number, number>;
    ngspiceOnlyRows: ReadonlySet<number>;
  },
): ComparisonResult[] {
  const results: ComparisonResult[] = [];
  const stepCount = Math.max(ours.steps.length, ref.steps.length);

  for (let si = 0; si < stepCount; si++) {
    const ourStep = ours.steps[si];
    const refStep = ref.steps[si];

    if (!ourStep && !refStep) continue;

    if (!ourStep || !refStep) {
      results.push({
        stepIndex: si,
        iterationIndex: -1,
        stepStartTime: (ourStep ?? refStep)!.stepStartTime,
        presence: ourStep ? "oursOnly" : "ngspiceOnly",
        voltageDiffs: [],
        rhsDiffs: [],
        matrixDiffs: [],
        stateDiffs: [],
        allWithinTol: false,
      });
      continue;
    }

    const iterCount = Math.min(ourStep.iterations.length, refStep.iterations.length);

    for (let ii = 0; ii < iterCount; ii++) {
      const ourIter = ourStep.iterations[ii];
      const refIter = refStep.iterations[ii];

      // Voltage diffs
      const voltageDiffs: ComparisonResult["voltageDiffs"] = [];
      const nodeCount = Math.min(ourIter.voltages.length, refIter.voltages.length);
      for (let n = 0; n < nodeCount; n++) {
        const o = ourIter.voltages[n];
        const t = refIter.voltages[n];
        const absDelta = Math.abs(o - t);
        const refMag = Math.max(Math.abs(o), Math.abs(t));
        const wt = withinTol(o, t, tolerance.vAbsTol, tolerance.relTol);
        voltageDiffs.push({
          nodeIndex: n,
          label: ours.topology.nodeLabels.get(n + 1) ?? `node_${n}`,
          ours: o,
          theirs: t,
          absDelta,
          relDelta: refMag > 0 ? absDelta / refMag : absDelta,
          withinTol: wt,
        });
      }

      // RHS diffs
      const rhsDiffs: ComparisonResult["rhsDiffs"] = [];
      const rhsLen = Math.min(ourIter.preSolveRhs.length, refIter.preSolveRhs.length);
      for (let r = 0; r < rhsLen; r++) {
        const o = ourIter.preSolveRhs[r];
        const t = refIter.preSolveRhs[r];
        const absDelta = Math.abs(o - t);
        rhsDiffs.push({
          index: r,
          ours: o,
          theirs: t,
          absDelta,
          withinTol: withinTol(o, t, tolerance.iAbsTol, tolerance.relTol),
        });
      }

      const matrixDiffs: ComparisonResult["matrixDiffs"] = [];
      const ourMap = new Map<string, number>();
      for (const e of ourIter.matrix) ourMap.set(`${e.row},${e.col}`, e.value);
      const refMap = new Map<string, number>();
      for (const e of refIter.matrix) {
        if (matrixMaps) {
          if (matrixMaps.ngspiceOnlyRows.has(e.row) || matrixMaps.ngspiceOnlyRows.has(e.col)) continue;
          const ourR = matrixMaps.ngRowToOurRow.get(e.row);
          const ourC = matrixMaps.ngColToOurCol.get(e.col);
          if (ourR === undefined || ourC === undefined) continue;
          refMap.set(`${ourR},${ourC}`, e.value);
        } else {
          refMap.set(`${e.row},${e.col}`, e.value);
        }
      }
      const allKeys = new Set([...ourMap.keys(), ...refMap.keys()]);
      for (const key of allKeys) {
        const [r, c] = key.split(",").map(Number);
        const o = ourMap.get(key) ?? 0;
        const t = refMap.get(key) ?? 0;
        const absDelta = Math.abs(o - t);
        if (!withinTol(o, t, tolerance.iAbsTol, tolerance.relTol)) {
          matrixDiffs.push({ row: r, col: c, ours: o, theirs: t, absDelta, withinTol: false });
        }
      }

      // Device state diffs — compare our pool-backed state slots against
      // ngspice state via device mappings
      const stateDiffs: ComparisonResult["stateDiffs"] = [];
      for (const ourEs of ourIter.elementStates) {
        // Find matching element in reference by label
        const refEs = refIter.elementStates.find(e => e.label === ourEs.label);
        if (!refEs) continue;

        // Look up the device mapping for this element type
        // The element label format is "type_N" or just the label; device type
        // is inferred from which mapping has slots that match our slot names.
        let mapping: DeviceMapping | undefined;
        for (const [, m] of Object.entries(DEVICE_MAPPINGS)) {
          const mappedSlots = Object.keys(m.slotToNgspice);
          const ourSlots = Object.keys(ourEs.slots);
          if (ourSlots.length > 0 && mappedSlots.some(s => s in ourEs.slots)) {
            mapping = m;
            break;
          }
        }
        if (!mapping) continue;

        // Build the set of slot names to compare: direct mappings (non-null)
        // plus any derived-ngspice slots. Derived slots are populated on the
        // ngspice side by the bridge unpacker and keyed by our slot name, so
        // the rest of this loop treats them identically to direct mappings.
        const comparableSlots = new Set<string>();
        for (const [slotName, ngIdx] of Object.entries(mapping.slotToNgspice)) {
          if (ngIdx !== null) comparableSlots.add(slotName);
        }
        if (mapping.derivedNgspiceSlots) {
          for (const slotName of Object.keys(mapping.derivedNgspiceSlots)) {
            comparableSlots.add(slotName);
          }
        }

        // Compare each mapped slot
        for (const slotName of comparableSlots) {
          if (!(slotName in ourEs.slots) || !(slotName in refEs.slots)) continue;

          const o = ourEs.slots[slotName];
          const t = refEs.slots[slotName];
          const absDelta = Math.abs(o - t);
          // Use charge tolerance for Q/CCAP slots, voltage for V slots, current for others
          const isCharge = slotName.startsWith("Q_") || slotName.startsWith("CCAP");
          const isVoltage = slotName.startsWith("V") && !slotName.startsWith("VON");
          const absTol = isCharge ? tolerance.qAbsTol
            : isVoltage ? tolerance.vAbsTol
            : tolerance.iAbsTol;
          const wt = withinTol(o, t, absTol, tolerance.relTol);

          stateDiffs.push({
            elementLabel: ourEs.label,
            slotName,
            ours: o,
            theirs: t,
            absDelta,
            withinTol: wt,
          });
        }
      }

      const allWithinTol = voltageDiffs.every(d => d.withinTol)
        && rhsDiffs.every(d => d.withinTol)
        && matrixDiffs.length === 0
        && stateDiffs.every(d => d.withinTol);

      results.push({
        stepIndex: si,
        iterationIndex: ii,
        stepStartTime: ourStep.stepStartTime,
        presence: "both",
        voltageDiffs,
        rhsDiffs,
        matrixDiffs,
        stateDiffs,
        allWithinTol,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format a ComparisonResult as a human-readable diff string.
 */
export function formatComparison(result: ComparisonResult): string {
  const lines: string[] = [];
  lines.push(`=== Step ${result.stepIndex}, Iteration ${result.iterationIndex} (tStart=${result.stepStartTime.toExponential(4)}) ===`);
  lines.push(`  Overall: ${result.allWithinTol ? "PASS" : "FAIL"}`);

  const vFails = result.voltageDiffs.filter(d => !d.withinTol);
  if (vFails.length > 0) {
    lines.push(`  Voltage mismatches (${vFails.length}):`);
    for (const d of vFails.slice(0, 10)) {
      lines.push(`    node ${d.nodeIndex} (${d.label}): ours=${d.ours.toExponential(6)} ref=${d.theirs.toExponential(6)} delta=${d.absDelta.toExponential(3)}`);
    }
    if (vFails.length > 10) lines.push(`    ... and ${vFails.length - 10} more`);
  }

  const rFails = result.rhsDiffs.filter(d => !d.withinTol);
  if (rFails.length > 0) {
    lines.push(`  RHS mismatches (${rFails.length}):`);
    for (const d of rFails.slice(0, 10)) {
      lines.push(`    row ${d.index}: ours=${d.ours.toExponential(6)} ref=${d.theirs.toExponential(6)} delta=${d.absDelta.toExponential(3)}`);
    }
  }

  if (result.matrixDiffs.length > 0) {
    lines.push(`  Matrix mismatches (${result.matrixDiffs.length}):`);
    for (const d of result.matrixDiffs.slice(0, 10)) {
      lines.push(`    [${d.row},${d.col}]: ours=${d.ours.toExponential(6)} ref=${d.theirs.toExponential(6)} delta=${d.absDelta.toExponential(3)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Find the first iteration where divergence exceeds a threshold.
 * Useful for pinpointing when our engine starts deviating from ngspice.
 */
export function findFirstDivergence(
  results: ComparisonResult[],
  threshold: number = 1e-3,
): ComparisonResult | null {
  for (const r of results) {
    for (const d of r.voltageDiffs) {
      if (d.absDelta > threshold) return r;
    }
  }
  return null;
}
