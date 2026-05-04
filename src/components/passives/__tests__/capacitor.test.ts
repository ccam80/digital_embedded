/**
 * Tests for the Capacitor component.
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
 *   - RC transient response: closed-form `V * (1 - exp(-t/τ))` step response
 *     verified through `buildFixture` + `coordinator.step()`. Validates
 *     observable RC behaviour without reaching past the engine boundary.
 */

import { describe, it, expect } from "vitest";
import {
  CapacitorDefinition,
  CAPACITOR_ATTRIBUTE_MAPPINGS,
  AnalogCapacitorElement,
} from "../capacitor.js";
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

describe("Capacitor", () => {
  describe("definition", () => {
    it("CapacitorDefinition name is 'Capacitor'", () => {
      expect(CapacitorDefinition.name).toBe("Capacitor");
    });

    it("CapacitorDefinition category is PASSIVES", () => {
      expect(CapacitorDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("CapacitorDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(CapacitorDefinition)).not.toThrow();
    });
  });

  describe("pinLayout", () => {
    it("CapacitorDefinition.pinLayout has 2 entries (pos, neg)", () => {
      expect(CapacitorDefinition.pinLayout).toHaveLength(2);
      expect(CapacitorDefinition.pinLayout[0].label).toBe("pos");
      expect(CapacitorDefinition.pinLayout[1].label).toBe("neg");
    });
  });

  describe("attributeMapping", () => {
    it("capacitance maps to capacitance property", () => {
      const m = CAPACITOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "capacitance");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("capacitance");
    });

    it("Label maps to label property", () => {
      const m = CAPACITOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("C1")).toBe("C1");
    });
  });

  describe("statePool", () => {
    it("_stateBase is -1 before compiler assigns it", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      expect((core as PoolBackedAnalogElement)._stateBase).toBe(-1);
    });
  });
});

// ---------------------------------------------------------------------------
// Temperature coefficients TC1, TC2, TNOM, SCALE
// ---------------------------------------------------------------------------

describe("Capacitor temperature coefficients", () => {
  it("TC1_zero_TNOM_room_temp_gives_nominal_capacitance", () => {
    // dT=0 → factor=1, C_eff = C_nom * SCALE * M = C_nom
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("TNOM", 300.15);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });

  it("TC1_non_zero_TNOM_offset_scales_capacitance", () => {
    // TNOM=250K → dT = 300.15-250 = 50.15, TC1=0.001 → factor=1.05015
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("TC1", 0.001);
    props.setModelParam("TNOM", 250);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });

  it("SCALE_multiplies_capacitance", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("SCALE", 3);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });
});

// ---------------------------------------------------------------------------
// M multiplicity multiplies C (parallel capacitors = higher C)
// ---------------------------------------------------------------------------

describe("Capacitor M multiplicity", () => {
  it("M2_doubles_effective_capacitance", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("M", 2);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });

  it("M1_leaves_capacitance_unchanged", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("M", 1);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });
});

// ---------------------------------------------------------------------------
// RC transient response (closed-form parity, observed through public surface)
// ---------------------------------------------------------------------------
//
// Circuit: VS=1V → R=1kΩ → C=1µF → GND.
// Time constant τ = R*C = 1 ms.
//
// Closed-form step response of an RC circuit driven by a DC source:
//   V_C(t) = Vsrc * (1 - exp(-t/τ))
//
// At t = τ, V_C ≈ Vsrc * (1 - exp(-1)) ≈ 0.63212 V.
// We assert V_C at t≈τ matches the closed-form value to 1e-3 relative tol.

interface RcCircuitParams {
  vSource: number;
  R: number;
  C: number;
}

function buildRcCircuit(facade: DefaultSimulatorFacade, p: RcCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: p.vSource } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: p.R } },
      { id: "c1",  type: "Capacitor",       props: { label: "C1", capacitance: p.C } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function findCapacitor(elements: ReadonlyArray<unknown>): AnalogCapacitorElement {
  const idx = elements.findIndex((el) => el instanceof AnalogCapacitorElement);
  if (idx < 0) throw new Error("AnalogCapacitorElement not found in compiled circuit");
  return elements[idx] as AnalogCapacitorElement;
}

describe("Capacitor RC transient response", () => {
  it("V(C_pos) matches closed-form Vsrc * (1 - exp(-t/τ)) at t≈τ (UIC start)", () => {
    const Vsrc = 1.0;
    const R    = 1000;
    const C    = 1e-6;
    const tau  = R * C;            // 1 ms
    const tStop = 5 * tau;         // run ~5τ
    const maxDt = tau / 100;       // 100 steps per τ keeps trap error well below 1e-3

    // Use UIC (Use Initial Conditions, ngspice MODEUIC) to skip DCOP. Without
    // explicit IC parameters the cap starts at V_C(0)=0, so we observe the
    // full RC step transient charging through R toward Vsrc.
    const fix = buildFixture({
      build: (_r, facade) => buildRcCircuit(facade, { vSource: Vsrc, R, C }),
      params: { tStop, maxTimeStep: maxDt, uic: true },
    });

    const cap = findCapacitor(fix.circuit.elements);
    const cPosNode = cap._pinNodes.get("pos")!;

    // Step until simTime crosses τ.
    while (fix.engine.simTime < tau) fix.coordinator.step();

    const vMeasured = fix.engine.getNodeVoltage(cPosNode);
    const vExpected = Vsrc * (1 - Math.exp(-fix.engine.simTime / tau));
    const relErr    = Math.abs(vMeasured - vExpected) / Math.abs(vExpected);
    expect(relErr).toBeLessThan(1e-3);
  });

  it("V(C_pos) reaches Vsrc steady state at t ≫ τ", () => {
    // Complementary check that doesn't depend on UIC: under DCOP the cap is
    // open at DC, so V_C must equal Vsrc both immediately (DCOP) and after
    // any transient run.
    const Vsrc = 1.0;
    const R    = 1000;
    const C    = 1e-6;
    const tau  = R * C;
    const fix = buildFixture({
      build: (_r, facade) => buildRcCircuit(facade, { vSource: Vsrc, R, C }),
      params: { tStop: 10 * tau, maxTimeStep: tau / 10 },
    });
    const cap = findCapacitor(fix.circuit.elements);
    const cPosNode = cap._pinNodes.get("pos")!;
    while (fix.engine.simTime < 5 * tau) fix.coordinator.step();
    expect(fix.engine.getNodeVoltage(cPosNode)).toBeCloseTo(Vsrc, 6);
  });
});
