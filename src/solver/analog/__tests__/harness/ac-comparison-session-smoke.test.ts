/**
 * AC ComparisonSession smoke test (Phase 2).
 *
 * Exercises the comparison-session machinery end-to-end in self-compare mode:
 *   - runAcSweep populates `_acSession` via the AcAnalysis snapshot sink.
 *   - The self-compare branch deep-clones ours into `_ngAcSession`.
 *   - getAcSessionShape() reports point counts, presence, and frequency
 *     parity (which must be exact under self-compare).
 *
 * Self-compare is the right tier for Phase 2 because it tests the harness
 * wiring (sink, session storage, report shape) without depending on the
 * ngspice DLL or a paired .dts/.cir fixture pair. Phase 1b's
 * `ac-bridge-smoke.test.ts` already proves the C->TS bridge round-trip;
 * Phase 3's full divergence smoke will land paired .dts/.cir fixtures.
 *
 * Circuit: the existing `rc-transient.dts`, a single-pole RC. The
 * AcVoltageSource carries default acMagnitude=1, acPhase=0 (vsrctemp.c:39, 42),
 * so its stampAc (vsrcacld.c:175-180) drives the sweep with acReal = 1,
 * acImag = 0 independent of the source's transient waveform.
 */

import { it, expect } from "vitest";
import { ComparisonSession } from "./comparison-session.js";

it("ac_self_compare_runs_and_report_is_consistent", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts",
    analysis: "ac",
    acParams: {
      type: "dec",
      numPoints: 5,
      fStart: 1,
      fStop: 10000,
      outputNodes: [],
    },
  });

  const ours = session.acSession;
  const ngsp = session.ngspiceAcSession;
  expect(ours).not.toBeNull();
  expect(ngsp).not.toBeNull();
  expect(ours!.source).toBe("ours");
  expect(ngsp!.source).toBe("ngspice");
  expect(ours!.points.length).toBeGreaterThan(0);
  expect(ngsp!.points.length).toBe(ours!.points.length);

  // Per-point parity (self-compare clones the our-side arrays).
  for (let i = 0; i < ours!.points.length; i++) {
    const o = ours!.points[i];
    const n = ngsp!.points[i];
    expect(n.freq).toBe(o.freq);
    expect(n.omega).toBe(o.omega);
    expect(n.matrixSize).toBe(o.matrixSize);
    expect(n.solRe.length).toBe(o.solRe.length);
    expect(n.solIm.length).toBe(o.solIm.length);
    // Defensive copy: clone arrays are equal but not the same buffer.
    expect(n.solRe).not.toBe(o.solRe);
    expect(n.solIm).not.toBe(o.solIm);
    for (let k = 0; k < o.solRe.length; k++) {
      expect(n.solRe[k]).toBe(o.solRe[k]);
      expect(n.solIm[k]).toBe(o.solIm[k]);
    }
  }

  // Solution actually computed something (a single freq with a finite,
  // non-zero magnitude across at least one MNA row).
  let anyNonZero = false;
  for (const p of ours!.points) {
    for (let k = 0; k < p.solRe.length; k++) {
      if (Math.hypot(p.solRe[k], p.solIm[k]) > 0) { anyNonZero = true; break; }
    }
    if (anyNonZero) break;
  }
  expect(anyNonZero).toBe(true);

  // Frequencies strictly increasing.
  for (let i = 1; i < ours!.points.length; i++) {
    expect(ours!.points[i].freq).toBeGreaterThan(ours!.points[i - 1].freq);
  }

  // getAcSessionShape() report consistency.
  const shape = session.getAcSessionShape();
  expect(shape.analysis).toBe("ac");
  expect(shape.pointCount.ours).toBe(ours!.points.length);
  expect(shape.pointCount.ngspice).toBe(ngsp!.points.length);
  expect(shape.pointCount.max).toBe(ours!.points.length);

  // Self-compare: every point present on both sides, exact frequency parity.
  expect(shape.presenceCounts.both).toBe(shape.pointCount.max);
  expect(shape.presenceCounts.oursOnly).toBe(0);
  expect(shape.presenceCounts.ngspiceOnly).toBe(0);
  expect(shape.largeFreqDeltas.length).toBe(0);

  for (const pt of shape.points) {
    expect(pt.presence).toBe("both");
    expect(pt.freq.ours).toBe(pt.freq.ngspice);
    expect(pt.omega.ours).toBe(pt.omega.ngspice);
    expect(pt.freqRelDelta).toBe(0);
  }
}, 30_000);

it("ac_session_shape_throws_when_no_ac_run", async () => {
  const session = await ComparisonSession.createSelfCompare({
    dtsPath: "src/solver/analog/__tests__/ngspice-parity/fixtures/rc-transient.dts",
    analysis: "dcop",
  });
  expect(() => session.getAcSessionShape()).toThrow(/requires an AC sweep run/);
});
