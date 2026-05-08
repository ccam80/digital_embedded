import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

import type { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// Ground canonical set
//
// Capability gate (from src/components/io/ground.ts):
//   - Single-pin OUTPUT element (`out`).
//   - Analog model: behavioral inline factory; setup() and load() are no-ops
//     because the compiler maps the connected node to MNA node 0 directly.
//     No params (paramDefs: []), no state slots, no junctions / *lim, no
//     getLteTimestep, no acceptStep, single behavioral model entry.
//   - Digital model: executeFn writes 0 into the output net every step.
//
// Applicable canon categories:
//   - Cat 1 Init       (T1, analog) - ground node sits at 0 V at step 0.
//   - Cat 2 DCOP       (T1, analog, analytical) - ground node = 0 V after DCOP.
//   - Cat 9 Bridge     (T1, digital) - executeFn drives output to 0.
//
// Inapplicable categories:
//   - Cat 3, 5: no analog state to evolve; load() stamps nothing.
//   - Cat 4: zero parameters (paramDefs: []).
//   - Cat 6: no junctions, no *lim calls in load().
//   - Cat 7: no getLteTimestep.
//   - Cat 8: no acceptStep / breakpoint registration.
//   - Cat 10: single behavioral model entry.
//   - Cat 11: single output pin, value always 0.
//   - Cat 12, 13, 14, 15: no documented forbidden inputs, no narrow ports
//     wider than the bus, no runtime diagnostic emission, no _onStateChange.
//
// File tier: fixture-only. Cat 9 uses facade.build + facade.compile +
// coordinator.step / readByLabel because Ground in a pure digital topology
// has no analog domain (mirrors DipSwitch canonical pattern).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAnalogGroundCircuit(facade: DefaultSimulatorFacade): Circuit {
  // VS (5 V) -> R (1 k) -> Ground. Single-loop DC: V(GND pin) = 0 V by
  // construction (the compiler maps GND's pin position to MNA node 0).
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "VS", voltage: 5 } },
      { id: "rl",  type: "Resistor",        props: { label: "RL", resistance: 1000 } },
      { id: "gnd", type: "Ground",          props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos", "rl:pos"],
      ["rl:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Cat 1 - Initialization (T1)
// ---------------------------------------------------------------------------

describe("Ground initialization (Cat 1, T1)", () => {
  it("ground_node_voltage_is_zero_at_step_0", () => {
    // After warm-start (one coordinator.step() inside buildFixture), the node
    // connected to Ground's `out` pin must read 0 V from the engine. The
    // analog compiler routes that net to MNA node 0; engine.getNodeVoltage
    // returns 0 for node 0 by convention.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogGroundCircuit(facade),
    });

    const gndNode = fix.circuit.labelToNodeId.get("GND");
    expect(gndNode).toBeDefined();
    expect(fix.engine.getNodeVoltage(gndNode!)).toBeCloseTo(0, 12);
  });
});

// ---------------------------------------------------------------------------
// Cat 2 - DC operating point (T1, analytical)
// ---------------------------------------------------------------------------

describe("Ground DCOP (Cat 2, T1 analytical)", () => {
  it("dcop_ground_node_is_zero_volts", () => {
    // VS (5 V) -> R (1 k) -> Ground. After DCOP: V(GND) = 0 V (closed form;
    // ground is the MNA reference). VS:pos = 5 V at the high side.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogGroundCircuit(facade),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const gndNode = fix.circuit.labelToNodeId.get("GND");
    expect(gndNode).toBeDefined();
    expect(fix.engine.getNodeVoltage(gndNode!)).toBeCloseTo(0, 12);

    // Sanity: VS:pos sits at the source voltage. Confirms the topology
    // closed; without the loop nothing distinguishes the analog ground
    // assertion from a vacuous getNodeVoltage(0) === 0 read.
    const posNode =
      fix.circuit.labelToNodeId.get("VS:pos") ??
      fix.circuit.labelToNodeId.get("RL:pos");
    expect(posNode).toBeDefined();
    expect(fix.engine.getNodeVoltage(posNode!)).toBeCloseTo(5, 6);
  });
});

// ---------------------------------------------------------------------------
// Cat 9 - Bridge / digital interaction (T1)
// ---------------------------------------------------------------------------

describe("Ground digital bridge (Cat 9, T1)", () => {
  it("digital_executefn_drives_out_to_zero", () => {
    // Pure digital topology: Ground -> Out. executeGround writes 0 to the
    // output net each step. After one step the downstream Out reads 0.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "gnd",  type: "Ground", props: { label: "GND" } },
        { id: "out1", type: "Out",    props: { label: "OUT", bitWidth: 1 } },
      ],
      connections: [
        ["gnd:out", "out1:in"],
      ],
    });
    const coordinator = facade.compile(circuit);
    coordinator.step();
    expect(coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0,
    });
    coordinator.dispose();
  });
});
