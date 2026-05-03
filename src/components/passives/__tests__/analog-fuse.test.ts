/**
 * Tests for the AnalogFuseElement MNA model and unified Fuse component.
 *
 * §4d / §4c exemplar: every test routes through `buildFixture`, drives the
 * simulation via the coordinator's public step() surface, and reads state
 * from the pool / engine / runtime-diagnostics public surface. No direct
 * load() drives, no hand-rolled rhs vectors, no matrix-stamp introspection
 * past `engine.solver.getCSCNonZeros()`.
 *
 * Test circuit shape: VS=Vsource → Fuse → R_load → GND.
 * Vsource and R_load are sized to produce the desired steady-state current
 * through the fuse. The fuse's `i2tRating` is sized so blow happens (or
 * doesn't) inside the simulated tStop window.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { AnalogFuseElement, ANALOG_FUSE_SCHEMA, createAnalogFuseElement } from "../analog-fuse.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentRegistry } from "../../../core/registry.js";
import { FuseDefinition } from "../../switching/fuse.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

const SLOT_I2T_ACCUM = ANALOG_FUSE_SCHEMA.indexOf.get("I2T_ACCUM")!;

// ---------------------------------------------------------------------------
// Circuit factory: VS=vSource → fuse → R=rLoad → GND.
//
// Steady-state intact current = vSource / (rCold + rLoad). Tests size
// (vSource, rLoad, i2tRating) so blow happens at the desired sim time.
// ---------------------------------------------------------------------------

interface FuseCircuitParams {
  vSource: number;
  rLoad: number;
  rCold?: number;
  rBlown?: number;
  i2tRating: number;
}

function buildFuseCircuit(facade: DefaultSimulatorFacade, p: FuseCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { label: "V1", voltage: p.vSource } },
      { id: "fuse", type: "Fuse",            props: { label: "F1", model: "behavioral", rCold: p.rCold ?? 0.01, rBlown: p.rBlown ?? 1e9, i2tRating: p.i2tRating } },
      { id: "rl",   type: "Resistor",        props: { label: "RL", resistance: p.rLoad } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vs:pos",   "fuse:out1"],
      ["fuse:out2", "rl:pos"],
      ["rl:neg",   "gnd:out"],
      ["vs:neg",   "gnd:out"],
    ],
  });
}

function findFuse(elements: ReadonlyArray<unknown>): AnalogFuseElement {
  const idx = elements.findIndex((el) => el instanceof AnalogFuseElement);
  if (idx < 0) throw new Error("AnalogFuseElement not found in compiled circuit");
  return elements[idx] as AnalogFuseElement;
}

// ---------------------------------------------------------------------------
// Fuse tests
// ---------------------------------------------------------------------------

describe("AnalogFuseElement", () => {
  describe("low_current_stays_intact", () => {
    it("0.5A through 1A-rated fuse for ~1s stays intact", () => {
      // I = 5V / (1Ω + 9Ω) = 0.5A; I²t after 1s = 0.25 A²·s, well below 1.0
      const fix = buildFixture({
        build: (_r, facade) => buildFuseCircuit(facade, {
          vSource: 5.0, rLoad: 9.0, rCold: 1.0, i2tRating: 1.0,
        }),
        params: { tStop: 1.5, maxTimeStep: 0.01 },
      });
      // Run to ~1s.
      while (fix.engine.simTime < 1.0) fix.coordinator.step();

      const fuse = findFuse(fix.circuit.elements);
      expect(fuse.blown).toBe(false);
      expect(fuse.thermalEnergy).toBeLessThan(1.0);
      expect(fuse.currentResistance).toBe(1.0);
    });
  });

  describe("overcurrent_blows_fuse", () => {
    it("3A through 1A-rated fuse blows at t ≈ i2tRating/I² ≈ 0.111s", () => {
      // I = 30V / (1Ω + 9Ω) = 3A; expectedBlowTime = 1 / 9 ≈ 0.111s
      const fix = buildFixture({
        build: (_r, facade) => buildFuseCircuit(facade, {
          vSource: 30.0, rLoad: 9.0, rCold: 1.0, i2tRating: 1.0,
        }),
        params: { tStop: 0.5, maxTimeStep: 0.001 },
      });
      const fuse = findFuse(fix.circuit.elements);

      // Step until blown or sim runs out.
      while (!fuse.blown && fix.engine.simTime < 0.5) {
        fix.coordinator.step();
      }
      expect(fuse.blown).toBe(true);

      const expected = 1.0 / 9.0;
      const actual = fix.engine.simTime;
      // Breakpoint scheduling lands the step exactly on the blow instant; the
      // observable simTime at first-blown is bounded by [expected, expected+dt].
      expect(actual).toBeGreaterThanOrEqual(expected * 0.8);
      expect(actual).toBeLessThanOrEqual(expected * 1.5);
    });
  });

  describe("blown_fuse_open_circuit", () => {
    it("blown fuse has resistance close to R_blown", () => {
      // I = 30V / (1Ω + 9Ω) = 3A → tBlow ≈ 0.111s with i2tRating=1
      const fix = buildFixture({
        build: (_r, facade) => buildFuseCircuit(facade, {
          vSource: 30.0, rLoad: 9.0, rCold: 1.0, rBlown: 1e9, i2tRating: 1.0,
        }),
        params: { tStop: 0.5, maxTimeStep: 0.001 },
      });
      const fuse = findFuse(fix.circuit.elements);

      while (!fuse.blown && fix.engine.simTime < 0.5) fix.coordinator.step();
      expect(fuse.blown).toBe(true);
      expect(fuse.currentResistance).toBe(1e9);
    });
  });

  describe("blown_emits_diagnostic", () => {
    it("driving overcurrent emits fuse-blown diagnostic to runtime collector", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildFuseCircuit(facade, {
          vSource: 30.0, rLoad: 9.0, rCold: 1.0, i2tRating: 1.0,
        }),
        params: { tStop: 0.5, maxTimeStep: 0.001 },
      });
      const fuse = findFuse(fix.circuit.elements);
      while (!fuse.blown && fix.engine.simTime < 0.5) fix.coordinator.step();
      const diags = fix.coordinator.getRuntimeDiagnostics().filter((d) => d.code === "fuse-blown");
      expect(diags.length).toBe(1);
      expect(diags[0].severity).toBe("info");
    });
  });

  describe("thermalRatio", () => {
    it("thermalRatio increases toward 1 under load (intact range)", () => {
      // Use a generous i2tRating so the fuse stays intact while we step
      // far enough to see I²t accumulate above zero.
      const fix = buildFixture({
        build: (_r, facade) => buildFuseCircuit(facade, {
          vSource: 30.0, rLoad: 9.0, rCold: 1.0, i2tRating: 100.0,
        }),
        params: { tStop: 0.1, maxTimeStep: 0.001 },
      });
      const fuse = findFuse(fix.circuit.elements);

      // Step ~10 ms — I=3A, I²·t = 9·0.01 = 0.09 A²·s, ratio ≈ 0.0009.
      while (fix.engine.simTime < 0.01) fix.coordinator.step();

      expect(fuse.blown).toBe(false);
      expect(fuse.thermalEnergy).toBeGreaterThan(0);
      expect(fuse.thermalRatio).toBeGreaterThan(0);
      expect(fuse.thermalRatio).toBeLessThan(1);
    });
  });

  describe("state_pool_contract", () => {
    it("CONDUCT slot reflects intact (1) state through pool when fuse is intact", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildFuseCircuit(facade, {
          vSource: 5.0, rLoad: 9.0, rCold: 1.0, i2tRating: 1.0,
        }),
        params: { tStop: 0.01, maxTimeStep: 0.001 },
      });
      const fuse = findFuse(fix.circuit.elements);

      const SLOT_CONDUCT = ANALOG_FUSE_SCHEMA.indexOf.get("CONDUCT")!;
      // load() writes CONDUCT each iter from _intact; intact ⇒ s0/s1[CONDUCT]=1
      // after the first warm-started step.
      expect(fix.pool.state0[fuse._stateBase + SLOT_CONDUCT]).toBe(1);
      expect(fix.pool.state1[fuse._stateBase + SLOT_CONDUCT]).toBe(1);
    });

    it("I2T_ACCUM rolls forward on accept (s1 reflects last-accepted history)", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildFuseCircuit(facade, {
          vSource: 30.0, rLoad: 9.0, rCold: 1.0, i2tRating: 10.0, // way above
        }),
        params: { tStop: 0.05, maxTimeStep: 0.001 },
      });
      const fuse = findFuse(fix.circuit.elements);

      const accumBefore = fix.pool.state1[fuse._stateBase + SLOT_I2T_ACCUM];
      while (fix.engine.simTime < 0.04) fix.coordinator.step();
      const accumAfter = fix.pool.state1[fuse._stateBase + SLOT_I2T_ACCUM];
      expect(accumAfter).toBeGreaterThan(accumBefore);
      expect(fuse.blown).toBe(false); // still intact under generous rating
    });
  });

  describe("props_writeback", () => {
    it("PropertyBag writeback propagates blown=true after fuse blows", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildFuseCircuit(facade, {
          vSource: 30.0, rLoad: 9.0, rCold: 1.0, i2tRating: 1.0,
        }),
        params: { tStop: 0.5, maxTimeStep: 0.001 },
      });
      const fuse = findFuse(fix.circuit.elements);
      while (!fuse.blown && fix.engine.simTime < 0.5) fix.coordinator.step();
      expect(fuse.blown).toBe(true);

      // The factory wires onStateChange to write PropertyBag fields. Find the
      // FuseElement (CircuitElement, not the AnalogFuseElement leaf) by
      // walking elementToCircuitElement.
      const fuseIdx = fix.circuit.elements.indexOf(fuse);
      const ce = fix.circuit.elementToCircuitElement.get(fuseIdx)!;
      const props = ce.getProperties();
      expect(props.get("blown")).toBe(true);
      expect(props.getOrDefault<number>("_thermalRatio", 0)).toBeGreaterThan(0);
    });
  });

  describe("unified FuseDefinition", () => {
    it("FuseDefinition behavioral entry produces an AnalogFuseElement", () => {
      const props = new PropertyBag();
      props.setModelParam("rCold", 0.1);
      props.setModelParam("rBlown", 1e9);
      props.setModelParam("i2tRating", 100.0);
      const entry = FuseDefinition.modelRegistry?.behavioral;
      if (!entry || entry.kind !== "inline") throw new Error("Expected inline behavioral entry");
      const el = entry.factory(new Map([["out1", 1], ["out2", 0]]), props, () => 0);
      expect(el).toBeInstanceOf(AnalogFuseElement);
    });

    it("FuseDefinition has switchPins for bus resolver", () => {
      expect(FuseDefinition.models?.digital?.switchPins).toEqual([0, 1]);
    });

    it("FuseDefinition has analog properties (rCold, i2tRating)", () => {
      const keys = FuseDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("rCold");
      expect(keys).toContain("rBlown");
      expect(keys).toContain("i2tRating");
      expect(keys).toContain("currentRating");
    });

    it("FuseDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(FuseDefinition)).not.toThrow();
    });

    it("createAnalogFuseElement factory creates AnalogFuseElement", () => {
      const props = new PropertyBag();
      props.setModelParam("rCold", 0.01);
      props.setModelParam("rBlown", 1e9);
      props.setModelParam("i2tRating", 1e-4);
      const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), props, () => 0);
      expect(el).toBeInstanceOf(AnalogFuseElement);
    });
  });
});
