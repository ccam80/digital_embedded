import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Programmatic circuit factory (T1)
// ---------------------------------------------------------------------------
//
// Resistive divider with a potentiometer between V1 and GND, wiper observed
// via a high-impedance sense resistor (1e8 Ohm) so the wiper node lives in
// the MNA without disturbing the divider voltage. Closed-form DCOP at the
// wiper:
//   R_top    = R * position
//   R_bottom = R * (1 - position)
//   V(W) ~= Vsrc * R_bottom / (R_top + R_bottom) = Vsrc * (1 - position)
// (The 1e8 Ohm sense resistor draws < 0.001% of the divider current, so the
// closed-form is bit-exact at the assertion's precision.)

interface PotDividerParams {
  vSource?: number;
  R?: number;
  position?: number;
}

function buildPotDividerCircuit(facade: DefaultSimulatorFacade, p: PotDividerParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { label: "V1",  voltage:    p.vSource ?? 1.0 } },
      { id: "pot",  type: "Potentiometer",   props: { label: "POT", resistance: p.R ?? 10000, position: p.position ?? 0.5 } },
      { id: "rsns", type: "Resistor",        props: { label: "RSNS", resistance: 1e8 } },
      { id: "gnd",  type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos",   "pot:pos"],
      ["pot:neg",  "gnd:out"],
      ["vs:neg",   "gnd:out"],
      ["pot:W",    "rsns:pos"],
      ["rsns:neg", "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function ceByLabel(fix: ReturnType<typeof buildFixture>, label: string): CircuitElement {
  for (const ce of fix.circuit.elementToCircuitElement.values()) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return ce;
  }
  throw new Error(`CircuitElement with label '${label}' not found`);
}

// ---------------------------------------------------------------------------
// Potentiometer initialization (T1) - Cat 1
// ---------------------------------------------------------------------------
//
// Potentiometer carries no state-pool slots (purely conductive G stamps with
// no time-derivative state). Cat 1 reduces to the post-warm-start node
// observability: at step 0, the wiper voltage already matches the closed-
// form divider value because warm-start runs DCOP before the first transient
// step.

describe("Potentiometer initialization (T1)", () => {
  it("init_post_warm_start_wiper_matches_closed_form_divider", () => {
    // V1 = 1V, R = 10k, position = 0.5: R_top = R_bottom = 5k.
    // V(W) = Vsrc * (1 - position) = 1.0 * 0.5 = 0.5V.
    const fix = buildFixture({
      build: (_r, facade) => buildPotDividerCircuit(facade, { vSource: 1.0, R: 10000, position: 0.5 }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "POT:W"))).toBeCloseTo(0.5, 4);
    // Power-rail nodes also seeded at DCOP values in step 0.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "V1:pos"))).toBeCloseTo(1.0, 6);
  });
});

// ---------------------------------------------------------------------------
// Potentiometer DCOP analytical (T1) - Cat 2 analytical
// ---------------------------------------------------------------------------

describe("Potentiometer DCOP analytical (T1)", () => {
  it("dcop_midpoint_symmetric_split", () => {
    // Cat 2 analytical: position = 0.5, R = 10k, V1 = 1V.
    //   R_top = R_bottom = 5k -> V(W) = Vsrc / 2 = 0.5V exactly.
    const fix = buildFixture({
      build: (_r, facade) => buildPotDividerCircuit(facade, { vSource: 1.0, R: 10000, position: 0.5 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "POT:W"))).toBeCloseTo(0.5, 4);
  });

  it("dcop_position_low_wiper_near_source", () => {
    // Cat 2 analytical: position = 0.01, R = 10k, V1 = 1V.
    //   R_top = 100, R_bottom = 9900 -> V(W) = 9900 / 10000 = 0.99V exactly.
    const fix = buildFixture({
      build: (_r, facade) => buildPotDividerCircuit(facade, { vSource: 1.0, R: 10000, position: 0.01 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "POT:W"))).toBeCloseTo(0.99, 3);
  });

  it("dcop_position_high_wiper_near_ground", () => {
    // Cat 2 analytical: position = 0.99, R = 10k, V1 = 1V.
    //   R_top = 9900, R_bottom = 100 -> V(W) = 100 / 10000 = 0.01V exactly.
    const fix = buildFixture({
      build: (_r, facade) => buildPotDividerCircuit(facade, { vSource: 1.0, R: 10000, position: 0.99 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "POT:W"))).toBeCloseTo(0.01, 3);
  });
});

// ---------------------------------------------------------------------------
// Potentiometer parameter hot-load (T1) - Cat 4
// ---------------------------------------------------------------------------
//
// Two structural model parameters: resistance, position. Each setParam(...)
// recomputes G_AW and G_WB (the two stamped conductances) so each is a
// derived-state recompute path.

describe("Potentiometer parameter hot-load (T1)", () => {
  it("hotload_position_changes_wiper_voltage", () => {
    // Cat 4: shifting position from 0.5 to 0.1 changes G_AW and G_WB so the
    // wiper voltage moves from V/2 to V*(1-0.1) = 0.9*V.
    const fix = buildFixture({
      build: (_r, facade) => buildPotDividerCircuit(facade, { vSource: 1.0, R: 10000, position: 0.5 }),
    });
    fix.coordinator.dcOperatingPoint();
    const wNode = nodeOf(fix, "POT:W");
    const before = fix.engine.getNodeVoltage(wNode);
    expect(before).toBeCloseTo(0.5, 4);

    const potEl = ceByLabel(fix, "POT");
    fix.coordinator.setComponentProperty(potEl, "position", 0.1);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(wNode);
    // Closed-form: V(W) = Vsrc * (1 - position) = 1.0 * 0.9 = 0.9V.
    expect(after).toBeCloseTo(0.9, 4);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_resistance_preserves_voltage_ratio_at_constant_position", () => {
    // Cat 4: scaling R uniformly leaves the divider ratio unchanged at fixed
    // position, but the per-half conductances both halve when R doubles.
    // The observable shift comes from the sense-resistor loading: the larger
    // R the more the 1e8 sense path perturbs V(W). Hold position=0.5 and
    // raise R from 10k to 1e7 - the divider ratio still resolves at 0.5V at
    // closed-form, but the sense load draws relatively more current and the
    // node moves measurably away from 0.5V.
    const fix = buildFixture({
      build: (_r, facade) => buildPotDividerCircuit(facade, { vSource: 1.0, R: 10000, position: 0.5 }),
    });
    fix.coordinator.dcOperatingPoint();
    const wNode = nodeOf(fix, "POT:W");
    const before = fix.engine.getNodeVoltage(wNode);
    expect(before).toBeCloseTo(0.5, 4);

    const potEl = ceByLabel(fix, "POT");
    // Raise R by 1000x. R_top = R_bottom = 5e6 - now comparable to the 1e8
    // sense load, so V(W) sags below 0.5V noticeably.
    fix.coordinator.setComponentProperty(potEl, "resistance", 1e7);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(wNode);
    // V(W) at position=0.5 with R=1e7 and 1e8 load:
    //   parallel(R_bottom, R_load) = 5e6 * 1e8 / (5e6 + 1e8) ~= 4.762e6
    //   V(W) = Vsrc * Rp / (R_top + Rp) = 1 * 4.762e6 / (5e6 + 4.762e6)
    //        ~= 0.4878V.
    expect(after).toBeCloseTo(0.4878, 3);
    expect(after).not.toBeCloseTo(before, 3);
  });
});
