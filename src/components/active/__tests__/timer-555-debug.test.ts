import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { PoolBackedAnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// .dts paths
// ---------------------------------------------------------------------------

const DTS_ASTABLE = path.resolve(
  "src/components/active/__tests__/fixtures/timer555-canon-astable.dts",
);
const DTS_QUIESCENT_LOW = path.resolve(
  "src/components/active/__tests__/fixtures/timer555-canon-quiescent-low.dts",
);

// ---------------------------------------------------------------------------
// Helper: locate the Timer555LatchDriver leaf element inside a compiled
// composite by matching stateSchema.owner.
// ---------------------------------------------------------------------------

function findLatchDriver(
  elements: ReadonlyArray<unknown>,
): PoolBackedAnalogElement {
  const idx = elements.findIndex(
    (el) =>
      el instanceof PoolBackedAnalogElement &&
      (el as PoolBackedAnalogElement).stateSchema.owner === "Timer555LatchDriver",
  );
  if (idx < 0) {
    throw new Error("Timer555LatchDriverElement not found in compiled circuit");
  }
  return elements[idx] as PoolBackedAnalogElement;
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Composite Timer555 expands to a latch-driver leaf. After warm-start, the
// LATCH_Q slot must hold a valid logic level (0 or 1).
// ---------------------------------------------------------------------------

describe("Timer555 initialization (T1)", () => {
  it("init_latch_q_and_output_level_quiescent_low", () => {
    // TRIG = 4V (above 1/3 VCC = 1.667V) and THR = 1V (below 2/3 VCC = 3.333V):
    // both comparators inactive, RS-latch holds whatever the warm-start lands on.
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC } },
            { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 4   } },
            { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 1   } },
            { id: "t",     type: "Timer555",        props: { label: "t" } },
            { id: "rdis",  type: "Resistor",        props: { label: "rdis", resistance: 1000 } },
            { id: "rout",  type: "Resistor",        props: { label: "rout", resistance: 1e6 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vcc:pos", "t:VCC"],
            ["vcc:pos", "t:RST"],
            ["vcc:pos", "rdis:pos"],
            ["vcc:neg", "gnd:out"],
            ["vtrig:pos", "t:TRIG"],
            ["vtrig:neg", "gnd:out"],
            ["vthr:pos",  "t:THR"],
            ["vthr:neg",  "gnd:out"],
            ["t:GND",   "gnd:out"],
            ["rdis:neg", "t:DIS"],
            ["t:OUT",   "rout:pos"],
            ["rout:neg", "gnd:out"],
          ],
        }),
    });

    const drv = findLatchDriver(fix.circuit.elements);
    const slotQ      = drv.stateSchema.indexOf.get("LATCH_Q")!;
    const q     = fix.pool.state0[drv._stateBase + slotQ];

    expect(Number.isFinite(q)).toBe(true);
    // LATCH_Q is binary (0 or 1) by composite contract.
    expect(q === 0 || q === 1).toBe(true);

    // Internal R-divider sets CTRL ≈ 2/3 VCC after warm-start.
    const ctrlNode = fix.circuit.labelToNodeId.get("t:CTRL");
    expect(ctrlNode).toBeDefined();
    const vCtrl = fix.engine.getNodeVoltage(ctrlNode!);
    expect(vCtrl).toBeCloseTo((2 / 3) * VCC, 1);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// With CTRL floating, the internal R-divider produces:
//   V_CTRL  ≈ (2/3) * VCC  (textbook 555)
//   V_LOWER ≈ (1/3) * VCC
// Independent of trigger / threshold inputs.
// ---------------------------------------------------------------------------

describe("Timer555 DCOP analytical (T1)", () => {
  it("dcop_internal_divider_two_thirds_vcc", () => {
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",  type: "DcVoltageSource", props: { label: "vcc", voltage: VCC } },
            { id: "t",    type: "Timer555",        props: { label: "t" } },
            { id: "gnd",  type: "Ground" },
          ],
          connections: [
            ["vcc:pos", "t:VCC"],
            ["vcc:pos", "t:RST"],
            ["vcc:neg", "gnd:out"],
            ["t:GND",   "gnd:out"],
            ["t:TRIG",  "gnd:out"],
            ["t:THR",   "gnd:out"],
            ["t:DIS",   "gnd:out"],
            ["t:OUT",   "gnd:out"],
          ],
        }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    // CTRL is an internal composite net. labelToNodeId uses the composite-pin
    // label format "t:CTRL". Closed-form: 5kΩ R-divider arms =>
    // V_CTRL = (2/3) * VCC = 3.333V.
    const ctrlNode = fix.circuit.labelToNodeId.get("t:CTRL");
    expect(ctrlNode).toBeDefined();
    const vCtrl = fix.engine.getNodeVoltage(ctrlNode!);
    expect(vCtrl).toBeCloseTo((2 / 3) * VCC, 2);
    // Trigger reference (CTRL/2) ≈ (1/3) * VCC = 1.667V.
    expect(vCtrl * 0.5).toBeCloseTo(VCC / 3, 2);
  });
});

// ---------------------------------------------------------------------------
// Categories 2-numerical / 3 / 5 — Astable paired vs ngspice (T3)
// Self-oscillating RC: f ≈ 1.44 / ((R1 + 2*R2) * C). With R1=1k, R2=10k,
// C=10µF, f ≈ 6.86 Hz, period ≈ 146ms. Capture ~2 periods at fine dt.
// ---------------------------------------------------------------------------

describeIfDll("Timer555 paired vs ngspice — astable (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_ASTABLE, analysis: "tran", tStop: 3e-1, maxStep: 1e-3 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_astable", async () => {
    // Two periods of self-oscillation at fine timestep.
    await session.runTransient(0, 3e-1, 1e-3);
    session.compareAllSteps();
  });

  it("dcop_paired_astable", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const cv of Object.values(stepEnd.branches)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_astable", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Categories 2-numerical / 3 / 5 — Quiescent-low paired vs ngspice (T3)
// Static-bias regime: TRIG / THR clamped externally, no self-oscillation.
// Distinct operating point from astable; exercises non-firing comparator path
// and discharge BJT in saturation.
// ---------------------------------------------------------------------------

describeIfDll("Timer555 paired vs ngspice — quiescent low (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_QUIESCENT_LOW, analysis: "tran", tStop: 1e-3, maxStep: 1e-5 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_quiescent_low", async () => {
    await session.runTransient(0, 1e-3, 1e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_quiescent_low", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_quiescent_low", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// Documented model params on Timer555: vDrop, rDischarge, rOut, cOut, vOH, vOL.
// vOH directly sets the output-high voltage; raising it must move OUT upward
// when the latch is high.
// ---------------------------------------------------------------------------

describe("Timer555 parameter hot-load (T1)", () => {
  it("hotload_vOH_changes_output_voltage_when_high", () => {
    // Build with TRIG below 1/3 VCC => set the latch high, output drives high.
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC } },
            { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 0.5 } },
            { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 1   } },
            { id: "t",     type: "Timer555",        props: { label: "t" } },
            { id: "rdis",  type: "Resistor",        props: { label: "rdis", resistance: 1000 } },
            { id: "rout",  type: "Resistor",        props: { label: "rout", resistance: 1e6 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vcc:pos", "t:VCC"],
            ["vcc:pos", "t:RST"],
            ["vcc:pos", "rdis:pos"],
            ["vcc:neg", "gnd:out"],
            ["vtrig:pos", "t:TRIG"],
            ["vtrig:neg", "gnd:out"],
            ["vthr:pos",  "t:THR"],
            ["vthr:neg",  "gnd:out"],
            ["t:GND",   "gnd:out"],
            ["rdis:neg", "t:DIS"],
            ["t:OUT",   "rout:pos"],
            ["rout:neg", "gnd:out"],
          ],
        }),
    });

    const outNode = fix.circuit.labelToNodeId.get("t:OUT")!;
    // Settle a few steps to let the latch reach the SET state.
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(outNode);

    const tElem = fix.element("t");
    fix.coordinator.setComponentProperty(tElem, "vOH", 3.3);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);

    // Documented contract: lowering vOH from 5V to 3.3V lowers OUT when the
    // latch is high.
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(3.3, 1);
  });

  it("hotload_vOL_changes_output_voltage_when_low", () => {
    // TRIG above 1/3 VCC, comp1 inactive; THR above 2/3 VCC => RESET path,
    // latch low, output drives low.
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC } },
            { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 4   } },
            { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 4.5 } },
            { id: "t",     type: "Timer555",        props: { label: "t" } },
            { id: "rdis",  type: "Resistor",        props: { label: "rdis", resistance: 1000 } },
            { id: "rout",  type: "Resistor",        props: { label: "rout", resistance: 1e6 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vcc:pos", "t:VCC"],
            ["vcc:pos", "t:RST"],
            ["vcc:pos", "rdis:pos"],
            ["vcc:neg", "gnd:out"],
            ["vtrig:pos", "t:TRIG"],
            ["vtrig:neg", "gnd:out"],
            ["vthr:pos",  "t:THR"],
            ["vthr:neg",  "gnd:out"],
            ["t:GND",   "gnd:out"],
            ["rdis:neg", "t:DIS"],
            ["t:OUT",   "rout:pos"],
            ["rout:neg", "gnd:out"],
          ],
        }),
    });

    const outNode = fix.circuit.labelToNodeId.get("t:OUT")!;
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(outNode);

    const tElem = fix.element("t");
    fix.coordinator.setComponentProperty(tElem, "vOL", 0.5);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);

    // Documented contract: raising vOL from 0V to 0.5V raises OUT when the
    // latch is low.
    expect(after).not.toBeCloseTo(before);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(0.5, 1);
  });

  it("hotload_vDrop_changes_dis_base_voltage", () => {
    // SET-path topology: TRIG below 1/3 VCC => latch high => discharge BJT
    // base clamped to vDrop. Hot-loading vDrop must move the disBase node.
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC } },
            { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 0.5 } },
            { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 1   } },
            { id: "t",     type: "Timer555",        props: { label: "t", vDrop: 1.5 } },
            { id: "rdis",  type: "Resistor",        props: { label: "rdis", resistance: 1000 } },
            { id: "rout",  type: "Resistor",        props: { label: "rout", resistance: 1e6 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vcc:pos", "t:VCC"],
            ["vcc:pos", "t:RST"],
            ["vcc:pos", "rdis:pos"],
            ["vcc:neg", "gnd:out"],
            ["vtrig:pos", "t:TRIG"],
            ["vtrig:neg", "gnd:out"],
            ["vthr:pos",  "t:THR"],
            ["vthr:neg",  "gnd:out"],
            ["t:GND",   "gnd:out"],
            ["rdis:neg", "t:DIS"],
            ["t:OUT",   "rout:pos"],
            ["rout:neg", "gnd:out"],
          ],
        }),
    });

    // disBase is an internal composite net; observe via the discharge resistor
    // pin that is connected to the BJT collector — V(DIS) shifts as the BJT's
    // base drive changes.
    const disNode = fix.circuit.labelToNodeId.get("t:DIS")!;
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(disNode);

    const tElem = fix.element("t");
    fix.coordinator.setComponentProperty(tElem, "vDrop", 3.0);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(disNode);

    // Raising vDrop from 1.5V to 3.0V must change the DIS-node voltage.
    expect(after).not.toBeCloseTo(before);
  });

  it("hotload_rOut_changes_output_voltage", () => {
    // SET-path topology with light external load (1MΩ rout); rOut sets the
    // companion output series resistance and therefore the divider ratio
    // between vOH and the external load.
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC } },
            { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 0.5 } },
            { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 1   } },
            { id: "t",     type: "Timer555",        props: { label: "t" } },
            { id: "rdis",  type: "Resistor",        props: { label: "rdis", resistance: 1000 } },
            { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 1000 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vcc:pos", "t:VCC"],
            ["vcc:pos", "t:RST"],
            ["vcc:pos", "rdis:pos"],
            ["vcc:neg", "gnd:out"],
            ["vtrig:pos", "t:TRIG"],
            ["vtrig:neg", "gnd:out"],
            ["vthr:pos",  "t:THR"],
            ["vthr:neg",  "gnd:out"],
            ["t:GND",   "gnd:out"],
            ["rdis:neg", "t:DIS"],
            ["t:OUT",   "rload:pos"],
            ["rload:neg", "gnd:out"],
          ],
        }),
    });

    const outNode = fix.circuit.labelToNodeId.get("t:OUT")!;
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(outNode);

    const tElem = fix.element("t");
    // Raise rOut from 100Ω default to 10kΩ — divides vOH down through rload=1k.
    fix.coordinator.setComponentProperty(tElem, "rOut", 10000);
    for (let i = 0; i < 10; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(outNode);

    expect(after).not.toBeCloseTo(before);
    expect(after).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
// Timer555 OUT pin is registered as a digital output (PinDirection.OUTPUT).
// Latch state must surface as a readable digital signal.
// ---------------------------------------------------------------------------

describe("Timer555 digital output bridge (T1)", () => {
  it("set_path_drives_digital_out_high", () => {
    // TRIG below 1/3 VCC + THR below 2/3 VCC => SET path => OUT digital = 1.
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC } },
            { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 0.5 } },
            { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 1   } },
            { id: "t",     type: "Timer555",        props: { label: "t" } },
            { id: "rdis",  type: "Resistor",        props: { label: "rdis", resistance: 1000 } },
            { id: "rout",  type: "Resistor",        props: { label: "rout", resistance: 1e6 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vcc:pos", "t:VCC"],
            ["vcc:pos", "t:RST"],
            ["vcc:pos", "rdis:pos"],
            ["vcc:neg", "gnd:out"],
            ["vtrig:pos", "t:TRIG"],
            ["vtrig:neg", "gnd:out"],
            ["vthr:pos",  "t:THR"],
            ["vthr:neg",  "gnd:out"],
            ["t:GND",   "gnd:out"],
            ["rdis:neg", "t:DIS"],
            ["t:OUT",   "rout:pos"],
            ["rout:neg", "gnd:out"],
          ],
        }),
    });

    // Step a few times to let the latch settle to SET.
    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const drv = findLatchDriver(fix.circuit.elements);
    const slotQ = drv.stateSchema.indexOf.get("LATCH_Q")!;
    const q = fix.pool.state0[drv._stateBase + slotQ];
    expect(q).toBe(1);

    // Analog OUT node must rise toward vOH (default 5V).
    const outNode = fix.circuit.labelToNodeId.get("t:OUT")!;
    const vOut = fix.engine.getNodeVoltage(outNode);
    expect(vOut).toBeGreaterThan(VCC * 0.5);
  });

  it("reset_path_drives_digital_out_low", () => {
    // THR above 2/3 VCC => RESET path => latch=0 => OUT digital = 0.
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC } },
            { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 4   } },
            { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 4.5 } },
            { id: "t",     type: "Timer555",        props: { label: "t" } },
            { id: "rdis",  type: "Resistor",        props: { label: "rdis", resistance: 1000 } },
            { id: "rout",  type: "Resistor",        props: { label: "rout", resistance: 1e6 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vcc:pos", "t:VCC"],
            ["vcc:pos", "t:RST"],
            ["vcc:pos", "rdis:pos"],
            ["vcc:neg", "gnd:out"],
            ["vtrig:pos", "t:TRIG"],
            ["vtrig:neg", "gnd:out"],
            ["vthr:pos",  "t:THR"],
            ["vthr:neg",  "gnd:out"],
            ["t:GND",   "gnd:out"],
            ["rdis:neg", "t:DIS"],
            ["t:OUT",   "rout:pos"],
            ["rout:neg", "gnd:out"],
          ],
        }),
    });

    for (let i = 0; i < 20; i++) fix.coordinator.step();

    const drv = findLatchDriver(fix.circuit.elements);
    const slotQ = drv.stateSchema.indexOf.get("LATCH_Q")!;
    const q = fix.pool.state0[drv._stateBase + slotQ];
    expect(q).toBe(0);

    // Analog OUT node must sit near vOL (default 0V).
    const outNode = fix.circuit.labelToNodeId.get("t:OUT")!;
    const vOut = fix.engine.getNodeVoltage(outNode);
    expect(vOut).toBeLessThan(VCC * 0.5);
  });
});
