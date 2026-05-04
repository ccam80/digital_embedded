/** Tests for the SparkGapElement and unified SparkGap component. */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import {
  SparkGapElement,
  SparkGapDefinition,
  createSparkGapElement,
  SPARK_GAP_DEFAULTS,
  SPARK_GAP_SCHEMA,
} from "../spark-gap.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { AnalogFactory } from "../../../core/registry.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

const SLOT_CONDUCTING = SPARK_GAP_SCHEMA.indexOf.get("CONDUCTING")!;

// ---------------------------------------------------------------------------
// Circuit factory: vs → rs → sg → GND. Sized so:
//   - rs = 100 Ω is small vs rOff (1e10 Ω) — blocking divider holds ≈ Vsrc.
//   - rs ≫ rOn (5 Ω) — conducting divider drops V(sg:pos) clearly below Vsrc.
//   - With rOn=5 and iHold=0.01, holding-current threshold V_src is
//     iHold·(rs+rOn) = 0.01·105 = 1.05 V. Tests above/below this boundary
//     verify hysteresis transitions.
// ---------------------------------------------------------------------------

interface SparkGapCircuitParams {
  vSource: number;
  rSeries?: number;
  vBreakdown?: number;
  rOn?: number;
  rOff?: number;
  iHold?: number;
}

function buildSparkGapCircuit(facade: DefaultSimulatorFacade, p: SparkGapCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs", type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource } },
      { id: "rs", type: "Resistor",       props: { label: "rs", resistance: p.rSeries ?? 100 } },
      { id: "sg", type: "SparkGap",       props: {
          label:      "sg",
          model:      "behavioral",
          vBreakdown: p.vBreakdown ?? 1000,
          rOn:        p.rOn        ?? 5,
          rOff:       p.rOff       ?? 1e10,
          iHold:      p.iHold      ?? 0.01,
      } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "rs:pos"],
      ["rs:neg", "sg:pos"],
      ["sg:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function findSparkGap(elements: ReadonlyArray<unknown>): SparkGapElement {
  const idx = elements.findIndex((el) => el instanceof SparkGapElement);
  if (idx < 0) throw new Error("SparkGapElement not found in compiled circuit");
  return elements[idx] as SparkGapElement;
}

function readConducting(fix: ReturnType<typeof buildFixture>, sg: SparkGapElement): number {
  return fix.pool.state1[sg._stateBase + SLOT_CONDUCTING];
}

function readSgPosVoltage(fix: ReturnType<typeof buildFixture>): number {
  const node = fix.circuit.labelToNodeId.get("sg:pos");
  if (node === undefined) throw new Error("sg:pos node not found in labelToNodeId");
  return fix.engine.getNodeVoltage(node);
}

// ---------------------------------------------------------------------------
// SparkGap
// ---------------------------------------------------------------------------

describe("SparkGap", () => {
  describe("definition", () => {
    it("SparkGapDefinition has a behavioral model entry", () => {
      expect(SparkGapDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("SparkGapDefinition has correct category", () => {
      expect(SparkGapDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("SparkGapDefinition has vBreakdown default 1000", () => {
      const params = SparkGapDefinition.modelRegistry?.behavioral?.params;
      expect(params).toBeDefined();
      expect(params!["vBreakdown"]).toBe(1000);
    });

    it("analogFactory creates a SparkGapElement", () => {
      const props = new PropertyBag();
      props.replaceModelParams(SPARK_GAP_DEFAULTS);
      const element = createSparkGapElement(new Map([["pos", 1], ["neg", 2]]), props, () => 0);
      expect(element).toBeInstanceOf(SparkGapElement);
    });

    it("branchCount is false (no extra branch row)", () => {
      const entry = SparkGapDefinition.modelRegistry?.behavioral as
        { kind: "inline"; factory: AnalogFactory; branchCount?: number } | undefined;
      expect(entry?.branchCount).toBeFalsy();
    });

    it("pre-setup _stateBase sentinel is -1 (compiler assigns during setup)", () => {
      const props = new PropertyBag();
      props.replaceModelParams(SPARK_GAP_DEFAULTS);
      const el = createSparkGapElement(new Map([["pos", 1], ["neg", 2]]), props, () => 0);
      expect(el._stateBase).toBe(-1);
    });
  });

  // -------------------------------------------------------------------------
  // Below-breakdown blocking
  //
  // Vsrc=500 V, vBreakdown=1000 V. After warm-start the gap is in blocking
  // state (rOff = 1e10 Ω), the rs-rOff divider holds V(sg:pos) ≈ Vsrc, and
  // pool CONDUCTING == 0.
  // -------------------------------------------------------------------------
  describe("blocks_below_breakdown", () => {
    it("pool CONDUCTING == 0 after warm-start with Vsrc < vBreakdown", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: 500, vBreakdown: 1000, rOn: 5, rOff: 1e10,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const sg = findSparkGap(fix.circuit.elements);
      expect(readConducting(fix, sg)).toBe(0);
    });

    it("V(sg:pos) ≈ Vsrc when blocking (rOff ≫ rs)", () => {
      const Vsrc = 500;
      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: Vsrc, rSeries: 100, vBreakdown: 1000, rOn: 5, rOff: 1e10,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      // Divider: V(sg:pos) = Vsrc · rOff / (rs + rOff) ≈ Vsrc to within 1e-7.
      const vPos = readSgPosVoltage(fix);
      expect(Math.abs(vPos - Vsrc) / Vsrc).toBeLessThan(1e-6);
    });
  });

  // -------------------------------------------------------------------------
  // Above-breakdown firing
  //
  // Vsrc=1500 V > vBreakdown=1000 V. During DCOP the gap sees vTerm ≈ Vsrc
  // (rOff dominates pre-fire), applyHysteresis flips CONDUCTING to 1 inside
  // load(), the bottom-of-load assignment commits to s0, and _seedFromDcop
  // copies state0 → state1 so post-warm-start CONDUCTING == 1.
  // -------------------------------------------------------------------------
  describe("conducts_above_breakdown", () => {
    it("pool CONDUCTING == 1 after warm-start with Vsrc > vBreakdown", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: 1500, vBreakdown: 1000, rOn: 5, rOff: 1e10,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const sg = findSparkGap(fix.circuit.elements);
      expect(readConducting(fix, sg)).toBe(1);
    });

    it("V(sg:pos) drops to Vsrc · rOn/(rs+rOn) when conducting", () => {
      const Vsrc = 1500;
      const rs   = 100;
      const rOn  = 5;
      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: Vsrc, rSeries: rs, vBreakdown: 1000, rOn, rOff: 1e10,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const vPos = readSgPosVoltage(fix);
      const expected = Vsrc * rOn / (rs + rOn); // 1500 · 5/105 ≈ 71.43 V
      expect(Math.abs(vPos - expected) / expected).toBeLessThan(0.01);
    });

    it("current above breakdown is much larger than below breakdown", () => {
      // I = (Vsrc - V(sg:pos)) / rs.
      // Below: V(sg:pos) ≈ Vsrc ⇒ I ≈ 0. Above: V(sg:pos) ≈ Vsrc·rOn/(rs+rOn)
      // ⇒ I ≈ Vsrc / (rs + rOn).
      const rs = 100;
      const fixBelow = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: 500, rSeries: rs, vBreakdown: 1000, rOn: 5, rOff: 1e10,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const I_below = (500 - readSgPosVoltage(fixBelow)) / rs;

      const fixAbove = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: 1500, rSeries: rs, vBreakdown: 1000, rOn: 5, rOff: 1e10,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const I_above = (1500 - readSgPosVoltage(fixAbove)) / rs;

      expect(I_above).toBeGreaterThan(Math.abs(I_below) * 1000);
    });
  });

  // -------------------------------------------------------------------------
  // Hold-current hysteresis (fire then reduce Vsrc but keep I > iHold)
  //
  // Fire at Vsrc=1500, then hot-patch Vsrc=10. Steady-state current after the
  // patch is I = Vsrc / (rs + rOn) = 10/105 ≈ 0.0952 A ≫ iHold=0.01 A, so
  // the gap stays conducting. Verified by pool CONDUCTING and the
  // conducting-divider voltage at sg:pos.
  // -------------------------------------------------------------------------
  describe("holds_until_current_drops", () => {
    it("gap stays conducting after Vsrc drop while I > iHold", () => {
      const rs   = 100;
      const rOn  = 5;
      const iHold = 0.01;

      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: 1500, rSeries: rs, vBreakdown: 1000, rOn, rOff: 1e10, iHold,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const sg = findSparkGap(fix.circuit.elements);
      // Warm-start fired the gap.
      expect(readConducting(fix, sg)).toBe(1);

      // Drop Vsrc to 10 V — well above iHold·(rs+rOn) = 1.05 V, so I stays
      // above iHold and the gap should remain conducting.
      fix.coordinator.setSourceByLabel("vs", "voltage", 10);
      // Re-converge to the new steady state.
      for (let i = 0; i < 20; i++) fix.coordinator.step();

      expect(readConducting(fix, sg)).toBe(1);
      // V(sg:pos) settles to the conducting divider value.
      const vPos = readSgPosVoltage(fix);
      const expected = 10 * rOn / (rs + rOn);
      expect(Math.abs(vPos - expected) / expected).toBeLessThan(0.05);
    });
  });

  // -------------------------------------------------------------------------
  // Extinction (Vsrc ⇒ I < iHold)
  //
  // Fire at Vsrc=1500, then hot-patch Vsrc=0. Current drops to 0 < iHold,
  // applyHysteresis returns 0, pool CONDUCTING transitions back to blocking.
  // -------------------------------------------------------------------------
  describe("extinguishes_below_holding", () => {
    it("gap returns to blocking when Vsrc drops so I < iHold", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: 1500, vBreakdown: 1000, rOn: 5, rOff: 1e10, iHold: 0.01,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const sg = findSparkGap(fix.circuit.elements);
      expect(readConducting(fix, sg)).toBe(1);

      // Vsrc → 0 ⇒ I = 0 < iHold; gap must extinguish.
      fix.coordinator.setSourceByLabel("vs", "voltage", 0);
      for (let i = 0; i < 20; i++) fix.coordinator.step();

      expect(readConducting(fix, sg)).toBe(0);
    });

    it("V(sg:pos) returns to source-tracking blocking divider after extinction", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: 1500, vBreakdown: 1000, rOn: 5, rOff: 1e10, iHold: 0.01,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      // Fire, then drop to a low forward voltage well under vBreakdown so
      // the gap is in the rOff branch but driven by a small Vsrc.
      fix.coordinator.setSourceByLabel("vs", "voltage", 0);
      for (let i = 0; i < 20; i++) fix.coordinator.step();
      const sg = findSparkGap(fix.circuit.elements);
      expect(readConducting(fix, sg)).toBe(0);

      // Re-energize at a low voltage that does not refire (50 V ≪ vBreakdown).
      fix.coordinator.setSourceByLabel("vs", "voltage", 50);
      for (let i = 0; i < 20; i++) fix.coordinator.step();
      // Gap is in blocking branch ⇒ rOff-dominated divider ⇒ V(sg:pos) ≈ Vsrc.
      expect(readConducting(fix, sg)).toBe(0);
      const vPos = readSgPosVoltage(fix);
      expect(Math.abs(vPos - 50) / 50).toBeLessThan(1e-4);
    });

    it("can re-fire after extinction (full hysteresis cycle)", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: 1500, vBreakdown: 1000, rOn: 5, rOff: 1e10, iHold: 0.01,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const sg = findSparkGap(fix.circuit.elements);
      expect(readConducting(fix, sg)).toBe(1);

      // Extinguish.
      fix.coordinator.setSourceByLabel("vs", "voltage", 0);
      for (let i = 0; i < 20; i++) fix.coordinator.step();
      expect(readConducting(fix, sg)).toBe(0);

      // Re-fire by raising Vsrc above vBreakdown again.
      fix.coordinator.setSourceByLabel("vs", "voltage", 1500);
      for (let i = 0; i < 20; i++) fix.coordinator.step();
      expect(readConducting(fix, sg)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Hot-loadable model parameters (system requirement: every model param
  // must be hot-loadable via setComponentProperty).
  // -------------------------------------------------------------------------
  describe("hot_loadable_params", () => {
    it("hot-patching vBreakdown above Vsrc keeps a previously-blocking gap blocked", () => {
      // Vsrc=500, vBreakdown=1000 — blocking at boot.
      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: 500, vBreakdown: 1000, rOn: 5, rOff: 1e10, iHold: 0.01,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const sg = findSparkGap(fix.circuit.elements);
      expect(readConducting(fix, sg)).toBe(0);

      // Lower vBreakdown to 200 V — now Vsrc=500 > vBreakdown ⇒ should fire.
      const sgIdx = fix.circuit.elements.indexOf(sg);
      const sgCircuitElement = fix.circuit.elementToCircuitElement.get(sgIdx)!;
      expect(sgCircuitElement).toBeDefined();
      fix.coordinator.setComponentProperty(sgCircuitElement, "vBreakdown", 200);
      for (let i = 0; i < 20; i++) fix.coordinator.step();

      expect(readConducting(fix, sg)).toBe(1);
    });

    it("hot-patching rOn changes the conducting-divider voltage at sg:pos", () => {
      const Vsrc = 1500;
      const rs   = 100;
      const fix = buildFixture({
        build: (_r, facade) => buildSparkGapCircuit(facade, {
          vSource: Vsrc, rSeries: rs, vBreakdown: 1000, rOn: 5, rOff: 1e10,
        }),
        params: { tStop: 1e-3, maxTimeStep: 1e-4 },
      });
      const sg = findSparkGap(fix.circuit.elements);
      expect(readConducting(fix, sg)).toBe(1);
      const vPosBefore = readSgPosVoltage(fix);

      // Hot-patch rOn from 5 to 50 — divider shifts from Vsrc·5/105 to Vsrc·50/150.
      const sgIdx = fix.circuit.elements.indexOf(sg);
      const sgCircuitElement = fix.circuit.elementToCircuitElement.get(sgIdx)!;
      fix.coordinator.setComponentProperty(sgCircuitElement, "rOn", 50);
      for (let i = 0; i < 20; i++) fix.coordinator.step();

      const vPosAfter = readSgPosVoltage(fix);
      const expectedAfter = Vsrc * 50 / (rs + 50);
      expect(Math.abs(vPosAfter - expectedAfter) / expectedAfter).toBeLessThan(0.05);
      // And the new sg:pos voltage must be measurably higher than before.
      expect(vPosAfter).toBeGreaterThan(vPosBefore * 2);
    });
  });
});
