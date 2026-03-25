/**
 * Tests for model binding in the analog compiler (Task 2.3.3).
 *
 * These tests build minimal mock circuits with semiconductor components
 * and verify that the compiler resolves and injects model parameters
 * correctly, and emits appropriate diagnostics.
 */

import { describe, it, expect, vi } from "vitest";
import { ModelLibrary, validateModel } from "../model-library.js";
import type { DeviceModel } from "../model-library.js";
import type { DeviceType } from "../model-parser.js";
import { DIODE_DEFAULTS } from "../model-defaults.js";
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

// ---------------------------------------------------------------------------
// validateModel diagnostic tests (compiler-independent)
// ---------------------------------------------------------------------------

describe("ModelBinding", () => {
  it("unknown_param_emits_diagnostic", () => {
    const model: DeviceModel = {
      name: "TestD",
      type: "D",
      level: 1,
      params: { IS: 1e-14, FOOBAR: 42 },
    };
    const diags = validateModel(model);
    const d = diags.find((x) => x.code === "model-param-ignored");
    expect(d).toBeDefined();
    expect(d!.summary).toContain("FOOBAR");
    expect(d!.severity).toBe("warning");
  });

  it("level_3_emits_diagnostic", () => {
    const model: DeviceModel = {
      name: "HighLevel",
      type: "NMOS",
      level: 3,
      params: { VTO: 0.7 },
    };
    const diags = validateModel(model);
    const d = diags.find((x) => x.code === "model-level-unsupported");
    expect(d).toBeDefined();
    expect(d!.summary).toContain("3");
    expect(d!.severity).toBe("error");
  });

  it("falls_back_to_default_when_no_model", () => {
    const lib = new ModelLibrary();

    // Look up a non-existent model name — should fall back to default
    const modelName = "NONEXISTENT";
    const resolved = lib.get(modelName) ?? lib.getDefault("D");

    expect(resolved.params["IS"]).toBeCloseTo(DIODE_DEFAULTS["IS"], 25);
    expect(resolved.params["N"]).toBe(DIODE_DEFAULTS["N"]);
  });

  it("user_model_resolved_over_default", () => {
    const lib = new ModelLibrary();
    lib.add({
      name: "D1N4148",
      type: "D",
      level: 1,
      params: { IS: 2.52e-9, N: 1.752 },
    });

    const modelName = "D1N4148";
    const resolved = lib.get(modelName) ?? lib.getDefault("D");

    // Should use user-supplied IS, not the default 1e-14
    expect(resolved.params["IS"]).toBeCloseTo(2.52e-9, 20);
    expect(resolved.params["N"]).toBeCloseTo(1.752, 10);
  });

  it("model_library_lookup_pattern_matches_compiler_logic", () => {
    const lib = new ModelLibrary();
    lib.add({
      name: "D1N4148",
      type: "D",
      level: 1,
      params: { IS: 2.52e-9 },
    });

    // Simulate what the compiler does:
    //   props.model = "D1N4148", analogDeviceType = "D"
    const propsModel = "D1N4148";
    const deviceType: DeviceType = "D";

    const resolved =
      (propsModel !== "" ? lib.get(propsModel) : undefined) ??
      lib.getDefault(deviceType);

    expect(resolved.params["IS"]).toBeCloseTo(2.52e-9, 20);
  });

  it("empty_model_name_falls_back_to_default", () => {
    const lib = new ModelLibrary();

    // Simulate props.model = "" (no model specified)
    const propsModel = "";
    const deviceType: DeviceType = "D";

    const resolved =
      (propsModel !== "" ? lib.get(propsModel) : undefined) ??
      lib.getDefault(deviceType);

    expect(resolved.params["IS"]).toBeCloseTo(DIODE_DEFAULTS["IS"], 25);
  });

  it("all_seven_device_types_resolve_defaults", () => {
    const lib = new ModelLibrary();
    const types: DeviceType[] = ["D", "NPN", "PNP", "NMOS", "PMOS", "NJFET", "PJFET"];

    for (const type of types) {
      const resolved = lib.getDefault(type);
      expect(resolved).toBeDefined();
      expect(resolved.type).toBe(type);
      expect(Object.keys(resolved.params).length).toBeGreaterThan(0);
    }
  });

  it("validate_model_with_multiple_unknown_params", () => {
    const model: DeviceModel = {
      name: "BadModel",
      type: "NPN",
      level: 1,
      params: { IS: 1e-16, UNKNOWN1: 1, UNKNOWN2: 2 },
    };
    const diags = validateModel(model);
    const ignored = diags.filter((d) => d.code === "model-param-ignored");
    expect(ignored.length).toBe(2);
    const paramNames = ignored.map((d) => d.summary);
    expect(paramNames.some((s) => s.includes("UNKNOWN1"))).toBe(true);
    expect(paramNames.some((s) => s.includes("UNKNOWN2"))).toBe(true);
  });

  it("compiler_passes_model_params", () => {
    // Verify that the analog compiler injects resolved .MODEL parameters
    // into the factory props bag under '_modelParams'.
    //
    // Circuit: Ground (node 0) + DiodeStub (node1 → node0)
    // DiodeStub has analogDeviceType = "D" so the compiler performs model binding.
    // A custom model "D1N4148" with IS=2.52e-9 is registered via circuit.metadata.models.
    // The factory spy captures the props and we assert _modelParams.IS === 2.52e-9.

    // Captured props from factory call
    let capturedModelParams: Record<string, number> | undefined;

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
        draw(_ctx: RenderContext) { /* no-op */ },
        serialize() { return serialized; },
        getHelpText() { return ""; },
        getAttribute(k: string) { return propsMap.get(k); },
      };
    }

    // Spy factory that captures the _modelParams from props
    const diodeFactory: AnalogElementFactory = (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
      capturedModelParams = props.has("_modelParams")
        ? (props.get("_modelParams") as unknown as Record<string, number>)
        : undefined;
      const stub: AnalogElement = {
        pinNodeIds: [...pinNodes.values()],
        allNodeIds: [...pinNodes.values()],
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

    // Registry
    const registry = new ComponentRegistry();

    // Ground
    registry.register({
      name: "Ground",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Ground",
      models: { analog: {} },
    } as unknown as ComponentDefinition);

    // DiodeStub — analog component with analogDeviceType = "D"
    registry.register({
      name: "DiodeStub",
      typeId: -1,
      factory: (_props) => { throw new Error("unused"); },
      pinLayout: [
        { label: "A", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
        { label: "K", direction: PinDirection.BIDIRECTIONAL, position: { x: 0, y: 0 } },
      ],
      propertyDefs: [{ key: "model", defaultValue: "" }],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "DiodeStub",
      models: {
        analog: {
          deviceType: "D" as import("../../analog/model-parser.js").DeviceType,
          factory: diodeFactory,
        },
      },
    } as unknown as ComponentDefinition);

    // Build circuit: Ground at (0,0), DiodeStub anode=(10,0) cathode=(0,0)
    // model property = "D1N4148" (custom model)
    const circuit = new Circuit({  });

    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }]);
    const diode = makeElement("DiodeStub", "d1",
      [{ x: 10, y: 0, label: "A" }, { x: 0, y: 0, label: "K" }],
      new Map<string, PropertyValue>([["model", "D1N4148"]]),
    );

    circuit.addElement(gnd);
    circuit.addElement(diode);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));

    // Register a custom model via circuit.metadata.models
    const customModel: DeviceModel = {
      name: "D1N4148",
      type: "D",
      level: 1,
      params: { IS: 2.52e-9, N: 1.752 },
    };
    (circuit.metadata as Record<string, unknown>)["models"] = new Map([
      ["D1N4148", customModel],
    ]);

    // Compile — this triggers model binding
    const compiled = compileUnified(circuit, registry).analog!;

    // Verify no compilation errors
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);

    // Verify factory was called and received _modelParams with custom IS
    expect(capturedModelParams).toBeDefined();
    expect(capturedModelParams!["IS"]).toBeCloseTo(2.52e-9, 20);
    expect(capturedModelParams!["N"]).toBeCloseTo(1.752, 10);
  });
});
