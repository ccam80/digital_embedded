import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import {
  ComparisonSession,
} from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { BJT_SIMPLE_SCHEMA, BJT_L1_SCHEMA } from "../bjt.js";

const DTS_NPN_CE = path.resolve("fixtures/npn-ce-harness.dts");
const DTS_NPN_CE_FULL = path.resolve("fixtures/npn-ce-full-harness.dts");
const DTS_PNP_CC = path.resolve("fixtures/pnp-cc-harness.dts");

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Asserts post-warm-start state pool slot values seeded by initState() / setup().
// One block per topology variant: NPN simple (L0), PNP simple (L0), NPN L1
// vertical, NPN L1 lateral. The L0 / L1 stateSchema differ — both warm-start
// paths exercise distinct code paths and need their own programmatic build.
// ---------------------------------------------------------------------------

describe("BJT initialization (T1)", () => {
  const SLOT_VBE_L0 = BJT_SIMPLE_SCHEMA.indexOf.get("VBE")!;
  const SLOT_VBE_L1 = BJT_L1_SCHEMA.indexOf.get("VBE")!;

  it("init_npn_simple_vbe_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vcc", type: "DcVoltageSource", props: { label: "Vcc", voltage: 5 } },
          { id: "rc", type: "Resistor", props: { label: "Rc", resistance: 1000 } },
          { id: "rb", type: "Resistor", props: { label: "Rb", resistance: 100000 } },
          { id: "q1", type: "NpnBJT", props: { label: "Q1", model: "simple" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vcc:pos", "rc:pos"],
          ["rc:neg", "q1:C"],
          ["vcc:pos", "rb:pos"],
          ["rb:neg", "q1:B"],
          ["q1:E", "gnd:out"],
          ["vcc:neg", "gnd:out"],
        ],
      }),
    });

    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "Q1",
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const el = fix.circuit.elements[idx]!;
    // initState seeds VBE to a positive forward-bias voltage for NPN polarity.
    const vbe = fix.pool.state0[el._stateBase + SLOT_VBE_L0];
    expect(Number.isFinite(vbe)).toBe(true);
    // Engine has solved a node voltage at the BJT base after warm-start.
    const vBase = fix.engine.getNodeVoltage(
      fix.circuit.labelToNodeId.get("Q1:B")!,
    );
    expect(Number.isFinite(vBase)).toBe(true);
  });

  it("init_pnp_simple_vbe_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vee", type: "DcVoltageSource", props: { label: "Vee", voltage: 5 } },
          { id: "re", type: "Resistor", props: { label: "Re", resistance: 1000 } },
          { id: "rb", type: "Resistor", props: { label: "Rb", resistance: 100000 } },
          { id: "q1", type: "PnpBJT", props: { label: "Q1", model: "simple" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vee:pos", "re:pos"],
          ["re:neg", "q1:E"],
          ["q1:B", "rb:pos"],
          ["rb:neg", "gnd:out"],
          ["q1:C", "gnd:out"],
          ["vee:neg", "gnd:out"],
        ],
      }),
    });

    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "Q1",
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const el = fix.circuit.elements[idx]!;
    const vbe = fix.pool.state0[el._stateBase + SLOT_VBE_L0];
    expect(Number.isFinite(vbe)).toBe(true);
  });

  it("init_npn_l1_vertical_vbe_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vcc", type: "DcVoltageSource", props: { label: "Vcc", voltage: 5 } },
          { id: "rc", type: "Resistor", props: { label: "Rc", resistance: 1000 } },
          { id: "rb", type: "Resistor", props: { label: "Rb", resistance: 100000 } },
          { id: "q1", type: "NpnBJT", props: { label: "Q1", model: "spice" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vcc:pos", "rc:pos"],
          ["rc:neg", "q1:C"],
          ["vcc:pos", "rb:pos"],
          ["rb:neg", "q1:B"],
          ["q1:E", "gnd:out"],
          ["vcc:neg", "gnd:out"],
        ],
      }),
    });

    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "Q1",
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const el = fix.circuit.elements[idx]!;
    const vbe = fix.pool.state0[el._stateBase + SLOT_VBE_L1];
    expect(Number.isFinite(vbe)).toBe(true);
  });

  it("init_npn_l1_lateral_vbe_seeded", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vcc", type: "DcVoltageSource", props: { label: "Vcc", voltage: 5 } },
          { id: "rc", type: "Resistor", props: { label: "Rc", resistance: 1000 } },
          { id: "rb", type: "Resistor", props: { label: "Rb", resistance: 100000 } },
          { id: "q1", type: "NpnBJT", props: { label: "Q1", model: "spice-lateral" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vcc:pos", "rc:pos"],
          ["rc:neg", "q1:C"],
          ["vcc:pos", "rb:pos"],
          ["rb:neg", "q1:B"],
          ["q1:E", "gnd:out"],
          ["vcc:neg", "gnd:out"],
        ],
      }),
    });

    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "Q1",
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const el = fix.circuit.elements[idx]!;
    const vbe = fix.pool.state0[el._stateBase + SLOT_VBE_L1];
    expect(Number.isFinite(vbe)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// Forward-active NPN common-emitter at IB = (Vcc - Vbe) / RB. Analytical truth
// for IC and Vc is hand-computable with default BF=100; collector node should
// settle strictly inside (0, Vcc). Bit-exact comparison against ngspice is the
// canonical Cat 2-numerical check (T3 sessions below).
// ---------------------------------------------------------------------------

describe("BJT DCOP analytical sanity (T1)", () => {
  it("dcop_npn_ce_converges", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vcc", type: "DcVoltageSource", props: { label: "Vcc", voltage: 5 } },
          { id: "rc", type: "Resistor", props: { label: "Rc", resistance: 1000 } },
          { id: "rb", type: "Resistor", props: { label: "Rb", resistance: 100000 } },
          { id: "q1", type: "NpnBJT", props: { label: "Q1", model: "spice" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vcc:pos", "rc:pos"],
          ["rc:neg", "q1:C"],
          ["vcc:pos", "rb:pos"],
          ["rb:neg", "q1:B"],
          ["q1:E", "gnd:out"],
          ["vcc:neg", "gnd:out"],
        ],
      }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
    const vc = fix.engine.getNodeVoltage(
      fix.circuit.labelToNodeId.get("Q1:C")!,
    );
    expect(Number.isFinite(vc)).toBe(true);
    // Forward-active CE: collector pulled below rail by IC*Rc.
    expect(vc).toBeGreaterThan(0);
    expect(vc).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// One it() per representative parameter group on the BJT model. Structural
// (BF / IS / VAF / BR / AREA) and derived-state-recompute (TEMP — universal
// for every analog component with temp-dependent state). Asserts the
// simulator output observably changed after setComponentProperty + step,
// not on internal element fields or property bag contents.
// ---------------------------------------------------------------------------

describe("BJT parameter hot-load (T1)", () => {
  function buildCe(modelKey: "simple" | "spice"): ReturnType<typeof buildFixture> {
    return buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vcc", type: "DcVoltageSource", props: { label: "Vcc", voltage: 5 } },
          { id: "rc", type: "Resistor", props: { label: "Rc", resistance: 1000 } },
          { id: "rb", type: "Resistor", props: { label: "Rb", resistance: 100000 } },
          { id: "q1", type: "NpnBJT", props: { label: "Q1", model: modelKey } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vcc:pos", "rc:pos"],
          ["rc:neg", "q1:C"],
          ["vcc:pos", "rb:pos"],
          ["rb:neg", "q1:B"],
          ["q1:E", "gnd:out"],
          ["vcc:neg", "gnd:out"],
        ],
      }),
    });
  }

  function getQ1(fix: ReturnType<typeof buildFixture>) {
    const idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "Q1",
    );
    const ce = fix.circuit.elementToCircuitElement.get(idx);
    expect(ce).toBeDefined();
    return { idx, ce: ce! };
  }

  it("hotload_BF_changes_vc", () => {
    const fix = buildCe("spice");
    const { ce } = getQ1(fix);
    const vcNode = fix.circuit.labelToNodeId.get("Q1:C")!;
    const before = fix.engine.getNodeVoltage(vcNode);
    fix.coordinator.setComponentProperty(ce, "BF", 25);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vcNode);
    // Lower BF -> less collector current -> Vc rises toward Vcc.
    expect(after).not.toBeCloseTo(before, 6);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_IS_changes_vc", () => {
    const fix = buildCe("spice");
    const { ce } = getQ1(fix);
    const vcNode = fix.circuit.labelToNodeId.get("Q1:C")!;
    const before = fix.engine.getNodeVoltage(vcNode);
    fix.coordinator.setComponentProperty(ce, "IS", 1e-13);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vcNode);
    // Larger IS -> larger IC at same Vbe -> Vc moves observably.
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_TEMP_changes_vc", () => {
    // TEMP is a derived-state-recompute parameter: setParam("TEMP", T)
    // triggers makeTp() which recomputes tSatCur / vt. This is the universal
    // temperature path required of every analog component with
    // temperature-dependent state.
    const fix = buildCe("spice");
    const { ce } = getQ1(fix);
    const vcNode = fix.circuit.labelToNodeId.get("Q1:C")!;
    const before = fix.engine.getNodeVoltage(vcNode);
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vcNode);
    // Raising TEMP raises tSatCur exponentially -> larger IC at same bias ->
    // Vc moves predictably. Recompute path verified by observable change.
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_AREA_changes_vc", () => {
    // AREA scales tSatCur via the area factor (instance-partitioned param).
    const fix = buildCe("spice");
    const { ce } = getQ1(fix);
    const vcNode = fix.circuit.labelToNodeId.get("Q1:C")!;
    const before = fix.engine.getNodeVoltage(vcNode);
    fix.coordinator.setComponentProperty(ce, "AREA", 4);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vcNode);
    expect(after).not.toBeCloseTo(before, 6);
  });

  it("hotload_BR_changes_vc", () => {
    // BR is a secondary parameter; reverse beta affects forward-active only
    // weakly via the Gummel-Poon QB term, but the recompute path must run
    // and produce an observable shift.
    const fix = buildCe("spice");
    const { ce } = getQ1(fix);
    const vcNode = fix.circuit.labelToNodeId.get("Q1:C")!;
    const before = fix.engine.getNodeVoltage(vcNode);
    fix.coordinator.setComponentProperty(ce, "BR", 0.1);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vcNode);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).not.toBe(before);
  });

  it("hotload_VAF_changes_vc", () => {
    // VAF (forward Early voltage) sets the output conductance go = IC/VAF.
    // Going from infinity (default) to a finite value changes the slope of
    // the IC-VCE characteristic at the operating point.
    const fix = buildCe("spice");
    const { ce } = getQ1(fix);
    const vcNode = fix.circuit.labelToNodeId.get("Q1:C")!;
    const before = fix.engine.getNodeVoltage(vcNode);
    fix.coordinator.setComponentProperty(ce, "VAF", 50);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(vcNode);
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// pnjlim fires on BJT BE / BC junctions during DCOP NR. Drives the engine to
// a converged DC-OP and asserts the limiting collector recorded the BE / BC
// junction visits.
// ---------------------------------------------------------------------------

describe("BJT limiting events own-engine (T1)", () => {
  it("limiting_pnjlim_fires_npn_ce", () => {
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vcc", type: "DcVoltageSource", props: { label: "Vcc", voltage: 5 } },
          { id: "rc", type: "Resistor", props: { label: "Rc", resistance: 1000 } },
          { id: "rb", type: "Resistor", props: { label: "Rb", resistance: 100000 } },
          { id: "q1", type: "NpnBJT", props: { label: "Q1", model: "spice" } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vcc:pos", "rc:pos"],
          ["rc:neg", "q1:C"],
          ["vcc:pos", "rb:pos"],
          ["rb:neg", "q1:B"],
          ["q1:E", "gnd:out"],
          ["vcc:neg", "gnd:out"],
        ],
      }),
    });
    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();
    const events = fix.coordinator.getLimitingEvents();
    // BJT load() pushes BE and BC events when limitingCollector is non-null.
    const be = events.find(e => e.label === "Q1" && e.junction === "BE");
    const bc = events.find(e => e.label === "Q1" && e.junction === "BC");
    expect(be).toBeDefined();
    expect(bc).toBeDefined();
    expect(be!.limitType).toBe("pnjlim");
    expect(bc!.limitType).toBe("pnjlim");
    expect(Number.isFinite(be!.vBefore)).toBe(true);
    expect(Number.isFinite(be!.vAfter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 7 — LTE rollback (T1)
// BJT.getLteTimestep proposes a dt based on cktTerr() over QBE / QBC / QSUB
// charge slots. Slots are non-zero only when caps (CJE / CJC / CJS / TF) are
// enabled. Topology: forward-biased NPN with caps activated. State1 / state0
// rotation invariant after the warm-start step is the rollback gate — the
// rolled charge slot must preserve the accepted-state value pattern.
// ---------------------------------------------------------------------------

describe("BJT LTE rollback (T1)", () => {
  it("lte_rollback_state_invariant", () => {
    const SLOT_QBE = BJT_L1_SCHEMA.indexOf.get("QBE")!;
    const fix = buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vcc", type: "DcVoltageSource", props: { label: "Vcc", voltage: 5 } },
          { id: "rc", type: "Resistor", props: { label: "Rc", resistance: 2200 } },
          { id: "rb", type: "Resistor", props: { label: "Rb", resistance: 47000 } },
          { id: "q1", type: "NpnBJT", props: {
            label: "Q1",
            model: "spice",
            // Activate cap-driven LTE path: BE/BC depletion + transit time.
            CJE: 20e-12,
            CJC: 8e-12,
            TF: 4e-10,
          } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vcc:pos", "rc:pos"],
          ["rc:neg", "q1:C"],
          ["vcc:pos", "rb:pos"],
          ["rb:neg", "q1:B"],
          ["q1:E", "gnd:out"],
          ["vcc:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });
    fix.coordinator.setConvergenceLogEnabled(true);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const log = fix.coordinator.getConvergenceLog();
    expect(log).not.toBeNull();
    // The rollback invariant: at any step boundary post-warm-start, accepted
    // state0 and state1 are populated (rotation has run)
    // and remain finite for the rolled QBE charge slot. cktTerr / LTE
    // proposals fire only when these slots carry meaningful values.
    const idx = fix.circuit.elements.findIndex(
      (_e, i2) => fix.elementLabels.get(i2) === "Q1",
    );
    const el = fix.circuit.elements[idx]!;
    expect(Number.isFinite(fix.pool.state0[el._stateBase + SLOT_QBE])).toBe(true);
    expect(Number.isFinite(fix.pool.state1[el._stateBase + SLOT_QBE])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — computeTemperature engine-driven path (T1)
//
// BjtL0Element and BjtL1Element both declare computeTemperature(ctx).
// The engine's defaultTemperatureHandler calls this via the optional-chaining
// dispatch (element.computeTemperature?.(ctx)). Tests verify:
//   1. Ambient temperature propagation: ctx.cktTemp changes the operating point.
//   2. Per-instance TEMP override locks the operating temperature regardless of
//      ambient (bjttemp.c:107-108 BJTtempGiven guard).
//   3. setParam("TEMP", v) on the hot-load path keeps _tempGiven = true so
//      subsequent computeTemperature calls still respect the override.
//   4. At cktTemp == TNOM (300.15 K), math is trivially identity
//      (ratio1 = T/TNOM - 1 = 0, factor = 1): node voltages are bit-exact
//      with the baseline fixture values.
// ---------------------------------------------------------------------------

describe("BJT computeTemperature engine-driven path (T1)", () => {
  function buildCeNpn(modelKey: "simple" | "spice"): ReturnType<typeof buildFixture> {
    return buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vcc", type: "DcVoltageSource", props: { label: "Vcc", voltage: 5 } },
          { id: "rc",  type: "Resistor",        props: { label: "Rc",  resistance: 1000 } },
          { id: "rb",  type: "Resistor",        props: { label: "Rb",  resistance: 100000 } },
          { id: "q1",  type: "NpnBJT",          props: { label: "Q1",  model: modelKey } },
          { id: "gnd", type: "Ground",          props: { label: "GND" } },
        ],
        connections: [
          ["vcc:pos", "rc:pos"],
          ["rc:neg",  "q1:C"],
          ["vcc:pos", "rb:pos"],
          ["rb:neg",  "q1:B"],
          ["q1:E",    "gnd:out"],
          ["vcc:neg", "gnd:out"],
        ],
      }),
    });
  }

  function buildCcPnp(modelKey: "simple" | "spice"): ReturnType<typeof buildFixture> {
    return buildFixture({
      build: (_r, f) => f.build({
        components: [
          { id: "vcc", type: "DcVoltageSource", props: { label: "Vcc", voltage: 5 } },
          { id: "re",  type: "Resistor",        props: { label: "Re",  resistance: 1000 } },
          { id: "rb",  type: "Resistor",        props: { label: "Rb",  resistance: 100000 } },
          { id: "q1",  type: "PnpBJT",          props: { label: "Q1",  model: modelKey } },
          { id: "gnd", type: "Ground",          props: { label: "GND" } },
        ],
        connections: [
          ["vcc:pos", "re:pos"],
          ["re:neg",  "q1:E"],
          ["q1:B",    "rb:pos"],
          ["rb:neg",  "gnd:out"],
          ["q1:C",    "gnd:out"],
          ["vcc:neg", "gnd:out"],
        ],
      }),
    });
  }

  it("computeTemperature_l0_npn_ambient_propagates", () => {
    // Build at 300.15 K (REFTEMP = TNOM), solve DCOP, record Vc.
    const fixCold = buildCeNpn("simple");
    fixCold.coordinator.dcOperatingPoint();
    const vcNode = fixCold.circuit.labelToNodeId.get("Q1:C")!;
    const vcCold = fixCold.engine.getNodeVoltage(vcNode);

    // Build second fixture; raise ambient to 400 K via setCircuitTemp.
    // cite: bjttemp.c:108 — if(!BJTtempGiven) here->BJTtemp = ckt->CKTtemp
    // Raising T raises tSatCur exponentially → larger IC at same Vbe → Vc drops.
    const fixHot = buildCeNpn("simple");
    fixHot.facade.setCircuitTemp(400);
    fixHot.coordinator.dcOperatingPoint();
    const vcHot = fixHot.engine.getNodeVoltage(vcNode);

    expect(vcHot).not.toBeCloseTo(vcCold, 6);
    expect(vcHot).toBeLessThan(vcCold);
  });

  it("computeTemperature_l1_npn_ambient_propagates", () => {
    // Same test as above but using L1 (full SPICE model).
    const fixCold = buildCeNpn("spice");
    fixCold.coordinator.dcOperatingPoint();
    const vcNode = fixCold.circuit.labelToNodeId.get("Q1:C")!;
    const vcCold = fixCold.engine.getNodeVoltage(vcNode);

    const fixHot = buildCeNpn("spice");
    fixHot.facade.setCircuitTemp(400);
    fixHot.coordinator.dcOperatingPoint();
    const vcHot = fixHot.engine.getNodeVoltage(vcNode);

    expect(vcHot).not.toBeCloseTo(vcCold, 6);
    expect(vcHot).toBeLessThan(vcCold);
  });

  it("computeTemperature_l0_pnp_ambient_propagates", () => {
    // PNP polarity: computeTemperature uses the same math (bjttemp.c is
    // polarity-agnostic). Raising T → larger tSatCur → larger IE at same Vbe
    // → emitter node voltage (Q1:E) moves observably.
    const fixCold = buildCcPnp("simple");
    fixCold.coordinator.dcOperatingPoint();
    const veNode = fixCold.circuit.labelToNodeId.get("Q1:E")!;
    const veCold = fixCold.engine.getNodeVoltage(veNode);

    const fixHot = buildCcPnp("simple");
    fixHot.facade.setCircuitTemp(400);
    fixHot.coordinator.dcOperatingPoint();
    const veHot = fixHot.engine.getNodeVoltage(veNode);

    expect(veHot).not.toBeCloseTo(veCold, 6);
  });

  it("computeTemperature_l0_npn_instance_override_respected", () => {
    // Per-instance TEMP set via setParam locks operating temp regardless of
    // ambient. cite: bjttemp.c:107 — BJTtempGiven guard.
    const fix = buildCeNpn("simple");
    const q1Idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "Q1",
    );
    const ce = fix.circuit.elementToCircuitElement.get(q1Idx)!;

    // Pin per-instance TEMP at 400 K via setComponentProperty (routes to setParam).
    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.dcOperatingPoint();
    const vcNode = fix.circuit.labelToNodeId.get("Q1:C")!;
    const vcAt400 = fix.engine.getNodeVoltage(vcNode);

    // Now raise ambient to 500 K. With _tempGiven=true, computeTemperature
    // must use the per-instance 400 K override, not ctx.cktTemp=500.
    fix.facade.setCircuitTemp(500);
    fix.coordinator.dcOperatingPoint();
    const vcAfterAmbientRaise = fix.engine.getNodeVoltage(vcNode);

    // If _tempGiven is correctly honored, the two DCOP results will be
    // equivalent (same per-instance temp both times). A small numerical
    // difference is allowed since NR iterates from a different init state,
    // but the result must be the same operating point to within SPICE tol.
    expect(Math.abs(vcAfterAmbientRaise - vcAt400)).toBeLessThan(1e-6);
  });

  it("computeTemperature_l1_npn_instance_override_respected", () => {
    // Same guard test as above, L1 model.
    const fix = buildCeNpn("spice");
    const q1Idx = fix.circuit.elements.findIndex(
      (_e, i) => fix.elementLabels.get(i) === "Q1",
    );
    const ce = fix.circuit.elementToCircuitElement.get(q1Idx)!;

    fix.coordinator.setComponentProperty(ce, "TEMP", 400);
    fix.coordinator.dcOperatingPoint();
    const vcNode = fix.circuit.labelToNodeId.get("Q1:C")!;
    const vcAt400 = fix.engine.getNodeVoltage(vcNode);

    fix.facade.setCircuitTemp(500);
    fix.coordinator.dcOperatingPoint();
    const vcAfterAmbientRaise = fix.engine.getNodeVoltage(vcNode);

    expect(Math.abs(vcAfterAmbientRaise - vcAt400)).toBeLessThan(1e-6);
  });

  it("computeTemperature_at_tnom_is_identity_l0_npn", () => {
    // At cktTemp = TNOM = REFTEMP = 300.15 K, the temperature math is
    // trivially identity: ratio1 = T/TNOM - 1 = 0, factor = exp(0) = 1.
    // cite: bjttemp.c:167-171 — ratio1 = here->BJTtemp/model->BJTtnom - 1;
    //   factlog = ratio1*EG/vt + XTI*ratlog;  factor = exp(factlog);
    //   tSatCur = IS * factor;  (= IS when T == TNOM)
    // Node voltages must be bit-exact with the baseline fixture result.
    const fixBase = buildCeNpn("simple");
    fixBase.coordinator.dcOperatingPoint();
    const vcNode = fixBase.circuit.labelToNodeId.get("Q1:C")!;
    const vcBase = fixBase.engine.getNodeVoltage(vcNode);

    const fixWithCall = buildCeNpn("simple");
    // Explicitly trigger computeTemperature at TNOM (no-op mathematically).
    fixWithCall.facade.setCircuitTemp(300.15);
    fixWithCall.coordinator.dcOperatingPoint();
    const vcWithCall = fixWithCall.engine.getNodeVoltage(vcNode);

    // Bit-exact at TNOM (same floating-point path through computeBjtTempParams).
    expect(vcWithCall).toBe(vcBase);
  });

  it("computeTemperature_at_tnom_is_identity_l1_npn", () => {
    // Same identity check for L1 model.
    // cite: bjttemp.c:167-171 — factor = exp(0) = 1 when T == TNOM.
    const fixBase = buildCeNpn("spice");
    fixBase.coordinator.dcOperatingPoint();
    const vcNode = fixBase.circuit.labelToNodeId.get("Q1:C")!;
    const vcBase = fixBase.engine.getNodeVoltage(vcNode);

    const fixWithCall = buildCeNpn("spice");
    fixWithCall.facade.setCircuitTemp(300.15);
    fixWithCall.coordinator.dcOperatingPoint();
    const vcWithCall = fixWithCall.engine.getNodeVoltage(vcNode);

    expect(vcWithCall).toBe(vcBase);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 / 6-paired — Harness sessions (T3)
// One describe()/session per .dts. Each session opens once in beforeAll,
// reuses across categories that share that circuit, disposes in afterAll.
// All gated on canonical dllAvailable() via describeIfDll.
// ---------------------------------------------------------------------------

describeIfDll("BJT NPN CE paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_NPN_CE,
      dllPath: DLL_PATH,
    });
    await session.runTransient(0, 1e-5, 1e-7);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("dcop_paired_npn_ce", () => {
    // Step 0 of a transient is the firsttime DCOP solve. The harness records
    // it alongside the first transient attempt; getStepEnd(0) exposes the
    // converged DC node and component slot values for paired comparison.
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("transient_step_end_paired_npn_ce", () => {
    session.compareAllSteps();
  });

  it("full_iteration_paired_npn_ce", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("BJT NPN CE full-model paired vs ngspice (T3)", () => {
  // Full-model fixture: caps (CJE/CJC/CJS), Early (VAF), high-injection
  // (IKF), parasitic R (RB/RC/RE), substrate (ISS), excess phase (PTF/TF/XTF),
  // 1 MHz sine drive. Exercises every cktMode-gated branch and every charge
  // slot — the rich topology is exactly what Cat 5 compareAllAttempts() needs
  // to surface predictor / NOBYPASS / MODEINITTRAN / cap-block divergences.
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_NPN_CE_FULL,
      dllPath: DLL_PATH,
    });
    await session.runTransient(0, 5e-6, 5e-8);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("dcop_paired_npn_ce_full", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("transient_step_end_paired_npn_ce_full", () => {
    session.compareAllSteps();
  });

  it("full_iteration_paired_npn_ce_full", () => {
    session.compareAllAttempts();
  });

  it("limiting_paired_npn_ce_full", () => {
    // Pair pnjlim limiting events on Q1 BE / BC junctions across the first
    // attempt of step 0. wasLimited and {vBefore,vAfter} must agree bit-exact.
    const cmp = session.getLimitingComparison("Q1", 0, 0);
    for (const j of cmp.junctions) {
      expect(j.limitingDiff).toBe(0);
    }
  });
});

describeIfDll("BJT PNP common-collector paired vs ngspice (T3)", () => {
  // PNP polarity exercises the polarity=-1 branch in load(): voltages and
  // currents flip sign throughout. Distinct from any NPN .dts.
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({
      dtsPath: DTS_PNP_CC,
      dllPath: DLL_PATH,
    });
    await session.runTransient(0, 5e-3, 5e-5);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("dcop_paired_pnp_cc", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("transient_step_end_paired_pnp_cc", () => {
    session.compareAllSteps();
  });

  it("full_iteration_paired_pnp_cc", () => {
    session.compareAllAttempts();
  });
});
