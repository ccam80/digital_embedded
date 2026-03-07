/**
 * Tests for subcircuit-loader.ts — Recursive .dig loading with cycle detection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadWithSubcircuits,
  clearSubcircuitCache,
  subcircuitCacheSize,
  SubcircuitHolderElement,
} from "../subcircuit-loader.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import { EmbeddedResolver } from "../file-resolver.js";
import type { FileResolver } from "../file-resolver.js";

// ---------------------------------------------------------------------------
// Minimal element for built-in registry entries
// ---------------------------------------------------------------------------

class StubElement extends AbstractCircuitElement {
  getPins(): readonly Pin[] { return []; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
  getHelpText(): string { return "stub"; }
}

function stubDef(name: string): ComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (props) => new StubElement(name, crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props),
    executeFn: () => {},
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
// Setup: clear cache before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearSubcircuitCache();
});

// ---------------------------------------------------------------------------
// recursiveLoad
// ---------------------------------------------------------------------------

describe("subcircuit-loader", () => {
  it("recursiveLoad — main .dig references sub .dig, resolver returns both, verify both loaded and registered", async () => {
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

    // SubA should now be registered in the registry
    const subADef = registry.get("SubA");
    expect(subADef).toBeDefined();
    expect(subADef!.name).toBe("SubA");

    // The SubA element in the circuit should be a SubcircuitHolderElement
    const subAEl = circuit.elements.find((el) => el.typeId === "SubA");
    expect(subAEl).toBeInstanceOf(SubcircuitHolderElement);

    // The holder has the loaded subcircuit definition
    const holder = subAEl as SubcircuitHolderElement;
    expect(holder.subcircuitDefinition).toBeDefined();
    expect(holder.subcircuitDefinition.elements).toHaveLength(3); // In, And, Out
  });

  // ---------------------------------------------------------------------------
  // circularDetection
  // ---------------------------------------------------------------------------

  it("circularDetection — A references B, B references A → throws with cycle message", async () => {
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

    // Load A as the root — it references B which references A (cycle)
    await expect(loadWithSubcircuits(aXml, resolver, registry)).rejects.toThrow(
      /Circular subcircuit reference/,
    );

    // Error message should contain both A and B
    try {
      clearSubcircuitCache();
      // Re-register since registry may be partially mutated
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

  it("depthLimit — chain of 31 nested subcircuits → throws depth limit error", async () => {
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

  it("cacheReuse — two instances of same subcircuit, resolver called only once", async () => {
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

  it("clearCache — load subcircuit, clear cache, load again, resolver called twice", async () => {
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
    expect(subcircuitCacheSize()).toBe(1);

    // Clear the module-level subcircuit cache
    clearSubcircuitCache();
    expect(subcircuitCacheSize()).toBe(0);

    // Second load (new registry — need a fresh registry since SubA is already in registry1)
    const registry2 = new ComponentRegistry();
    registry2.register(stubDef("In"));
    registry2.register(stubDef("Out"));

    await loadWithSubcircuits(mainXml, resolver, registry2);
    // Resolver should have been called again (cache was cleared)
    expect(resolveFn).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // No subcircuits — circuit with only built-in elements loads normally
  // ---------------------------------------------------------------------------

  it("noSubcircuits — circuit with only built-in elements loads without using resolver", async () => {
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

  it("nestedLoad — A references B which references C (all within depth limit)", async () => {
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

    // B and C should both be registered
    expect(registry.get("B")).toBeDefined();
    expect(registry.get("C")).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // SubcircuitHolderElement executeFn is no-op
  // ---------------------------------------------------------------------------

  it("subcircuitExecuteFnNoOp — registered subcircuit execute function does not throw", async () => {
    const mainXml = makeDigXml(["In", "SubA"]);
    const subAXml = makeDigXml(["In", "Out"]);

    const resolver = new EmbeddedResolver(new Map([["SubA", subAXml]]));
    const registry = new ComponentRegistry();
    registry.register(stubDef("In"));
    registry.register(stubDef("Out"));

    await loadWithSubcircuits(mainXml, resolver, registry);

    const subADef = registry.get("SubA");
    expect(subADef).toBeDefined();

    // executeFn should be callable without throwing
    const mockState = new Uint32Array(10);
    const mockLayout = {
      inputCount: () => 0,
      inputOffset: () => 0,
      outputCount: () => 0,
      outputOffset: () => 0,
      stateOffset: () => 0,
    };
    expect(() => subADef!.executeFn(0, mockState, new Uint32Array(mockState.length), mockLayout)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SubcircuitHolderElement direct tests
// ---------------------------------------------------------------------------

import { Circuit } from "../../core/circuit.js";

describe("SubcircuitHolderElement", () => {
  it("stores subcircuit definition", () => {
    const def = new Circuit();
    const element = new SubcircuitHolderElement("TestSub", def, new PropertyBag());

    expect(element.subcircuitDefinition).toBe(def);
    expect(element.typeId).toBe("TestSub");
    expect(element.getPins()).toHaveLength(0);
    expect(element.getHelpText()).toContain("TestSub");
  });

  it("getBoundingBox returns position-based rect", () => {
    const def = new Circuit();
    const element = new SubcircuitHolderElement("Sub", def, new PropertyBag());
    element.position = { x: 10, y: 20 };

    const bb = element.getBoundingBox();
    expect(bb.x).toBe(10);
    expect(bb.y).toBe(20);
  });

  it("draw is a no-op (does not throw)", () => {
    const def = new Circuit();
    const element = new SubcircuitHolderElement("Sub", def, new PropertyBag());
    expect(() => element.draw({} as RenderContext)).not.toThrow();
  });
});
