/**
 * Tests for the behavioral analog factories backing digital gates: AND,
 * NAND, OR, NOR, XOR, NOT.
 *
 * Migration shape M1- per Test 1.29 contract (Entry 1- pin-loading +
 * direct-role tests, plus UC-2 sweep). Every gate test acquires its engine
 * via `ComparisonSession.createSelfCompare({ buildCircuit, analysis })`.
 * Inputs are driven by `DcVoltageSource` instances; outputs are loaded by
 * `Resistor` to ground. The gate runs as the analog `behavioral` model.
 *
 * Pin loading is configured exclusively via
 * `circuit.metadata.digitalPinLoadingOverrides` (Decision #10), and
 * pin-loading assertions assert observable voltage sag (Decision #11).
 * The direct-role assertion reads `_ourTopology.matrixRowLabels` and
 * asserts no entry tagged `${gateLabel}:.*:branch` exists (per
 * `capture.ts:159`).
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { PropertyBag } from "../../../core/properties.js";
import {
  makeAndAnalogFactory,
  makeNandAnalogFactory,
  makeOrAnalogFactory,
  makeNorAnalogFactory,
  makeXorAnalogFactory,
  makeNotAnalogFactory,
} from "../behavioral-gate.js";

// ---------------------------------------------------------------------------
// Threshold constants- match the registered CMOS_3V3 pin-electrical defaults.
// ---------------------------------------------------------------------------

const VDD = 3.3;
const GND = 0.0;
const LOAD_R = 10_000; // 10 kohm output load

// ---------------------------------------------------------------------------
// Two-input gate circuit factory.
//
// Drives `In_1`/`In_2` through ideal DC sources and loads the gate's `out`
// with a 10 kohm resistor to ground.
// ---------------------------------------------------------------------------

function build2InputGate(gateType: string, vA: number, vB: number) {
  return (registry: ComponentRegistry): Circuit => {
    const facade = new DefaultSimulatorFacade(registry);
    return facade.build({
      components: [
        { id: "vsA",  type: "DcVoltageSource", props: { label: "vsA", voltage: vA } },
        { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB", voltage: vB } },
        { id: "gate", type: gateType,         props: { label: "gate", model: "behavioral", inputCount: 2 } },
        { id: "rLoad", type: "Resistor",       props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vsA:pos",  "gate:In_1"],
        ["vsB:pos",  "gate:In_2"],
        ["gate:out", "rLoad:A"],
        ["rLoad:B",  "gnd:out"],
        ["vsA:neg",  "gnd:out"],
        ["vsB:neg",  "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// One-input gate circuit factory (NOT).
// ---------------------------------------------------------------------------

function build1InputGate(gateType: string, vIn: number) {
  return (registry: ComponentRegistry): Circuit => {
    const facade = new DefaultSimulatorFacade(registry);
    return facade.build({
      components: [
        { id: "vsIn", type: "DcVoltageSource", props: { label: "vsIn", voltage: vIn } },
        { id: "gate", type: gateType,         props: { label: "gate", model: "behavioral" } },
        { id: "rLoad", type: "Resistor",       props: { label: "rLoad", resistance: LOAD_R } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vsIn:pos", "gate:In_1"],
        ["gate:out", "rLoad:A"],
        ["rLoad:B",  "gnd:out"],
        ["vsIn:neg", "gnd:out"],
      ],
    });
  };
}

// ---------------------------------------------------------------------------
// AND gate tests
// ---------------------------------------------------------------------------

describe("AND", () => {
  it("both_high_outputs_high", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: build2InputGate("And", VDD, VDD),
      analysis: "dcop",
    });
    const vOut = session.getStepEnd(0).nodes["gate:out"].ours!;
    expect(vOut).toBeGreaterThan(3.0);
  });

  it("one_low_outputs_low", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: build2InputGate("And", VDD, GND),
      analysis: "dcop",
    });
    const vOut = session.getStepEnd(0).nodes["gate:out"].ours!;
    expect(vOut).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// NOT gate tests
// ---------------------------------------------------------------------------

describe("NOT", () => {
  it("inverts", async () => {
    // Input HIGH -> output LOW
    const sessionHigh = await ComparisonSession.createSelfCompare({
      buildCircuit: build1InputGate("Not", VDD),
      analysis: "dcop",
    });
    expect(sessionHigh.getStepEnd(0).nodes["gate:out"].ours!).toBeLessThan(0.5);

    // Input LOW -> output HIGH
    const sessionLow = await ComparisonSession.createSelfCompare({
      buildCircuit: build1InputGate("Not", GND),
      analysis: "dcop",
    });
    expect(sessionLow.getStepEnd(0).nodes["gate:out"].ours!).toBeGreaterThan(3.0);
  });
});

// ---------------------------------------------------------------------------
// NAND gate tests
// ---------------------------------------------------------------------------

describe("NAND", () => {
  it("truth_table_all_combinations", async () => {
    const combos: [number, number, boolean][] = [
      [GND, GND, true],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, false],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: build2InputGate("NAnd", vA, vB),
        analysis: "dcop",
      });
      const vOut = session.getStepEnd(0).nodes["gate:out"].ours!;
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// XOR gate tests
// ---------------------------------------------------------------------------

describe("XOR", () => {
  it("truth_table_all_combinations", async () => {
    const combos: [number, number, boolean][] = [
      [GND, GND, false],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, false],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: build2InputGate("XOr", vA, vB),
        analysis: "dcop",
      });
      const vOut = session.getStepEnd(0).nodes["gate:out"].ours!;
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// NR convergence test
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("converges_within_5_iterations", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: build2InputGate("And", VDD, VDD),
      analysis: "dcop",
    });
    // First step is the DC operating point; the accepted attempt's iteration
    // count is the NR iteration count.
    const shape = session.getStepShape(0);
    const attempts = shape.attempts.ours!;
    const accepted = attempts.find(a => a.accepted);
    expect(accepted).toBeDefined();
    expect(accepted!.iterationCount).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Factory tests- confirm the behavioural factories produce analog elements
// with the expected pin layout.
// ---------------------------------------------------------------------------

describe("Factory", () => {
  it("and_factory_returns_analog_element", () => {
    const factory: AnalogFactory = makeAndAnalogFactory(2);
    const props = new PropertyBag();
    const element = factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0);
    expect(element).toBeDefined();
    expect(typeof element.load).toBe("function");
    expect(element.branchIndex).toBe(-1);
    expect(element._pinNodes.size).toBe(3);
  });

  it("not_factory_returns_1_input_element", () => {
    const factory: AnalogFactory = makeNotAnalogFactory();
    const props = new PropertyBag();
    const element = factory(new Map([["In_1", 1], ["out", 2]]), props, () => 0);
    expect(element).toBeDefined();
    expect(element._pinNodes.size).toBe(2);
  });

  it("nand_factory_correct_truth_table", async () => {
    // Simply construct the NAND factory to confirm it is a callable factory,
    // then drive both inputs HIGH through M1 and assert vOut < 0.5V.
    const factory: AnalogFactory = makeNandAnalogFactory(2);
    expect(typeof factory).toBe("function");

    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: build2InputGate("NAnd", VDD, VDD),
      analysis: "dcop",
    });
    expect(session.getStepEnd(0).nodes["gate:out"].ours!).toBeLessThan(0.5);
  });

  it("or_factory_returns_analog_element", async () => {
    const factory: AnalogFactory = makeOrAnalogFactory(2);
    expect(typeof factory).toBe("function");

    const combos: [number, number, boolean][] = [
      [GND, GND, false],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, true],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: build2InputGate("Or", vA, vB),
        analysis: "dcop",
      });
      const vOut = session.getStepEnd(0).nodes["gate:out"].ours!;
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });

  it("nor_factory_returns_analog_element", async () => {
    const factory: AnalogFactory = makeNorAnalogFactory(2);
    expect(typeof factory).toBe("function");

    const combos: [number, number, boolean][] = [
      [GND, GND, true],
      [GND, VDD, false],
      [VDD, GND, false],
      [VDD, VDD, false],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: build2InputGate("NOr", vA, vB),
        analysis: "dcop",
      });
      const vOut = session.getStepEnd(0).nodes["gate:out"].ours!;
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });

  it("xor_factory_returns_analog_element", async () => {
    const factory: AnalogFactory = makeXorAnalogFactory(2);
    expect(typeof factory).toBe("function");

    const combos: [number, number, boolean][] = [
      [GND, GND, false],
      [GND, VDD, true],
      [VDD, GND, true],
      [VDD, VDD, false],
    ];
    for (const [vA, vB, expectHigh] of combos) {
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: build2InputGate("XOr", vA, vB),
        analysis: "dcop",
      });
      const vOut = session.getStepEnd(0).nodes["gate:out"].ours!;
      if (expectHigh) {
        expect(vOut).toBeGreaterThan(2.0);
      } else {
        expect(vOut).toBeLessThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Pin-loading test (Entry 1 voltage-sag assertion).
//
// A non-ideal source drives the gate's `In_1` net through a 10 kohm series
// resistor. With `rIn = 100 kohm` from the CMOS_3V3 family on a loaded pin,
//   vNet = 5 * 100k / (10k + 100k) = 4.545454545454...V
// On an ideal pin (no input load), vNet stays at 5.0V exactly.
// ---------------------------------------------------------------------------

describe("Pin loading", () => {
  function buildGateWithLoadedSel(loading: "loaded" | "ideal") {
    return (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      const c = facade.build({
        components: [
          { id: "vsIn", type: "DcVoltageSource", props: { label: "vsIn", voltage: 5 } },
          { id: "vsB",  type: "DcVoltageSource", props: { label: "vsB",  voltage: 0 } },
          { id: "rsrc", type: "Resistor",        props: { label: "rsrc", resistance: 10_000 } },
          { id: "gate", type: "And",             props: { label: "gate", model: "behavioral", inputCount: 2 } },
          { id: "rLoad", type: "Resistor",       props: { label: "rLoad", resistance: LOAD_R } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vsIn:pos",  "rsrc:A"],
          ["rsrc:B",    "gate:In_1"],
          ["vsB:pos",   "gate:In_2"],
          ["gate:out",  "rLoad:A"],
          ["rLoad:B",   "gnd:out"],
          ["vsIn:neg",  "gnd:out"],
          ["vsB:neg",   "gnd:out"],
        ],
      });
      // Per-net override- Decision #10:
      c.metadata.digitalPinLoadingOverrides = [
        { anchor: { type: "pin", instanceId: "gate", pinLabel: "In_1" }, loading },
      ];
      return c;
    };
  }

  it("loaded_pin_sees_voltage_sag", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildGateWithLoadedSel("loaded"),
      analysis: "dcop",
    });
    // 5V * 100k / (10k + 100k) = 4.5454545454...V
    const vNet = session.getStepEnd(0).nodes["gate:In_1"].ours!;
    expect(vNet).toBeCloseTo(4.5454545454545454, 9);
  });

  it("ideal_pin_sees_full_source_voltage", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildGateWithLoadedSel("ideal"),
      analysis: "dcop",
    });
    const vNet = session.getStepEnd(0).nodes["gate:In_1"].ours!;
    expect(vNet).toBeCloseTo(5.0, 9);
  });
});

// ---------------------------------------------------------------------------
// Direct-role test (Entry 1 matrixRowLabels assertion).
//
// Gate output pins always use `role="direct"` (conductance + Norton source
// form), never `role="branch"`. Per `capture.ts:159`, branch rows are tagged
// `${label}:branch`. We assert no row label matches `gate:.*:branch`.
// ---------------------------------------------------------------------------

describe("Direct role", () => {
  it("gate_output_uses_direct_role", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: build2InputGate("Or", VDD, GND),
      analysis: "dcop",
    });
    const matrixRowLabels = (session as unknown as {
      _ourTopology: { matrixRowLabels: Map<number, string> };
    })._ourTopology.matrixRowLabels;
    const branchLabelPattern = /^gate:.*:branch$/;
    let hasGateBranchRow = false;
    matrixRowLabels.forEach((label) => {
      if (branchLabelPattern.test(label)) hasGateBranchRow = true;
    });
    expect(hasGateBranchRow).toBe(false);
  });
});
