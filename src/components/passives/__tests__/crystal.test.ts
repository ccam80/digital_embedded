import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import "../../../solver/analog/__tests__/harness/comparison-session-asserts.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness)
// ---------------------------------------------------------------------------

const DTS_DC_BLOCK = path.resolve(
  "src/components/passives/__tests__/fixtures/crystal-canon-dc-block.dts",
);
const DTS_RESONATOR = path.resolve(
  "src/components/passives/__tests__/fixtures/crystal-canon-resonator.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------
//
// DC-block topology: V_DC -> xtal -> R_bleed -> GND.
// The BVD model places C_s and C_0 across pos/neg with no DC path through L_s
// (only branch incidence). At DC, all source voltage drops across the
// crystal; the bleed resistor anchors the floating xtal:neg node.

interface DcBlockParams {
  V?: number;
  rBleed?: number;
  frequency?: number;
  qualityFactor?: number;
  motionalCapacitance?: number;
  shuntCapacitance?: number;
}

function buildDcBlockCircuit(facade: DefaultSimulatorFacade, p: DcBlockParams): Circuit {
  return facade.build({
    components: [
      { id: "vs", type: "DcVoltageSource", props: { label: "vs", voltage: p.V ?? 1 } },
      { id: "xtal", type: "QuartzCrystal", props: {
          label: "xtal",
          frequency: p.frequency ?? 1e6,
          qualityFactor: p.qualityFactor ?? 1000,
          motionalCapacitance: p.motionalCapacitance ?? 2e-14,
          shuntCapacitance: p.shuntCapacitance ?? 5e-12,
      } },
      { id: "rbleed", type: "Resistor", props: { label: "rbleed", resistance: p.rBleed ?? 1e9 } },
      { id: "gnd", type: "Ground", props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos", "xtal:pos"],
      ["xtal:neg", "rbleed:pos"],
      ["rbleed:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// QuartzCrystal initialization (T1) — Cat 1
// ---------------------------------------------------------------------------

describe("QuartzCrystal initialization (T1)", () => {
  it("init_post_warm_start_dc_block_full_drop_across_crystal", () => {
    // Cat 1: post-warm-start node voltages for the DC-block topology.
    // V_DC=1V across (xtal in series with R_bleed=1G); BVD caps block DC,
    // L_s has only branch incidence (no DC conductance path), so all 1V
    // drops across the crystal: V(xtal:pos)=1, V(xtal:neg)~=0.
    const fix = buildFixture({
      build: (_r, facade) => buildDcBlockCircuit(facade, { V: 1.0, rBleed: 1e9 }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "xtal:pos"))).toBeCloseTo(1.0, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"))).toBeCloseTo(0.0, 3);
  });
});

// ---------------------------------------------------------------------------
// QuartzCrystal DCOP analytical (T1) — Cat 2 analytical
// ---------------------------------------------------------------------------

describe("QuartzCrystal DCOP analytical (T1)", () => {
  it("dcop_dc_blocks_full_drop_across_crystal", () => {
    // Cat 2 analytical: BVD caps block DC; the only DC path is through the
    // bleed resistor in series. With no DC path through the crystal, all
    // the source voltage appears across xtal:pos / xtal:neg; bleed current
    // is V(xtal:neg)/R_bleed ~= 0 / 1e9 ~= 0.
    const fix = buildFixture({
      build: (_r, facade) => buildDcBlockCircuit(facade, { V: 1.0, rBleed: 1e9 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vXtalPos = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:pos"));
    const vXtalNeg = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"));
    expect(vXtalPos).toBeCloseTo(1.0, 6);
    expect(vXtalNeg).toBeCloseTo(0.0, 3);
    const iBleed = Math.abs(vXtalNeg) / 1e9;
    expect(iBleed).toBeLessThan(1e-9);
  });

  it("dcop_dc_block_higher_voltage_scales_drop", () => {
    // Cat 2 analytical: scaling V_DC linearly scales V(xtal:pos), still
    // with all the source voltage across the crystal at DC.
    const fix = buildFixture({
      build: (_r, facade) => buildDcBlockCircuit(facade, { V: 5.0, rBleed: 1e9 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "xtal:pos"))).toBeCloseTo(5.0, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"))).toBeCloseTo(0.0, 3);
  });
});

// ---------------------------------------------------------------------------
// QuartzCrystal parameter hot-load (T1) — Cat 4
// ---------------------------------------------------------------------------
//
// The Crystal exposes four model params (frequency, qualityFactor,
// motionalCapacitance, shuntCapacitance) all of which feed the derived
// L_s = 1/(4*pi^2*f^2*Cs) and R_s = 2*pi*f*L_s/Q. At DC, these only
// affect the (open) reactive arm; transient behaviour is the observable
// for hot-load. We assert that the post-step transient node voltage
// changes when each documented parameter is hot-loaded.

describe("QuartzCrystal parameter hot-load (T1)", () => {
  it("hotload_frequency_changes_transient_response", () => {
    // Cat 4: frequency feeds L_s (1/f^2) and R_s (linear in f).
    // At a non-DC step, swapping f shifts both L_s and R_s and therefore
    // the integrated companion-current contribution; expect V(xtal:neg)
    // to differ between two different frequencies at a comparable step.
    const fix = buildFixture({
      build: (_r, facade) => buildDcBlockCircuit(facade, { V: 1.0, rBleed: 1e9, frequency: 1e6 }),
    });
    fix.coordinator.step();
    fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"));

    const xtalEl = fix.element("xtal");
    fix.coordinator.setComponentProperty(xtalEl, "frequency", 1e7);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"));
    expect(after).not.toBeCloseTo(before);
  });

  it("hotload_qualityFactor_changes_transient_response", () => {
    // Cat 4: Q only enters R_s = 2*pi*f*L_s/Q; raising Q drops R_s,
    // which changes the motional-arm conductance stamp and the resulting
    // node voltage at a transient step.
    const fix = buildFixture({
      build: (_r, facade) => buildDcBlockCircuit(facade, { V: 1.0, rBleed: 1e9, qualityFactor: 1000 }),
    });
    fix.coordinator.step();
    fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"));

    const xtalEl = fix.element("xtal");
    fix.coordinator.setComponentProperty(xtalEl, "qualityFactor", 50000);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"));
    expect(after).not.toBeCloseTo(before);
  });

  it("hotload_motionalCapacitance_changes_transient_response", () => {
    // Cat 4: motionalCapacitance feeds L_s (1/Cs) AND C_s itself; both
    // companion stamps (L_s row and C_s row) shift, so the transient
    // node voltage moves.
    const fix = buildFixture({
      build: (_r, facade) => buildDcBlockCircuit(facade, { V: 1.0, rBleed: 1e9, motionalCapacitance: 2e-14 }),
    });
    fix.coordinator.step();
    fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"));

    const xtalEl = fix.element("xtal");
    fix.coordinator.setComponentProperty(xtalEl, "motionalCapacitance", 1e-13);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"));
    expect(after).not.toBeCloseTo(before);
  });

  it("hotload_shuntCapacitance_changes_transient_response", () => {
    // Cat 4: shuntCapacitance is C_0 directly across pos/neg; changing it
    // changes the C_0 companion-conductance stamp and therefore the
    // transient node voltage.
    const fix = buildFixture({
      build: (_r, facade) => buildDcBlockCircuit(facade, { V: 1.0, rBleed: 1e9, shuntCapacitance: 5e-12 }),
    });
    fix.coordinator.step();
    fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"));

    const xtalEl = fix.element("xtal");
    fix.coordinator.setComponentProperty(xtalEl, "shuntCapacitance", 5e-11);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "xtal:neg"));
    expect(after).not.toBeCloseTo(before);
  });
});

// ---------------------------------------------------------------------------
// QuartzCrystal LTE rollback (T1) — Cat 7
// ---------------------------------------------------------------------------

describe("QuartzCrystal LTE rollback (T1)", () => {
  it("lte_rollback_state_invariant_after_rejection", () => {
    // Cat 7: AnalogCrystalElement implements getLteTimestep over PHI_L,
    // Q_CS, Q_C0. When LTE rejects a step the engine rotates pool state
    // vectors so state0 == state1 at the slot level (rollback
    // invariant). Drive a fast resonant excitation that produces sharp
    // transient gradients; allow the engine to step until either an LTE
    // rejection appears or the convergence log fills.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vac", type: "AcVoltageSource", props: {
            label: "vac",
            amplitude: 1.0,
            frequency: 1e7,
            waveform: "sine",
          } },
          { id: "xtal", type: "QuartzCrystal", props: {
            label: "xtal",
            frequency: 1e6,
            qualityFactor: 50000,
            motionalCapacitance: 2e-14,
            shuntCapacitance: 5e-12,
          } },
          { id: "rload", type: "Resistor", props: { label: "rload", resistance: 50 } },
          { id: "gnd", type: "Ground", props: { label: "gnd" } },
        ],
        connections: [
          ["vac:pos", "xtal:pos"],
          ["xtal:neg", "rload:pos"],
          ["rload:neg", "gnd:out"],
          ["vac:neg", "gnd:out"],
        ],
      }),
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    for (let i = 0; i < 200; i++) fix.coordinator.step();

    const log = fix.coordinator.getConvergenceLog();
    expect(log).not.toBeNull();
    const rejected = log!.find((s) => s.lteRejected === true);
    if (rejected !== undefined) {
      // Rollback invariant: state0 and state1 agree at the rolled state slots
      // for the crystal's reactive arms after the rotation. QuartzCrystal is a
      // kind:"netlist" composite (crystal.ts buildCrystalNetlist) — PHI / Q
      // state lives on the flattened pool-backed leaves, not on the "xtal"
      // wrapper. The leaves are labelled `${parent}:${subElementName}`:
      //   xtal:lS  — motional inductor, schema slot "PHI"
      //   xtal:cS  — motional capacitor, schema slot "Q"
      //   xtal:c0  — shunt capacitor,    schema slot "Q"
      // Resolve each leaf and read its own stateSchema (sanctioned name-keyed
      // slot lookup, per the project's "schema lookups over slot exports" rule).
      type PoolLeaf = { _stateBase: number; stateSchema: { indexOf: Map<string, number> } };
      const leafByLabel = (label: string): PoolLeaf => {
        const el = fix.circuit.elements.find(
          (e) => (e as { label?: string }).label === label,
        ) as PoolLeaf | undefined;
        expect(el, `composite leaf "${label}" must be resolvable`).toBeDefined();
        return el!;
      };
      const assertRolled = (leaf: PoolLeaf, slotName: string): void => {
        const slot = leaf.stateSchema.indexOf.get(slotName)!;
        const idx = leaf._stateBase + slot;
        expect(fix.pool.state0[idx]).toBe(fix.pool.state1[idx]);
      };

      assertRolled(leafByLabel("xtal:lS"), "PHI");
      assertRolled(leafByLabel("xtal:cS"), "Q");
      assertRolled(leafByLabel("xtal:c0"), "Q");
    }
  });
});

// ---------------------------------------------------------------------------
// QuartzCrystal — T3 harness: DC-block paired vs ngspice
// (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("QuartzCrystal DC-block paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_DC_BLOCK, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_dc_block", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_dc_block", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_dc_block", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// QuartzCrystal — T3 harness: resonator paired vs ngspice
// (Cat 2-numerical / 3 / 5)
// ---------------------------------------------------------------------------

describeIfDll("QuartzCrystal resonator paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RESONATOR, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_resonator", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_resonator", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_resonator", () => {
    session.compareAllAttempts();
  });
});
