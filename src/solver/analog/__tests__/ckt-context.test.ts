/**
 * Tests for CKTCircuitContext- Phase 1 Task 1.1.1
 *
 * Migrated per §3 POISON-PATTERN WARNING and §4 test-infrastructure rules:
 * - CKTCircuitContext is engine-internal; direct construction is engine-impersonation.
 * - All observable properties are now asserted via buildFixture on public surfaces.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "./fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// allocates_all_buffers_after_setup
// Renamed from allocates_all_buffers_at_init per §3c ssB14 + Phase1 File 7.
// Migration: internal buffer-length assertions replaced by public-surface checks:
//   engine.solver.getCSCNonZeros().length > 0  (matrix allocated)
//   pool.state0.length > 0                      (state pool allocated)
// ---------------------------------------------------------------------------

describe("CKTCircuitContext", () => {
  it("allocates_all_buffers_after_setup", () => {
    // Vs=5V → R=1kΩ → Diode → GND (minimal nonlinear circuit to force setup)
    const { engine, pool, circuit } = buildFixture({
      build: (_registry, facade) => {
        const f = facade as DefaultSimulatorFacade;
        return f.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "d1",  type: "Diode",           props: { label: "d1" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos", "r1:pos"],
            ["r1:neg", "d1:A"],
            ["d1:K",   "gnd:out"],
            ["vs:neg", "gnd:out"],
          ],
        });
      },
    });

    // Matrix must be populated after warm-start
    const solver = engine.solver;
    expect(solver).not.toBeNull();
    expect(solver!.getCSCNonZeros().length).toBeGreaterThan(0);
    // State pool must be allocated
    expect(pool.state0.length).toBeGreaterThan(0);
    // Node voltage at a known node must be set (DCOP ran successfully)
    const nodeId = circuit.labelToNodeId.get("vs:pos") ?? circuit.labelToNodeId.get("r1:pos") ?? 1;
    const vTop = engine.getNodeVoltage(nodeId);
    expect(typeof vTop).toBe("number");
    expect(isFinite(vTop)).toBe(true);
  });

  // Deleted: zero_allocations_on_reuse.
  // Coverage: none; internal Float64Array allocation counter via Proxy install
  //   (the `as unknown as typeof Float64Array` cast at old line 239) is the
  //   §4g pre-existing smell identified in the mission brief. No observable
  //   public surface exposes allocation counts.
  // Reason: Engine-impersonation + eradicated Proxy-install cast per §4g Phase A.

  // Deleted: loadCtx_fields_populated.
  // Coverage: mna-end-to-end.test.ts covers DCOP convergence + field consistency
  //   through the full pipeline.
  // Reason: LoadContext fields are internal engine state with no public getter;
  //   direct ctx.loadCtx access is engine-impersonation per §3 POISON.

  // Deleted: deltaOld init / seeded_to_maxTimeStep.
  // Coverage: integration.test.ts covers deltaOld seeding and integration coefficient
  //   correctness through observable timestep / LTE behavior.
  // Reason: ctx.loadCtx.deltaOld is internal; no public surface exposes the
  //   raw 7-slot array contents per §3 POISON.

  // Deleted: LoadContext defaults / bypass_defaults_to_false.
  // Coverage: mna-end-to-end.test.ts (full pipeline reaches correct DCOP solution
  //   whether bypass is true or false on the first iteration).
  // Reason: ctx.loadCtx.bypass is an internal NR field; engine-impersonation per §3.

  // Deleted: LoadContext defaults / voltTol_defaults_to_1e_minus_6.
  // Coverage: convergence-regression.test.ts exercises convergence with tight voltTol
  //   through observable DCOP convergence outcomes.
  // Reason: ctx.loadCtx.voltTol is an internal NR field; engine-impersonation per §3.
});

// Deleted: DcOpResult / reset_preserves_array_identity.
// Coverage: dc-operating-point.test.ts covers DcOpResult semantics via the full
//   solveDcOperatingPoint() pipeline, which calls reset() internally.
// Reason: ctx.dcopResult is an engine-internal mutable object; direct mutation and
//   identity check requires engine-impersonation per §3 POISON.

// Deleted: solver / single_allocation.
// Coverage: sparse-solver.test.ts covers SparseSolver allocation and identity
//   invariants. The CKTCircuitContext→solver plumbing is exercised by every
//   buildFixture-based test (matrix stamps require ctx.solver).
// Reason: ctx.solver getter/setter is internal engine wiring; cannot be observed
//   through buildFixture public surface per §3 POISON.
