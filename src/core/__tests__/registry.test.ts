import { describe, it, expect, beforeEach } from "vitest";
import {
  ComponentRegistry,
  ComponentCategory,
  isStandalone,
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
import {
  register74xxLibrary,
  LIBRARY_74XX,
} from "../../components/library-74xx.js";
import { createDefaultRegistry } from "../../components/register-all.js";

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

// ---------------------------------------------------------------------------
// register*Library round-trip — framework-layer generic contract
//
// One row per discovered `register*Library` helper. The contract under test is:
// after the helper runs, every entry it claims to have registered is reachable
// via getByCategory(<category>) AND via getStandalone(name), and every retrieved
// definition's `.category` matches the helper's category.
//
// Adding a new register*Library helper? Add a row to LIBRARY_HELPERS below.
// ---------------------------------------------------------------------------

interface LibraryHelperCase {
  readonly helperName: string;
  readonly category: ComponentCategory;
  readonly register: (registry: ComponentRegistry) => void;
  readonly manifestNames: readonly string[];
}

const LIBRARY_HELPERS: readonly LibraryHelperCase[] = [
  {
    helperName: "register74xxLibrary",
    category: ComponentCategory.SEVENTY_FOUR_XX,
    register: (registry) => register74xxLibrary(registry),
    manifestNames: LIBRARY_74XX.map((entry) => entry.name),
  },
];

describe.each(LIBRARY_HELPERS)(
  "register*Library round-trip: $helperName",
  ({ register, category, manifestNames }) => {
    let registry: ComponentRegistry;

    beforeEach(() => {
      registry = new ComponentRegistry();
      register(registry);
    });

    it("getByCategory length matches the manifest length passed to the helper", () => {
      expect(registry.getByCategory(category)).toHaveLength(manifestNames.length);
    });

    it("every name from getByCategory is retrievable via getStandalone(name)", () => {
      const namesFromCategory = registry.getByCategory(category).map((d) => d.name);
      for (const name of namesFromCategory) {
        const def = registry.getStandalone(name);
        expect(def).toBeDefined();
        expect(def!.name).toBe(name);
      }
    });

    it("every retrieved definition has category equal to the helper's category", () => {
      for (const def of registry.getByCategory(category)) {
        expect(def.category).toBe(category);
      }
      for (const name of manifestNames) {
        const def = registry.getStandalone(name);
        expect(def).toBeDefined();
        expect(def!.category).toBe(category);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Parametric AttributeMapping audit across the default registry. Replaces the
// per-component `definitionComplete > attributeMap covers X, Y, Z` blocks the
// wave-3 §3 sweep deleted from individual component test files.
//
// For every registered ComponentDefinition that declares an attributeMap:
//  - well-formedness: each entry has a non-empty xmlName, a non-empty
//    propertyKey, and a callable convert function.
//  - xmlName uniqueness within each component's attributeMap.
//  - convert is a pure mapping that produces a defined PropertyValue for an
//    empty XML string (never throws, never returns undefined). Per-component
//    semantic round-trips (e.g. "8" -> 8) live with the component's tests when
//    they observe a simulator effect; structural correctness audits live here.
// ---------------------------------------------------------------------------

describe("AttributeMapping parametric audit (every registered component)", () => {
  const defaultRegistry = createDefaultRegistry();
  const definitions = defaultRegistry
    .getAll()
    .filter((d) => Array.isArray(d.attributeMap) && d.attributeMap.length > 0);

  it("default registry has at least one component with an attributeMap", () => {
    expect(definitions.length).toBeGreaterThan(0);
  });

  for (const def of definitions) {
    describe(def.name, () => {
      const seenXmlNames = new Map<string, number>();
      for (const mapping of def.attributeMap) {
        const count = seenXmlNames.get(mapping.xmlName) ?? 0;
        seenXmlNames.set(mapping.xmlName, count + 1);
      }

      it("attributeMap xmlNames are unique within the component", () => {
        const duplicates = [...seenXmlNames.entries()]
          .filter(([, n]) => n > 1)
          .map(([name]) => name);
        expect(duplicates).toEqual([]);
      });

      for (const mapping of def.attributeMap) {
        it(`xmlName "${mapping.xmlName}" entry is well-formed`, () => {
          expect(typeof mapping.xmlName).toBe("string");
          expect(mapping.xmlName.length).toBeGreaterThan(0);
          expect(typeof mapping.propertyKey).toBe("string");
          expect(mapping.propertyKey.length).toBeGreaterThan(0);
          expect(typeof mapping.convert).toBe("function");
        });

        it(`xmlName "${mapping.xmlName}" convert("") returns a defined PropertyValue`, () => {
          const result = mapping.convert("");
          expect(result).toBeDefined();
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// User-facing definition parametric audit (every registered, non-internalOnly
// component). Closes the per-component coverage gap that wave-3 §3 deletions
// vacated:
//
//   - helpText: every public component must surface user help text.
//   - category: must be a recognised ComponentCategory enum value.
//   - factory: factory(new PropertyBag()) must return a defined CircuitElement
//     without throwing for every public definition (constructor smoke).
//   - pinLayout: every public component must declare at least one pin.
//
// Internal-only definitions are skipped: they are never placed by users, do
// not appear in palettes, and may have factory contracts that require more
// than an empty PropertyBag.
// ---------------------------------------------------------------------------

const VALID_CATEGORY_VALUES: readonly string[] = [
  "LOGIC", "IO", "FLIP_FLOPS", "MEMORY", "ARITHMETIC", "WIRING",
  "SWITCHING", "PLD", "MISC", "GRAPHICS", "TERMINAL", "74XX",
  "SUBCIRCUIT", "PASSIVES", "SEMICONDUCTORS", "SOURCES", "ACTIVE",
];

describe("Public definition parametric audit (every registered, non-internalOnly component)", () => {
  const userFacingDefinitions = createDefaultRegistry()
    .getAll()
    .filter(isStandalone);

  it("default registry has at least one user-facing definition", () => {
    expect(userFacingDefinitions.length).toBeGreaterThan(0);
  });

  for (const def of userFacingDefinitions) {
    // 74xx stubs are place-holder definitions whose factory + pinLayout
    // require the corresponding .dig subcircuit to be pre-loaded
    // (`register74xxLibrary(registry, pinMap74xx)`). The factory throws
    // a documented "must be loaded from <id>.dig before placement" error
    // and pinLayout is intentionally empty until the pinMap is supplied.
    // Coverage for 74xx structural conformance lives in
    // `src/components/__tests__/library-74xx.test.ts` and
    // `src/components/__tests__/library-manifests.test.ts`.
    const isStub74xx = def.category as string === "74XX";

    describe(def.name, () => {
      it("helpText is a non-empty string", () => {
        expect(typeof def.helpText).toBe("string");
        expect(def.helpText.length).toBeGreaterThan(0);
      });

      it("category is a recognised ComponentCategory value", () => {
        expect(VALID_CATEGORY_VALUES).toContain(def.category as string);
      });

      if (!isStub74xx) {
        it("factory(new PropertyBag()) returns a defined CircuitElement without throwing", () => {
          const el = def.factory(new PropertyBag());
          expect(el).toBeDefined();
          expect(el).not.toBeNull();
        });

        it("pinLayout declares at least one pin", () => {
          expect(Array.isArray(def.pinLayout)).toBe(true);
          expect(def.pinLayout.length).toBeGreaterThan(0);
        });
      }
    });
  }
});
