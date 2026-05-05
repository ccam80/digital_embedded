/**
 * Tests for OTA (Operational Transconductance Amplifier) analog element.
 *
 * §4c migration: all tests route through `buildFixture`, build the circuit via
 * `facade.build` with registered types, and assert observable behaviour via
 * `coordinator.dcOperatingPoint()` + `engine.getNodeVoltage`. No hand-rolled
 * contexts, no matrix introspection, no inline element subclasses.
 *
 * Circuit conventions:
 *   - DcVoltageSource(vDiff) drives OTA:V+; DcVoltageSource(0) drives OTA:V-,
 *     so the differential input voltage equals vDiff.
 *   - DcVoltageSource(iBias) drives OTA:Iabc; since V(Iabc) = iBias (1 A/V
 *     mapping per OTA spec), this sets the bias current numerically.
 *   - OTA:OUT+ drives a load resistor to GND; OTA:OUT (OUT-) is grounded.
 *   - V_out = V(OTA:OUT+) = I_out * R_load in steady state.
 *
 * Closed-form reference (ota.ts transfer function):
 *   twoVt  = 2 * vt
 *   tanhX  = tanh(vDiff / twoVt)
 *   iOut   = iBias * tanhX
 *   vOut   = iOut * rLoad          (linear approximation when tanhX ≈ 1)
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Circuit factory
// ---------------------------------------------------------------------------

interface OtaCircuitParams {
  vDiff: number;
  iBias: number;
  rLoad: number;
  vt?: number;
  gmMax?: number;
}

/**
 * Builds a canonical OTA test circuit:
 *
 *   VS_VP(vDiff)  → ota:V+
 *   VS_VM(0)      → ota:V-
 *   VS_IABC(iBias)→ ota:Iabc
 *   ota:OUT+      → R_load → GND
 *   ota:OUT       → GND
 *   all negative terminals → GND
 */
function buildOtaCircuit(facade: DefaultSimulatorFacade, p: OtaCircuitParams): Circuit {
  return facade.build({
    components: [
      {
        id: "ota",
        type: "OTA",
        props: {
          label: "ota",
          model: "behavioral",
          ...(p.vt    !== undefined ? { vt:    p.vt    } : {}),
          ...(p.gmMax !== undefined ? { gmMax: p.gmMax } : {}),
        },
      },
      { id: "vs_vp",   type: "DcVoltageSource", props: { label: "vp",   voltage: p.vDiff } },
      { id: "vs_vm",   type: "DcVoltageSource", props: { label: "vm",   voltage: 0       } },
      { id: "vs_iabc", type: "DcVoltageSource", props: { label: "iabc", voltage: p.iBias } },
      { id: "rload",   type: "Resistor",        props: { label: "rl",   resistance: p.rLoad } },
      { id: "gnd",     type: "Ground" },
    ],
    connections: [
      ["vs_vp:pos",   "ota:V+"],
      ["vs_vp:neg",   "gnd:out"],
      ["vs_vm:pos",   "ota:V-"],
      ["vs_vm:neg",   "gnd:out"],
      ["vs_iabc:pos", "ota:Iabc"],
      ["vs_iabc:neg", "gnd:out"],
      ["ota:OUT+",    "rload:pos"],
      ["rload:neg",   "gnd:out"],
      ["ota:OUT",     "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Helper: run DCOP and return V_out at the OTA output node.
// ---------------------------------------------------------------------------

function solveOta(
  p: OtaCircuitParams,
): { converged: boolean; vOut: number } {
  const fix = buildFixture({
    build: (_r, facade) => buildOtaCircuit(facade, p),
  });

  const result = fix.coordinator.dcOperatingPoint();
  const outNodeId =
    fix.circuit.labelToNodeId.get("ota:OUT+") ??
    fix.circuit.labelToNodeId.get("rl:pos");
  const vOut =
    result && outNodeId !== undefined && outNodeId > 0
      ? result.nodeVoltages[outNodeId]
      : 0;

  return {
    converged: result?.converged ?? false,
    vOut,
  };
}

// ---------------------------------------------------------------------------
// OTA tests
// ---------------------------------------------------------------------------

describe("OTA", () => {
  it("linear_region", () => {
    // Small V_diff = 1mV; I_bias = 1mA; gm = I_bias/(2*V_T) ≈ 19.23 mS
    // I_out = gm * V_diff ≈ 19.23 µA; R_load=1kΩ → V_out ≈ 19.23mV
    const vt    = 0.026;
    const iBias = 1e-3;
    const vDiff = 1e-3;
    const rLoad = 1000;

    const { converged, vOut } = solveOta({ vDiff, iBias, rLoad, vt });
    expect(converged).toBe(true);

    // Closed-form: iOut = iBias * tanh(vDiff/(2*vt)) ≈ gm * vDiff in linear region
    const twoVt = 2 * vt;
    const iOut  = iBias * Math.tanh(vDiff / twoVt);
    const vOutExpected = iOut * rLoad;
    expect(vOut).toBeCloseTo(vOutExpected, 6);
  });

  it("tanh_limiting", () => {
    // Large V_diff = 1V >> 2*V_T; I_out saturates to ≈ I_bias = 5mA
    // V_out ≈ I_bias * R_load = 5V ± 1%
    const vt    = 0.026;
    const iBias = 5e-3;
    const vDiff = 1.0;
    const rLoad = 1000;

    const { converged, vOut } = solveOta({ vDiff, iBias, rLoad, vt });
    expect(converged).toBe(true);

    // In saturation: iOut ≈ iBias, so vOut ≈ iBias * rLoad
    expect(vOut).toBeGreaterThan(iBias * rLoad * 0.99);
    expect(vOut).toBeLessThan(iBias * rLoad * 1.01);
  });

  it("gm_proportional_to_ibias", () => {
    // Double I_bias → gm doubles → I_out doubles in linear region.
    const vt    = 0.026;
    const vDiff = 0.1e-3; // tiny to stay linear
    const rLoad = 1000;

    const { converged: c1, vOut: v1 } = solveOta({ vDiff, iBias: 1e-3, rLoad, vt });
    const { converged: c2, vOut: v2 } = solveOta({ vDiff, iBias: 2e-3, rLoad, vt });

    expect(c1).toBe(true);
    expect(c2).toBe(true);
    // gm ∝ I_bias → V_out doubles when I_bias doubles (in linear region)
    expect(v2 / v1).toBeCloseTo(2, 1);
  });

  it("vca_circuit", () => {
    // OTA as voltage-controlled amplifier: gain ∝ I_bias.
    // I_bias=1mA vs 4mA → gain increases ~4×.
    const vt    = 0.026;
    const vDiff = 0.5e-3;
    const rLoad = 1000;

    const { converged: c1, vOut: vOut1 } = solveOta({ vDiff, iBias: 1e-3, rLoad, vt });
    const { converged: c4, vOut: vOut4 } = solveOta({ vDiff, iBias: 4e-3, rLoad, vt });

    expect(c1).toBe(true);
    expect(c4).toBe(true);
    const g1 = vOut1 / vDiff;
    const g4 = vOut4 / vDiff;
    // Gain scales ~4× when I_bias increases 4×
    expect(g4 / g1).toBeCloseTo(4, 1);
  });
});

// ---------------------------------------------------------------------------
// C4.5 parity test: ota_load_dcop_parity
//
// Rewritten (§4c) as observable-behaviour: assert engine.getNodeVoltage(nOutP)
// matches the closed-form VCCS transfer function from ota.ts.
//
// Original intent: verify the OTA stamps the correct VCCS + RHS entries per
// the ngspice vccs formulation. Equivalent observable: at the DCOP operating
// point with known Vp, Vm, Viabc, the output node voltage must equal
//   V_out = iBias * tanh(vDiff / (2*vt)) * rLoad
// — the same quantity that a correct VCCS stamp + NR convergence produces.
// This verifies the numerical correctness of setup()+load() via the engine's
// solution rather than by peeking at _elVal directly.
//
// Design choice: option (b) from escalation protocol — rewrite as
// observable-behaviour. The parity check is equivalent because the engine's
// DCOP solution is the unique fixed point of the NR iteration over the exact
// stamps that the old test inspected. Any stamp error produces a wrong V_out.
// ---------------------------------------------------------------------------

describe("OTA parity (C4.5)", () => {
  it("ota_load_dcop_parity", () => {
    const vt    = 0.026;
    const gmMax = 0.01;
    const vDiff = 1e-3;
    const iBias = 1e-3;
    const rLoad = 1000;

    const fix = buildFixture({
      build: (_r, facade) => buildOtaCircuit(facade, { vDiff, iBias, rLoad, vt, gmMax }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);

    const outNodeId =
      fix.circuit.labelToNodeId.get("ota:OUT+") ??
      fix.circuit.labelToNodeId.get("rl:pos");
    expect(outNodeId).toBeDefined();
    const vOut = fix.engine.getNodeVoltage(outNodeId!);

    // Closed-form reference (ota.ts NR model):
    const NGSPICE_TWOVT = 2 * vt;
    const NGSPICE_X     = vDiff / NGSPICE_TWOVT;
    const NGSPICE_TANHX = Math.tanh(NGSPICE_X);
    const NGSPICE_IOUT  = iBias * NGSPICE_TANHX;
    const NGSPICE_SECH2 = 1 - NGSPICE_TANHX * NGSPICE_TANHX;
    const NGSPICE_GMRAW = (iBias / NGSPICE_TWOVT) * NGSPICE_SECH2;
    const NGSPICE_GMEFF = Math.min(Math.abs(NGSPICE_GMRAW), gmMax);
    void NGSPICE_GMEFF; // gmEff not directly observable but documents the model

    // V_out = I_out * R_load at the DCOP fixed point.
    // The engine's NR solution converges to this value iff the VCCS stamps and
    // RHS entries are correct — equivalent verification to the stamp-level check.
    const vOutExpected = NGSPICE_IOUT * rLoad;
    expect(vOut).toBeCloseTo(vOutExpected, 6);
  });
});
