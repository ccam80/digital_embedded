/**
 * Tests for the _spiceModelOverrides compiler merge (P1.4).
 *
 * Verifies that both compiler sites (standalone analog and mixed-signal)
 * correctly merge _spiceModelOverrides into _modelParams.
 *
 * Tests 1–4 from the Part 3 acceptance criteria (headless surface):
 *   1. Override merge: IS overridden to 1e-14, other params equal NPN defaults
 *   2. Empty overrides: {} leaves _modelParams equal to raw defaults
 *   3. No overrides property: _modelParams equals raw defaults
 *   4. Malformed JSON: emits invalid-spice-overrides warning, falls back to defaults
 */

import { describe, it, expect } from "vitest";
import { compileUnified } from "@/compile/compile.js";
import { Circuit, Wire } from "../../../core/circuit.js";
import { ComponentRegistry, ComponentCategory } from "../../../core/registry.js";
import type { ComponentDefinition, ExecuteFunction } from "../../../core/registry.js";
import { PropertyBag } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { SerializedElement } from "../../../core/element.js";
import type { AnalogElement } from "../element.js";
import type { SparseSolver } from "../sparse-solver.js";
import type { AnalogElementFactory } from "../behavioral-gate.js";
import { BJT_NPN_DEFAULTS } from "../../../components/semiconductors/bjt.js";
import { TUNNEL_DIODE_PARAM_DEFAULTS as TUNNEL_DIODE_DEFAULTS } from "../../../components/semiconductors/tunnel-diode.js";
import { DIODE_PARAM_DEFAULTS as DIODE_DEFAULTS } from "../../../components/semiconductors/diode.js";
import { SCHOTTKY_PARAM_DEFAULTS as SCHOTTKY_DEFAULTS } from "../../../components/semiconductors/schottky.js";
import { ZENER_PARAM_DEFAULTS as ZENER_DEFAULTS } from "../../../components/semiconductors/zener.js";

// ---------------------------------------------------------------------------
// Shared circuit-building helpers
// ---------------------------------------------------------------------------

function makePin(x: number, y: number, label = ""): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isInverted: false,
    isClock: false,
    bitWidth: 1,
  };
}

function makeElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string }>,
  propsMap: Map<string, PropertyValue> = new Map(),
  registry?: ComponentRegistry,
): CircuitElement {
  const def = registry?.get(typeId);
  const resolvedPins = pins.map((p, i) => makePin(p.x, p.y, p.label || def?.pinLayout[i]?.label || ""));
  const propertyBag = new PropertyBag(propsMap.entries());
  const serialized: SerializedElement = {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    properties: {},
  };
  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement["rotation"],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) { },
    serialize() { return serialized; },
    getAttribute(k: string) { return propsMap.get(k); },
  };
}

/**
 * Build a minimal analog circuit: Ground + NPN-stub with the given
 * _spiceModelOverrides property value (or absent if undefined).
 *
 * Returns { capturedModelParams, diagnostics } from compileUnified.
 */
function buildAndCompile(spiceModelOverrides?: Record<string, number> | string): {
  capturedModelParams: Record<string, number> | undefined;
  diagnostics: Array<{ code: string; severity: string; message?: string; summary?: string }>;
} {
  let capturedModelParams: Record<string, number> | undefined;

  const npnFactory: AnalogElementFactory = (_pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    capturedModelParams = props.getModelParamKeys().length > 0
      ? Object.fromEntries(props.getModelParamKeys().map(k => [k, props.getModelParam<number>(k)]))
      : undefined;
    const stub: AnalogElement = {
      pinNodeIds: [],
      allNodeIds: [],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp(_s: SparseSolver) {},
    };
    return stub;
  };

  function noopExecFn(): ExecuteFunction {
    return (_idx, _state, _layout) => {};
  }

  const registry = new ComponentRegistry();

  registry.register({
    name: "Ground",
    typeId: -1,
    factory: (_props) => { throw new Error("unused"); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "Ground",
    models: { mnaModels: { behavioral: {} } },
  } as unknown as ComponentDefinition);

  registry.register({
    name: "NpnStub",
    typeId: -1,
    factory: (_props) => { throw new Error("unused"); },
    pinLayout: [
      { label: "C", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
      { label: "B", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
      { label: "E", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
    ],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: "NPN Stub",
    models: {
      mnaModels: {
        behavioral: {
          deviceType: "NPN" as string,
          factory: npnFactory,
        },
      },
    },
  } as unknown as ComponentDefinition);

  const propsMap = new Map<string, PropertyValue>();
  propsMap.set("label", "q1");
  if (spiceModelOverrides !== undefined) {
    propsMap.set("_spiceModelOverrides", spiceModelOverrides);
  }

  const circuit = new Circuit();
  const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }], new Map(), registry);
  // Three pins all sharing node 0 (self-wired) — minimal valid topology
  const npn = makeElement(
    "NpnStub",
    "q1",
    [
      { x: 10, y: 0, label: "C" },
      { x: 20, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ],
    propsMap,
    registry,
  );

  circuit.addElement(gnd);
  circuit.addElement(npn);
  circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
  circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
  circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));

  const compiled = compileUnified(circuit, registry).analog!;

  return {
    capturedModelParams,
    diagnostics: compiled.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spice-model-overrides compiler merge", () => {
  it("override_merge: IS overridden to 1e-14, other params stay at NPN defaults", () => {
    const { capturedModelParams, diagnostics } = buildAndCompile({ IS: 1e-14 });

    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    expect(capturedModelParams).toBeDefined();
    expect(capturedModelParams!["IS"]).toBe(1e-14);
    // BF should remain at the NPN default (not overridden)
    expect(capturedModelParams!["BF"]).toBe(BJT_NPN_DEFAULTS["BF"]);
    // NF should remain at the NPN default
    expect(capturedModelParams!["NF"]).toBe(BJT_NPN_DEFAULTS["NF"]);
  });

  it("empty_overrides: {} leaves _modelParams equal to raw defaults", () => {
    const { capturedModelParams, diagnostics } = buildAndCompile({});

    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    expect(capturedModelParams).toBeDefined();
    expect(capturedModelParams!["IS"]).toBe(BJT_NPN_DEFAULTS["IS"]);
    expect(capturedModelParams!["BF"]).toBe(BJT_NPN_DEFAULTS["BF"]);
  });

  it("no_overrides_property: _modelParams equals raw defaults", () => {
    const { capturedModelParams, diagnostics } = buildAndCompile(undefined);

    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    expect(capturedModelParams).toBeDefined();
    expect(capturedModelParams!["IS"]).toBe(BJT_NPN_DEFAULTS["IS"]);
    expect(capturedModelParams!["BF"]).toBe(BJT_NPN_DEFAULTS["BF"]);
  });

  // -------------------------------------------------------------------------
  // Per-component defaultParams resolution tests
  // -------------------------------------------------------------------------

  it("schottky_lossy_diff_regression: override IS to DIODE_DEFAULTS.IS preserves that value", () => {
    let capturedModelParams: Record<string, number> | undefined;

    const schottkyFactory: AnalogElementFactory = (_pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
      capturedModelParams = props.getModelParamKeys().length > 0
      ? Object.fromEntries(props.getModelParamKeys().map(k => [k, props.getModelParam<number>(k)]))
      : undefined;
      const stub: AnalogElement = {
        pinNodeIds: [],
        allNodeIds: [],
        branchIndex: -1,
        isNonlinear: false,
        isReactive: false,
        stamp(_s: SparseSolver) {},
      };
      return stub;
    };

    const registry = new ComponentRegistry();

    registry.register({
      name: "Ground",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Ground",
      models: { mnaModels: { behavioral: {} } },
    } as unknown as ComponentDefinition);

    registry.register({
      name: "SchottkyStub",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [
        { label: "A", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
        { label: "K", direction: PinDirection.BIDIRECTIONAL, position: { x: 10, y: 0 } },
      ],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Schottky Stub",
      models: {
        mnaModels: {
          behavioral: {
            deviceType: "D" as string,
            factory: schottkyFactory,
            defaultParams: SCHOTTKY_DEFAULTS,
          },
        },
      },
    } as unknown as ComponentDefinition);

    // Override IS to exactly DIODE_DEFAULTS.IS (1e-14) — verifies that an
    // override matching the default value is stored and applied correctly.
    const propsMap = new Map<string, PropertyValue>([
      ["label", "d1"],
      ["_spiceModelOverrides", { IS: DIODE_DEFAULTS["IS"] }],
    ]);

    const circuit = new Circuit();
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }], new Map(), registry);
    const schottky = makeElement(
      "SchottkyStub",
      "d1",
      [
        { x: 0, y: 0, label: "A" },
        { x: 10, y: 0, label: "K" },
      ],
      propsMap,
      registry,
    );

    circuit.addElement(gnd);
    circuit.addElement(schottky);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    expect(capturedModelParams).toBeDefined();
    // The override IS=1e-14 must be preserved, NOT replaced by SCHOTTKY_DEFAULTS.IS
    expect(capturedModelParams!["IS"]).toBe(DIODE_DEFAULTS["IS"]);
    expect(capturedModelParams!["IS"]).not.toBe(SCHOTTKY_DEFAULTS["IS"]);
  });

  it("zener_defaults: no overrides resolves ZENER_DEFAULTS, not DIODE_DEFAULTS", () => {
    let capturedModelParams: Record<string, number> | undefined;

    const zenerFactory: AnalogElementFactory = (_pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
      capturedModelParams = props.getModelParamKeys().length > 0
      ? Object.fromEntries(props.getModelParamKeys().map(k => [k, props.getModelParam<number>(k)]))
      : undefined;
      const stub: AnalogElement = {
        pinNodeIds: [],
        allNodeIds: [],
        branchIndex: -1,
        isNonlinear: false,
        isReactive: false,
        stamp(_s: SparseSolver) {},
      };
      return stub;
    };

    const registry = new ComponentRegistry();

    registry.register({
      name: "Ground",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Ground",
      models: { mnaModels: { behavioral: {} } },
    } as unknown as ComponentDefinition);

    registry.register({
      name: "ZenerStub",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [
        { label: "A", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
        { label: "K", direction: PinDirection.BIDIRECTIONAL, position: { x: 10, y: 0 } },
      ],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Zener Stub",
      models: {
        mnaModels: {
          behavioral: {
            deviceType: "D" as string,
            factory: zenerFactory,
            defaultParams: ZENER_DEFAULTS,
          },
        },
      },
    } as unknown as ComponentDefinition);

    const propsMap = new Map<string, PropertyValue>([["label", "z1"]]);

    const circuit = new Circuit();
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }], new Map(), registry);
    const zener = makeElement(
      "ZenerStub",
      "z1",
      [
        { x: 0, y: 0, label: "A" },
        { x: 10, y: 0, label: "K" },
      ],
      propsMap,
      registry,
    );

    circuit.addElement(gnd);
    circuit.addElement(zener);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    expect(capturedModelParams).toBeDefined();
    // BV must be finite (ZENER_DEFAULTS.BV = 5.1), not Infinity (DIODE_DEFAULTS.BV)
    expect(capturedModelParams!["BV"]).toBe(ZENER_DEFAULTS["BV"]);
    expect(Number.isFinite(capturedModelParams!["BV"])).toBe(true);
    // IS should match ZENER_DEFAULTS (same as DIODE_DEFAULTS in this case)
    expect(capturedModelParams!["IS"]).toBe(ZENER_DEFAULTS["IS"]);
  });

  it("schottky_base_defaults: no overrides resolves SCHOTTKY_DEFAULTS.IS, not DIODE_DEFAULTS.IS", () => {
    let capturedModelParams: Record<string, number> | undefined;

    const schottkyFactory: AnalogElementFactory = (_pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
      capturedModelParams = props.getModelParamKeys().length > 0
      ? Object.fromEntries(props.getModelParamKeys().map(k => [k, props.getModelParam<number>(k)]))
      : undefined;
      const stub: AnalogElement = {
        pinNodeIds: [],
        allNodeIds: [],
        branchIndex: -1,
        isNonlinear: false,
        isReactive: false,
        stamp(_s: SparseSolver) {},
      };
      return stub;
    };

    const registry = new ComponentRegistry();

    registry.register({
      name: "Ground",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Ground",
      models: { mnaModels: { behavioral: {} } },
    } as unknown as ComponentDefinition);

    registry.register({
      name: "SchottkyStub2",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [
        { label: "A", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
        { label: "K", direction: PinDirection.BIDIRECTIONAL, position: { x: 10, y: 0 } },
      ],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Schottky Stub 2",
      models: {
        mnaModels: {
          behavioral: {
            deviceType: "D" as string,
            factory: schottkyFactory,
            defaultParams: SCHOTTKY_DEFAULTS,
          },
        },
      },
    } as unknown as ComponentDefinition);

    const propsMap = new Map<string, PropertyValue>([["label", "d2"]]);

    const circuit = new Circuit();
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }], new Map(), registry);
    const schottky = makeElement(
      "SchottkyStub2",
      "d2",
      [
        { x: 0, y: 0, label: "A" },
        { x: 10, y: 0, label: "K" },
      ],
      propsMap,
      registry,
    );

    circuit.addElement(gnd);
    circuit.addElement(schottky);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    expect(capturedModelParams).toBeDefined();
    // IS must be SCHOTTKY_DEFAULTS.IS (1e-8), not DIODE_DEFAULTS.IS (1e-14)
    expect(capturedModelParams!["IS"]).toBe(SCHOTTKY_DEFAULTS["IS"]);
    expect(capturedModelParams!["IS"]).not.toBe(DIODE_DEFAULTS["IS"]);
    // N must be SCHOTTKY_DEFAULTS.N
    expect(capturedModelParams!["N"]).toBe(SCHOTTKY_DEFAULTS["N"]);
  });

  it("tunnel_diode_migration: _modelParams contains IP, VP, IV, VV from TUNNEL_DIODE_DEFAULTS", () => {
    let capturedModelParams: Record<string, number> | undefined;

    const tunnelFactory: AnalogElementFactory = (_pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
      capturedModelParams = props.getModelParamKeys().length > 0
      ? Object.fromEntries(props.getModelParamKeys().map(k => [k, props.getModelParam<number>(k)]))
      : undefined;
      const stub: AnalogElement = {
        pinNodeIds: [],
        allNodeIds: [],
        branchIndex: -1,
        isNonlinear: false,
        isReactive: false,
        stamp(_s: SparseSolver) {},
      };
      return stub;
    };

    const registry = new ComponentRegistry();

    registry.register({
      name: "Ground",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Ground",
      models: { mnaModels: { behavioral: {} } },
    } as unknown as ComponentDefinition);

    registry.register({
      name: "TunnelDiodeStub",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [
        { label: "A", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
        { label: "K", direction: PinDirection.BIDIRECTIONAL, position: { x: 10, y: 0 } },
      ],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Tunnel Diode Stub",
      models: {
        mnaModels: {
          behavioral: {
            deviceType: "TUNNEL" as string,
            factory: tunnelFactory,
          },
        },
      },
    } as unknown as ComponentDefinition);

    const circuit = new Circuit();
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }], new Map(), registry);
    const td = makeElement(
      "TunnelDiodeStub",
      "td1",
      [
        { x: 0, y: 0, label: "A" },
        { x: 10, y: 0, label: "K" },
      ],
      new Map<string, PropertyValue>([["label", "TD1"]]),
      registry,
    );

    circuit.addElement(gnd);
    circuit.addElement(td);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));

    const compiled = compileUnified(circuit, registry).analog!;
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    expect(capturedModelParams).toBeDefined();
    expect(capturedModelParams!["IP"]).toBe(TUNNEL_DIODE_DEFAULTS.IP);
    expect(capturedModelParams!["VP"]).toBe(TUNNEL_DIODE_DEFAULTS.VP);
    expect(capturedModelParams!["IV"]).toBe(TUNNEL_DIODE_DEFAULTS.IV);
    expect(capturedModelParams!["VV"]).toBe(TUNNEL_DIODE_DEFAULTS.VV);
  });
});
