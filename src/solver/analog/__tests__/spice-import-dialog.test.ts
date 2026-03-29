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
import { parseModelCard } from "../model-parser.js";
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
): CircuitElement {
  const resolvedPins = pins.map((p) => makePin(p.x, p.y, p.label ?? ""));
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

  it("applySpiceImportResult stores _spiceModelOverrides as JSON string", () => {
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);

    applySpiceImportResult(element, {
      overridesJson: JSON.stringify({ IS: 1e-14, BF: 200 }),
      modelName: "2N2222",
    });

    const stored = element.getProperties().get("_spiceModelOverrides");
    expect(typeof stored).toBe("string");
    const parsed = JSON.parse(stored as string) as Record<string, number>;
    expect(parsed["IS"]).toBe(1e-14);
    expect(parsed["BF"]).toBe(200);
  });

  it("applySpiceImportResult stores _spiceModelName for display", () => {
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);

    applySpiceImportResult(element, {
      overridesJson: JSON.stringify({ IS: 2e-14 }),
      modelName: "BC547",
    });

    expect(element.getProperties().get("_spiceModelName")).toBe("BC547");
  });

  it("applySpiceImportResult overwrites previously stored model name and overrides", () => {
    const propsMap = new Map<string, PropertyValue>([
      ["_spiceModelName", "OLD_MODEL"],
      ["_spiceModelOverrides", JSON.stringify({ IS: 1e-10 })],
    ]);
    const element = makeElement("NpnStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ], propsMap);

    applySpiceImportResult(element, {
      overridesJson: JSON.stringify({ IS: 5e-15, BF: 300 }),
      modelName: "2SC1815",
    });

    expect(element.getProperties().get("_spiceModelName")).toBe("2SC1815");
    const overrides = JSON.parse(element.getProperties().get("_spiceModelOverrides") as string) as Record<string, number>;
    expect(overrides["IS"]).toBe(5e-15);
    expect(overrides["BF"]).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Tests: end-to-end compile flow — import → store → compile → params applied
// ---------------------------------------------------------------------------

describe("spice-import-dialog: compile integration", () => {
  function buildRegistryAndCircuit(spiceModelOverrides?: string): {
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
            deviceType: "NPN" as import("../../../core/analog-types.js").DeviceType,
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
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }]);
    const npn = makeElement(
      "NpnStub",
      "q1",
      [
        { x: 10, y: 0, label: "C" },
        { x: 20, y: 0, label: "B" },
        { x: 0, y: 0, label: "E" },
      ],
      propsMap,
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

    const overridesJson = JSON.stringify(parsed.params);
    const { capturedModelParams, diagnostics } = buildRegistryAndCircuit(overridesJson);

    const errors = diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    expect(capturedModelParams).toBeDefined();
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

    applySpiceImportResult(element, {
      overridesJson: JSON.stringify(parsed.params),
      modelName: parsed.name,
    });

    expect(element.getProperties().get("_spiceModelName")).toBe("BC547");
    const overrides = JSON.parse(element.getProperties().get("_spiceModelOverrides") as string) as Record<string, number>;
    expect(overrides["IS"]).toBe(6e-15);
    expect(overrides["BF"]).toBe(110);
  });

  it("unmodified params stay at NPN defaults when IS is overridden", () => {
    const modelCard = ".MODEL MYBJT NPN(IS=2e-15)";
    const parsed = parseModelCard(modelCard);

    expect("message" in parsed).toBe(false);
    if ("message" in parsed) return;

    const { capturedModelParams } = buildRegistryAndCircuit(JSON.stringify(parsed.params));

    expect(capturedModelParams).toBeDefined();
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

    const { capturedModelParams } = buildRegistryAndCircuit(JSON.stringify(parsed.params));

    expect(capturedModelParams).toBeDefined();
    expect(capturedModelParams!["IS"]).toBeCloseTo(6.734e-15, 20);
    expect(capturedModelParams!["BF"]).toBeCloseTo(416.4, 5);
  });
});
