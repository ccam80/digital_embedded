/**
 * Tests for subcircuit-loader.ts- Recursive .dig loading with cycle detection.
 */

import { describe, it, expect, vi } from "vitest";
import {
  loadWithSubcircuits,
} from "../subcircuit-loader.js";
import { SubcircuitElement } from "../../components/subcircuit/subcircuit.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { EmbeddedResolver } from "../file-resolver.js";
import type { FileResolver } from "../file-resolver.js";
import { TestElement } from "../../test-fixtures/test-element.js";
import { noopExecFn } from "../../test-fixtures/execute-stubs.js";

function stubDef(name: string): ComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (props) => new TestElement(name, crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    models: { digital: { executeFn: noopExecFn } },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: name,
  };
}

// ---------------------------------------------------------------------------
// .dig XML helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid .dig XML string with the given element names placed at
 * fixed positions. All elements use no attributes.
 */
function makeDigXml(elementNames: string[]): string {
  const elements = elementNames
    .map(
      (name, i) =>
        `    <visualElement>
      <elementName>${name}</elementName>
      <elementAttributes/>
      <pos x="${i * 100}" y="0"/>
    </visualElement>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements>
${elements}
  </visualElements>
  <wires/>
</circuit>`;
}

// ---------------------------------------------------------------------------
// recursiveLoad
// ---------------------------------------------------------------------------

describe("subcircuit-loader", () => {
  it("recursiveLoad- main .dig references sub .dig, resolver returns both, verify both loaded and registered", async () => {
    // Main circuit uses In, Out (built-in), and SubA (subcircuit)
    const mainXml = makeDigXml(["In", "Out", "SubA"]);
    // SubA contains only built-in elements
    const subAXml = makeDigXml(["In", "And", "Out"]);

    const resolver = new EmbeddedResolver(new Map([["SubA", subAXml]]));

    const registry = new ComponentRegistry();
    registry.register(stubDef("In"));
    registry.register(stubDef("Out"));
    registry.register(stubDef("And"));

    const circuit = await loadWithSubcircuits(mainXml, resolver, registry);

    // Main circuit should have 3 elements: In, Out, SubA-instance
    expect(circuit.elements).toHaveLength(3);

    // SubA should be in circuit-scoped subcircuit metadata (not global registry)
    expect(circuit.metadata.subcircuits).toBeDefined();
    const subADef = circuit.metadata.subcircuits!.get("SubA");
    expect(subADef).toBeDefined();
    expect(subADef!.name).toBe("SubA");

    // The SubA element in the circuit should be a SubcircuitElement
    const subAEl = circuit.elements.find((el) => el.typeId === "SubA");
    expect(subAEl).toBeInstanceOf(SubcircuitElement);

    // The element has the loaded subcircuit definition
    const subEl = subAEl as SubcircuitElement;
    expect(subEl.definition.circuit.elements).toHaveLength(3); // In, And, Out
  });

  // ---------------------------------------------------------------------------
  // circularDetection
  // ---------------------------------------------------------------------------

  it("circularDetection- A references B, B references A → throws with cycle message", async () => {
    const aXml = makeDigXml(["In", "B"]);
    const bXml = makeDigXml(["In", "A"]);

    const resolver = new EmbeddedResolver(
      new Map([
        ["A", aXml],
        ["B", bXml],
      ]),
    );

    const registry = new ComponentRegistry();
    registry.register(stubDef("In"));

    // Load A as the root- it references B which references A (cycle)
    await expect(loadWithSubcircuits(aXml, resolver, registry)).rejects.toThrow(
      /Circular subcircuit reference/,
    );

    // Error message should contain both A and B
    try {
      // Fresh registry- no cache to clear, each load is independent
      const reg2 = new ComponentRegistry();
      reg2.register(stubDef("In"));
      await loadWithSubcircuits(aXml, resolver, reg2);
    } catch (e) {
      expect((e as Error).message).toContain("A");
      expect((e as Error).message).toContain("B");
    }
  });

  // ---------------------------------------------------------------------------
  // depthLimit
  // ---------------------------------------------------------------------------

  it("depthLimit- chain of 31 nested subcircuits → throws depth limit error", async () => {
    // Create a chain: Level0 → Level1 → ... → Level30 → Level31 (31 levels deep)
    const resolver: FileResolver = {
      resolve: async (name: string) => {
        const num = parseInt(name.replace("Level", ""), 10);
        if (num >= 30) {
          // Level30 references Level31, which will push depth beyond 30
          return makeDigXml([`Level${num + 1}`]);
        }
        return makeDigXml([`Level${num + 1}`]);
      },
    };

    const registry = new ComponentRegistry();

    // Root is Level0 which starts the chain
    const rootXml = makeDigXml(["Level0"]);

    await expect(loadWithSubcircuits(rootXml, resolver, registry)).rejects.toThrow(
      /depth limit/i,
    );
  });

  // ---------------------------------------------------------------------------
  // cacheReuse
  // ---------------------------------------------------------------------------

  it("cacheReuse- two instances of same subcircuit, resolver called only once", async () => {
    // Main circuit has two SubA instances
    const mainXml = makeDigXml(["In", "SubA", "SubA", "Out"]);
    const subAXml = makeDigXml(["In", "Out"]);

    const resolveFn = vi.fn().mockResolvedValue(subAXml);
    const resolver: FileResolver = { resolve: resolveFn };

    const registry = new ComponentRegistry();
    registry.register(stubDef("In"));
    registry.register(stubDef("Out"));

    await loadWithSubcircuits(mainXml, resolver, registry);

    // Even though SubA appears twice in the circuit, resolver should be called once
    expect(resolveFn).toHaveBeenCalledTimes(1);
    expect(resolveFn).toHaveBeenCalledWith("SubA");
  });

  // ---------------------------------------------------------------------------
  // clearCache
  // ---------------------------------------------------------------------------

  it("separateLoads- each loadWithSubcircuits call re-resolves independently", async () => {
    const mainXml = makeDigXml(["In", "SubA", "Out"]);
    const subAXml = makeDigXml(["In", "Out"]);

    const resolveFn = vi.fn().mockResolvedValue(subAXml);
    const resolver: FileResolver = { resolve: resolveFn };

    const registry1 = new ComponentRegistry();
    registry1.register(stubDef("In"));
    registry1.register(stubDef("Out"));

    // First load
    await loadWithSubcircuits(mainXml, resolver, registry1);
    expect(resolveFn).toHaveBeenCalledTimes(1);

    // Second load (fresh registry- each call is independent, no shared cache)
    const registry2 = new ComponentRegistry();
    registry2.register(stubDef("In"));
    registry2.register(stubDef("Out"));

    await loadWithSubcircuits(mainXml, resolver, registry2);
    // Resolver called again- no module-level cache shared between calls
    expect(resolveFn).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // No subcircuits- circuit with only built-in elements loads normally
  // ---------------------------------------------------------------------------

  it("noSubcircuits- circuit with only built-in elements loads without using resolver", async () => {
    const xml = makeDigXml(["In", "And", "Out"]);

    const resolveFn = vi.fn();
    const resolver: FileResolver = { resolve: resolveFn };

    const registry = new ComponentRegistry();
    registry.register(stubDef("In"));
    registry.register(stubDef("And"));
    registry.register(stubDef("Out"));

    const circuit = await loadWithSubcircuits(xml, resolver, registry);

    expect(circuit.elements).toHaveLength(3);
    expect(resolveFn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Multi-level nesting within depth limit
  // ---------------------------------------------------------------------------

  it("nestedLoad- A references B which references C (all within depth limit)", async () => {
    const aXml = makeDigXml(["In", "B", "Out"]);
    const bXml = makeDigXml(["In", "C", "Out"]);
    const cXml = makeDigXml(["In", "And", "Out"]);

    const resolver = new EmbeddedResolver(
      new Map([
        ["B", bXml],
        ["C", cXml],
      ]),
    );

    const registry = new ComponentRegistry();
    registry.register(stubDef("In"));
    registry.register(stubDef("Out"));
    registry.register(stubDef("And"));

    const circuit = await loadWithSubcircuits(aXml, resolver, registry);

    // A has 3 elements: In, B (subcircuit), Out
    expect(circuit.elements).toHaveLength(3);

    // B and C should both be in circuit-scoped subcircuit metadata
    expect(circuit.metadata.subcircuits).toBeDefined();
    expect(circuit.metadata.subcircuits!.has("B")).toBe(true);
    expect(circuit.metadata.subcircuits!.has("C")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // SubcircuitElement executeFn is no-op
  // ---------------------------------------------------------------------------

  it("subcircuitExecuteFnNoOp- circuit-scoped subcircuit execute function does not throw", async () => {
    const mainXml = makeDigXml(["In", "SubA"]);
    const subAXml = makeDigXml(["In", "Out"]);

    const resolver = new EmbeddedResolver(new Map([["SubA", subAXml]]));
    const registry = new ComponentRegistry();
    registry.register(stubDef("In"));
    registry.register(stubDef("Out"));

    const circuit = await loadWithSubcircuits(mainXml, resolver, registry);

    // SubA should be in circuit-scoped metadata
    expect(circuit.metadata.subcircuits).toBeDefined();
    const subASubDef = circuit.metadata.subcircuits!.get("SubA");
    expect(subASubDef).toBeDefined();

    // Build a ComponentDefinition from the SubcircuitDefinition
    const { buildSubcircuitComponentDef } = await import("../../components/subcircuit/subcircuit.js");
    const subADef = buildSubcircuitComponentDef("SubA", subASubDef!);

    // executeFn should be callable without throwing
    const mockState = new Uint32Array(10);
    const mockLayout = {
      wiringTable: new Int32Array(64).map((_, i) => i),
      inputCount: () => 0,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 0,
      stateOffset: () => 0,
      getProperty: () => undefined,
    };
    expect(() => subADef.models!.digital!.executeFn(0, mockState, new Uint32Array(mockState.length), mockLayout)).not.toThrow();
  });
});
