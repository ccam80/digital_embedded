/**
 * OPtran operating-point pseudo-transient fallback — Surface 3 (paired ngspice).
 *
 * Gate #4 of the `analysis#recon/opTran` recon (spec/v41-port/reconstruction/
 * analysis-optran.md): the inductor-singular fixture under the `optran` option
 * should converge via OPtran to the unique 3V/5V OP bit-exact against the
 * ngspice DLL's optran run (harness_first_divergence null across classes).
 *
 * STATUS — gate #4 is BLOCKED on a separate digiTS issue outside this recon's
 * scope (see the escalation in the recon report). The fixture
 * `v1 1 0 dc 3 / v2 2 0 dc 5 / l1 1 2 1m` is an inductor-induced DC
 * branch-current singularity. The spec's premise was that the static ladder
 * (direct NR + gmin stepping + source stepping) fails on `l1#branch`, forcing
 * OPtran on BOTH sides. Measured against the actual v41 DLL in this harness:
 *
 *   - ngspice DOES fall to OPtran: its DC-OP attempt stream runs gmin + source
 *     stepping, THEN tranInit/tranNR/tranPredictor (the OPtran pseudo-transient),
 *     settling to v1=3, v2=5 with physical branch currents (~2 mA).
 *   - digiTS's dynamic_gmin spuriously REPORTS convergence on the singular
 *     circuit before OPtran is ever reached: it lands v1=3, v2=5 but with
 *     nonphysical branch currents (~2e12 A = gmin^-1 scale) that still pass the
 *     voltage-based convergence test. Because the static ladder "succeeds",
 *     solveDcOperatingPoint never invokes the OPtran fallback.
 *
 * So the two engines take different DC-OP paths (digiTS: gmin-only; ngspice:
 * gmin + source + OPtran) and harness_first_divergence is non-null even though
 * the node voltages agree. The OPtran port itself (option plumbing + driver +
 * the cktop.c:101-108 fall-through + harness optran variant) is complete and
 * the default-off invariant (gate #3) holds; what blocks gate #4 is that
 * digiTS's dynamic_gmin accepts a nonphysical branch-current solution rather
 * than failing the singularity and falling through to OPtran.
 *
 * This test encodes the desired behaviour as the spec defines it as a GENUINE
 * FAILING (red) test — NOT weakened to green (no `.skip`/`.fails`) — recording
 * the blocker honestly per author-for-desired-behaviour. It goes green once
 * digiTS's gmin stepping correctly fails the branch-current singularity
 * (FIX-006) so the OPtran fallback is reached on the digiTS side too.
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
  // Gate #4 desired behaviour: OPtran settles to the unique OP bit-exact vs
  // ngspice, firstDivergence null across classes. A GENUINE FAILING (red) test —
  // NOT weakened to green — recording the blocker honestly: digiTS's dynamic_gmin
  // spuriously converges the branch-current singularity before OPtran runs, so
  // the fallback is never reached (FIX-006). Goes green when FIX-006 lands.
  it("OPtran settles to 3V/5V bit-exact vs ngspice (null divergence) [RED pending FIX-006]", async () => {
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

  // What IS true today: both engines reach the source-pinned node voltages
  // (v1=3, v2=5) even though they take different convergence paths and the
  // branch currents disagree. This passes and documents the partial result.
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
