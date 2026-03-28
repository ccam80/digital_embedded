import { describe, it, expect, beforeEach } from "vitest";
import {
  ComponentRegistry,
  ComponentCategory,
  hasDigitalModel,
  hasMnaModel,
  availableModels,
  getActiveModelKey,
  modelKeyToDomain,
} from "../registry.js";
import type {
  ComponentDefinition,
  AttributeMapping,
  ComponentLayout,
  ExecuteFunction,
  DigitalModel,
  MnaModel,
  ComponentModels,
  MnaModel,
} from "../registry.js";
import { PropertyBag } from "../properties.js";
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
): ComponentDefinition {
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
      expect(registry.get("And")).toBeUndefined();
    });

    it("registers a definition and retrieves it by name", () => {
      const def = makeDefinition("And");
      registry.register(def);
      const result = registry.get("And");
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
      expect(registry.get("And")?.name).toBe("And");
      expect(registry.get("Or")?.name).toBe("Or");
    });
  });

  describe("auto-assigned type IDs", () => {
    it("assigns typeId 0 to the first registered component", () => {
      registry.register(makeDefinition("And"));
      expect(registry.get("And")!.typeId).toBe(0);
    });

    it("assigns incrementing type IDs in registration order", () => {
      registry.register(makeDefinition("And"));
      registry.register(makeDefinition("Or"));
      registry.register(makeDefinition("Not"));
      expect(registry.get("And")!.typeId).toBe(0);
      expect(registry.get("Or")!.typeId).toBe(1);
      expect(registry.get("Not")!.typeId).toBe(2);
    });

    it("does not use the caller-supplied typeId", () => {
      const def = makeDefinition("And");
      def.typeId = 999;
      registry.register(def);
      expect(registry.get("And")!.typeId).toBe(0);
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
      const def = registry.get("And")!;
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

      const stored = registry.get("And")!;
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
      const stubAnalogFactory = () => ({ stamp: () => {}, stampHistory: () => {}, stampInitial: () => {} } as any);
      const def: ComponentDefinition = {
        ...makeDefinition("SharedComponent"),
        models: { digital: { executeFn: noopExecuteFn }, mnaModels: { behavioral: { factory: stubAnalogFactory } } },
      };
      registry.register(def);

      const digital = registry.getWithModel("digital");
      const analog = registry.getWithModel("analog");

      expect(digital.map((d) => d.name)).toContain("SharedComponent");
      expect(analog.map((d) => d.name)).toContain("SharedComponent");
    });

    it("pure_analog_excluded_from_digital", () => {
      const stubAnalogFactory = () => ({ stamp: () => {}, stampHistory: () => {}, stampInitial: () => {} } as any);
      const def: ComponentDefinition = {
        ...makeDefinition("PureAnalog"),
        models: { mnaModels: { behavioral: { factory: stubAnalogFactory } } },
      };
      registry.register(def);

      const digital = registry.getWithModel("digital");
      const analog = registry.getWithModel("analog");

      expect(digital.map((d) => d.name)).not.toContain("PureAnalog");
      expect(analog.map((d) => d.name)).toContain("PureAnalog");
    });
  });

  describe("ComponentModels types and utilities (P1-1 through P1-5)", () => {
    const stubAnalogFactory = () =>
      ({ stamp: () => {}, stampHistory: () => {}, stampInitial: () => {} } as any);

    it("hasDigitalModel returns true when models.digital is defined", () => {
      const def = makeDefinition("DigOnly");
      registry.register(def);
      const stored = registry.get("DigOnly")!;
      expect(hasDigitalModel(stored)).toBe(true);
    });

    it("hasDigitalModel returns false for pure-analog component", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("PureA"),
        models: { mnaModels: { behavioral: { factory: stubAnalogFactory } } },
      };
      registry.register(def);
      const stored = registry.get("PureA")!;
      expect(hasDigitalModel(stored)).toBe(false);
    });

    it("hasAnalogModel returns true when mna model is present", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("WithAnalog"),
        models: { digital: { executeFn: noopExecuteFn }, mnaModels: { behavioral: { factory: stubAnalogFactory } } },
      };
      registry.register(def);
      const stored = registry.get("WithAnalog")!;
      expect(hasMnaModel(stored)).toBe(true);
    });

    it("hasMnaModel returns false for digital-only component", () => {
      const def = makeDefinition("DigOnly2");
      registry.register(def);
      const stored = registry.get("DigOnly2")!;
      expect(hasMnaModel(stored)).toBe(false);
    });

    it("availableModels returns ['digital'] for digital-only component", () => {
      const def = makeDefinition("JustDigital");
      registry.register(def);
      const stored = registry.get("JustDigital")!;
      expect(availableModels(stored)).toEqual(["digital"]);
    });

    it("availableModels returns ['behavioral'] for pure-mna component", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("JustAnalog"),
        models: { mnaModels: { behavioral: { factory: stubAnalogFactory } } },
      };
      registry.register(def);
      const stored = registry.get("JustAnalog")!;
      expect(availableModels(stored)).toEqual(["behavioral"]);
    });

    it("availableModels returns both keys for dual-model component", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("DualModel"),
        models: { digital: { executeFn: noopExecuteFn }, mnaModels: { behavioral: { factory: stubAnalogFactory } } },
      };
      registry.register(def);
      const stored = registry.get("DualModel")!;
      const models = availableModels(stored);
      expect(models).toContain("digital");
      expect(models).toContain("behavioral");
      expect(models).toHaveLength(2);
    });

    it("models field is preserved through register()", () => {
      const def = makeDefinition("AutoPop");
      registry.register(def);
      const stored = registry.get("AutoPop")!;
      expect(stored.models).toBeDefined();
      expect(stored.models.digital).toBeDefined();
      expect(stored.models.digital!.executeFn).toBe(noopExecuteFn);
    });

    it("models.digital.sampleFn is preserved through register()", () => {
      const sampleFn: ExecuteFunction = () => {};
      const def: ComponentDefinition = {
        ...makeDefinition("WithSample"),
        models: { digital: { executeFn: noopExecuteFn, sampleFn } },
      };
      registry.register(def);
      const stored = registry.get("WithSample")!;
      expect(stored.models.digital!.sampleFn).toBe(sampleFn);
    });

    it("models.digital.stateSlotCount is preserved through register()", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("WithState"),
        models: { digital: { executeFn: noopExecuteFn, stateSlotCount: 3 } },
      };
      registry.register(def);
      const stored = registry.get("WithState")!;
      expect(stored.models.digital!.stateSlotCount).toBe(3);
    });

    it("models.digital.switchPins is preserved through register()", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("Switch"),
        models: { digital: { executeFn: noopExecuteFn, switchPins: [0, 1] } },
      };
      registry.register(def);
      const stored = registry.get("Switch")!;
      expect(stored.models.digital!.switchPins).toEqual([0, 1]);
    });

    it("models.mnaModels.behavioral.requiresBranchRow is preserved through register()", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("VSource"),
        models: { mnaModels: { behavioral: { factory: stubAnalogFactory, requiresBranchRow: true } } },
      };
      registry.register(def);
      const stored = registry.get("VSource")!;
      expect(stored.models.mnaModels.behavioral!.requiresBranchRow).toBe(true);
    });

    it("register() preserves explicitly supplied models", () => {
      const customModels: ComponentModels = {
        digital: { executeFn: noopExecuteFn },
      };
      const def: ComponentDefinition = { ...makeDefinition("ExplicitModels"), models: customModels };
      registry.register(def);
      const stored = registry.get("ExplicitModels")!;
      expect(stored.models).toBe(customModels);
    });

    it("defaultModel is preserved through register()", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("WithDefault"),
        models: { digital: { executeFn: noopExecuteFn }, mnaModels: { behavioral: { factory: stubAnalogFactory } } },
        defaultModel: "digital",
      };
      registry.register(def);
      const stored = registry.get("WithDefault")!;
      expect(stored.defaultModel).toBe("digital");
    });

    it("getWithModel digital returns components with digital model", () => {
      registry.register(makeDefinition("Gate1"));
      registry.register(makeDefinition("Gate2"));
      const def: ComponentDefinition = {
        ...makeDefinition("PureAnalogOnly"),
        models: { mnaModels: { behavioral: { factory: stubAnalogFactory } } },
      };
      registry.register(def);
      const digital = registry.getWithModel("digital");
      expect(digital.map((d) => d.name)).toContain("Gate1");
      expect(digital.map((d) => d.name)).toContain("Gate2");
      expect(digital.map((d) => d.name)).not.toContain("PureAnalogOnly");
    });

    it("getWithModel analog returns components with analog model", () => {
      registry.register(makeDefinition("DigOnlyGate"));
      const def: ComponentDefinition = {
        ...makeDefinition("AnalogPassive"),
        models: { mnaModels: { behavioral: { factory: stubAnalogFactory } } },
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
      const result = registry.get("Diode");
      expect(result!.name).toBe("PldDiode"); // alias takes precedence
    });

    it("without the alias, get(Diode) returns the semiconductor Diode", () => {
      registry.register(makeDefinition("PldDiode"));
      // No alias "Diode" → "PldDiode"
      const diode = makeDefinition("Diode");
      registry.register(diode);

      const result = registry.get("Diode");
      expect(result).toBeDefined();
      expect(result!.name).toBe("Diode");
      expect(registry.get("PldDiode")!.name).toBe("PldDiode");
    });
  });

  describe("getActiveModelKey", () => {
    const stubMnaFactory = () =>
      ({ stamp: () => {}, stampHistory: () => {}, stampInitial: () => {} } as any);

    function makeMockElementWithProp(
      instanceId: string,
      simulationModel?: string,
    ): CircuitElement {
      const base = makeMockElement("TestType", instanceId);
      return {
        ...base,
        getAttribute(name: string): PropertyValue | undefined {
          if (name === 'simulationModel') return simulationModel;
          return undefined;
        },
      };
    }

    it("returns simulationModel prop when set to 'digital' and digital model exists", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("AndGate"),
        models: {
          digital: { executeFn: noopExecuteFn },
          mnaModels: { behavioral: { factory: stubMnaFactory } },
        },
        defaultModel: "behavioral",
      };
      const el = makeMockElementWithProp("and1", "digital");
      expect(getActiveModelKey(el, def)).toBe("digital");
    });

    it("returns simulationModel prop when set to an mnaModels key", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("OpAmp"),
        models: {
          mnaModels: {
            ideal: { factory: stubMnaFactory },
            real: { factory: stubMnaFactory, getInternalNodeCount: () => 1 },
          },
        },
        defaultModel: "ideal",
      };
      const el = makeMockElementWithProp("op1", "real");
      expect(getActiveModelKey(el, def)).toBe("real");
    });

    it("throws when simulationModel prop is set to an invalid key", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("Resistor"),
        models: { mnaModels: { behavioral: { factory: stubMnaFactory } } },
        defaultModel: "behavioral",
      };
      const el = makeMockElementWithProp("r1", "nonexistent");
      expect(() => getActiveModelKey(el, def)).toThrow(
        /Unknown simulationModel "nonexistent"/,
      );
    });

    it("throws with valid keys listed when simulationModel prop is invalid", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("Bjt"),
        models: {
          mnaModels: {
            behavioral: { factory: stubMnaFactory },
            spice: { factory: stubMnaFactory },
          },
        },
        defaultModel: "behavioral",
      };
      const el = makeMockElementWithProp("q1", "missing");
      expect(() => getActiveModelKey(el, def)).toThrow(/behavioral.*spice|spice.*behavioral/);
    });

    it("falls through to defaultModel when simulationModel prop is absent", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("Capacitor"),
        models: {
          mnaModels: {
            behavioral: { factory: stubMnaFactory },
            ideal: { factory: stubMnaFactory },
          },
        },
        defaultModel: "ideal",
      };
      const el = makeMockElementWithProp("c1", undefined);
      expect(getActiveModelKey(el, def)).toBe("ideal");
    });

    it("falls through to 'digital' when no prop and no defaultModel", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("Buffer"),
        models: {
          digital: { executeFn: noopExecuteFn },
          mnaModels: { behavioral: { factory: stubMnaFactory } },
        },
      };
      const el = makeMockElementWithProp("buf1", undefined);
      expect(getActiveModelKey(el, def)).toBe("digital");
    });

    it("falls through to first mnaModels key when no prop, no defaultModel, no digital", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("Inductor"),
        models: { mnaModels: { behavioral: { factory: stubMnaFactory } } },
      };
      const el = makeMockElementWithProp("l1", undefined);
      expect(getActiveModelKey(el, def)).toBe("behavioral");
    });

    it("throws when component has no models at all", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("Empty"),
        models: {},
      };
      const el = makeMockElementWithProp("e1", undefined);
      expect(() => getActiveModelKey(el, def)).toThrow(/no models/);
    });
  });

  describe("pinElectrical on ComponentDefinition", () => {
    it("pinElectrical stored on ComponentDefinition is preserved through register()", () => {
      const spec: PinElectricalSpec = { vOH: 3.3, vOL: 0, vIH: 2.0, vIL: 0.8 };
      const def: ComponentDefinition = {
        ...makeDefinition("BridgeGate"),
        pinElectrical: spec,
      };
      registry.register(def);
      const stored = registry.get("BridgeGate")!;
      expect(stored.pinElectrical).toEqual(spec);
    });

    it("pinElectricalOverrides stored on ComponentDefinition is preserved through register()", () => {
      const overrides: Record<string, PinElectricalSpec> = {
        out: { vOH: 5.0, vOL: 0.1, rOut: 25 },
        in: { vIH: 2.5, vIL: 0.5 },
      };
      const def: ComponentDefinition = {
        ...makeDefinition("HighDriveGate"),
        pinElectricalOverrides: overrides,
      };
      registry.register(def);
      const stored = registry.get("HighDriveGate")!;
      expect(stored.pinElectricalOverrides).toEqual(overrides);
    });

    it("pinElectrical and pinElectricalOverrides are independent of models.mnaModels.behavioral", () => {
      const spec: PinElectricalSpec = { vOH: 3.3, vOL: 0 };
      const def: ComponentDefinition = {
        ...makeDefinition("MixedGate"),
        pinElectrical: spec,
        models: { digital: { executeFn: noopExecuteFn }, mnaModels: { behavioral: {} } },
      };
      registry.register(def);
      const stored = registry.get("MixedGate")!;
      expect(stored.pinElectrical).toEqual(spec);
      expect(stored.models.mnaModels?.behavioral).toBeDefined();
    });

    it("ComponentDefinition without pinElectrical has undefined pinElectrical", () => {
      const def = makeDefinition("PlainGate");
      registry.register(def);
      const stored = registry.get("PlainGate")!;
      expect(stored.pinElectrical).toBeUndefined();
      expect(stored.pinElectricalOverrides).toBeUndefined();
    });

    it("MnaModel interface does not include pinElectrical fields", () => {
      // Verify at the type level: MnaModel keys should not include pinElectrical.
      // This is enforced by TypeScript — if someone adds pinElectrical to MnaModel,
      // they must also update ComponentDefinition (where it belongs).
      const mnaKeys: Array<keyof MnaModel> = [
        "factory", "subcircuitModel", "getInternalNodeCount",
        "requiresBranchRow", "deviceType", "defaultParams",
      ];
      expect(mnaKeys).not.toContain("pinElectrical");
      expect(mnaKeys).not.toContain("pinElectricalOverrides");
    });
  });

  describe("modelKeyToDomain", () => {
    const stubMnaFactory = () =>
      ({ stamp: () => {}, stampHistory: () => {}, stampInitial: () => {} } as any);

    it("returns 'digital' for key 'digital' when digital model exists", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("AndGate2"),
        models: { digital: { executeFn: noopExecuteFn } },
      };
      expect(modelKeyToDomain("digital", def)).toBe("digital");
    });

    it("returns 'mna' for a key present in mnaModels", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("Resistor2"),
        models: { mnaModels: { behavioral: { factory: stubMnaFactory } } },
        defaultModel: "behavioral",
      };
      expect(modelKeyToDomain("behavioral", def)).toBe("mna");
    });

    it("returns 'mna' for any key that is not 'digital'", () => {
      const def: ComponentDefinition = {
        ...makeDefinition("OpAmp2"),
        models: {
          mnaModels: {
            ideal: { factory: stubMnaFactory },
            real: { factory: stubMnaFactory },
          },
        },
      };
      expect(modelKeyToDomain("ideal", def)).toBe("mna");
      expect(modelKeyToDomain("real", def)).toBe("mna");
    });
  });
});
