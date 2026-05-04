import { describe, it, expect, beforeEach } from "vitest";
import {
  ComponentRegistry,
  ComponentCategory,
  type ParamDef,
} from "../registry.js";
import type {
  StandaloneComponentDefinition,
  AttributeMapping,
  ComponentLayout,
  ExecuteFunction,
  ComponentModels,
} from "../registry.js";
import { PropertyBag, PropertyType } from "../properties.js";
import type { PinElectricalSpec } from "../pin-electrical.js";
import type { CircuitElement, SerializedElement } from "../element.js";
import type { PropertyValue } from "../properties.js";
import type { Pin } from "../pin.js";
import type { RenderContext, Rect } from "../renderer-interface.js";
import type { Rotation } from "../pin.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockElement(typeId: string, instanceId: string): CircuitElement {
  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as Rotation,
    mirror: false,
    getPins(): readonly Pin[] {
      return [];
    },
    getProperties(): PropertyBag {
      return new PropertyBag();
    },
    draw(_ctx: RenderContext): void {
      // no-op
    },
    getBoundingBox(): Rect {
      return { x: 0, y: 0, width: 4, height: 4 };
    },
    serialize(): SerializedElement {
      return {
        typeId,
        instanceId,
        position: { x: 0, y: 0 },
        rotation: 0 as Rotation,
        mirror: false,
        properties: {},
      };
    },
    getAttribute(_name: string): PropertyValue | undefined {
      return undefined;
    },
    setAttribute(_name: string, _value: PropertyValue): void {},
  };
}

const noopExecuteFn: ExecuteFunction = (
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void => {
  // no-op
};

function makeDefinition(
  name: string,
  category: ComponentCategory = ComponentCategory.LOGIC,
): StandaloneComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (_props: PropertyBag) => makeMockElement(name, `${name}-instance`),
    models: { digital: { executeFn: noopExecuteFn } },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category,
    helpText: `Help for ${name}`,
  };
}

// ---------------------------------------------------------------------------
// ComponentRegistry tests
// ---------------------------------------------------------------------------

describe("ComponentRegistry", () => {
  let registry: ComponentRegistry;

  beforeEach(() => {
    registry = new ComponentRegistry();
  });

  describe("register and get", () => {
    it("returns undefined for an unregistered name", () => {
      expect(registry.getStandalone("And")).toBeUndefined();
    });

    it("registers a definition and retrieves it by name", () => {
      const def = makeDefinition("And");
      registry.register(def);
      const result = registry.getStandalone("And");
      expect(result?.name).toBe("And");
    });

    it("throws when registering the same name twice", () => {
      registry.register(makeDefinition("And"));
      expect(() => registry.register(makeDefinition("And"))).toThrow(
        /already registered/,
      );
    });

    it("registers multiple definitions with distinct names", () => {
      registry.register(makeDefinition("And"));
      registry.register(makeDefinition("Or"));
      expect(registry.getStandalone("And")?.name).toBe("And");
      expect(registry.getStandalone("Or")?.name).toBe("Or");
    });
  });

  describe("auto-assigned type IDs", () => {
    it("assigns typeId 0 to the first registered component", () => {
      registry.register(makeDefinition("And"));
      expect(registry.getStandalone("And")!.typeId).toBe(0);
    });

    it("assigns incrementing type IDs in registration order", () => {
      registry.register(makeDefinition("And"));
      registry.register(makeDefinition("Or"));
      registry.register(makeDefinition("Not"));
      expect(registry.getStandalone("And")!.typeId).toBe(0);
      expect(registry.getStandalone("Or")!.typeId).toBe(1);
      expect(registry.getStandalone("Not")!.typeId).toBe(2);
    });

    it("does not use the caller-supplied typeId", () => {
      const def = makeDefinition("And");
      def.typeId = 999;
      registry.register(def);
      expect(registry.getStandalone("And")!.typeId).toBe(0);
    });

    it("type IDs from separate registries are independent", () => {
      const r1 = new ComponentRegistry();
      const r2 = new ComponentRegistry();
      r1.register(makeDefinition("And"));
      r2.register(makeDefinition("And"));
      expect(r1.get("And")!.typeId).toBe(0);
      expect(r2.get("And")!.typeId).toBe(0);
    });
  });

  describe("getAll", () => {
    it("returns empty array when nothing is registered", () => {
      expect(registry.getAll()).toHaveLength(0);
    });

    it("returns all registered definitions", () => {
      registry.register(makeDefinition("And"));
      registry.register(makeDefinition("Or"));
      const all = registry.getAll();
      expect(all).toHaveLength(2);
      const names = all.map((d) => d.name);
      expect(names).toContain("And");
      expect(names).toContain("Or");
    });

    it("returns definitions in registration order", () => {
      registry.register(makeDefinition("And"));
      registry.register(makeDefinition("Or"));
      registry.register(makeDefinition("Not"));
      const all = registry.getAll();
      expect(all[0].name).toBe("And");
      expect(all[1].name).toBe("Or");
      expect(all[2].name).toBe("Not");
    });
  });

  describe("getByCategory", () => {
    it("returns empty array for a category with no registrations", () => {
      expect(registry.getByCategory(ComponentCategory.LOGIC)).toHaveLength(0);
    });

    it("returns definitions in the requested category", () => {
      registry.register(makeDefinition("And", ComponentCategory.LOGIC));
      registry.register(makeDefinition("Or", ComponentCategory.LOGIC));
      registry.register(makeDefinition("Input", ComponentCategory.IO));
      const logic = registry.getByCategory(ComponentCategory.LOGIC);
      expect(logic).toHaveLength(2);
      expect(logic.map((d) => d.name)).toContain("And");
      expect(logic.map((d) => d.name)).toContain("Or");
    });

    it("does not include definitions from other categories", () => {
      registry.register(makeDefinition("And", ComponentCategory.LOGIC));
      registry.register(makeDefinition("Input", ComponentCategory.IO));
      expect(registry.getByCategory(ComponentCategory.IO)).toHaveLength(1);
      expect(registry.getByCategory(ComponentCategory.IO)[0].name).toBe("Input");
    });
  });

  describe("size", () => {
    it("starts at 0", () => {
      expect(registry.size).toBe(0);
    });

    it("increments with each registration", () => {
      registry.register(makeDefinition("And"));
      expect(registry.size).toBe(1);
      registry.register(makeDefinition("Or"));
      expect(registry.size).toBe(2);
    });
  });

  describe("factory", () => {
    it("factory produces a CircuitElement when called", () => {
      registry.register(makeDefinition("And"));
      const def = registry.getStandalone("And")!;
      const el = def.factory(new PropertyBag());
      expect(el.typeId).toBe("And");
    });
  });

  describe("AttributeMapping", () => {
    it("stores and exposes attribute mappings", () => {
      const attrMap: AttributeMapping[] = [
        {
          xmlName: "Bits",
          propertyKey: "bitWidth",
          convert: (v: string) => parseInt(v, 10),
        },
      ];
      const def = makeDefinition("And");
      def.attributeMap = attrMap;
      registry.register(def);

      const stored = registry.getStandalone("And")!;
      // Original mapping + 3 auto-injected (label, showLabel, showValue)
      expect(stored.attributeMap.length).toBeGreaterThanOrEqual(1);
      expect(stored.attributeMap[0].xmlName).toBe("Bits");
      expect(stored.attributeMap[0].propertyKey).toBe("bitWidth");
      expect(stored.attributeMap[0].convert("8")).toBe(8);
    });

    it("convert function transforms XML string to PropertyValue correctly", () => {
      const mapping: AttributeMapping = {
        xmlName: "Label",
        propertyKey: "label",
        convert: (v: string) => v.trim(),
      };
      expect(mapping.convert("  hello  ")).toBe("hello");
    });

    it("convert function can produce boolean values", () => {
      const mapping: AttributeMapping = {
        xmlName: "WideShape",
        propertyKey: "wideShape",
        convert: (v: string) => v === "true",
      };
      expect(mapping.convert("true")).toBe(true);
      expect(mapping.convert("false")).toBe(false);
    });
  });

  describe("ComponentCategory enum", () => {
    it("has all required categories", () => {
      expect(ComponentCategory.LOGIC).toBe("LOGIC");
      expect(ComponentCategory.IO).toBe("IO");
      expect(ComponentCategory.FLIP_FLOPS).toBe("FLIP_FLOPS");
      expect(ComponentCategory.MEMORY).toBe("MEMORY");
      expect(ComponentCategory.ARITHMETIC).toBe("ARITHMETIC");
      expect(ComponentCategory.WIRING).toBe("WIRING");
      expect(ComponentCategory.SWITCHING).toBe("SWITCHING");
      expect(ComponentCategory.PLD).toBe("PLD");
      expect(ComponentCategory.MISC).toBe("MISC");
      expect(ComponentCategory.GRAPHICS).toBe("GRAPHICS");
      expect(ComponentCategory.TERMINAL).toBe("TERMINAL");
      expect(ComponentCategory.SEVENTY_FOUR_XX).toBe("74XX");
    });
  });

  describe("AnalogInfrastructure", () => {
    it("new_categories_accepted", () => {
      const def = makeDefinition("TestPassive", ComponentCategory.PASSIVES);
      registry.register(def);
      const result = registry.getByCategory(ComponentCategory.PASSIVES);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("TestPassive");
    });

    it("component_with_both_models_appears_in_digital_and_analog", () => {
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("SharedComponent"),
        models: { digital: { executeFn: noopExecuteFn } },
        modelRegistry: { behavioral: { kind: 'analog' } as any },
      };
      registry.register(def);

      const digital = registry.getWithModel("digital");
      const analog = registry.getWithModel("analog");

      expect(digital.map((d) => d.name)).toContain("SharedComponent");
      expect(analog.map((d) => d.name)).toContain("SharedComponent");
    });

    it("pure_analog_excluded_from_digital", () => {
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("PureAnalog"),
        models: {},
        modelRegistry: { behavioral: { kind: 'analog' } as any },
      };
      registry.register(def);

      const digital = registry.getWithModel("digital");
      const analog = registry.getWithModel("analog");

      expect(digital.map((d) => d.name)).not.toContain("PureAnalog");
      expect(analog.map((d) => d.name)).toContain("PureAnalog");
    });
  });

  describe("ComponentModels types and utilities (P1-1 through P1-5)", () => {
    it("models field is preserved through register()", () => {
      const def = makeDefinition("AutoPop");
      registry.register(def);
      const stored = registry.getStandalone("AutoPop")!;
      expect(stored.models).toBeDefined();
      expect(stored.models.digital).toBeDefined();
      expect(stored.models.digital!.executeFn).toBe(noopExecuteFn);
    });

    it("models.digital.sampleFn is preserved through register()", () => {
      const sampleFn: ExecuteFunction = () => {};
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("WithSample"),
        models: { digital: { executeFn: noopExecuteFn, sampleFn } },
      };
      registry.register(def);
      const stored = registry.getStandalone("WithSample")!;
      expect(stored.models.digital!.sampleFn).toBe(sampleFn);
    });

    it("models.digital.stateSlotCount is preserved through register()", () => {
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("WithState"),
        models: { digital: { executeFn: noopExecuteFn, stateSlotCount: 3 } },
      };
      registry.register(def);
      const stored = registry.getStandalone("WithState")!;
      expect(stored.models.digital!.stateSlotCount).toBe(3);
    });

    it("models.digital.switchPins is preserved through register()", () => {
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("Switch"),
        models: { digital: { executeFn: noopExecuteFn, switchPins: [0, 1] } },
      };
      registry.register(def);
      const stored = registry.getStandalone("Switch")!;
      expect(stored.models.digital!.switchPins).toEqual([0, 1]);
    });

    it("modelRegistry is preserved through register()", () => {
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("VSource"),
        models: {},
        modelRegistry: { behavioral: { kind: 'analog' } as any },
      };
      registry.register(def);
      const stored = registry.getStandalone("VSource")!;
      expect(stored.modelRegistry?.behavioral).toBeDefined();
    });

    it("register() preserves explicitly supplied models", () => {
      const customModels: ComponentModels = {
        digital: { executeFn: noopExecuteFn },
      };
      const def: StandaloneComponentDefinition = { ...makeDefinition("ExplicitModels"), models: customModels };
      registry.register(def);
      const stored = registry.getStandalone("ExplicitModels")!;
      expect(stored.models).toBe(customModels);
    });

    it("defaultModel is preserved through register()", () => {
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("WithDefault"),
        models: { digital: { executeFn: noopExecuteFn } },
        defaultModel: "digital",
      };
      registry.register(def);
      const stored = registry.getStandalone("WithDefault")!;
      expect(stored.defaultModel).toBe("digital");
    });

    it("getWithModel digital returns components with digital model", () => {
      registry.register(makeDefinition("Gate1"));
      registry.register(makeDefinition("Gate2"));
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("PureAnalogOnly"),
        models: {},
        modelRegistry: { behavioral: { kind: 'analog' } as any },
      };
      registry.register(def);
      const digital = registry.getWithModel("digital");
      expect(digital.map((d) => d.name)).toContain("Gate1");
      expect(digital.map((d) => d.name)).toContain("Gate2");
      expect(digital.map((d) => d.name)).not.toContain("PureAnalogOnly");
    });

    it("getWithModel analog returns components with analog model", () => {
      registry.register(makeDefinition("DigOnlyGate"));
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("AnalogPassive"),
        models: {},
        modelRegistry: { behavioral: { kind: 'analog' } as any },
      };
      registry.register(def);
      const analog = registry.getWithModel("analog");
      expect(analog.map((d) => d.name)).toContain("AnalogPassive");
      expect(analog.map((d) => d.name)).not.toContain("DigOnlyGate");
    });
  });

  describe("alias must not shadow a later canonical name", () => {
    it("alias shadows later canonical registration", () => {
      registry.register(makeDefinition("PldDiode"));
      registry.registerAlias("Diode", "PldDiode");

      const diode = makeDefinition("Diode");
      registry.register(diode);
      const result = registry.getStandalone("Diode");
      expect(result!.name).toBe("PldDiode"); // alias takes precedence
    });

    it("without the alias, get(Diode) returns the semiconductor Diode", () => {
      registry.register(makeDefinition("PldDiode"));
      // No alias "Diode" â†’ "PldDiode"
      const diode = makeDefinition("Diode");
      registry.register(diode);

      const result = registry.getStandalone("Diode");
      expect(result).toBeDefined();
      expect(result!.name).toBe("Diode");
      expect(registry.getStandalone("PldDiode")!.name).toBe("PldDiode");
    });
  });

  describe("pinElectrical on StandaloneComponentDefinition", () => {
    it("pinElectrical stored on StandaloneComponentDefinition is preserved through register()", () => {
      const spec: PinElectricalSpec = { vOH: 3.3, vOL: 0, vIH: 2.0, vIL: 0.8 };
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("BridgeGate"),
        pinElectrical: spec,
      };
      registry.register(def);
      const stored = registry.getStandalone("BridgeGate")!;
      expect(stored.pinElectrical).toEqual(spec);
    });

    it("pinElectricalOverrides stored on StandaloneComponentDefinition is preserved through register()", () => {
      const overrides: Record<string, PinElectricalSpec> = {
        out: { vOH: 5.0, vOL: 0.1, rOut: 25 },
        in: { vIH: 2.5, vIL: 0.5 },
      };
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("HighDriveGate"),
        pinElectricalOverrides: overrides,
      };
      registry.register(def);
      const stored = registry.getStandalone("HighDriveGate")!;
      expect(stored.pinElectricalOverrides).toEqual(overrides);
    });

    it("pinElectrical and pinElectricalOverrides are independent of modelRegistry", () => {
      const spec: PinElectricalSpec = { vOH: 3.3, vOL: 0 };
      const def: StandaloneComponentDefinition = {
        ...makeDefinition("MixedGate"),
        pinElectrical: spec,
        models: { digital: { executeFn: noopExecuteFn } },
        modelRegistry: { behavioral: { kind: 'analog' } as any },
      };
      registry.register(def);
      const stored = registry.getStandalone("MixedGate")!;
      expect(stored.pinElectrical).toEqual(spec);
      expect(stored.modelRegistry?.behavioral).toBeDefined();
    });

    it("StandaloneComponentDefinition without pinElectrical has undefined pinElectrical", () => {
      const def = makeDefinition("PlainGate");
      registry.register(def);
      const stored = registry.getStandalone("PlainGate")!;
      expect(stored.pinElectrical).toBeUndefined();
      expect(stored.pinElectricalOverrides).toBeUndefined();
    });

  });

  describe("ParamDef.partition", () => {
    it("accepts omitted partition (defaults to undefined)", () => {
      const d: ParamDef = { key: "X", type: PropertyType.FLOAT, label: "X", rank: "primary" };
      expect(d.partition).toBeUndefined();
    });

    it("accepts partition: 'instance'", () => {
      const d: ParamDef = { key: "OFF", type: PropertyType.FLOAT, label: "OFF", rank: "secondary", partition: "instance" };
      expect(d.partition).toBe("instance");
    });

    it("accepts partition: 'model'", () => {
      const d: ParamDef = { key: "IS", type: PropertyType.FLOAT, label: "IS", rank: "primary", partition: "model" };
      expect(d.partition).toBe("model");
    });
  });
});
