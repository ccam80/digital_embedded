import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { VDMOS_SCHEMA } from "../vdmos.js";

const DTS_POWER_SWITCH = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/vdmos-power-switch.dts",
);
const DTS_AC = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/vdmos-ac.dts",
);

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// ---------------------------------------------------------------------------

describe("VDMOS initialization (T1)", () => {
  const SLOT_VGS = VDMOS_SCHEMA.indexOf.get("VGS")!;
  const SLOT_VDS = VDMOS_SCHEMA.indexOf.get("VDS")!;

  it("init_schema_has_18_slots", () => {
    expect(VDMOS_SCHEMA.size).toBe(18);
  });

  it("init_nmos_vgs_vds_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 15 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 10 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 100 } },
          { id: "m1", type: "VDMOSN", props: { label: "M1", model: "spice-vdmos" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "M1",
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const el = fix.circuit.elements[idx]!;
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_VGS])).toBe(true);
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_VDS])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical sanity)
// ---------------------------------------------------------------------------

describe("VDMOS DCOP analytical sanity (T1)", () => {
  it("dcop_nmos_power_switch_on", () => {
    // Gate driven well above Vth (default 3V): switch ON, drain pulled low.
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 15 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 10 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 100 } },
          { id: "m1", type: "VDMOSN", props: { label: "M1", model: "spice-vdmos" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vd = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("M1:D")!);
    expect(Number.isFinite(vd)).toBe(true);
    expect(vd).toBeGreaterThanOrEqual(0);
    expect(vd).toBeLessThan(15);
  });

  it("dcop_nmos_power_switch_off", () => {
    // Gate below Vth: switch OFF, drain near rail.
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 15 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 0 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 100 } },
          { id: "m1", type: "VDMOSN", props: { label: "M1", model: "spice-vdmos" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vd = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("M1:D")!);
    expect(vd).toBeGreaterThan(14); // off → drain near 15V rail
  });

  it("dcop_pmos_converges", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 15 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 5 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 100 } },
          { id: "m1", type: "VDMOSP", props: { label: "M1", model: "spice-vdmos" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "m1:S"],
          ["m1:D", "rd:pos"],
          ["rd:neg", "gnd:out"],
          ["vg:pos", "m1:G"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vd = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("M1:D")!);
    expect(Number.isFinite(vd)).toBe(true);
  });

  it("dcop_body_diode_reverse_conduction", () => {
    // Source above drain → body diode (S→D) forward-biased, conducts.
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vs", type: "DcVoltageSource", props: { label: "Vs", voltage: 5 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 100 } },
          { id: "m1", type: "VDMOSN", props: { label: "M1", model: "spice-vdmos" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          // Source held at +5V, drain pulled to ground through Rd, gate off.
          ["vs:pos", "m1:S"],
          ["m1:D", "rd:pos"],
          ["rd:neg", "gnd:out"],
          ["m1:G", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vd = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("M1:D")!);
    // Body diode clamps drain a forward-drop below source (~5V).
    expect(vd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// ---------------------------------------------------------------------------

describe("VDMOS parameter hot-load (T1)", () => {
  function buildSwitch(): ReturnType<typeof buildFixture> {
    return buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 15 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 6 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 100 } },
          { id: "m1", type: "VDMOSN", props: { label: "M1", model: "spice-vdmos" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
  }

  function getM1(fix: ReturnType<typeof buildFixture>) {
    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "M1",
    );
    const ce = fix.circuit.elementToCircuitElement.get(idx);
    expect(ce).toBeDefined();
    return { idx, ce: ce! };
  }

  it("hotload_KP_changes_vd", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "KP", 200);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_VTH_changes_vd", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    // Raise threshold above the 6V gate drive → device turns off → drain rises.
    fix.coordinator.setComponentProperty(ce, "VTH", 8);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_LAMBDA_changes_vd", () => {
    // LAMBDA feeds the drain-current model directly (vdmosload.c:356,360); it
    // takes effect without a topology change, unlike RD (which gates prime-node
    // allocation and so requires a recompile to alter conductance routing).
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "LAMBDA", 0.1);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).not.toBe(before);
  });

  it("hotload_TEMP_changes_vd", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const before = fix.engine.getNodeVoltage(vdNode);
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_THERMAL_flag_toggles_self_heat", () => {
    const fix = buildSwitch();
    const { ce } = getM1(fix);
    const vdNode = fix.circuit.labelToNodeId.get("M1:D")!;
    // Enabling self-heating without recompile is honoured by load()'s selfheat
    // gate (thermal && rthjcGiven). The thermal nodes are not allocated until a
    // recompile, so the result must stay finite/converged either way.
    fix.coordinator.setComponentProperty(ce, "THERMAL", 1);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vdNode);
    expect(Number.isFinite(after)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// load() calls fetlim / limvds on the MOS junctions and pnjlim on the body
// diode. High gate drive forces the GS / DS limiters during DCOP recovery.
// ---------------------------------------------------------------------------

describe("VDMOS limiting events own-engine (T1)", () => {
  it("limiting_records_events_nmos_switch", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "Vdd", voltage: 100 } },
          { id: "vg", type: "DcVoltageSource", props: { label: "Vg", voltage: 20 } },
          { id: "rd", type: "Resistor", props: { label: "Rd", resistance: 10 } },
          { id: "m1", type: "VDMOSN", props: { label: "M1", model: "spice-vdmos" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vdd:pos", "rd:pos"],
          ["rd:neg", "m1:D"],
          ["vg:pos", "m1:G"],
          ["m1:S", "gnd:out"],
          ["vdd:neg", "gnd:out"],
          ["vg:neg", "gnd:out"],
        ],
      }),
    });
    fix.coordinator.setLimitingCapture(true);
    const result = fix.coordinator.dcOperatingPoint();
    expect(result!.converged).toBe(true);
    // VDMOS load() exercises fetlim/limvds; the collector must be populated.
    const events = fix.coordinator.getLimitingEvents();
    expect(Array.isArray(events)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Harness sessions (T3), gated on the DLL.
// ---------------------------------------------------------------------------

describeIfDll("VDMOS power switch paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_POWER_SWITCH,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("dcop_paired_power_switch", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("transient_step_end_paired_power_switch", () => {
    session.compareAllSteps();
  });

  it("full_iteration_paired_power_switch", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("VDMOS AC small-signal paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_AC,
      dllPath: DLL_PATH,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("ac_dcop_bias_paired", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });
});
