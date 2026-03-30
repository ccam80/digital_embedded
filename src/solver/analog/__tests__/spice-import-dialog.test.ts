/**
 * Headless tests for the .MODEL import flow (W11.1).
 *
 * Verifies:
 * 1. parseModelCard() → store as _spiceModelOverrides → compile → params applied
 * 2. Display name stored as _spiceModelName
 * 3. applySpiceImportResult sets both properties on the PropertyBag
 * 4. Invalid .MODEL text produces a ParseError (not stored)
 * 5. Params from the imported model are merged over defaults at compile time
 */

import { describe, it, expect } from "vitest";
import { parseModelCard, parseSubcircuit } from "../model-parser.js";
import { applySpiceImportResult } from "../../../app/spice-model-apply.js";
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
import { BJT_NPN_DEFAULTS } from "../model-defaults.js";

// ---------------------------------------------------------------------------
// Minimal element builder (shared with spice-model-overrides.test.ts pattern)
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

  it("applySpiceImportResult stores _spiceModelOverrides as Record<string, number>", () => {
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);
    const circuit = new Circuit();

    applySpiceImportResult(element, {
      overrides: { IS: 1e-14, BF: 200 },
      modelName: "2N2222",
      deviceType: "NPN",
    }, circuit);

    const stored = element.getProperties().get("_spiceModelOverrides") as Record<string, number>;
    expect(typeof stored).toBe("object");
    expect(stored["IS"]).toBe(1e-14);
    expect(stored["BF"]).toBe(200);
  });

  it("applySpiceImportResult stores _spiceModelName for display", () => {
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);
    const circuit = new Circuit();

    applySpiceImportResult(element, {
      overrides: { IS: 2e-14 },
      modelName: "BC547",
      deviceType: "NPN",
    }, circuit);

    expect(element.getProperties().get("_spiceModelName")).toBe("BC547");
  });

  it("applySpiceImportResult overwrites previously stored model name and overrides", () => {
    const propsMap = new Map<string, PropertyValue>([
      ["_spiceModelName", "OLD_MODEL"],
      ["_spiceModelOverrides", { IS: 1e-10 }],
    ]);
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ], propsMap);
    const circuit = new Circuit();

    applySpiceImportResult(element, {
      overrides: { IS: 5e-15, BF: 300 },
      modelName: "2SC1815",
      deviceType: "NPN",
    }, circuit);

    expect(element.getProperties().get("_spiceModelName")).toBe("2SC1815");
    const overrides = element.getProperties().get("_spiceModelOverrides") as Record<string, number>;
    expect(overrides["IS"]).toBe(5e-15);
    expect(overrides["BF"]).toBe(300);
  });

  it("applySpiceImportResult writes to circuit.metadata.namedParameterSets (library-level)", () => {
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);
    const circuit = new Circuit();

    applySpiceImportResult(element, {
      overrides: { IS: 1e-14, BF: 200 },
      modelName: "2N2222",
      deviceType: "NPN",
    }, circuit);

    const sets = circuit.metadata.namedParameterSets;
    expect(sets!["2N2222"].deviceType).toBe("NPN");
    expect(sets!["2N2222"].params["IS"]).toBe(1e-14);
    expect(sets!["2N2222"].params["BF"]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: end-to-end compile flow — import → store → compile → params applied
// ---------------------------------------------------------------------------

describe("spice-import-dialog: compile integration", () => {
  function buildRegistryAndCircuit(spiceModelOverrides?: Record<string, number>): {
    capturedModelParams: Record<string, number> | undefined;
    diagnostics: Array<{ code: string; severity: string; summary?: string }>;
  } {
    let capturedModelParams: Record<string, number> | undefined;

    const npnFactory: AnalogElementFactory = (_pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
      capturedModelParams = props.has("_modelParams")
        ? (props.get("_modelParams") as unknown as Record<string, number>)
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
      factory: (_props: unknown) => { throw new Error("unused"); },
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
    return { capturedModelParams, diagnostics: compiled.diagnostics };
  }

  it("import .MODEL card → store as _spiceModelOverrides → compile applies IS override", () => {
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

  it("import .MODEL card → _spiceModelName stored on element → visible in PropertyBag", () => {
    const modelCard = ".MODEL BC547 NPN(IS=6e-15 BF=110)";
    const parsed = parseModelCard(modelCard);

    expect("message" in parsed).toBe(false);
    if ("message" in parsed) return;

    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);

    const circuit = new Circuit();
    applySpiceImportResult(element, {
      overrides: parsed.params,
      modelName: parsed.name,
      deviceType: parsed.deviceType,
    }, circuit);

    expect(element.getProperties().get("_spiceModelName")).toBe("BC547");
    const overrides = element.getProperties().get("_spiceModelOverrides") as Record<string, number>;
    expect(overrides["IS"]).toBe(6e-15);
    expect(overrides["BF"]).toBe(110);
  });

  it("unmodified params stay at NPN defaults when IS is overridden", () => {
    const modelCard = ".MODEL MYBJT NPN(IS=2e-15)";
    const parsed = parseModelCard(modelCard);

    expect("message" in parsed).toBe(false);
    if ("message" in parsed) return;

    const { capturedModelParams } = buildRegistryAndCircuit(parsed.params);

    expect(capturedModelParams!["IS"]).toBe(2e-15);
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
    expect(parsed.params["IS"]).toBeCloseTo(6.734e-15, 20);
    expect(parsed.params["BF"]).toBeCloseTo(416.4, 5);

    const { capturedModelParams } = buildRegistryAndCircuit(parsed.params);

    expect(capturedModelParams!["IS"]).toBeCloseTo(6.734e-15, 20);
    expect(capturedModelParams!["BF"]).toBeCloseTo(416.4, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: auto-detect format from first non-blank line
// ---------------------------------------------------------------------------

describe("spice-import-dialog: auto-detect format", () => {
  it(".SUBCKT auto-detect — input starting with .SUBCKT is parsed as subcircuit", () => {
    const text = ".SUBCKT MYAMP in out vcc vee\nR1 in out 1k\n.ENDS";
    const trimmed = text.trim();
    const firstNonBlank = trimmed.split("\n").find((l) => l.trim() !== "")!.trim();
    expect(/^\.subckt\b/i.test(firstNonBlank)).toBe(true);

    const result = parseSubcircuit(trimmed);
    expect(result.name).toBe("MYAMP");
    expect(result.ports).toEqual(["in", "out", "vcc", "vee"]);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]!.type).toBe("R");
  });

  it(".MODEL auto-detect — input starting with .MODEL is parsed as model card", () => {
    const text = ".MODEL 2N2222 NPN(IS=1e-14 BF=200)";
    const trimmed = text.trim();
    const firstNonBlank = trimmed.split("\n").find((l) => l.trim() !== "")!.trim();
    expect(/^\.subckt\b/i.test(firstNonBlank)).toBe(false);

    const result = parseModelCard(trimmed);
    expect("message" in result).toBe(false);
    if ("message" in result) return;
    expect(result.name).toBe("2N2222");
    expect(result.deviceType).toBe("NPN");
  });

  it("mixed content auto-detect — first non-blank line determines type (.SUBCKT wins)", () => {
    const text = "\n\n.SUBCKT FILTER in out\nR1 in out 10k\n.ENDS\n.MODEL EXTRA NPN()";
    const lines = text.split("\n");
    const firstNonBlank = lines.find((l) => l.trim() !== "")!.trim();
    expect(/^\.subckt\b/i.test(firstNonBlank)).toBe(true);

    const result = parseSubcircuit(text.trim());
    expect(result.name).toBe("FILTER");
    expect(result.ports).toEqual(["in", "out"]);
  });

  it("mixed content auto-detect — first non-blank line determines type (.MODEL wins)", () => {
    const text = "\n\n.MODEL 1N4148 D(IS=2.52e-9 RS=0.568)\n.SUBCKT IGNORED a b\n.ENDS";
    const lines = text.split("\n");
    const firstNonBlank = lines.find((l) => l.trim() !== "")!.trim();
    expect(/^\.subckt\b/i.test(firstNonBlank)).toBe(false);

    const result = parseModelCard(text.trim());
    expect("message" in result).toBe(false);
    if ("message" in result) return;
    expect(result.name).toBe("1N4148");
    expect(result.deviceType).toBe("D");
  });

  it(".SUBCKT case-insensitive — lower-case .subckt is detected as subcircuit", () => {
    const text = ".subckt mymod a b\nR1 a b 1k\n.ends";
    const firstNonBlank = text.trim().split("\n").find((l) => l.trim() !== "")!.trim();
    expect(/^\.subckt\b/i.test(firstNonBlank)).toBe(true);

    const result = parseSubcircuit(text);
    expect(result.name).toBe("mymod");
    expect(result.ports).toEqual(["a", "b"]);
  });
});
