// Tests CKTCircuitContext observable properties via buildFixture on public surfaces.

import { describe, it, expect } from "vitest";
import { buildFixture } from "./fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// allocates_all_buffers_after_setup
// Verifies via public-surface checks that buffers are allocated after setup:
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

});

