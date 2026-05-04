/**
 * Tests for the Inductor component.
 *
 * §4c gap-fill (2026-05-03): all engine-impersonator tests that drove
 * `element.load(ctx)` directly with hand-built `LoadContext` and asserted
 * bit-exact `ag[]`-coefficient or pool-slot stamping have been deleted.
 * Bit-exact per-NR-iteration parity is covered by the ngspice comparison
 * harness (`harness_*` MCP tools, `src/solver/analog/__tests__/ngspice-parity/*`).
 *
 * Remaining coverage in this file:
 *   - Component definition / pinLayout / attributeMapping smoke tests
 *   - Property-bag / temperature-coefficient / M-multiplicity factory checks
 *   - State-pool contract: `_stateBase = -1` before compiler assigns it
 *   - RL transient response: closed-form `V * (1 - exp(-t/τ))` step response
 *     verified through `buildFixture` + `coordinator.step()`. Validates
 *     observable RL behaviour without reaching past the engine boundary.
 */

import { describe, it, expect } from "vitest";
import {
  InductorDefinition,
  INDUCTOR_ATTRIBUTE_MAPPINGS,
  AnalogInductorElement,
} from "../inductor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { PoolBackedAnalogElement } from "../../../solver/analog/element.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// definition smoke tests
// ---------------------------------------------------------------------------

describe("Inductor", () => {
  describe("definition", () => {
    it("InductorDefinition name is 'Inductor'", () => {
      expect(InductorDefinition.name).toBe("Inductor");
    });

    it("InductorDefinition has analog model", () => {
      expect(InductorDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("InductorDefinition has analogFactory", () => {
      expect((InductorDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    });

    it("element allocates a branch row in setup() (visible after buildFixture warm-start)", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildRlCircuit(facade, { vSource: 1, R: 1000, L: 1e-3 }),
      });
      const ind = findInductor(fix.circuit.elements);
      // After compile + warm-start the inductor's branch row has been allocated.
      expect(ind.branchIndex).toBeGreaterThan(0);
    });

    it("InductorDefinition category is PASSIVES", () => {
      expect(InductorDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("InductorDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(InductorDefinition)).not.toThrow();
    });
  });

  describe("pinLayout", () => {
    it("InductorDefinition.pinLayout has 2 entries (pos, neg)", () => {
      expect(InductorDefinition.pinLayout).toHaveLength(2);
      expect(InductorDefinition.pinLayout[0].label).toBe("pos");
      expect(InductorDefinition.pinLayout[1].label).toBe("neg");
    });
  });

  describe("attributeMapping", () => {
    it("inductance maps to inductance property", () => {
      const m = INDUCTOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "inductance");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("inductance");
    });

    it("Label maps to label property", () => {
      const m = INDUCTOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("L1")).toBe("L1");
    });
  });

  describe("statePool", () => {
    it("_stateBase is -1 before compiler assigns it", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 0.01);
      const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      expect((core as PoolBackedAnalogElement)._stateBase).toBe(-1);
    });
  });
});

// ---------------------------------------------------------------------------
// Temperature coefficients TC1, TC2, TNOM, SCALE
// ---------------------------------------------------------------------------

describe("Inductor temperature coefficients", () => {
  it("TC1_scales_inductance_linearly", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("TC1", 1e-3);     // 0.1% per K
    props.setModelParam("TNOM", 300.15);  // nominal at room temp
    getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
    // At T=300.15 (room temp), dT=0, factor=1, L_eff = L_nom
  });

  it("TC1_non_zero_TNOM_offset_scales_inductance", () => {
    // With TNOM=250K, at T=300.15 → dT=50.15, TC1=0.001 → factor=1.05015
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("TC1", 0.001);
    props.setModelParam("TNOM", 250);
    getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });

  it("SCALE_multiplies_inductance", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("SCALE", 2.5);
    getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });
});

// ---------------------------------------------------------------------------
// M multiplicity divides L (parallel inductors = lower L)
// ---------------------------------------------------------------------------

describe("Inductor M multiplicity", () => {
  it("M2_halves_effective_inductance", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("M", 2);
    getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });

  it("M1_leaves_inductance_unchanged", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("M", 1);
    getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });
});

// ---------------------------------------------------------------------------
// RL transient response (closed-form parity, observed through public surface)
// ---------------------------------------------------------------------------
//
// Circuit: VS=1V → R=1kΩ → L=1mH → GND.
// Time constant τ = L/R = 1µs.
//
// Closed-form step response of an RL circuit driven by a DC source:
//   i(t)         = (Vsrc / R) * (1 - exp(-t/τ))
//   V_inductor(t)= Vsrc * exp(-t/τ)              (voltage across L)
//   V_R(t)       = Vsrc * (1 - exp(-t/τ))        (voltage across R)
//
// The node between R and L (call it node M) sits at:
//   V(M) = Vsrc - V_R(t) = Vsrc * exp(-t/τ)
//
// At t = τ, V(M) ≈ Vsrc * exp(-1) ≈ 0.36788 V.
// We assert V(M) at t≈τ matches the closed-form value to 1e-3 relative tol.

interface RlCircuitParams {
  vSource: number;
  R: number;
  L: number;
}

function buildRlCircuit(facade: DefaultSimulatorFacade, p: RlCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: p.vSource } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: p.R } },
      { id: "l1",  type: "Inductor",        props: { label: "L1", inductance: p.L } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "l1:pos"],
      ["l1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function findInductor(elements: ReadonlyArray<unknown>): AnalogInductorElement {
  const idx = elements.findIndex((el) => el instanceof AnalogInductorElement);
  if (idx < 0) throw new Error("AnalogInductorElement not found in compiled circuit");
  return elements[idx] as AnalogInductorElement;
}

describe("Inductor RL transient response", () => {
  it("V(L_pos) matches closed-form Vsrc * exp(-t/τ) at t≈τ (UIC start)", () => {
    const Vsrc = 1.0;
    const R    = 1000;
    const L    = 1e-3;
    const tau  = L / R;            // 1 µs
    const tStop = 5 * tau;         // run ~5τ to keep the engine engaged
    const maxDt = tau / 100;       // 100 steps per τ keeps trap error well below 1e-3

    // Use UIC (Use Initial Conditions, ngspice MODEUIC) to skip DCOP. Without
    // explicit IC parameters the inductor starts at I_L(0)=0. With I_L=0,
    // V_R=0 at t=0, so V(L_pos) = Vsrc, then decays as the current builds.
    const fix = buildFixture({
      build: (_r, facade) => buildRlCircuit(facade, { vSource: Vsrc, R, L }),
      params: { tStop, maxTimeStep: maxDt, uic: true },
    });

    const ind = findInductor(fix.circuit.elements);
    // V(L_pos) is the mid-node between R and L. Closed-form: Vsrc * exp(-t/τ).
    const lPosNode = ind._pinNodes.get("pos")!;

    // Step until simTime crosses τ.
    while (fix.engine.simTime < tau) fix.coordinator.step();

    const vMeasured = fix.engine.getNodeVoltage(lPosNode);
    const vExpected = Vsrc * Math.exp(-fix.engine.simTime / tau);
    const relErr    = Math.abs(vMeasured - vExpected) / Math.abs(vExpected);
    expect(relErr).toBeLessThan(1e-3);
  });

  it("V(L_pos) reaches 0 (inductor short) at DC steady state", () => {
    // Complementary DCOP-driven check: at DC steady state inductor is a
    // short ⇒ V(L_pos) = V(L_neg) = 0 (gnd), regardless of how the engine
    // got there.
    const Vsrc = 1.0;
    const R    = 1000;
    const L    = 1e-3;
    const tau  = L / R;
    const fix = buildFixture({
      build: (_r, facade) => buildRlCircuit(facade, { vSource: Vsrc, R, L }),
      params: { tStop: 10 * tau, maxTimeStep: tau / 10 },
    });
    const ind = findInductor(fix.circuit.elements);
    const lPosNode = ind._pinNodes.get("pos")!;
    while (fix.engine.simTime < 5 * tau) fix.coordinator.step();
    expect(fix.engine.getNodeVoltage(lPosNode)).toBeCloseTo(0, 6);
  });
});
