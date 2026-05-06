import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { PoolBackedAnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// .dts paths (reused; authored by a parallel session)
// ---------------------------------------------------------------------------

const DTS_QUIESCENT_LOW = path.resolve(
  "src/components/active/__tests__/fixtures/timer555-canon-quiescent-low.dts",
);
const DTS_ASTABLE = path.resolve(
  "src/components/active/__tests__/fixtures/timer555-canon-astable.dts",
);

// ---------------------------------------------------------------------------
// Helper: locate the Timer555LatchDriver leaf element in a compiled circuit.
// Composite Timer555 expands to several leaves; the latch driver owns the
// LATCH_Q / OUTPUT_LOGIC_LEVEL state slots. Match by stateSchema.owner.
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
// Circuit factory helpers (T1 programmatic)
// ---------------------------------------------------------------------------

/**
 * Quiescent Timer555 with VCC=5V, TRIG=4V (above 1/3 VCC), THR=1V (below
 * 2/3 VCC). Both comparators inactive — latch holds warm-start state.
 * CTRL pin sits at 2/3 VCC from the internal R-divider.
 */
function buildQuiescentFixture(VCC = 5) {
  return buildFixture({
    build: (_r, facade) =>
      facade.build({
        components: [
          { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC } },
          { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 4   } },
          { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 1   } },
          { id: "t",     type: "Timer555",        props: { label: "t"                   } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vcc:pos",   "t:VCC"],
          ["vcc:neg",   "gnd:out"],
          ["t:GND",     "gnd:out"],
          ["t:RST",     "vcc:pos"],
          ["vtrig:pos", "t:TRIG"],
          ["vtrig:neg", "gnd:out"],
          ["vthr:pos",  "t:THR"],
          ["vthr:neg",  "gnd:out"],
          ["t:DIS",     "gnd:out"],
          ["t:OUT",     "gnd:out"],
        ],
      }),
  });
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// ---------------------------------------------------------------------------
// After buildFixture's warm-start step, verify:
//   (a) The CTRL pin sits at 2/3 VCC from the internal R-divider.
//   (b) The Timer555LatchDriver leaf exists and its pool slots are initialised
//       (LATCH_Q ∈ {0,1}, OUTPUT_LOGIC_LEVEL mirrors LATCH_Q).
// ---------------------------------------------------------------------------

describe("Timer555 initialization (T1)", () => {
  it("init_internal_divider_ctrl_voltage", () => {
    // CTRL ≈ 2/3 × 5V = 3.333V ±1%.
    const VCC = 5;
    const fix = buildQuiescentFixture(VCC);
    const ctrlNode = fix.circuit.labelToNodeId.get("t:CTRL");
    expect(ctrlNode).toBeDefined();
    const vCtrl = fix.engine.getNodeVoltage(ctrlNode!);
    const vExpected = VCC * (2 / 3);
    const errorPct = Math.abs(vCtrl - vExpected) / vExpected * 100;
    expect(errorPct).toBeLessThan(1);
  });

  it("init_latch_driver_pool_slots_valid", () => {
    // After warm-start the latch leaf exists and its state pool slots are
    // initialised to consistent values (LATCH_Q ∈ {0,1}, OUTPUT_LOGIC_LEVEL
    // mirrors LATCH_Q). Resolve slot indices via the schema (no SLOT_*
    // constant import) and read pool state via fix.pool.state0.
    const fix = buildQuiescentFixture();
    const drv = findLatchDriver(fix.circuit.elements);
    const slotQ      = drv.stateSchema.indexOf.get("LATCH_Q")!;
    const slotLevel  = drv.stateSchema.indexOf.get("OUTPUT_LOGIC_LEVEL")!;
    expect(slotQ).toBeGreaterThanOrEqual(0);
    expect(slotLevel).toBeGreaterThanOrEqual(0);

    const q   = fix.pool.state0[drv._stateBase + slotQ];
    const out = fix.pool.state0[drv._stateBase + slotLevel];
    // Both slots must be 0 or 1 (logic levels).
    expect([0, 1]).toContain(Math.round(q));
    expect([0, 1]).toContain(Math.round(out));
    // OUTPUT_LOGIC_LEVEL must mirror LATCH_Q.
    expect(Math.round(out)).toBe(Math.round(q));
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point, analytical (T1)
// ---------------------------------------------------------------------------
// Closed-form: CTRL = 2/3 VCC regardless of VCC level (three-resistor divider
// of equal value). TRIG threshold = 1/3 VCC, THR threshold = 2/3 VCC.
// Tested at VCC = 5V (nominal) and VCC = 12V (extended range).
// ---------------------------------------------------------------------------

describe("Timer555 DCOP analytical (T1)", () => {
  it("dcop_ctrl_two_thirds_vcc_at_5v", () => {
    const VCC = 5;
    const fix = buildQuiescentFixture(VCC);
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const ctrlNode = fix.circuit.labelToNodeId.get("t:CTRL");
    expect(ctrlNode).toBeDefined();
    const vCtrl = fix.engine.getNodeVoltage(ctrlNode!);
    expect(vCtrl).toBeCloseTo(VCC * (2 / 3), 3);
  });

  it("dcop_ctrl_two_thirds_vcc_at_12v", () => {
    const VCC = 12;
    const fix = buildQuiescentFixture(VCC);
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const ctrlNode = fix.circuit.labelToNodeId.get("t:CTRL");
    expect(ctrlNode).toBeDefined();
    const vCtrl = fix.engine.getNodeVoltage(ctrlNode!);
    expect(vCtrl).toBeCloseTo(VCC * (2 / 3), 3);
  });

  it("dcop_trig_threshold_one_third_vcc", () => {
    // The trigger threshold is CTRL/2 = 1/3 VCC.
    const VCC = 5;
    const fix = buildQuiescentFixture(VCC);
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const ctrlNode = fix.circuit.labelToNodeId.get("t:CTRL");
    expect(ctrlNode).toBeDefined();
    const vCtrl = fix.engine.getNodeVoltage(ctrlNode!);
    const vTrigRef = vCtrl * 0.5;
    expect(vTrigRef).toBeCloseTo(VCC / 3, 3);
  });
});

// ---------------------------------------------------------------------------
// Categories 2-numerical / 3 / 5 — Quiescent-low paired vs ngspice (T3)
// Static-bias regime: TRIG = 4V (above 1/3 VCC), THR = 1V (below 2/3 VCC).
// Both comparators inactive; latch holds, output should latch low through the
// discharge BJT in saturation. Distinct operating point from astable; exercises
// non-firing comparator paths and BJT saturation.
// ---------------------------------------------------------------------------

describeIfDll("Timer555 paired vs ngspice — quiescent low (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_QUIESCENT_LOW, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  // Cat 3 — runs the transient and sweeps every step end vs ngspice.
  it("transient_step_end_paired_quiescent_low", async () => {
    await session.runTransient(0, 1e-3, 1e-5);
    session.compareAllSteps();
  });

  // Cat 2-numerical — DCOP-equivalent (step 0 is the boot step containing the
  // operating point) full-node comparison from the recorded session.
  it("dcop_paired_quiescent_low", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const cv of Object.values(stepEnd.branches)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  // Cat 5 — every iteration of every attempt of every step vs ngspice.
  it("full_iteration_paired_quiescent_low", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Categories 2-numerical / 3 / 5 — Astable paired vs ngspice (T3)
// Self-oscillating RC: f ≈ 1.44 / ((R1 + 2*R2) * C). With R1=1k, R2=10k,
// C=10µF, f ≈ 6.86 Hz, period ≈ 146ms. Capture a representative window at
// fine timestep.
// ---------------------------------------------------------------------------

describeIfDll("Timer555 paired vs ngspice — astable (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_ASTABLE, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_astable", async () => {
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
// Category 4 — Parameter hot-load (T1)
// ---------------------------------------------------------------------------
// TIMER555_PARAM_DEFS: vDrop, rDischarge, rOut, cOut, vOH, vOL. Documented
// contract: vOH sets the output-high voltage; vOL sets the output-low voltage.
// Drive the latch into a known state (SET / RESET) via TRIG / THR, change the
// param, step, and confirm OUT moves to the new rail.
// ---------------------------------------------------------------------------

describe("Timer555 parameter hot-load (T1)", () => {
  it("hotload_vOH_changes_output_high_voltage", () => {
    // Default vOH=5.0V. After setComponentProperty("vOH", 4.0) and one step,
    // OUT pin must read ≈ 4.0V when the latch is in high state.
    // Use quiescent fixture with TRIG pulled below 1/3 VCC to force latch SET.
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC  } },
            { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 0.5  } },
            { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 1.0  } },
            { id: "t",     type: "Timer555",        props: { label: "t"                    } },
            { id: "rout",  type: "Resistor",        props: { label: "rout",  resistance: 1e6 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vcc:pos",   "t:VCC"],
            ["vcc:neg",   "gnd:out"],
            ["t:GND",     "gnd:out"],
            ["t:RST",     "vcc:pos"],
            ["vtrig:pos", "t:TRIG"],
            ["vtrig:neg", "gnd:out"],
            ["vthr:pos",  "t:THR"],
            ["vthr:neg",  "gnd:out"],
            ["t:DIS",     "gnd:out"],
            ["t:OUT",     "rout:pos"],
            ["rout:neg",  "gnd:out"],
          ],
        }),
    });

    const timerEl = [...fix.circuit.elementToCircuitElement.values()].find(
      (ce) => ce.getProperties().getOrDefault<string>("label", "") === "t",
    );
    expect(timerEl).toBeDefined();

    const outNode = fix.circuit.labelToNodeId.get("t:OUT");
    expect(outNode).toBeDefined();

    // Confirm OUT is high before hot-load (TRIG=0.5V < 1/3 VCC → latch set).
    const before = fix.engine.getNodeVoltage(outNode!);
    expect(before).toBeGreaterThan(VCC * 0.8); // OUT high

    // Hot-load: lower vOH to 4.0V.
    fix.coordinator.setComponentProperty(timerEl!, "vOH", 4.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode!);
    // After hot-load, OUT should be closer to 4.0V than 5.0V.
    expect(Math.abs(after - 4.0)).toBeLessThan(Math.abs(after - 5.0));
  });

  it("hotload_vOL_changes_output_low_voltage", () => {
    // Default vOL=0.0V. After setComponentProperty("vOL", 0.5) and one step,
    // OUT pin must read ≈ 0.5V when the latch is in low state.
    // Use quiescent fixture with TRIG high and THR above 2/3 VCC to force RESET.
    const VCC = 5;
    const fix = buildFixture({
      build: (_r, facade) =>
        facade.build({
          components: [
            { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: VCC  } },
            { id: "vtrig", type: "DcVoltageSource", props: { label: "vtrig", voltage: 4.0  } },
            { id: "vthr",  type: "DcVoltageSource", props: { label: "vthr",  voltage: 4.0  } },
            { id: "t",     type: "Timer555",        props: { label: "t"                    } },
            { id: "rout",  type: "Resistor",        props: { label: "rout",  resistance: 1e6 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vcc:pos",   "t:VCC"],
            ["vcc:neg",   "gnd:out"],
            ["t:GND",     "gnd:out"],
            ["t:RST",     "vcc:pos"],
            ["vtrig:pos", "t:TRIG"],
            ["vtrig:neg", "gnd:out"],
            ["vthr:pos",  "t:THR"],
            ["vthr:neg",  "gnd:out"],
            ["t:DIS",     "gnd:out"],
            ["t:OUT",     "rout:pos"],
            ["rout:neg",  "gnd:out"],
          ],
        }),
    });

    const timerEl = [...fix.circuit.elementToCircuitElement.values()].find(
      (ce) => ce.getProperties().getOrDefault<string>("label", "") === "t",
    );
    expect(timerEl).toBeDefined();

    const outNode = fix.circuit.labelToNodeId.get("t:OUT");
    expect(outNode).toBeDefined();

    // Confirm OUT is low (THR=4V > 2/3 VCC=3.333V → latch reset).
    const before = fix.engine.getNodeVoltage(outNode!);
    expect(before).toBeLessThan(VCC * 0.2); // OUT low

    // Hot-load: raise vOL to 0.5V.
    fix.coordinator.setComponentProperty(timerEl!, "vOL", 0.5);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(outNode!);
    // After hot-load, OUT should be closer to 0.5V than 0.0V.
    expect(Math.abs(after - 0.5)).toBeLessThan(Math.abs(after - 0.0));
  });
});

