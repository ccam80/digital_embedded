/**
 * Headless tests for the .MODEL import flow (W11.1).
 *
 * Verifies:
 * 1. parseModelCard() extracts name, deviceType, and params correctly
 * 2. applySpiceImportResult sets model property and model params on PropertyBag
 * 3. applySpiceImportResult writes to circuit.metadata.models
 * 4. Invalid .MODEL text produces a ParseError (not stored)
 * 5. Params from the imported model are applied at compile time via metadata.models
 */

import { describe, it, expect } from "vitest";
import { parseModelCard, parseSubcircuit } from "../model-parser.js";
import { detectFormat } from "../../../app/spice-import-dialog.js";
import { applySpiceImportResult } from "../../../app/spice-model-apply.js";
import { compileUnified } from "@/compile/compile.js";
import { Circuit, Wire } from "../../../core/circuit.js";
import { ComponentRegistry, ComponentCategory } from "../../../core/registry.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import { PropertyBag } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { SerializedElement } from "../../../core/element.js";
import type { AnalogElement } from "../element.js";
import type { ComplexSparseSolver } from "../complex-sparse-solver.js";
import type { LoadContext } from "../load-context.js";
import type { AnalogElementFactory } from "../behavioral-gate.js";
import { BJT_NPN_DEFAULTS } from "../../../components/semiconductors/bjt.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Minimal element builder (shared with spice-model-overrides.test.ts pattern)
// ---------------------------------------------------------------------------

function makePin(x: number, y: number, label = ""): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isNegated: false,
    kind: "signal" as const,
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
  const _mp: Record<string, number> = {};
  for (const [k, v] of propsMap) if (typeof v === 'number') _mp[k] = v;
  propertyBag.replaceModelParams(_mp);
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
    setAttribute(k: string, v: PropertyValue) { propsMap.set(k, v); },
  };
}

// ---------------------------------------------------------------------------
// Tests: parseModelCard and applySpiceImportResult
// ---------------------------------------------------------------------------

describe("spice-import-dialog: parse and apply", () => {
  it("parseModelCard returns ParsedModel for valid NPN .MODEL card", () => {
    const text = ".MODEL 2N2222 NPN(IS=1e-14 BF=200 NF=1)";
    const result = parseModelCard(text);

    expect("message" in result).toBe(false);
    if ("message" in result) return;

    expect(result.name).toBe("2N2222");
    expect(result.deviceType).toBe("NPN");
    expect(result.params["IS"]).toBe(1e-14);
    expect(result.params["BF"]).toBe(200);
    expect(result.params["NF"]).toBe(1);
  });

  it("parseModelCard returns ParseError for invalid input", () => {
    const text = "not a model statement at all";
    const result = parseModelCard(text);

    expect("message" in result).toBe(true);
    if (!("message" in result)) return;
    expect(result.line).toBeGreaterThanOrEqual(1);
    expect(typeof result.message).toBe("string");
  });

  it("applySpiceImportResult sets model property on element", () => {
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);
    const circuit = new Circuit();

    // Build a minimal registry with NpnStub that has a behavioral modelRegistry entry
    const registry = new ComponentRegistry();
    registry.register({
      name: "NpnStub",
      typeId: -1,
      factory: (_props: unknown) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "NPN Stub",
      modelRegistry: {
        behavioral: {
          kind: "inline",
          factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp() {} }),
          params: {},
        },
      },
    } as unknown as ComponentDefinition);

    applySpiceImportResult(element, {
      overrides: { IS: 1e-14, BF: 200 },
      modelName: "2N2222",
      deviceType: "NPN",
    }, circuit, registry);

    expect(element.getProperties().get("model")).toBe("2N2222");
  });

  it("applySpiceImportResult stores params in model params partition", () => {
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);
    const circuit = new Circuit();

    const registry = new ComponentRegistry();
    registry.register({
      name: "NpnStub",
      typeId: -1,
      factory: (_props: unknown) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "NPN Stub",
      modelRegistry: {
        behavioral: {
          kind: "inline",
          factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp() {} }),
          params: {},
        },
      },
    } as unknown as ComponentDefinition);

    applySpiceImportResult(element, {
      overrides: { IS: 2e-14 },
      modelName: "BC547",
      deviceType: "NPN",
    }, circuit, registry);

    expect(element.getProperties().getModelParam<number>("IS")).toBe(2e-14);
  });

  it("applySpiceImportResult overwrites previously stored model name and overrides", () => {
    const propsMap = new Map<string, PropertyValue>([
      ["model", "OLD_MODEL"],
    ]);
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ], propsMap);
    const circuit = new Circuit();

    const registry = new ComponentRegistry();
    registry.register({
      name: "NpnStub",
      typeId: -1,
      factory: (_props: unknown) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "NPN Stub",
      modelRegistry: {
        behavioral: {
          kind: "inline",
          factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp() {} }),
          params: {},
        },
      },
    } as unknown as ComponentDefinition);

    applySpiceImportResult(element, {
      overrides: { IS: 5e-15, BF: 300 },
      modelName: "2SC1815",
      deviceType: "NPN",
    }, circuit, registry);

    expect(element.getProperties().get("model")).toBe("2SC1815");
    expect(element.getProperties().getModelParam<number>("IS")).toBe(5e-15);
    expect(element.getProperties().getModelParam<number>("BF")).toBe(300);
  });

  it("applySpiceImportResult writes to circuit.metadata.models (library-level)", () => {
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);
    const circuit = new Circuit();

    const registry = new ComponentRegistry();
    registry.register({
      name: "NpnStub",
      typeId: -1,
      factory: (_props: unknown) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "NPN Stub",
      modelRegistry: {
        behavioral: {
          kind: "inline",
          factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp() {} }),
          params: {},
        },
      },
    } as unknown as ComponentDefinition);

    applySpiceImportResult(element, {
      overrides: { IS: 1e-14, BF: 200 },
      modelName: "2N2222",
      deviceType: "NPN",
    }, circuit, registry);

    const entry = circuit.metadata.models?.["NpnStub"]?.["2N2222"];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("inline");
    expect(entry!.params["IS"]).toBe(1e-14);
    expect(entry!.params["BF"]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: end-to-end compile flow — import → store → compile → params applied
// ---------------------------------------------------------------------------

describe("spice-import-dialog: compile integration", () => {
  function buildRegistryAndCircuit(modelOverrides?: Record<string, number>): {
    capturedModelParams: Record<string, number> | undefined;
    diagnostics: Array<{ code: string; severity: string; summary?: string }>;
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
        ngspiceLoadOrder: 0,
        isNonlinear: false,
        isReactive: false,
        load(_ctx: LoadContext): void {},
        stampAc(_solver: ComplexSparseSolver, _omega: number, _ctx: LoadContext): void {},
        setParam(_k: string, _v: number): void {},
        getPinCurrents(_v: Float64Array): number[] { return []; },
      };
      return stub;
    };

    const registry = new ComponentRegistry();

    registry.register({
      name: "Ground",
      typeId: -1,
      factory: (_props: unknown) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Ground",
      models: {},
      modelRegistry: { behavioral: { kind: 'inline' as const, factory: () => { throw new Error('not used'); }, paramDefs: [], params: {} } },
    } as unknown as ComponentDefinition);

    registry.register({
      name: "NpnStub",
      typeId: -1,
      factory: (_props: unknown) => { throw new Error("unused"); },
      pinLayout: [
        { label: "C", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
        { label: "B", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
        { label: "E", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
      ],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "NPN Stub",
      modelRegistry: {
        behavioral: {
          kind: "inline",
          factory: npnFactory,
          params: { ...BJT_NPN_DEFAULTS },
        },
      },
    } as unknown as ComponentDefinition);

    const propsMap = new Map<string, PropertyValue>();
    propsMap.set("label", "q1");

    const circuit = new Circuit();
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }], new Map(), registry);
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

    // If overrides provided, store them in circuit.metadata.models and set model property.
    // Merge defaults from the behavioral entry params so unoverridden params are present.
    if (modelOverrides !== undefined) {
      const behavioralEntry = registry.get("NpnStub")!.modelRegistry!["behavioral"]!;
      const entry: ModelEntry = {
        kind: "inline",
        factory: getFactory(behavioralEntry),
        paramDefs: [],
        params: { ...behavioralEntry.params, ...modelOverrides },
      };
      circuit.metadata.models = { NpnStub: { imported: entry } };
      npn.getProperties().set("model", "imported");
    }

    circuit.addElement(gnd);
    circuit.addElement(npn);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));

    const compiled = compileUnified(circuit, registry).analog!;
    return { capturedModelParams, diagnostics: compiled.diagnostics };
  }

  it("import .MODEL card → store in metadata.models → compile applies IS override", () => {
    const modelCard = ".MODEL 2N2222 NPN(IS=1e-14 BF=200)";
    const parsed = parseModelCard(modelCard);

    expect("message" in parsed).toBe(false);
    if ("message" in parsed) return;

    const { capturedModelParams, diagnostics } = buildRegistryAndCircuit(parsed.params);

    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    expect(capturedModelParams!["IS"]).toBe(1e-14);
    expect(capturedModelParams!["BF"]).toBe(200);
  });

  it("import .MODEL card → model name stored on element via model property → visible in PropertyBag", () => {
    const modelCard = ".MODEL BC547 NPN(IS=6e-15 BF=110)";
    const parsed = parseModelCard(modelCard);

    expect("message" in parsed).toBe(false);
    if ("message" in parsed) return;

    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);

    const registry = new ComponentRegistry();
    registry.register({
      name: "NpnStub",
      typeId: -1,
      factory: (_props: unknown) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "NPN Stub",
      modelRegistry: {
        behavioral: {
          kind: "inline",
          factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp() {} }),
          params: {},
        },
      },
    } as unknown as ComponentDefinition);

    const circuit = new Circuit();
    applySpiceImportResult(element, {
      overrides: parsed.params,
      modelName: parsed.name,
      deviceType: parsed.deviceType,
    }, circuit, registry);

    expect(element.getProperties().get("model")).toBe("BC547");
    expect(element.getProperties().getModelParam<number>("IS")).toBe(6e-15);
    expect(element.getProperties().getModelParam<number>("BF")).toBe(110);
  });

  it("unmodified params stay at NPN defaults when IS is overridden", () => {
    const modelCard = ".MODEL MYBJT NPN(IS=2e-15)";
    const parsed = parseModelCard(modelCard);

    expect("message" in parsed).toBe(false);
    if ("message" in parsed) return;

    const { capturedModelParams } = buildRegistryAndCircuit(parsed.params);

    expect(capturedModelParams!["IS"]).toBe(2e-15);
    // BF not overridden, should come from behavioral entry defaults
    expect(capturedModelParams!["BF"]).toBe(BJT_NPN_DEFAULTS["BF"]);
    expect(capturedModelParams!["NF"]).toBe(BJT_NPN_DEFAULTS["NF"]);
  });

  it("multiline .MODEL card with continuation is parsed and applied correctly", () => {
    const modelCard = [
      ".MODEL 2N3904 NPN(",
      "+ IS=6.734e-15",
      "+ BF=416.4",
      "+ NF=0.9927",
      "+ VAF=74.03",
      ")",
    ].join("\n");

    const parsed = parseModelCard(modelCard);

    expect("message" in parsed).toBe(false);
    if ("message" in parsed) return;

    expect(parsed.name).toBe("2N3904");
    expect(parsed.params["IS"]).toBe(6.734e-15);
    expect(parsed.params["BF"]).toBe(416.4);

    const { capturedModelParams } = buildRegistryAndCircuit(parsed.params);

    expect(capturedModelParams!["IS"]).toBe(6.734e-15);
    expect(capturedModelParams!["BF"]).toBe(416.4);
  });
});

// ---------------------------------------------------------------------------
// Tests: auto-detect format from first non-blank line
// ---------------------------------------------------------------------------

describe("spice-import-dialog: auto-detect format", () => {
  it(".SUBCKT auto-detect — input starting with .SUBCKT is parsed as subcircuit", () => {
    const text = ".SUBCKT MYAMP in out vcc vee\nR1 in out 1k\n.ENDS";
    expect(detectFormat(text.trim())).toBe("subckt");

    const result = parseSubcircuit(text.trim());
    expect(result.name).toBe("MYAMP");
    expect(result.ports).toEqual(["in", "out", "vcc", "vee"]);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]!.type).toBe("R");
  });

  it(".MODEL auto-detect — input starting with .MODEL is parsed as model card", () => {
    const text = ".MODEL 2N2222 NPN(IS=1e-14 BF=200)";
    expect(detectFormat(text.trim())).toBe("model");

    const result = parseModelCard(text.trim());
    expect("message" in result).toBe(false);
    if ("message" in result) return;
    expect(result.name).toBe("2N2222");
    expect(result.deviceType).toBe("NPN");
  });

  it("mixed content auto-detect — first non-blank line determines type (.SUBCKT wins)", () => {
    const text = "\n\n.SUBCKT FILTER in out\nR1 in out 10k\n.ENDS\n.MODEL EXTRA NPN()";
    expect(detectFormat(text.trim())).toBe("subckt");

    const result = parseSubcircuit(text.trim());
    expect(result.name).toBe("FILTER");
    expect(result.ports).toEqual(["in", "out"]);
  });

  it("mixed content auto-detect — first non-blank line determines type (.MODEL wins)", () => {
    const text = "\n\n.MODEL 1N4148 D(IS=2.52e-9 RS=0.568)\n.SUBCKT IGNORED a b\n.ENDS";
    expect(detectFormat(text.trim())).toBe("model");

    const result = parseModelCard(text.trim());
    expect("message" in result).toBe(false);
    if ("message" in result) return;
    expect(result.name).toBe("1N4148");
    expect(result.deviceType).toBe("D");
  });

  it(".SUBCKT case-insensitive — lower-case .subckt is detected as subcircuit", () => {
    const text = ".subckt mymod a b\nR1 a b 1k\n.ends";
    expect(detectFormat(text.trim())).toBe("subckt");

    const result = parseSubcircuit(text);
    expect(result.name).toBe("mymod");
    expect(result.ports).toEqual(["a", "b"]);
  });
});
