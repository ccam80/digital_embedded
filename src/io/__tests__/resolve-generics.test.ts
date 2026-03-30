/**
 * Tests for resolve-generics.ts — HGS generic circuit resolution.
 */

import { describe, it, expect } from "vitest";
import {
  resolveGenericCircuit,
  isGenericCircuit,
  GenericResolutionCache,
} from "../resolve-generics.js";
import { GenericCache, computeGenericCacheKey } from "../generic-cache.js";
import { Circuit } from "../../core/circuit.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { ComponentDefinition, AttributeMapping } from "../../core/registry.js";
import { PropertyBag } from "../../core/properties.js";
import { AndDefinition } from "../../components/gates/and.js";
import { InDefinition } from "../../components/io/in.js";
import { parseDigXml } from "../dig-parser.js";
import { loadDigCircuit } from "../dig-loader.js";
import type { HGSValue } from "../../hgs/value.js";
import { TestElement } from "../../test-fixtures/test-element.js";
import { noopExecFn } from "../../test-fixtures/execute-stubs.js";

function makeTestFactory(typeName: string) {
  return (props: PropertyBag) =>
    new TestElement(typeName, crypto.randomUUID(), { x: 0, y: 0 }, [], props);
}

// ---------------------------------------------------------------------------
// GenericInitCode and GenericCode component definitions
//
// These are special-purpose elements handled by the resolver.
// They store their HGS code in the "generic" property and GenericInitCode
// also stores an "enabled" boolean.
// ---------------------------------------------------------------------------

function makeGenericCodeDef(typeName: string): ComponentDefinition {
  const attributeMap: AttributeMapping[] = [
    { xmlName: "generic", propertyKey: "generic", convert: (v) => v },
    { xmlName: "enabled", propertyKey: "enabled", convert: (v) => v === "true" },
  ];
  return {
    name: typeName,
    typeId: -1,
    factory: makeTestFactory(typeName),
    pinLayout: [],
    propertyDefs: [],
    attributeMap,
    category: ComponentCategory.MISC,
    helpText: typeName,
    models: {
      digital: { executeFn: noopExecFn },
    },
  };
}

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

function makeRegistry(...defs: ComponentDefinition[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const def of defs) {
    registry.register(def);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Circuit builders
// ---------------------------------------------------------------------------

/**
 * Build a generic circuit containing a GenericInitCode element that declares
 * the given variable when executed.
 */
function buildInitCodeCircuit(code: string, enabled: boolean = true): Circuit {
  const circuit = new Circuit({ isGeneric: true });
  const props = new PropertyBag();
  props.set("generic", code);
  props.set("enabled", enabled);
  const el = new TestElement(
    "GenericInitCode",
    crypto.randomUUID(),
    { x: 0, y: 0 },
    [],
    props,
  );
  circuit.addElement(el);
  return circuit;
}

/**
 * Build an element with the given typeId and property set.
 */
function buildElement(typeId: string, props: PropertyBag): TestElement {
  return new TestElement(typeId, crypto.randomUUID(), { x: 0, y: 0 }, [], props);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Generic", () => {
  it("resolvesInitCode", async () => {
    const registry = makeRegistry(makeGenericCodeDef("GenericInitCode"));

    // Circuit with GenericInitCode declaring `inputs := 8`
    const circuit = buildInitCodeCircuit("inputs:=8;");

    const resolved = await resolveGenericCircuit(circuit, new Map(), registry);

    // The resolved circuit has no GenericInitCode elements
    expect(resolved.elements.filter((e) => e.typeId === "GenericInitCode")).toHaveLength(0);

    // The circuit itself is no longer generic
    expect(resolved.metadata.isGeneric).toBe(false);

    // To verify args, we re-run the init code and check directly
    // (the args context is internal; we verify by observing side effects in other tests)
    // Here we just confirm resolution completes without error
    expect(resolved).toBeInstanceOf(Circuit);
  });

  it("modifiesComponentAttributes", async () => {
    const registry = makeRegistry(
      makeGenericCodeDef("GenericInitCode"),
      { ...AndDefinition, name: "And" },
    );

    // Build a circuit:
    //   GenericInitCode: inputs := 8;
    //   And gate with generic code: this.Inputs = args.inputs;
    const circuit = new Circuit({ isGeneric: true });

    // GenericInitCode element
    const initProps = new PropertyBag();
    initProps.set("generic", "inputs:=8;");
    initProps.set("enabled", true);
    circuit.addElement(buildElement("GenericInitCode", initProps));

    // And element with generic attribute
    const andProps = new PropertyBag();
    andProps.set("generic", "this.Inputs=args.inputs;");
    andProps.set("inputCount", 2); // default 2 inputs
    circuit.addElement(buildElement("And", andProps));

    const resolved = await resolveGenericCircuit(circuit, new Map(), registry);

    // Find the And element in the resolved circuit
    const andEls = resolved.elements.filter((e) => e.typeId === "And");
    expect(andEls).toHaveLength(1);

    const andEl = andEls[0];
    // After resolution, the And element should have inputCount = 8
    // (converted from HGS bigint 8n via the Inputs → inputCount mapping)
    const inputCount = andEl.getProperties().getOrDefault<number>("inputCount", 2);
    expect(inputCount).toBe(8);
  });

  it("generatesCircuitStructure", async () => {
    const registry = makeRegistry(
      makeGenericCodeDef("GenericInitCode"),
      makeGenericCodeDef("GenericCode"),
      { ...InDefinition, name: "In" },
    );

    // Build a circuit:
    //   GenericInitCode: (empty — we'll use external args)
    //   GenericCode: addComponent("In", 0, 0);
    const circuit = new Circuit({ isGeneric: true });

    // We supply external args so no GenericInitCode is needed
    const codeProps = new PropertyBag();
    codeProps.set("generic", 'addComponent("In", 0, 0);');
    circuit.addElement(buildElement("GenericCode", codeProps));

    const externalArgs = new Map<string, HGSValue>([["n", 1n]]);
    const resolved = await resolveGenericCircuit(circuit, externalArgs, registry);

    // A new In element should have been added
    const inEls = resolved.elements.filter((e) => e.typeId === "In");
    expect(inEls).toHaveLength(1);
    expect(inEls[0].position).toEqual({ x: 0, y: 0 });
  });

  it("disabledInitCodeIgnored", async () => {
    const registry = makeRegistry(
      makeGenericCodeDef("GenericInitCode"),
    );

    // Build a circuit with TWO GenericInitCode elements:
    //   one enabled=true: inputs := 8
    //   one enabled=false: inputs := 5 (this one should be ignored)
    const circuit = new Circuit({ isGeneric: true });

    const enabledProps = new PropertyBag();
    enabledProps.set("generic", "inputs:=8;");
    enabledProps.set("enabled", true);
    circuit.addElement(buildElement("GenericInitCode", enabledProps));

    const disabledProps = new PropertyBag();
    disabledProps.set("generic", "inputs:=5;");
    disabledProps.set("enabled", false);
    circuit.addElement(buildElement("GenericInitCode", disabledProps));

    // Add an And gate to verify the right args were used
    registry.register({ ...AndDefinition, name: "And" });

    const andProps = new PropertyBag();
    andProps.set("generic", "this.Inputs=args.inputs;");
    andProps.set("inputCount", 2);
    circuit.addElement(buildElement("And", andProps));

    const resolved = await resolveGenericCircuit(circuit, new Map(), registry);

    // Should have resolved with inputs=8 (the enabled init code)
    const andEl = resolved.elements.find((e) => e.typeId === "And");
    expect(andEl).toBeDefined();
    const inputCount = andEl!.getProperties().getOrDefault<number>("inputCount", 2);
    expect(inputCount).toBe(8);
  });

  it("cachesResults", async () => {
    const registry = makeRegistry(
      makeGenericCodeDef("GenericInitCode"),
    );

    const circuit = buildInitCodeCircuit("inputs:=8;");

    const cache = new GenericResolutionCache();
    const args = new Map<string, HGSValue>();
    const argsKey = GenericResolutionCache.keyFor(args);

    // First call — not cached
    expect(cache.get(argsKey)).toBeUndefined();

    const resolved1 = await resolveGenericCircuit(circuit, args, registry);
    cache.set(argsKey, resolved1);

    // Second call — returns cached result (same reference)
    const cached = cache.get(argsKey);
    expect(cached).toBe(resolved1);

    // Verify the cache key is stable
    const argsKey2 = GenericResolutionCache.keyFor(args);
    expect(argsKey2).toBe(argsKey);
  });

  it("genAndExample", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes>
    <entry>
      <string>isGeneric</string>
      <boolean>true</boolean>
    </entry>
  </attributes>
  <visualElements>
    <visualElement>
      <elementName>GenericInitCode</elementName>
      <elementAttributes>
        <entry>
          <string>generic</string>
          <string>inputs:=8;</string>
        </entry>
      </elementAttributes>
      <pos x="100" y="100"/>
    </visualElement>
    <visualElement>
      <elementName>And</elementName>
      <elementAttributes>
        <entry>
          <string>generic</string>
          <string>this.Inputs=args.inputs;</string>
        </entry>
      </elementAttributes>
      <pos x="300" y="100"/>
    </visualElement>
  </visualElements>
  <wires/>
</circuit>`;

    // Set up registry with all needed components
    const registry = makeRegistry(
      makeGenericCodeDef("GenericInitCode"),
      makeGenericCodeDef("GenericCode"),
      { ...AndDefinition, name: "And" },
      { ...InDefinition, name: "In" },
    );

    // Also register Out for this test (GenericCode adds Out elements)
    registry.register(makeTestDef("Out"));

    // Parse and load the circuit (dig-loader will throw on GenericInitCode/GenericCode
    // because they're registered as TestElement — that's fine, we just need
    // the circuit structure)
    const parsed = parseDigXml(xml);
    const circuit = loadDigCircuit(parsed, registry);

    // The circuit should be marked as generic
    expect(circuit.metadata.isGeneric).toBe(true);

    // Resolve with default args (use enabled GenericInitCode which sets inputs:=8)
    const resolved = await resolveGenericCircuit(circuit, new Map(), registry);

    // The resolved circuit should not be generic
    expect(resolved.metadata.isGeneric).toBe(false);

    // The And gate should have inputs = 8 (from the init code)
    const andEl = resolved.elements.find((e) => e.typeId === "And");
    expect(andEl).toBeDefined();
    const inputCount = andEl!.getProperties().getOrDefault<number>("inputCount", 2);
    expect(inputCount).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// isGenericCircuit
// ---------------------------------------------------------------------------

describe("isGenericCircuit", () => {
  it("returnsTrueForGenericCircuit", () => {
    const circuit = new Circuit({ isGeneric: true });
    expect(isGenericCircuit(circuit)).toBe(true);
  });

  it("returnsFalseForNonGenericCircuit", () => {
    const circuit = new Circuit({ isGeneric: false });
    expect(isGenericCircuit(circuit)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GenericResolutionCache
// ---------------------------------------------------------------------------

describe("GenericResolutionCache", () => {
  it("keyForEmptyMapIsStable", () => {
    const key1 = GenericResolutionCache.keyFor(new Map());
    const key2 = GenericResolutionCache.keyFor(new Map());
    expect(key1).toBe(key2);
  });

  it("keyForSameArgsDifferentInsertionOrder", () => {
    const map1 = new Map<string, HGSValue>([["a", 1n], ["b", 2n]]);
    const map2 = new Map<string, HGSValue>([["b", 2n], ["a", 1n]]);
    expect(GenericResolutionCache.keyFor(map1)).toBe(GenericResolutionCache.keyFor(map2));
  });

  it("keyForDifferentArgsIsDifferent", () => {
    const map1 = new Map<string, HGSValue>([["inputs", 8n]]);
    const map2 = new Map<string, HGSValue>([["inputs", 4n]]);
    expect(GenericResolutionCache.keyFor(map1)).not.toBe(GenericResolutionCache.keyFor(map2));
  });
});

// ---------------------------------------------------------------------------
// Helper — make a simple test component definition
// ---------------------------------------------------------------------------

function makeTestDef(name: string): ComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: makeTestFactory(name),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [
      { xmlName: "Label", propertyKey: "label", convert: (v) => v },
    ],
    category: ComponentCategory.MISC,
    helpText: name,
    models: {
      digital: { executeFn: () => {} },
    },
  };
}

// ---------------------------------------------------------------------------
// Task 6.2.4 spec-required tests
// ---------------------------------------------------------------------------

describe("resolveGeneric", () => {
  it("resolveBasic", async () => {
    // Generic circuit with args.bits = 8; script sets element bit widths.
    // We use an And gate whose Inputs attribute gets set to args.bits.
    const registry = makeRegistry(
      makeGenericCodeDef("GenericInitCode"),
      { ...AndDefinition, name: "And" },
    );

    const circuit = new Circuit({ isGeneric: true });

    const initProps = new PropertyBag();
    initProps.set("generic", "bits:=8;");
    initProps.set("enabled", true);
    circuit.addElement(buildElement("GenericInitCode", initProps));

    const andProps = new PropertyBag();
    andProps.set("generic", "this.Inputs=args.bits;");
    andProps.set("inputCount", 2);
    circuit.addElement(buildElement("And", andProps));

    const resolved = await resolveGenericCircuit(circuit, new Map(), registry);

    expect(resolved.metadata.isGeneric).toBe(false);
    const andEl = resolved.elements.find((e) => e.typeId === "And");
    expect(andEl).toBeDefined();
    expect(andEl!.getProperties().getOrDefault<number>("inputCount", 2)).toBe(8);
  });

  it("addComponent", async () => {
    // Generic script calls addComponent() → extra component appears in resolved circuit.
    const registry = makeRegistry(
      makeGenericCodeDef("GenericCode"),
      { ...InDefinition, name: "In" },
    );

    const circuit = new Circuit({ isGeneric: true });

    const codeProps = new PropertyBag();
    codeProps.set("generic", 'addComponent("In", 2, 4);');
    circuit.addElement(buildElement("GenericCode", codeProps));

    const externalArgs = new Map<string, HGSValue>([["n", 1n]]);
    const resolved = await resolveGenericCircuit(circuit, externalArgs, registry);

    const inEls = resolved.elements.filter((e) => e.typeId === "In");
    expect(inEls).toHaveLength(1);
    expect(inEls[0].position).toEqual({ x: 2, y: 4 });
  });

  it("cacheHit", async () => {
    // Resolve the same generic with the same args twice.
    // The GenericCache should return the same object reference on the second call.
    const registry = makeRegistry(
      makeGenericCodeDef("GenericInitCode"),
    );
    const circuit = buildInitCodeCircuit("bits:=4;");

    const cache = new GenericCache();
    const args = new Map<string, HGSValue>();
    const key = computeGenericCacheKey("myCircuit", args);

    const resolved1 = await resolveGenericCircuit(circuit, args, registry);
    cache.set(key, resolved1);

    const hit = cache.get(key);
    expect(hit).toBeDefined();
    expect(hit).toBe(resolved1);
  });

  it("cacheMiss", async () => {
    // Resolve the same generic with different args → different results, different keys.
    const registry = makeRegistry(
      makeGenericCodeDef("GenericInitCode"),
      { ...AndDefinition, name: "And" },
    );

    const circuit = new Circuit({ isGeneric: true });

    const initProps = new PropertyBag();
    initProps.set("generic", "bits:=4;");
    initProps.set("enabled", true);
    circuit.addElement(buildElement("GenericInitCode", initProps));

    const andProps = new PropertyBag();
    andProps.set("generic", "this.Inputs=args.bits;");
    andProps.set("inputCount", 2);
    circuit.addElement(buildElement("And", andProps));

    const args4 = new Map<string, HGSValue>([["bits", 4n]]);
    const args8 = new Map<string, HGSValue>([["bits", 8n]]);

    const key4 = computeGenericCacheKey("myCircuit", args4);
    const key8 = computeGenericCacheKey("myCircuit", args8);

    const resolved4 = await resolveGenericCircuit(circuit, args4, registry);
    const resolved8 = await resolveGenericCircuit(circuit, args8, registry);

    expect(key4).not.toBe(key8);
    expect(resolved4).not.toBe(resolved8);

    const andEl4 = resolved4.elements.find((e) => e.typeId === "And");
    const andEl8 = resolved8.elements.find((e) => e.typeId === "And");
    expect(andEl4!.getProperties().getOrDefault<number>("inputCount", 2)).toBe(4);
    expect(andEl8!.getProperties().getOrDefault<number>("inputCount", 2)).toBe(8);
  });

  it("templateUnmodified", async () => {
    // After resolution, the original template circuit must be unchanged.
    const registry = makeRegistry(
      makeGenericCodeDef("GenericInitCode"),
      { ...AndDefinition, name: "And" },
    );

    const circuit = new Circuit({ isGeneric: true });

    const initProps = new PropertyBag();
    initProps.set("generic", "n:=3;");
    initProps.set("enabled", true);
    circuit.addElement(buildElement("GenericInitCode", initProps));

    const andProps = new PropertyBag();
    andProps.set("generic", "this.Inputs=args.n;");
    andProps.set("inputCount", 2);
    circuit.addElement(buildElement("And", andProps));

    const originalElementCount = circuit.elements.length;
    const originalAndInputCount = circuit.elements
      .find((e) => e.typeId === "And")!
      .getProperties()
      .getOrDefault<number>("inputCount", 2);

    await resolveGenericCircuit(circuit, new Map(), registry);

    expect(circuit.metadata.isGeneric).toBe(true);
    expect(circuit.elements).toHaveLength(originalElementCount);
    const andAfter = circuit.elements
      .find((e) => e.typeId === "And")!
      .getProperties()
      .getOrDefault<number>("inputCount", 2);
    expect(andAfter).toBe(originalAndInputCount);
  });

  it("perElementScript", async () => {
    // An element with a `generic` attribute script modifies that element's properties.
    // Uses external args to bypass needing a GenericInitCode.
    const registry = makeRegistry(
      { ...AndDefinition, name: "And" },
    );

    const circuit = new Circuit({ isGeneric: true });

    const andProps = new PropertyBag();
    andProps.set("generic", "this.Inputs=args.count;");
    andProps.set("inputCount", 2);
    circuit.addElement(buildElement("And", andProps));

    const externalArgs = new Map<string, HGSValue>([["count", 5n]]);
    const resolved = await resolveGenericCircuit(circuit, externalArgs, registry);

    const andEl = resolved.elements.find((e) => e.typeId === "And");
    expect(andEl).toBeDefined();
    expect(andEl!.getProperties().getOrDefault<number>("inputCount", 2)).toBe(5);
  });
});
