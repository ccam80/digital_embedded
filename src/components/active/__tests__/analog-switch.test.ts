import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import {
  SW_SCHEMA,
  SPDT_SCHEMA,
} from "../analog-switch.js";
import { PoolBackedAnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Slot indices — resolved via schema, never raw SLOT_* imports (B-3)
// ---------------------------------------------------------------------------

const SLOT_STATE  = SW_SCHEMA.indexOf.get("CURRENT_STATE")!;
const SLOT_V_CTRL = SW_SCHEMA.indexOf.get("V_CTRL")!;

const SLOT_NO_STATE = SPDT_SCHEMA.indexOf.get("NO_CURRENT_STATE")!;
const SLOT_NC_STATE = SPDT_SCHEMA.indexOf.get("NC_CURRENT_STATE")!;

// ---------------------------------------------------------------------------
// .dts paths
// ---------------------------------------------------------------------------

const DTS_SPST_ON  = path.resolve("src/components/active/__tests__/fixtures/analog-switch-canon-spst-on.dts");
const DTS_SPST_OFF = path.resolve("src/components/active/__tests__/fixtures/analog-switch-canon-spst-off.dts");
const DTS_SPDT_NO  = path.resolve("src/components/active/__tests__/fixtures/analog-switch-canon-spdt-no.dts");
const DTS_SPDT_NC  = path.resolve("src/components/active/__tests__/fixtures/analog-switch-canon-spdt-nc.dts");

// ---------------------------------------------------------------------------
// Helpers: locate switch elements by stateSchema.owner
// ---------------------------------------------------------------------------

function findSPSTElement(elements: ReadonlyArray<unknown>): PoolBackedAnalogElement {
  const idx = elements.findIndex(
    (el) =>
      el instanceof PoolBackedAnalogElement &&
      (el as PoolBackedAnalogElement).stateSchema.owner === "SWElement",
  );
  if (idx < 0) throw new Error("AnalogSwitchSPSTElement not found in compiled circuit");
  return elements[idx] as PoolBackedAnalogElement;
}

function findSPDTElement(elements: ReadonlyArray<unknown>): PoolBackedAnalogElement {
  const idx = elements.findIndex(
    (el) =>
      el instanceof PoolBackedAnalogElement &&
      (el as PoolBackedAnalogElement).stateSchema.owner === "SWElementSPDT",
  );
  if (idx < 0) throw new Error("AnalogSwitchSPDTElement not found in compiled circuit");
  return elements[idx] as PoolBackedAnalogElement;
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Post-warm-start: state slots are finite; sentinel matches drive condition.
// REALLY_OFF=0, REALLY_ON=1 per the SwitchSPST state-schema contract.
// ---------------------------------------------------------------------------

describe("AnalogSwitchSPST initialization — switch ON (T1)", () => {
  it("init_spst_on_state_really_on", () => {
    // V_ctrl=3.3V > vThreshold=1.65V => CURRENT_STATE = REALLY_ON (1)
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: 5   } },
          { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 1000 } },
          {
            id: "sw",
            type: "SwitchSPST",
            props: { label: "sw", model: "behavioral", rOn: 1, rOff: 1e9, vThreshold: 1.65, vHysteresis: 0 },
          },
          { id: "vctrl", type: "DcVoltageSource", props: { label: "vctrl", voltage: 3.3 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vcc:pos",   "rload:pos"],
          ["vcc:neg",   "gnd:out"],
          ["rload:neg", "sw:in"],
          ["sw:out",    "gnd:out"],
          ["vctrl:pos", "sw:ctrl"],
          ["vctrl:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });

    const sw = findSPSTElement(fix.circuit.elements);
    const state  = fix.pool.state0[sw._stateBase + SLOT_STATE];
    const vCtrl  = fix.pool.state0[sw._stateBase + SLOT_V_CTRL];

    expect(Number.isFinite(state)).toBe(true);
    expect(Number.isFinite(vCtrl)).toBe(true);
    expect(state).toBe(1); // REALLY_ON
    expect(vCtrl).toBeCloseTo(3.3, 2);
  });
});

describe("AnalogSwitchSPST initialization — switch OFF (T1)", () => {
  it("init_spst_off_state_really_off", () => {
    // V_ctrl=0V < vThreshold=1.65V => CURRENT_STATE = REALLY_OFF (0)
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: 5   } },
          { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 1000 } },
          {
            id: "sw",
            type: "SwitchSPST",
            props: { label: "sw", model: "behavioral", rOn: 1, rOff: 1e9, vThreshold: 1.65, vHysteresis: 0 },
          },
          { id: "vctrl", type: "DcVoltageSource", props: { label: "vctrl", voltage: 0 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vcc:pos",   "rload:pos"],
          ["vcc:neg",   "gnd:out"],
          ["rload:neg", "sw:in"],
          ["sw:out",    "gnd:out"],
          ["vctrl:pos", "sw:ctrl"],
          ["vctrl:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });

    const sw = findSPSTElement(fix.circuit.elements);
    const state  = fix.pool.state0[sw._stateBase + SLOT_STATE];
    const vCtrl  = fix.pool.state0[sw._stateBase + SLOT_V_CTRL];

    expect(Number.isFinite(state)).toBe(true);
    expect(Number.isFinite(vCtrl)).toBe(true);
    expect(state).toBe(0); // REALLY_OFF
    expect(vCtrl).toBeCloseTo(0, 4);
  });
});

describe("AnalogSwitchSPDT initialization — NO path closed (T1)", () => {
  it("init_spdt_no_path_closed", () => {
    // V_ctrl=3.3V > vThreshold=1.65V => COM-NO: REALLY_ON(1), COM-NC: REALLY_OFF(0)
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: 5   } },
          { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 1000 } },
          {
            id: "sw",
            type: "SwitchSPDT",
            props: { label: "sw", model: "behavioral", rOn: 1, rOff: 1e9, vThreshold: 1.65, vHysteresis: 0 },
          },
          { id: "rnc",   type: "Resistor",        props: { label: "rnc",   resistance: 1e6 } },
          { id: "vctrl", type: "DcVoltageSource", props: { label: "vctrl", voltage: 3.3 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vcc:pos",   "rload:pos"],
          ["vcc:neg",   "gnd:out"],
          ["rload:neg", "sw:com"],
          ["sw:no",     "gnd:out"],
          ["sw:nc",     "rnc:pos"],
          ["rnc:neg",   "gnd:out"],
          ["vctrl:pos", "sw:ctrl"],
          ["vctrl:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });

    const sw = findSPDTElement(fix.circuit.elements);
    const noState = fix.pool.state0[sw._stateBase + SLOT_NO_STATE];
    const ncState = fix.pool.state0[sw._stateBase + SLOT_NC_STATE];

    expect(Number.isFinite(noState)).toBe(true);
    expect(Number.isFinite(ncState)).toBe(true);
    expect(noState).toBe(1); // COM-NO: REALLY_ON
    expect(ncState).toBe(0); // COM-NC: REALLY_OFF
  });
});

describe("AnalogSwitchSPDT initialization — NC path closed (T1)", () => {
  it("init_spdt_nc_path_closed", () => {
    // V_ctrl=0V < vThreshold=1.65V => COM-NO: REALLY_OFF(0), COM-NC: REALLY_ON(1)
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: 5   } },
          { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 1000 } },
          {
            id: "sw",
            type: "SwitchSPDT",
            props: { label: "sw", model: "behavioral", rOn: 1, rOff: 1e9, vThreshold: 1.65, vHysteresis: 0 },
          },
          { id: "rno",   type: "Resistor",        props: { label: "rno",   resistance: 1e6 } },
          // V_ctrl=-3.3V: invertCtrl negates to +3.3V > vThreshold=1.65V => NC closes
          { id: "vctrl", type: "DcVoltageSource", props: { label: "vctrl", voltage: -3.3 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vcc:pos",   "rload:pos"],
          ["vcc:neg",   "gnd:out"],
          ["rload:neg", "sw:com"],
          ["sw:nc",     "gnd:out"],
          ["sw:no",     "rno:pos"],
          ["rno:neg",   "gnd:out"],
          ["vctrl:pos", "sw:ctrl"],
          ["vctrl:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 2e-5, maxTimeStep: 1e-6 },
    });

    const sw = findSPDTElement(fix.circuit.elements);
    const noState = fix.pool.state0[sw._stateBase + SLOT_NO_STATE];
    const ncState = fix.pool.state0[sw._stateBase + SLOT_NC_STATE];

    expect(Number.isFinite(noState)).toBe(true);
    expect(Number.isFinite(ncState)).toBe(true);
    // V_ctrl=-3.3V: NO path inverted=+3.3V > threshold => also REALLY_ON? No —
    // NO uses normal polarity: v_ctrl=-3.3V < 1.65V => REALLY_OFF.
    // NC uses invertCtrl: -(-3.3)=+3.3V > 1.65V => REALLY_ON.
    expect(noState).toBe(0); // COM-NO: REALLY_OFF
    expect(ncState).toBe(1); // COM-NC: REALLY_ON
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point analytical (T1)
// Resistive-divider closed-form:
//   Closed: V_sw_in = V_supply * rOn_eff / (R_load + rOn_eff)
//   Open:   V_sw_in = V_supply * rOff_eff / (R_load + rOff_eff)
// rOn_eff = max(rOn, 1e-3); rOff_eff = max(rOff, rOn_eff*2).
// ---------------------------------------------------------------------------

describe("AnalogSwitchSPST DCOP analytical (T1)", () => {
  it("dcop_spst_closed_output_matches_divider", () => {
    // rOn=1 (eff=1), R_load=1000: V_sw_in = 5 * 1/1001 ≈ 0.004995V
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: 5   } },
          { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 1000 } },
          {
            id: "sw",
            type: "SwitchSPST",
            props: { label: "sw", model: "behavioral", rOn: 1, rOff: 1e9, vThreshold: 1.65, vHysteresis: 0 },
          },
          { id: "vctrl", type: "DcVoltageSource", props: { label: "vctrl", voltage: 3.3 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vcc:pos",   "rload:pos"],
          ["vcc:neg",   "gnd:out"],
          ["rload:neg", "sw:in"],
          ["sw:out",    "gnd:out"],
          ["vctrl:pos", "sw:ctrl"],
          ["vctrl:neg", "gnd:out"],
        ],
      }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const nodeId = fix.circuit.labelToNodeId.get("sw:in");
    expect(nodeId).toBeDefined();
    const vOut = fix.engine.getNodeVoltage(nodeId!);
    expect(vOut).toBeCloseTo(5 * 1 / 1001, 4);
  });

  it("dcop_spst_open_output_near_supply", () => {
    // rOff=1e9 (eff=1e9), R_load=1000: V_sw_in = 5*1e9/(1000+1e9) ≈ 4.999995V
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: 5   } },
          { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 1000 } },
          {
            id: "sw",
            type: "SwitchSPST",
            props: { label: "sw", model: "behavioral", rOn: 1, rOff: 1e9, vThreshold: 1.65, vHysteresis: 0 },
          },
          { id: "vctrl", type: "DcVoltageSource", props: { label: "vctrl", voltage: 0 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vcc:pos",   "rload:pos"],
          ["vcc:neg",   "gnd:out"],
          ["rload:neg", "sw:in"],
          ["sw:out",    "gnd:out"],
          ["vctrl:pos", "sw:ctrl"],
          ["vctrl:neg", "gnd:out"],
        ],
      }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const nodeId = fix.circuit.labelToNodeId.get("sw:in");
    expect(nodeId).toBeDefined();
    const vOut = fix.engine.getNodeVoltage(nodeId!);
    // 5 * 1e9 / (1000 + 1e9) = 4.999995V
    expect(vOut).toBeCloseTo(5 * 1e9 / (1000 + 1e9), 4);
  });
});

// ---------------------------------------------------------------------------
// Category 3 + 5 — Transient step-end paired + full-iteration paired (T3)
// Four .dts circuits: spst-on, spst-off, spdt-no, spdt-nc.
// ---------------------------------------------------------------------------

describeIfDll("AnalogSwitchSPST closed vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_SPST_ON, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_spst_on", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_spst_on", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_spst_on", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("AnalogSwitchSPST open vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_SPST_OFF, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_spst_off", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_spst_off", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_spst_off", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("AnalogSwitchSPDT NO-closed vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_SPDT_NO, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_spdt_no", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_spdt_no", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_spdt_no", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("AnalogSwitchSPDT NC-closed vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_SPDT_NC, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_spdt_nc", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_spdt_nc", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_spdt_nc", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// Closed-form resistive-divider assertions; no Number.isFinite weakening (B-8).
// rOn_eff = max(rOn, 1e-3); rOff_eff = max(rOff, rOn_eff*2).
// ---------------------------------------------------------------------------

describe("AnalogSwitchSPST parameter hot-load (T1)", () => {
  function buildSpstOnFixture() {
    return buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vcc",   type: "DcVoltageSource", props: { label: "vcc",   voltage: 5   } },
          { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 1000 } },
          {
            id: "sw",
            type: "SwitchSPST",
            props: { label: "sw", model: "behavioral", rOn: 1, rOff: 1e9, vThreshold: 1.65, vHysteresis: 0 },
          },
          { id: "vctrl", type: "DcVoltageSource", props: { label: "vctrl", voltage: 3.3 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vcc:pos",   "rload:pos"],
          ["vcc:neg",   "gnd:out"],
          ["rload:neg", "sw:in"],
          ["sw:out",    "gnd:out"],
          ["vctrl:pos", "sw:ctrl"],
          ["vctrl:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-6 },
    });
  }

  it("hotload_rOn_raises_sw_in_voltage", () => {
    // Before: rOn=1 => V_sw_in = 5*1/(1000+1) ≈ 0.004995V
    // After setParam("rOn",50): V_sw_in = 5*50/(1000+50) ≈ 0.23810V
    const fix = buildSpstOnFixture();
    fix.coordinator.step();

    const nodeId = fix.circuit.labelToNodeId.get("sw:in")!;
    const before = fix.engine.getNodeVoltage(nodeId);
    expect(before).toBeCloseTo(5 * 1 / 1001, 4);

    fix.coordinator.setComponentProperty(fix.element("sw"), "rOn", 50);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(nodeId);
    expect(after).toBeCloseTo(5 * 50 / 1050, 4);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_rOff_no_effect_on_closed_switch", () => {
    // Switch is ON; rOff change does not affect closed-state conductance.
    // V_sw_in stays at rOn-divider value before and after.
    const fix = buildSpstOnFixture();
    fix.coordinator.step();

    const nodeId = fix.circuit.labelToNodeId.get("sw:in")!;
    const before = fix.engine.getNodeVoltage(nodeId);
    expect(before).toBeCloseTo(5 * 1 / 1001, 4);

    fix.coordinator.setComponentProperty(fix.element("sw"), "rOff", 100);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(nodeId);
    expect(after).toBeCloseTo(5 * 1 / 1001, 4);
  });

  it("hotload_vThreshold_above_vctrl_opens_switch", () => {
    // Raise vThreshold from 1.65 to 4.0 (above V_ctrl=3.3V) => switch opens.
    // V_sw_in jumps to near V_supply (rOff divider ≈ 4.999995V).
    const fix = buildSpstOnFixture();
    fix.coordinator.step();

    const nodeId = fix.circuit.labelToNodeId.get("sw:in")!;
    const before = fix.engine.getNodeVoltage(nodeId);
    expect(before).toBeCloseTo(5 * 1 / 1001, 4);

    fix.coordinator.setComponentProperty(fix.element("sw"), "vThreshold", 4.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(nodeId);
    // rOff_eff = max(1e9, 2) = 1e9; 5*1e9/(1000+1e9) ≈ 4.999995V
    expect(after).toBeCloseTo(5 * 1e9 / (1000 + 1e9), 4);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_vHysteresis_keeps_settled_on_state", () => {
    // vHysteresis=0.5: upper band = vThreshold+vHysteresis = 2.15V < V_ctrl=3.3V.
    // Already-settled REALLY_ON state is preserved after setParam + step.
    const fix = buildSpstOnFixture();
    fix.coordinator.step();

    const sw = findSPSTElement(fix.circuit.elements);
    expect(fix.pool.state0[sw._stateBase + SLOT_STATE]).toBe(1); // REALLY_ON

    fix.coordinator.setComponentProperty(fix.element("sw"), "vHysteresis", 0.5);
    fix.coordinator.step();

    expect(fix.pool.state0[sw._stateBase + SLOT_STATE]).toBe(1); // still REALLY_ON
  });
});
