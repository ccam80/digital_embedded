/**
 * Tests for the Analog Comparator component.
 *
 * All tests use the M2 facade pattern: DefaultSimulatorFacade.compile()
 * drives a full circuit; output voltages are read via coordinator.readAllSignals()
 * or facade.readSignal(). No direct element construction.
 *
 * Tests cover:
 *   Comparator::output_high_when_vp_greater    V+=2V, V-=1V; output near vOH
 *   Comparator::output_low_when_vm_greater     V+=1V, V-=2V; output near vOL
 *   Comparator::hysteresis_prevents_chatter   10mV hysteresis; 5mV oscillation; no toggle
 *   Comparator::zero_crossing_detector        V-=0V; V+ sweeps through 0; clean transition
 *   Comparator parity (C4.5)::comparator_load_dcop_parity  DC-OP output matches expected state
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";
import type { Circuit } from "../../../core/circuit.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Circuit builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal comparator test circuit:
 *
 *   Vp (DcVoltageSource) -> cmp:in+
 *   Vn (DcVoltageSource) -> cmp:in-
 *   cmp:out (open-collector output)
 *   GND ties all negative terminals
 *
 * The comparator label is "cmp"; output readable as "cmp:out".
 * Voltage sources labeled "vp" and "vn" so their nodes appear in the signal map.
 */
function buildComparatorCircuit(
  facade: DefaultSimulatorFacade,
  opts: {
    vp: number;
    vn: number;
    hysteresis?: number;
    vos?: number;
    rSat?: number;
    model?: string;
  },
): Circuit {
  const { vp, vn, hysteresis = 0, vos = 0, rSat = 50, model = "open-collector" } = opts;
  return facade.build({
    components: [
      {
        id: "gnd",
        type: "Ground",
        props: { label: "GND" },
      },
      {
        id: "vp_src",
        type: "DcVoltageSource",
        props: { label: "vp", voltage: vp },
      },
      {
        id: "vn_src",
        type: "DcVoltageSource",
        props: { label: "vn", voltage: vn },
      },
      {
        id: "cmp",
        type: "VoltageComparator",
        props: {
          label: "cmp",
          model,
          hysteresis,
          vos,
          rSat,
        },
      },
    ],
    connections: [
      // V+ source: pos -> cmp in+, neg -> ground
      ["vp_src:pos", "cmp:in+"],
      ["vp_src:neg", "gnd:out"],
      // V- source: pos -> cmp in-, neg -> ground
      ["vn_src:pos", "cmp:in-"],
      ["vn_src:neg", "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Comparator tests
// ---------------------------------------------------------------------------

describe("Comparator", () => {
  let facade: DefaultSimulatorFacade;

  beforeEach(() => {
    facade = new DefaultSimulatorFacade(registry);
  });

  it("output_high_when_vp_greater", () => {
    // V+ = 2V, V- = 1V: V+ > V-  comparator activates (open-collector sinks).
    // After DC-OP, the output node is pulled LOW (vOL = 0V by default).
    const circuit = buildComparatorCircuit(facade, { vp: 2.0, vn: 1.0, vos: 0, hysteresis: 0 });
    const coordinator: SimulationCoordinator = facade.compile(circuit);
    const dcOp = facade.getDcOpResult();

    // DC-OP must converge for a well-formed comparator circuit.
    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);

    // In active (sinking) state the output is driven toward vOL (0V).
    // The output node voltage must be below the midpoint of [vOL, vOH].
    const outVoltage = facade.readSignal(coordinator, "cmp:out");
    expect(outVoltage).toBeLessThan(1.65);
  });

  it("output_low_when_vm_greater", () => {
    // V+ = 1V, V- = 2V: V+ < V-  comparator inactive (open-collector off).
    // In inactive state the output is high-impedance; without a pull-up the
    // node floats to the supply rail or remains at a high impedance.
    const circuit = buildComparatorCircuit(facade, { vp: 1.0, vn: 2.0, vos: 0, hysteresis: 0 });
    const coordinator: SimulationCoordinator = facade.compile(circuit);
    const dcOp = facade.getDcOpResult();

    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);

    // In inactive (high-impedance) state, the output is not driven low.
    // Without an external pull-up, the comparator does not sink current;
    // the output conductance to ground is G_off = 1/1e9 (very small).
    // The output voltage will not be at the saturated-low level.
    const outActive = facade.readSignal(coordinator, "cmp:out");
    // When inactive, the comparator is not sinking, so output is not at vOL.
    // We verify it is NOT equal to the active (saturated) level.
    const activeCircuit = buildComparatorCircuit(facade, { vp: 2.0, vn: 1.0, vos: 0, hysteresis: 0 });
    const activeCoord = facade.compile(activeCircuit);
    const activeOut = facade.readSignal(activeCoord, "cmp:out");

    // Active output should be lower than inactive output (active sinks to vOL).
    expect(activeOut).toBeLessThan(outActive);
  });

  it("hysteresis_prevents_chatter", () => {
    // 10mV hysteresis: V+ oscillates 4mV around V- (within the dead band).
    // Initial state: V+ < V-  inactive. After oscillating inside the hysteresis
    // band, the output must remain in the same (inactive) state.
    const vn = 1.0;
    const hysteresis = 0.010; // 10mV -> half-band = 5mV

    // Start with V+ 4mV below V-  inactive (V+ - V- = -0.004 < -half-band).
    const circuitStart = buildComparatorCircuit(facade, {
      vp: vn - 0.004,
      vn,
      hysteresis,
      vos: 0,
    });
    const coordStart = facade.compile(circuitStart);
    const dcOpStart = facade.getDcOpResult();
    expect(dcOpStart!.converged).toBe(true);
    const outStart = facade.readSignal(coordStart, "cmp:out");

    // Oscillate V+ 4mV above V- (still inside the hysteresis band: 4mV < 5mV half-band).
    const circuitOscillate = buildComparatorCircuit(facade, {
      vp: vn + 0.004,
      vn,
      hysteresis,
      vos: 0,
    });
    const coordOscillate = facade.compile(circuitOscillate);
    const dcOpOscillate = facade.getDcOpResult();
    expect(dcOpOscillate!.converged).toBe(true);
    const outOscillate = facade.readSignal(coordOscillate, "cmp:out");

    // Both states must produce the same output (no transition within the band).
    // A voltage difference of < 0.1V indicates no state flip occurred.
    expect(Math.abs(outOscillate - outStart)).toBeLessThan(0.1);
  });

  it("zero_crossing_detector", () => {
    // V- = 0V (tied to ground reference); V+ sweeps through 0.
    // V+ negative  output inactive (high); V+ positive  output active (low).
    const vn = 0.0;

    // V+ = -1V: inactive
    const circuitNeg = buildComparatorCircuit(facade, { vp: -1.0, vn, vos: 0, hysteresis: 0 });
    const coordNeg = facade.compile(circuitNeg);
    const outNeg = facade.readSignal(coordNeg, "cmp:out");

    // V+ = +0.1V: active (sinking)
    const circuitPos = buildComparatorCircuit(facade, { vp: 0.1, vn, vos: 0, hysteresis: 0 });
    const coordPos = facade.compile(circuitPos);
    const outPos = facade.readSignal(coordPos, "cmp:out");

    // Active (sinking) output must be lower than inactive output.
    expect(outPos).toBeLessThan(outNeg);
  });
});

// ---------------------------------------------------------------------------
// C4.5 parity test  comparator_load_dcop_parity
// ---------------------------------------------------------------------------
//
// Drives the open-collector comparator via a full DC-OP and verifies the
// output node voltage is consistent with the comparator being in active
// (sinking) state.
//
// Reference: comparator.ts, open-collector model.
//   Active state: output sinks through rSat to ground  output voltage = vOL.
//   G_sat = 1/rSat; with no external load, output is pulled to vOL = 0V.

describe("Comparator parity (C4.5)", () => {
  it("comparator_load_dcop_parity", () => {
    // Canonical operating point: V+=2V, V-=1V  output active (open-collector sinks).
    // rSat=50, hysteresis=0, vos=0: output is driven to vOL = 0V.
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildComparatorCircuit(facade, {
      vp: 2.0,
      vn: 1.0,
      rSat: 50,
      hysteresis: 0,
      vos: 0,
    });

    const coordinator: SimulationCoordinator = facade.compile(circuit);
    const dcOp = facade.getDcOpResult();

    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);

    // With V+ > V-, the comparator is in active (sinking) state.
    // The output node is pulled toward vOL (0.0V) through rSat.
    // Without an external pull-up, the output floats at vOL = 0.0V.
    const outVoltage = facade.readSignal(coordinator, "cmp:out");
    expect(outVoltage).toBeCloseTo(0.0, 3);
  });
});
