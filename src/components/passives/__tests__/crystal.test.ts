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
// AC resonator topology: V_AC -> xtal -> R_load -> GND.
//
// The BVD motional arm (R_s, L_s, C_s) has its series resonance at
// f_s = 1/(2π√(L_s·C_s)). With frequency=1e6 and C_s=2e-14, L_s and C_s are
// chosen so f_s = 1 MHz. At f_s the motional arm impedance collapses to ~R_s,
// so the V_AC / (xtal ∥ C_0) / R_load divider passes a large signal to
// xtal:neg. Both `frequency` (which sets L_s and shifts f_s) and
// `qualityFactor` (which sets R_s and thus the divider depth at resonance)
// move the complex AC node voltage at xtal:neg — the observable the DC-block
// topology cannot expose (R_s/L_s carry ~0 current at a DC operating point).
// ---------------------------------------------------------------------------

interface AcResonatorParams {
  frequency?: number;
  qualityFactor?: number;
  motionalCapacitance?: number;
  shuntCapacitance?: number;
  rLoad?: number;
}

function buildAcResonatorCircuit(facade: DefaultSimulatorFacade, p: AcResonatorParams): Circuit {
  return facade.build({
    components: [
      { id: "vac", type: "AcVoltageSource", props: {
          label: "vac",
          amplitude: 0.1,
          frequency: p.frequency ?? 1e6,
          waveform: "sine",
      } },
      { id: "xtal", type: "QuartzCrystal", props: {
          label: "xtal",
          frequency: p.frequency ?? 1e6,
          qualityFactor: p.qualityFactor ?? 1000,
          motionalCapacitance: p.motionalCapacitance ?? 2e-14,
          shuntCapacitance: p.shuntCapacitance ?? 5e-12,
      } },
      { id: "rload", type: "Resistor", props: { label: "rload", resistance: p.rLoad ?? 1000 } },
      { id: "gnd", type: "Ground", props: { label: "gnd" } },
    ],
    connections: [
      ["vac:pos", "xtal:pos"],
      ["xtal:neg", "rload:pos"],
      ["rload:neg", "gnd:out"],
      ["vac:neg", "gnd:out"],
    ],
  });
}

// Complex magnitude of the AC solution at a node, at the single sweep point
// nearest the series resonance (1 MHz). `acAnalysis` relinearises at DC then
// solves the complex MNA system per frequency; the magnitude at xtal:neg is
// the divider response and depends on the motional R_s / L_s.
function acMagAtResonance(fix: ReturnType<typeof buildFixture>, node: string): number {
  const res = fix.coordinator.acAnalysis({
    type: "lin",
    numPoints: 1,
    fStart: 1e6,
    fStop: 1e6,
    outputNodes: [node],
  })!;
  const re = res.real.get(node)!;
  const im = res.imag.get(node)!;
  return Math.hypot(re[0], im[0]);
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
  it("hotload_frequency_changes_ac_resonance_response", () => {
    // Cat 4: frequency feeds L_s = 1/(4π²f²C_s) and R_s = 2πf·L_s/Q. The
    // DC-block topology cannot expose this — at a DC operating point the
    // motional arm (R_s, L_s) carries ~0 current through the blocking C_s, so
    // a change in L_s/R_s leaves V(xtal:neg) untouched. The AC resonator
    // probes the series resonance: hot-loading frequency shifts f_s away from
    // the 1 MHz sweep point, collapsing the divider response at xtal:neg.
    const fix = buildFixture({
      build: (_r, facade) => buildAcResonatorCircuit(facade, { frequency: 1e6 }),
    });
    const before = acMagAtResonance(fix, "xtal:neg");

    const xtalEl = fix.element("xtal");
    fix.coordinator.setComponentProperty(xtalEl, "frequency", 1.01e6);
    const after = acMagAtResonance(fix, "xtal:neg");
    expect(after).not.toBeCloseTo(before);
  });

  it("hotload_qualityFactor_changes_ac_resonance_response", () => {
    // Cat 4: Q enters only R_s = 2πf·L_s/Q. At a DC operating point R_s sits
    // in series with the blocking C_s and carries ~0 current, so the DC-block
    // topology cannot expose a Q change. At series resonance the motional arm
    // impedance collapses to ~R_s, so R_s sets the divider depth at xtal:neg;
    // raising Q lowers R_s and raises the AC response. Probe at the 1 MHz
    // resonance point and assert the magnitude moves.
    const fix = buildFixture({
      build: (_r, facade) => buildAcResonatorCircuit(facade, { qualityFactor: 1000 }),
    });
    const before = acMagAtResonance(fix, "xtal:neg");

    const xtalEl = fix.element("xtal");
    fix.coordinator.setComponentProperty(xtalEl, "qualityFactor", 50000);
    const after = acMagAtResonance(fix, "xtal:neg");
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
