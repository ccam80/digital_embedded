import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

import type { Circuit } from "../../../core/circuit.js";
import type { ComponentSpec } from "../../../headless/netlist-types.js";
import type { CircuitElement } from "../../../core/element.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITS = 8;
const V_REF = 5.0;

// .dts fixture for T3 harness categories (full-scale: all 8 inputs HIGH at 5V)
const DTS_FULLSCALE = path.resolve(
  "src/components/active/__tests__/fixtures/dac-canon-fullscale.dts",
);
const DTS_ZERO = path.resolve(
  "src/components/active/__tests__/fixtures/dac-canon-zero.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factory (T1 categories)
// ---------------------------------------------------------------------------

function buildDacCircuit(args: {
  inputBits: boolean[];
  vRef?: number;
  vHigh?: number;
  paramOverrides?: Record<string, number>;
}): (_registry: unknown, facade: import("../../../headless/default-facade.js").DefaultSimulatorFacade) => Circuit {
  const vRef = args.vRef ?? V_REF;
  const driveHigh = args.vHigh ?? vRef;
  const overrides = args.paramOverrides ?? {};

  return (_registry, facade) => {
    const components: ComponentSpec[] = [
      { id: "dac",   type: "DAC",             props: { label: "dac", bits: BITS, ...overrides } },
      { id: "vref",  type: "DcVoltageSource", props: { label: "vref", voltage: vRef } },
      { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 1e6 } },
      { id: "gnd",   type: "Ground",          props: {} },
    ];
    for (let i = 0; i < BITS; i++) {
      const v = args.inputBits[i] ? driveHigh : 0.0;
      components.push({ id: `vd${i}`, type: "DcVoltageSource", props: { label: `vd${i}`, voltage: v } });
    }
    const connections: Array<[string, string]> = [
      ["vref:pos",  "dac:VREF"],
      ["vref:neg",  "gnd:out"],
      ["dac:GND",   "gnd:out"],
      ["dac:OUT",   "rload:pos"],
      ["rload:neg", "gnd:out"],
    ];
    for (let i = 0; i < BITS; i++) {
      connections.push([`vd${i}:pos`, `dac:D${i}`]);
      connections.push([`vd${i}:neg`, `gnd:out`]);
    }
    return facade.build({ components, connections });
  };
}

/** Convert a decimal code (0..2^N - 1) to an array of N booleans (LSB first). */
function codeToBits(code: number): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < BITS; i++) bits.push((code & (1 << i)) !== 0);
  return bits;
}

/** Resolve the MNA node id for the DAC OUT pin. */
function getDacOutNode(fix: ReturnType<typeof buildFixture>): number {
  const id =
    fix.circuit.labelToNodeId.get("dac:OUT") ??
    fix.circuit.labelToNodeId.get("rload:pos");
  if (id === undefined) throw new Error("DAC:OUT node id not found in labelToNodeId map");
  return id;
}

/** Resolve the CircuitElement for the DAC parent (for setComponentProperty). */
function getDacCircuitElement(fix: ReturnType<typeof buildFixture>): CircuitElement {
  const ce = fix.coordinator.compiled.labelToCircuitElement.get("dac");
  if (ce === undefined) throw new Error("DAC CircuitElement not found by label 'dac'");
  return ce;
}

// ===========================================================================
// Category 1 — Initialization (T1)
// ---------------------------------------------------------------------------
// Post-warm-start: DAC OUT node settles to the correct target voltage
// after the warm-start step that drives setup() + initState() + first step.
// ===========================================================================

describe("DAC initialization (T1)", () => {
  it("init_out_resolves_to_full_scale_after_warm_start", () => {
    // All bits HIGH → code = 255 → V_OUT = V_REF · 255/255 = V_REF (5V).
    // Closed-form: 5.0V.
    const fix = buildFixture({
      build: buildDacCircuit({ inputBits: Array(BITS).fill(true) }),
    });
    const out = getDacOutNode(fix);
    const vOut = fix.engine.getNodeVoltage(out);
    expect(vOut).toBeCloseTo(V_REF, 2);
  });

  it("init_out_resolves_to_zero_after_warm_start_all_low", () => {
    // All bits LOW → code = 0 → V_OUT = 0V.
    const fix = buildFixture({
      build: buildDacCircuit({ inputBits: Array(BITS).fill(false) }),
    });
    const out = getDacOutNode(fix);
    const vOut = fix.engine.getNodeVoltage(out);
    expect(vOut).toBeCloseTo(0, 4);
  });
});

// ===========================================================================
// Category 2 — DC operating point analytical (T1)
// ---------------------------------------------------------------------------
// V_OUT = V_REF · code / (2^N - 1) for the unipolar DAC.
// Closed-form expected values verified against dcOperatingPoint().
// ===========================================================================

describe("DAC DCOP analytical (T1)", () => {
  it("dcop_full_scale", () => {
    // code = 255 → V_OUT = 5.0V.
    const fix = buildFixture({
      build: buildDacCircuit({ inputBits: Array(BITS).fill(true) }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(getDacOutNode(fix))).toBeCloseTo(V_REF, 2);
  });

  it("dcop_zero_code", () => {
    // code = 0 → V_OUT = 0V.
    const fix = buildFixture({
      build: buildDacCircuit({ inputBits: Array(BITS).fill(false) }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(getDacOutNode(fix))).toBeCloseTo(0, 4);
  });

  it("dcop_midscale_msb_only", () => {
    // D7 (MSB) = 1, rest = 0 → code = 128 → V_OUT = 5 · 128/255 ≈ 2.510V.
    const bits = Array(BITS).fill(false);
    bits[BITS - 1] = true;
    const fix = buildFixture({ build: buildDacCircuit({ inputBits: bits }) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(getDacOutNode(fix))).toBeCloseTo((V_REF * 128) / 255, 2);
  });

  it("dcop_monotonic_ramp", () => {
    // V_OUT increases monotonically as code increases 0..255 (sampled at 17 points).
    const codes = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];
    const voltages: number[] = [];
    for (const code of codes) {
      const fix = buildFixture({ build: buildDacCircuit({ inputBits: codeToBits(code) }) });
      fix.coordinator.dcOperatingPoint();
      voltages.push(fix.engine.getNodeVoltage(getDacOutNode(fix)));
    }
    for (let i = 1; i < voltages.length; i++) {
      expect(voltages[i]!).toBeGreaterThan(voltages[i - 1]!);
    }
  });

  it("dcop_lsb_step_size", () => {
    // LSB step = V_REF / (2^N - 1) = 5/255 ≈ 0.019608V. Verified at three
    // consecutive code transitions.
    const sample = (code: number): number => {
      const fix = buildFixture({ build: buildDacCircuit({ inputBits: codeToBits(code) }) });
      fix.coordinator.dcOperatingPoint();
      return fix.engine.getNodeVoltage(getDacOutNode(fix));
    };
    const expectedLsb = V_REF / 255;
    expect(sample(1) - sample(0)).toBeCloseTo(expectedLsb, 3);
    expect(sample(2) - sample(1)).toBeCloseTo(expectedLsb, 3);
    expect(sample(128) - sample(127)).toBeCloseTo(expectedLsb, 3);
  });

  it("dcop_output_scales_with_vref", () => {
    // Full-scale at VREF=5V and VREF=3.3V; output ratio must equal VREF ratio.
    const allHigh = Array(BITS).fill(true);
    const fix5 = buildFixture({ build: buildDacCircuit({ inputBits: allHigh, vRef: 5.0 }) });
    fix5.coordinator.dcOperatingPoint();
    const v5 = fix5.engine.getNodeVoltage(getDacOutNode(fix5));

    const fix33 = buildFixture({ build: buildDacCircuit({ inputBits: allHigh, vRef: 3.3 }) });
    fix33.coordinator.dcOperatingPoint();
    const v33 = fix33.engine.getNodeVoltage(getDacOutNode(fix33));

    // v33/v5 = 3.3/5.0 ≈ 0.66
    expect(v33 / v5).toBeCloseTo(3.3 / 5.0, 2);
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
// One it() per parameter declared on DAC_PARAM_DEFS. Asserts documented
// post-change observable per the parameter contract.
// ===========================================================================

describe("DAC parameter hot-load (T1)", () => {
  function setupHotLoadFix(vHigh = V_REF): {
    fix: ReturnType<typeof buildFixture>;
    ce: CircuitElement;
    out: number;
  } {
    const fix = buildFixture({
      build: buildDacCircuit({
        inputBits: Array(BITS).fill(true),
        vRef: V_REF,
        vHigh,
      }),
    });
    const ce = getDacCircuitElement(fix);
    const out = getDacOutNode(fix);
    return { fix, ce, out };
  }

  it("hotload_vIH_shifts_threshold_so_3p3v_reads_low", () => {
    // Contract: vIH = 4.0V. Drive all bits at 3.3V. Documented:
    // 3.3V < vIH → all bits LOW → code = 0 → V_OUT = 0V.
    const { fix, ce, out } = setupHotLoadFix(3.3);
    const vBefore = fix.engine.getNodeVoltage(out);
    fix.coordinator.setComponentProperty(ce, "vIH", 4.0);
    fix.coordinator.step();
    const vAfter = fix.engine.getNodeVoltage(out);
    expect(vAfter).not.toBeCloseTo(vBefore);
    expect(vAfter).toBeCloseTo(0, 4);
  });

  it("hotload_vIL_shifts_threshold_so_1v_reads_low", () => {
    // Contract: vIL = 1.5V. Drive all bits at 1.0V. Documented:
    // 1.0V < vIL → all bits LOW → code = 0 → V_OUT = 0V.
    const { fix, ce, out } = setupHotLoadFix(1.0);
    fix.coordinator.setComponentProperty(ce, "vIL", 1.5);
    fix.coordinator.step();
    const vAfter = fix.engine.getNodeVoltage(out);
    expect(vAfter).toBeCloseTo(0, 4);
  });

  it("hotload_rOut_sags_output_under_load", () => {
    // Contract: rOut = 1000Ω with 1MΩ load. Closed form:
    // V_OUT = V_target · R_load / (R_load + rOut) = 5 · 1e6 / (1e6 + 1e3) ≈ 4.9950V.
    const { fix, ce, out } = setupHotLoadFix();
    fix.coordinator.setComponentProperty(ce, "rOut", 1e3);
    fix.coordinator.step();
    const vAfter = fix.engine.getNodeVoltage(out);
    const expected = V_REF * 1e6 / (1e6 + 1e3);
    expect(vAfter).toBeCloseTo(expected, 3);
  });

  it("hotload_rIn_changes_input_loading_network", () => {
    // Contract: rIn changes the per-data-pin input loading resistance.
    // With all bits driven by ideal VSRCs at V_REF, V_OUT stays at V_REF
    // before and after the hot-load (no DC attenuation through rIn).
    const { fix, ce, out } = setupHotLoadFix();
    const vBefore = fix.engine.getNodeVoltage(out);
    fix.coordinator.setComponentProperty(ce, "rIn", 1e5);
    fix.coordinator.step();
    const vAfter = fix.engine.getNodeVoltage(out);
    expect(vAfter).toBeCloseTo(vBefore, 2);
    expect(vAfter).toBeCloseTo(V_REF, 2);
  });

  it("hotload_cIn_changes_input_loading_capacitance", () => {
    // Contract: cIn changes per-data-pin input loading capacitance.
    // At DC the capacitor is open; V_OUT stays at V_REF before and after.
    const { fix, ce, out } = setupHotLoadFix();
    const vBefore = fix.engine.getNodeVoltage(out);
    fix.coordinator.setComponentProperty(ce, "cIn", 1e-9);
    fix.coordinator.step();
    const vAfter = fix.engine.getNodeVoltage(out);
    expect(vAfter).toBeCloseTo(vBefore, 2);
    expect(vAfter).toBeCloseTo(V_REF, 2);
  });
});

// ===========================================================================
// Category 9 — Bridge / digital interaction (T1)
// ---------------------------------------------------------------------------
// Cross-domain path: analog voltage on data pins → DACDriver threshold →
// binary code → V_OUT. Exercises the full composite expansion.
// ===========================================================================

describe("DAC bridge / digital interaction (T1)", () => {
  it("digital_high_inputs_drive_full_scale_analog", () => {
    // All D_i at V_REF (5V) → code = 255 → V_OUT = V_REF.
    const fix = buildFixture({
      build: buildDacCircuit({ inputBits: Array(BITS).fill(true) }),
    });
    fix.coordinator.step();
    expect(fix.engine.getNodeVoltage(getDacOutNode(fix))).toBeCloseTo(V_REF, 2);
  });

  it("digital_low_inputs_drive_zero_analog", () => {
    // All D_i at 0V → code = 0 → V_OUT = 0V.
    const fix = buildFixture({
      build: buildDacCircuit({ inputBits: Array(BITS).fill(false) }),
    });
    fix.coordinator.step();
    expect(fix.engine.getNodeVoltage(getDacOutNode(fix))).toBeCloseTo(0, 4);
  });

  it("digital_msb_only_drives_mid_analog", () => {
    // D7 (MSB) only HIGH → code = 128 → V_OUT = V_REF · 128/255 ≈ 2.510V.
    const bits = Array(BITS).fill(false);
    bits[BITS - 1] = true;
    const fix = buildFixture({ build: buildDacCircuit({ inputBits: bits }) });
    fix.coordinator.step();
    expect(fix.engine.getNodeVoltage(getDacOutNode(fix))).toBeCloseTo((V_REF * 128) / 255, 2);
  });

  it("vref_scales_analog_output_proportionally", () => {
    // Full-scale code at VREF=5V vs VREF=3.3V: output ratio = VREF ratio.
    const allHigh = Array(BITS).fill(true);
    const fix5 = buildFixture({ build: buildDacCircuit({ inputBits: allHigh, vRef: 5.0 }) });
    fix5.coordinator.step();
    const v5 = fix5.engine.getNodeVoltage(getDacOutNode(fix5));

    const fix33 = buildFixture({ build: buildDacCircuit({ inputBits: allHigh, vRef: 3.3 }) });
    fix33.coordinator.step();
    const v33 = fix33.engine.getNodeVoltage(getDacOutNode(fix33));

    expect(v33 / v5).toBeCloseTo(3.3 / 5.0, 2);
  });
});

// ===========================================================================
// Category 2 (numerical) / 3 / 5 — Harness paired vs ngspice (T3)
// Two operating regions: full-scale (all bits HIGH) and zero-code (all LOW).
// ===========================================================================

describeIfDll("DAC full-scale paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_FULLSCALE, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_fullscale", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_fullscale", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_fullscale", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("DAC zero-code paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_ZERO, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_zero", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_zero", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_zero", () => {
    session.compareAllAttempts();
  });
});
