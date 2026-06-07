import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness)
// ---------------------------------------------------------------------------
//
// Two operating-region configurations (Step 1: harness file, no topology
// variants — VariableRail has a single behavioral model and a single VSRC-shape
// stamp). The first regime is a 12V rail with a 1kΩ resistive load (DC-only;
// branch-row stamp + RHS at a higher-magnitude operating point). The second is
// a 5V rail charging 1uF through 1kΩ to ground (RC transient; exercises the
// rail's branch-row stamp under predictor / dt-selection while the cap's
// companion model evolves).

const DTS_VRAIL_12V_1K = path.resolve(
  "src/components/sources/__tests__/fixtures/variable-rail-canon-12v-1k.dts",
);

const DTS_VRAIL_RC_CHARGE = path.resolve(
  "src/components/sources/__tests__/fixtures/variable-rail-canon-rc-charge.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factory (T1)
// ---------------------------------------------------------------------------
//
// VariableRail has a single pin "pos"; "neg" is internally tied to ground (0)
// inside VariableRailAnalogImpl.setup(). The load resistor provides a return
// path so the MNA matrix is well-posed.

interface VRailCircuitParams {
  voltage: number;
  resistance?: number;
}

function buildVRailCircuit(facade: DefaultSimulatorFacade, p: VRailCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vrail", type: "VariableRail", props: { label: "vrail", voltage: p.voltage } },
      { id: "rl",    type: "Resistor",     props: { label: "rl", resistance: p.resistance ?? 1000 } },
      { id: "gnd",   type: "Ground",       props: { label: "gnd" } },
    ],
    connections: [
      ["vrail:pos", "rl:pos"],
      ["rl:neg",    "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// VariableRail initialization (T1) — Cat 1
// ---------------------------------------------------------------------------
//
// VariableRailAnalogImpl extends AnalogElement with no state-pool slots — its
// only stamp-time state is the cached `_voltage`. The post-warm-start
// observable for Cat 1 is therefore the converged node voltage at step 0:
// vrail:pos held at exactly the programmed rail voltage by the branch-row
// constraint stamped in load().

describe("VariableRail initialization (T1)", () => {
  it("init_post_warm_start_pos_node_held_at_rail_voltage", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 5, resistance: 1000 }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(5.0, 9);
  });
});

// ---------------------------------------------------------------------------
// VariableRail DCOP analytical (T1) — Cat 2 analytical
// ---------------------------------------------------------------------------

describe("VariableRail DCOP analytical (T1)", () => {
  it("dcop_pos_node_equals_rail_voltage_5v", () => {
    // Closed-form: V(vrail:pos) = 5.0. Loop current |I| = 5/1000 = 5 mA.
    // The single declared pin is "pos"; getElementPinCurrents returns a
    // length-1 array (the branch current into pos). Sign convention is
    // solver-internal — assert magnitude.
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 5, resistance: 1000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(5.0, 9);

    const vrIdx = fix.elementIndex("vrail");
    const vrPins = fix.engine.getElementPinCurrents(vrIdx);
    expect(Math.abs(vrPins[0])).toBeCloseTo(5.0 / 1000, 9);
  });

  it("dcop_pos_node_equals_rail_voltage_12v_smaller_load", () => {
    // Higher-magnitude operating regime (12V into 470Ω). Closed-form:
    // V(vrail:pos) = 12.0; |I| = 12/470 ≈ 0.025532 A.
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 12, resistance: 470 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(12.0, 9);

    const vrIdx = fix.elementIndex("vrail");
    const vrPins = fix.engine.getElementPinCurrents(vrIdx);
    expect(Math.abs(vrPins[0])).toBeCloseTo(12.0 / 470, 9);
  });

  it("dcop_pos_node_settles_to_zero_when_voltage_is_zero", () => {
    // FOLDED from original `zero_voltage_settles_to_zero`: voltage=0 is the
    // strongest external proof of the unconditional `rhs[branch] += voltage`
    // path in load() (no srcFact gating that would zero the RHS during the
    // DCOP source-stepping sweep). Closed-form: V(vrail:pos) = 0.0.
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 0, resistance: 1000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(0.0, 9);
  });
});

// ---------------------------------------------------------------------------
// VariableRail parameter hot-load (T1) — Cat 4
// ---------------------------------------------------------------------------
//
// VariableRail params: `voltage` (primary, only). No TEMP / AREA / SCALE /
// derived-state-recompute parameters — `setParam("voltage", v)` directly
// updates the cached `_voltage` field consumed at the next load(). One it()
// covers the only param.

describe("VariableRail parameter hot-load (T1)", () => {
  it("hotload_voltage_changes_pos_node", () => {
    // Cat 4: vrail=5V, rl=1k → V(vrail:pos)=5V before. Hot-load voltage=10V →
    // V(vrail:pos)=10V after. Closed-form post-change observable.
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 5, resistance: 1000 }),
    });
    const posNode = nodeOf(fix, "vrail:pos");
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(posNode);
    expect(before).toBeCloseTo(5.0, 9);

    const vrEl = fix.element("vrail");
    fix.coordinator.setComponentProperty(vrEl, "voltage", 10);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(posNode);

    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(10.0, 9);
  });
});

// ---------------------------------------------------------------------------
// VariableRail paired vs ngspice — 12V/1k load (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// Per Step 2c: the harness RUN lives in the FIRST it() of the describe
// (transient run); subsequent siblings read from the recorded session.

describeIfDll("VariableRail paired vs ngspice — 12V/1k load (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_VRAIL_12V_1K, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_12v_1k", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_12v_1k", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_12v_1k", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// VariableRail paired vs ngspice — 5V RC charge (T3) — Cat 2 num / 3 / 5
// ---------------------------------------------------------------------------
//
// Second operating-region configuration: a transient regime where the rail
// drives an RC charging network (tau = RC = 1ms). The capacitor's companion
// model evolves with predictor / dt-selection while the rail's branch-row
// stamp must remain bit-exact against ngspice across every iteration.

describeIfDll("VariableRail paired vs ngspice — 5V RC charge (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_VRAIL_RC_CHARGE, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rc_charge", async () => {
    await session.runTransient(0, 5e-3, 50e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_rc_charge", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_rc_charge", () => {
    session.compareAllAttempts();
  });
});
