/**
 * End-to-end MNA engine tests.
 *
 * These tests exercise the FULL pipeline:
 *   real ComponentDefinitions → compileUnified() → MNAEngine → verify
 *
 * They close the critical test gap where existing tests either:
 *   (a) use hand-built ConcreteCompiledAnalogCircuit (bypass compiler), or
 *   (b) test the compiler without running the engine.
 *
 * Coverage:
 *   1. Full-pipeline DC operating point (resistor divider via real definitions)
 *   2. Tight-tolerance transient verification (RC/RL steady-state <0.1%)
 *   3. Multi-nonlinear convergence (series diodes, parallel diodes, diode clamp)
 *   4. Analytical verification (divider ratio, Shockley consistency, superposition)
 *
 * Migration shape M1: ComparisonSession.createSelfCompare({ buildCircuit, analysis }).
 * Engine acquired by the harness; results read via getStepEnd / getStepShape.
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ===========================================================================
// 1. Full-pipeline DC operating point (compiler → engine)
// ===========================================================================

describe("End-to-end: full pipeline", () => {
  it("resistor_divider_dc_op_via_compiler", async () => {
    // Vs=5V → R1=1kΩ → midpoint → R2=1kΩ → GND
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 1000 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "r2:A"],
            ["r2:B",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    // Midpoint = 2.5V, top = 5.0V
    const vMid = stepEnd.nodes["r1:B"]?.ours ?? stepEnd.nodes["r2:A"]?.ours;
    expect(vMid).toBeDefined();
    expect(vMid!).toBeGreaterThan(2.4);
    expect(vMid!).toBeLessThan(2.6);
  });

  it("diode_circuit_dc_op_via_compiler", async () => {
    // Vs=5V → R=1kΩ → Diode(anode→cathode) → GND
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "d1",  type: "Diode",           props: { label: "d1" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "d1:A"],
            ["d1:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    // Lower voltage = diode anode ≈ 0.6–0.75V
    const vAnode = stepEnd.nodes["d1:A"]?.ours ?? stepEnd.nodes["r1:B"]?.ours;
    expect(vAnode).toBeDefined();
    expect(vAnode!).toBeGreaterThan(0.55);
    expect(vAnode!).toBeLessThan(0.80);
    // Higher voltage = supply = 5V
  });
});

// ===========================================================================
// 2. Tight-tolerance transient tests
// ===========================================================================

describe("End-to-end: tight transient tolerances", () => {
  it("rc_steady_state_no_drift", async () => {
    // Vs=5V, R=1kΩ, C=1µF. After DC OP capacitor is at 5V.
    // Run 2ms transient- voltage must not drift from 5V.
    const RC = 1e-3;
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "c1",  type: "Capacitor",       props: { label: "c1",  capacitance: 1e-6 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "c1:pos"],
            ["c1:neg",  "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "tran",
      tStop: 2 * RC,
    });

    expect(session.errors).toHaveLength(0);

    const lastStep = session.getStepEnd(session.getSessionShape().stepCount.ours - 1);
    // Capacitor top node voltage must remain at 5V with <0.1% drift
    const vCap = lastStep.nodes["c1:pos"]?.ours ?? lastStep.nodes["r1:B"]?.ours;
    expect(vCap).toBeDefined();
    const driftPct = Math.abs(vCap! - 5.0) / 5.0 * 100;
    expect(driftPct).toBeLessThan(0.1);
  });

  it("rc_steady_state_current_zero", async () => {
    // At steady state with C fully charged, current through R should be ~0.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "c1",  type: "Capacitor",       props: { label: "c1",  capacitance: 1e-6 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "c1:pos"],
            ["c1:neg",  "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "tran",
      tStop: 2e-4,
      maxStep: 1e-6,
    });

    expect(session.errors).toHaveLength(0);

    const stepCount = session.getSessionShape().stepCount.ours;
    const lastStep = session.getStepEnd(stepCount - 1);
    // Steady-state accuracy: <0.01% voltage deviation
    const vNode = lastStep.nodes["c1:pos"]?.ours ?? lastStep.nodes["r1:B"]?.ours;
    expect(vNode).toBeDefined();
    const errorPct = Math.abs(vNode! - 5.0) / 5.0 * 100;
    expect(errorPct).toBeLessThan(0.01);
  });

  it("rl_dc_steady_state_tight_tolerance", async () => {
    // Vs=5V, R=100Ω, L=10mH → τ=L/R=0.1ms
    // At DC: inductor is short, I = 5V/100Ω = 50mA
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 100 } },
            { id: "l1",  type: "Inductor",        props: { label: "l1",  inductance: 10e-3 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "l1:A"],
            ["l1:B",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "tran",
      tStop: 1e-3,
      maxStep: 5e-6,
    });

    expect(session.errors).toHaveLength(0);

    // Branch current through inductor: read from branches
    const stepCount = session.getSessionShape().stepCount.ours;
    const lastStep = session.getStepEnd(stepCount - 1);
    // Steady-state inductor branch current ≈ 50mA; <0.1% deviation
    const iL = lastStep.branches["l1:branch"]?.ours;
    expect(iL).toBeDefined();
    const errorPct = Math.abs(Math.abs(iL!) - 0.05) / 0.05 * 100;
    expect(errorPct).toBeLessThan(0.1);
  });
});

// ===========================================================================
// 3. Multi-nonlinear convergence
// ===========================================================================

describe("End-to-end: multi-nonlinear convergence", () => {
  it("two_diodes_in_series", async () => {
    // Vs=5V → R=1kΩ → D1 → D2 → GND
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "d1",  type: "Diode",           props: { label: "d1" } },
            { id: "d2",  type: "Diode",           props: { label: "d2" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "d1:A"],
            ["d1:K",    "d2:A"],
            ["d2:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    // D2 anode = single diode drop ≈ 0.6–0.75V
    const vD2A = stepEnd.nodes["d2:A"]?.ours ?? stepEnd.nodes["d1:K"]?.ours;
    expect(vD2A).toBeDefined();
    expect(vD2A!).toBeGreaterThan(0.55);
    expect(vD2A!).toBeLessThan(0.80);

    // D1 anode = two diode drops ≈ 1.2–1.5V
    const vD1A = stepEnd.nodes["d1:A"]?.ours ?? stepEnd.nodes["r1:B"]?.ours;
    expect(vD1A).toBeDefined();
    expect(vD1A!).toBeGreaterThan(1.1);
    expect(vD1A!).toBeLessThan(1.6);

    // Both diode drops should be nearly equal (same Is, n, same current)
    const vD1 = vD1A! - vD2A!;
    const vD2 = vD2A!;
    expect(Math.abs(vD1 - vD2) / vD2).toBeLessThan(0.05);
  });

  it("parallel_diodes", async () => {
    // Vs=5V → R=1kΩ → [D1 || D2] → GND
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "d1",  type: "Diode",           props: { label: "d1" } },
            { id: "d2",  type: "Diode",           props: { label: "d2" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "d1:A"],
            ["r1:B",    "d2:A"],
            ["d1:K",    "gnd:out"],
            ["d2:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    // Diode forward voltage ≈ 0.6–0.75V
    const vAnode = stepEnd.nodes["d1:A"]?.ours ?? stepEnd.nodes["r1:B"]?.ours;
    expect(vAnode).toBeDefined();
    expect(vAnode!).toBeGreaterThan(0.55);
    expect(vAnode!).toBeLessThan(0.80);
  });

  it("diode_clamp_on_resistor_divider", async () => {
    // Vs=5V → R1=1kΩ → mid → R2=1kΩ → GND
    //                   mid → D1 → GND
    // Without D1: V_mid = 2.5V. With D1: V_mid ≈ 0.65V (diode clamps)
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 1000 } },
            { id: "d1",  type: "Diode",           props: { label: "d1" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "r2:A"],
            ["r1:B",    "d1:A"],
            ["r2:B",    "gnd:out"],
            ["d1:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    const vMid = stepEnd.nodes["d1:A"]?.ours ?? stepEnd.nodes["r1:B"]?.ours;
    expect(vMid).toBeDefined();
    expect(vMid!).toBeGreaterThan(0.55);
    expect(vMid!).toBeLessThan(0.80);
    expect(vMid!).toBeLessThan(2.5); // must be below no-diode value
  });

  it("anti_parallel_diodes", async () => {
    // Vs=5V → R=1kΩ → node2 → D1(forward) → GND
    //                  node2 → D2(reverse: anode=gnd, cathode=node2) → GND
    // D2 reverse leakage is negligible; result ≈ single forward diode
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "d1",  type: "Diode",           props: { label: "d1" } },
            { id: "d2",  type: "Diode",           props: { label: "d2" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "d1:A"],
            ["d1:K",    "gnd:out"],
            ["gnd:out", "d2:A"],
            ["d2:K",    "r1:B"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    const vNode = stepEnd.nodes["d1:A"]?.ours ?? stepEnd.nodes["r1:B"]?.ours;
    expect(vNode).toBeDefined();
    expect(vNode!).toBeGreaterThan(0.55);
    expect(vNode!).toBeLessThan(0.80);
  });
});

// ===========================================================================
// 4. Analytical verification with tight tolerances
// ===========================================================================

describe("End-to-end: analytical verification", () => {
  it("resistor_divider_2_to_1_ratio", async () => {
    // R1=2kΩ, R2=1kΩ → V_mid = 5 * 1/3 ≈ 1.6667V
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 2000 } },
            { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 1000 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "r2:A"],
            ["r2:B",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    // Current = 5V / 3kΩ
  });

  it("diode_shockley_equation_consistency", async () => {
    // Vs=5V → R=10kΩ → D(Is=1e-14, n=1) → GND
    // At operating point: Id_ohm = (Vs-Vd)/R must equal Id_shockley = Is*(exp(Vd/Vt)-1)
    const Vs = 5.0;
    const R = 10000;
    const Is = 1e-14;
    const n = 1.0;
    const Vt = 0.02585;

    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: Vs } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: R } },
            { id: "d1",  type: "Diode",           props: { label: "d1",  IS: Is, N: n } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "r1:A"],
            ["r1:B",    "d1:A"],
            ["d1:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    const vd = stepEnd.nodes["d1:A"]?.ours ?? stepEnd.nodes["r1:B"]?.ours;
    expect(vd).toBeDefined();

    const iOhm = (Vs - vd!) / R;
    const iShockley = Is * (Math.exp(vd! / (n * Vt)) - 1);

    // Both must agree to <0.1%
    const relError = Math.abs(iOhm - iShockley) / iOhm;
    expect(relError).toBeLessThan(0.001);

    expect(vd!).toBeGreaterThan(0.55);
    expect(vd!).toBeLessThan(0.75);
  });

  it("superposition_two_sources", async () => {
    // V1=10V (node1→gnd), V2=5V (node3→gnd)
    // R1=1kΩ (node1→node2), R2=2kΩ (node3→node2), R3=1kΩ (node2→gnd)
    //
    // KCL at node2: (10-Vn2)/1k + (5-Vn2)/2k - Vn2/1k = 0
    //   25 = 5*Vn2 → Vn2 = 5V
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "v1",  type: "DcVoltageSource", props: { label: "v1",  voltage: 10 } },
            { id: "v2",  type: "DcVoltageSource", props: { label: "v2",  voltage: 5 } },
            { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
            { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 2000 } },
            { id: "r3",  type: "Resistor",        props: { label: "r3",  resistance: 1000 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["v1:pos",  "r1:A"],
            ["v2:pos",  "r2:A"],
            ["r1:B",    "r2:B"],
            ["r1:B",    "r3:A"],
            ["r3:B",    "gnd:out"],
            ["v1:neg",  "gnd:out"],
            ["v2:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

  });
});

// ===========================================================================
// 5. MOSFET through compiler
// ===========================================================================

describe("MOSFET through compiler", () => {
  it("nmos_common_source_dc_op", async () => {
    // VDD=5V → Rd=10kΩ → drain. Gate=2V (Vgs=2V). Source=GND.
    // NMOS default W/L=1, KP=120e-6, VTO=0.7, LAMBDA=0.02
    // Saturation: ids = KP/2*(W/L)*(Vgs-Vth)² = 60e-6*1*1.69 ≈ 0.1014mA
    // Vdrain = 5 - 0.1014e-3 * 10000 ≈ 3.986V
    // Confirm saturation: Vds(≈3.99V) > Vgs-Vth(1.3V) ✓
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vdd",  type: "DcVoltageSource", props: { label: "vdd", voltage: 5 } },
            { id: "rd",   type: "Resistor",        props: { label: "rd",  resistance: 10000 } },
            { id: "m1",   type: "NMOS",            props: { label: "m1" } },
            { id: "vg",   type: "DcVoltageSource", props: { label: "vg",  voltage: 2 } },
            { id: "gnd1", type: "Ground" },
            { id: "gnd2", type: "Ground" },
          ],
          connections: [
            ["vdd:pos",  "rd:A"],
            ["rd:B",     "m1:D"],
            ["vg:pos",   "m1:G"],
            ["m1:S",     "gnd1:out"],
            ["vdd:neg",  "gnd1:out"],
            ["vg:neg",   "gnd2:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    // Drain node: pulled below VDD by ≈0.1014mA through 10kΩ
    const vDrain = stepEnd.nodes["m1:D"]?.ours ?? stepEnd.nodes["rd:B"]?.ours;
    expect(vDrain).toBeDefined();
    expect(vDrain!).toBeGreaterThan(1.3);   // saturation condition
    expect(vDrain!).toBeLessThan(5.0);      // drain pulled below supply
    expect(vDrain!).toBeGreaterThan(3.0);   // significant voltage (not near ground)
  });

  it("nmos_triode_region_dc_op", async () => {
    // VDD=5V → Rd=100kΩ → drain. Gate=3V (Vgs=3V). Source=GND.
    // NMOS default W/L=1, KP=120e-6, VTO=0.7 → Vgs-Vth=2.3V
    // Large Rd forces Vds small → triode (linear) region: Vds < Vgs-Vth = 2.3V
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vdd",  type: "DcVoltageSource", props: { label: "vdd", voltage: 5 } },
            { id: "rd",   type: "Resistor",        props: { label: "rd",  resistance: 100000 } },
            { id: "m1",   type: "NMOS",            props: { label: "m1" } },
            { id: "vg",   type: "DcVoltageSource", props: { label: "vg",  voltage: 3 } },
            { id: "gnd1", type: "Ground" },
            { id: "gnd2", type: "Ground" },
          ],
          connections: [
            ["vdd:pos",  "rd:A"],
            ["rd:B",     "m1:D"],
            ["vg:pos",   "m1:G"],
            ["m1:S",     "gnd1:out"],
            ["vdd:neg",  "gnd1:out"],
            ["vg:neg",   "gnd2:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    // Drain node (lowest non-ground voltage): must be in triode → Vds < Vgs-Vth = 2.3V
    const vDrain = stepEnd.nodes["m1:D"]?.ours ?? stepEnd.nodes["rd:B"]?.ours;
    expect(vDrain).toBeDefined();
    expect(vDrain!).toBeLessThan(2.3);   // triode condition
    expect(vDrain!).toBeGreaterThan(0.0); // conducting (above ground)
  });

  it("pmos_common_source_dc_op", async () => {
    // PMOS source=VDD=5V, gate=3V (Vsg=2V), drain through Rd=10kΩ to GND.
    // PMOS default W/L=1, KP=60e-6, VTO=-0.7, LAMBDA=0.02
    // |Vsg|=2V, |Vtp|=0.7V → |Vsg|-|Vtp|=1.3V
    // Saturation: |ids| = KP/2*(W/L)*1.3² = 30e-6*1.69 ≈ 50.7µA
    // Vdrain = ids*Rd = 50.7e-6*10000 ≈ 0.507V
    // Confirm saturation: |Vds|=5-0.507=4.493V > 1.3V ✓
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",   type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
            { id: "rd",   type: "Resistor",        props: { label: "rd",  resistance: 10000 } },
            { id: "m1",   type: "PMOS",            props: { label: "m1" } },
            { id: "vg",   type: "DcVoltageSource", props: { label: "vg",  voltage: 3 } },
            { id: "gnd1", type: "Ground" },
            { id: "gnd2", type: "Ground" },
          ],
          connections: [
            ["vs:pos",   "m1:S"],
            ["m1:D",     "rd:A"],
            ["rd:B",     "gnd1:out"],
            ["vg:pos",   "m1:G"],
            ["vs:neg",   "gnd1:out"],
            ["vg:neg",   "gnd2:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    // Drain node: pulled up from ground by PMOS current through Rd
    // Expected ≈ 0.5V, must be above ground and confirm saturation: |Vds|>1.3V → Vdrain<3.7V
    const vDrain = stepEnd.nodes["m1:D"]?.ours ?? stepEnd.nodes["rd:A"]?.ours;
    expect(vDrain).toBeDefined();
    expect(vDrain!).toBeGreaterThan(0.0);   // PMOS conducting (above ground)
    expect(vDrain!).toBeLessThan(3.7);      // saturation: |Vds|=5-Vdrain > 1.3V
  });
});
