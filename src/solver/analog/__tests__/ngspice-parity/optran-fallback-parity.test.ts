/**
 * OPtran operating-point pseudo-transient fallback — Surface 3 (paired ngspice).
 *
 * Gate #4 of the `analysis#recon/opTran` recon (spec/v41-port/reconstruction/
 * analysis-optran.md). The fixture `v1 1 0 dc 3 / v2 2 0 dc 5 / l1 1 2 1m` is an
 * inductor-induced DC branch-current singularity: an ideal inductor bridging two
 * source-pinned nodes has no static DC solution, and gmin (a node-to-ground
 * conductance) cannot resolve a branch-current indeterminacy. Both engines
 * therefore exhaust direct NR + gmin stepping + source stepping, fall through to
 * the OPtran pseudo-transient (cktop.c:104), and settle to v1=3, v2=5 with a
 * physical ~-2 mA branch current / phi = -2 uWb inductor flux.
 *
 * The two solves are bit-exact: harness_first_divergence is null across every
 * class (voltage / state / rhs / matrix / integration / convergence / shape).
 * That includes the diagonal gmin OPtran carries on the node diagonals through
 * the pseudo-transient (CKTdiagGmin = gminstart, cktop.c:647), which scales the
 * source-pinned nodes by (1 - gmin) identically on both sides.
 */

import { it, expect } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import { describeIfDll, DLL_PATH } from "./parity-helpers.js";

const DTS_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/optran-inductor-singular.dts",
);

const OPTRAN = { opstepsize: 1e-8, opfinaltime: 1e-6, opramptime: 0 };

describeIfDll("OPtran inductor-singular parity — recon gate #4", () => {
  // Gate #4: OPtran settles to the unique OP bit-exact vs ngspice, with
  // firstDivergence null across every signal class.
  it("OPtran settles to 3V/5V bit-exact vs ngspice (null divergence)", async () => {
    const session = await ComparisonSession.create({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
      deferStructuralAsserts: true,
    });
    try {
      await session.runDcOp(OPTRAN);
      const fd = session.firstDivergence();
      expect(fd.earliest).toBeNull();
    } finally {
      session.dispose();
    }
  }, 240_000);

  // A focused readout of the settled node voltages: both engines reach the
  // source-pinned v1=3, v2=5 via the same gmin -> source -> OPtran path (the
  // bit-exact assertion above already covers the full per-iteration signal set).
  it("both engines reach the source-pinned node voltages v1=3, v2=5", async () => {
    const session = await ComparisonSession.create({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
      deferStructuralAsserts: true,
    });
    try {
      await session.runDcOp(OPTRAN);
      expect(session.errors).toEqual([]);

      const ourStep = session.ourSession!.steps[0]!;
      const ngStep = session.ngspiceSessionAligned!.steps[0]!;
      const ourLast = ourStep.attempts.at(-1)!.iterations.at(-1)!;
      const ngLast = ngStep.attempts.at(-1)!.iterations.at(-1)!;

      // Slots 1 and 2 are the two source-pinned voltage nodes.
      expect(ourLast.voltages[1]).toBeCloseTo(3, 6);
      expect(ourLast.voltages[2]).toBeCloseTo(5, 6);
      expect(ngLast.voltages[1]).toBeCloseTo(3, 6);
      expect(ngLast.voltages[2]).toBeCloseTo(5, 6);
    } finally {
      session.dispose();
    }
  }, 240_000);
});
