/**
 * Category 4 -- Parameter hot-load (T1) for the Transformer netlist composite.
 *
 * Verifies that hot-loading k, L1, and L2 via setParam triggers
 * MUTfactor recomputation and that subsequent NR convergence reflects the
 * new operating point. Uses the canonical T1 buildFixture API.
 */

import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { AnalogInductorElement } from "../inductor.js";
import { MutualInductorElement } from "../mutual-inductor.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";
import type { Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// Circuit builder
// ---------------------------------------------------------------------------

interface AcBenchParams {
  amplitude: number;
  frequency: number;
  rLoad: number;
  primaryInductance: number;
  couplingCoefficient: number;
}

function buildAcBench(facade: DefaultSimulatorFacade, p: AcBenchParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "AcVoltageSource", props: {
          label: "VS", amplitude: p.amplitude, frequency: p.frequency,
      } },
      { id: "tx",  type: "Transformer", props: {
          label:               "TX1",
          model:               "behavioral",
          turnsRatio:          1.0,
          primaryInductance:   p.primaryInductance,
          couplingCoefficient: p.couplingCoefficient,
      } },
      { id: "rl",  type: "Resistor", props: { label: "RLOAD", resistance: p.rLoad } },
      { id: "gnd", type: "Ground",   props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos",  "tx:P1"],
      ["vs:neg",  "gnd:out"],
      ["tx:P2",   "gnd:out"],
      ["tx:S1",   "rl:pos"],
      ["rl:neg",  "gnd:out"],
      ["tx:S2",   "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label ${label} not found in labelToNodeId`);
  return n;
}

function getTransformerCe(fix: Fixture) {
  const idx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "TX1",
  );
  if (idx < 0) throw new Error("TX1 element not found by elementLabels");
  const ce = fix.circuit.elementToCircuitElement.get(idx);
  if (ce === undefined) throw new Error("TX1 elementToCircuitElement entry missing");
  return ce;
}

function getInductorElement(fix: Fixture, subLabel: string): AnalogInductorElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const el = fix.circuit.elements[i]!;
    if (el instanceof AnalogInductorElement && el.label === subLabel) {
      return el;
    }
  }
  throw new Error(`AnalogInductorElement with label ${subLabel} not found`);
}

function getMutElement(fix: Fixture, subLabel: string): MutualInductorElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const el = fix.circuit.elements[i]!;
    if (el instanceof MutualInductorElement && el.label === subLabel) {
      return el;
    }
  }
  throw new Error(`MutualInductorElement with label ${subLabel} not found`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Transformer hot-load k, L1, L2 via setParam (T1 Category 4)", () => {
  it("hotload_k_recomputes_mutFactor_and_shifts_secondary_voltage", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        primaryInductance: 1e-3, couplingCoefficient: 0.99,
      }),
      params: { tStop: 5e-3, maxTimeStep: 5e-6, uic: true },
    });

    const s1Node = nodeOf(fix, "TX1:S1");
    const mutEl = getMutElement(fix, "TX1:MUT");

    const mutFactorBefore = mutEl.mutFactor;

    // Run 1.5 cycles to let the AC settle past startup transient.
    while (fix.engine.simTime < 1.5e-3) fix.coordinator.step();
    const vSecBefore = fix.engine.getNodeVoltage(s1Node);

    // Hot-load k from 0.99 to 0.50 via setComponentProperty on the
    // top-level TransformerElement. Routes through
    // SubcircuitWrapperElement.setParam("k", 0.50) -> MutualInductorElement
    // .setParam("k", 0.50) -> _coupling = 0.50 -> recomputeMutFactor().
    fix.coordinator.setComponentProperty(getTransformerCe(fix), "k", 0.50);

    const mutFactorAfter = mutEl.mutFactor;

    // MUTfactor must have recomputed: k dropped 0.99 -> 0.50
    expect(mutFactorAfter).toBeLessThan(mutFactorBefore);
    // Precise ratio: MUTfactor = k*sqrt(L1*L2), so ratio = 0.50/0.99
    expect(mutFactorAfter / mutFactorBefore).toBeCloseTo(0.50 / 0.99, 6);

    // Step the engine to let NR reconverge at the new operating point.
    fix.coordinator.step();
    const vSecAfter = fix.engine.getNodeVoltage(s1Node);

    // Lower k reduces energy coupled to the secondary; voltage magnitude shifts.
    expect(Math.abs(vSecAfter)).toBeLessThan(Math.abs(vSecBefore) * 0.85);
  });

  it("hotload_L1_via_inductor_setParam_recomputes_mutFactor", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        primaryInductance: 1e-3, couplingCoefficient: 0.99,
      }),
      params: { tStop: 5e-3, maxTimeStep: 5e-6, uic: true },
    });

    const s1Node = nodeOf(fix, "TX1:S1");
    const l1El = getInductorElement(fix, "TX1:L1");
    const mutEl = getMutElement(fix, "TX1:MUT");

    const mutFactorBefore = mutEl.mutFactor;
    const l1Before = l1El.inductance;

    // Run 1.5 cycles to settle.
    while (fix.engine.simTime < 1.5e-3) fix.coordinator.step();
    const vSecBefore = fix.engine.getNodeVoltage(s1Node);

    // Hot-load L1 directly on the AnalogInductorElement.
    // setParam("inductance", 4e-3) sets _nominalL -> _effectiveL, then cascades
    // to all _mutSiblings via recomputeMutFactor().
    l1El.setParam("inductance", 4e-3);
    // Propagate through engine temperature pass (matches setComponentProperty contract).
    fix.coordinator.getAnalogEngine()!.configure({});

    const l1After = l1El.inductance;
    const mutFactorAfter = mutEl.mutFactor;

    expect(l1Before).toBeCloseTo(1e-3, 12);
    expect(l1After).toBeCloseTo(4e-3, 12);

    // MUTfactor = k*sqrt(L1*L2). L1 quadrupled (1mH->4mH) while L2 stays
    // at 1mH (1:1 turns ratio), so MUTfactor doubles.
    expect(mutFactorAfter).toBeCloseTo(mutFactorBefore * 2, 6);

    fix.coordinator.step();
    const vSecAfter = fix.engine.getNodeVoltage(s1Node);

    expect(vSecAfter).not.toBeCloseTo(vSecBefore, 3);
  });

  it("hotload_L2_via_inductor_setParam_recomputes_mutFactor", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        primaryInductance: 1e-3, couplingCoefficient: 0.99,
      }),
      params: { tStop: 5e-3, maxTimeStep: 5e-6, uic: true },
    });

    const s1Node = nodeOf(fix, "TX1:S1");
    const l2El = getInductorElement(fix, "TX1:L2");
    const mutEl = getMutElement(fix, "TX1:MUT");

    const mutFactorBefore = mutEl.mutFactor;
    const l2Before = l2El.inductance;

    while (fix.engine.simTime < 1.5e-3) fix.coordinator.step();
    const vSecBefore = fix.engine.getNodeVoltage(s1Node);

    l2El.setParam("inductance", 4e-3);
    fix.coordinator.getAnalogEngine()!.configure({});

    const l2After = l2El.inductance;
    const mutFactorAfter = mutEl.mutFactor;

    expect(l2Before).toBeCloseTo(1e-3, 12);
    expect(l2After).toBeCloseTo(4e-3, 12);

    // MUTfactor doubles: sqrt(1e-3 * 4e-3) vs sqrt(1e-3 * 1e-3).
    expect(mutFactorAfter).toBeCloseTo(mutFactorBefore * 2, 6);

    fix.coordinator.step();
    const vSecAfter = fix.engine.getNodeVoltage(s1Node);

    expect(vSecAfter).not.toBeCloseTo(vSecBefore, 3);
  });

  it("hotload_k_then_L1_then_L2_in_sequence_each_shifts_mutFactor", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        primaryInductance: 1e-3, couplingCoefficient: 0.99,
      }),
      params: { tStop: 10e-3, maxTimeStep: 5e-6, uic: true },
    });

    const s1Node = nodeOf(fix, "TX1:S1");
    const l1El = getInductorElement(fix, "TX1:L1");
    const l2El = getInductorElement(fix, "TX1:L2");
    const mutEl = getMutElement(fix, "TX1:MUT");

    while (fix.engine.simTime < 1.5e-3) fix.coordinator.step();
    const vSec0 = fix.engine.getNodeVoltage(s1Node);
    const mutFactor0 = mutEl.mutFactor;

    // Step 1: hot-load k from 0.99 to 0.50
    fix.coordinator.setComponentProperty(getTransformerCe(fix), "k", 0.50);
    const mutFactor1 = mutEl.mutFactor;
    fix.coordinator.step();
    const vSec1 = fix.engine.getNodeVoltage(s1Node);

    expect(mutFactor1).not.toBeCloseTo(mutFactor0, 6);
    expect(vSec1).not.toBeCloseTo(vSec0, 3);

    // Step 2: hot-load L1 from 1mH to 2mH
    l1El.setParam("inductance", 2e-3);
    fix.coordinator.getAnalogEngine()!.configure({});
    const mutFactor2 = mutEl.mutFactor;
    fix.coordinator.step();
    const vSec2 = fix.engine.getNodeVoltage(s1Node);

    expect(mutFactor2).not.toBeCloseTo(mutFactor1, 6);
    expect(vSec2).not.toBeCloseTo(vSec1, 3);

    // Step 3: hot-load L2 from 1mH to 2mH
    l2El.setParam("inductance", 2e-3);
    fix.coordinator.getAnalogEngine()!.configure({});
    const mutFactor3 = mutEl.mutFactor;
    fix.coordinator.step();
    const vSec3 = fix.engine.getNodeVoltage(s1Node);

    expect(mutFactor3).not.toBeCloseTo(mutFactor2, 6);
    expect(vSec3).not.toBeCloseTo(vSec2, 3);

    // Final MUTfactor = 0.50 * sqrt(2e-3 * 2e-3) = 0.50 * 2e-3 = 1e-3
    expect(mutFactor3).toBeCloseTo(0.50 * Math.sqrt(2e-3 * 2e-3), 10);
  });
});
