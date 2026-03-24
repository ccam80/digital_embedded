/**
 * Tests for ComponentPalette — tree structure, filtering, recent history,
 * and collapsed state.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ComponentPalette } from "../palette.js";
import { ComponentRegistry, ComponentCategory } from "@/core/registry";
import type { ComponentDefinition } from "@/core/registry";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRegistry(): ComponentRegistry {
  return new ComponentRegistry();
}

function stubDef(
  name: string,
  category: ComponentCategory,
): ComponentDefinition {
  return {
    name,
    typeId: -1,
    category,
    helpText: `${name} help`,
    propertyDefs: [],
    pinLayout: [],
    attributeMap: [],
    factory: (_props) => {
      throw new Error("not needed in palette tests");
    },
    executeFn: () => {},
  };
}

function registerDef(
  registry: ComponentRegistry,
  name: string,
  category: ComponentCategory,
): ComponentDefinition {
  const def = stubDef(name, category);
  registry.register(def);
  return registry.get(name)!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Palette", () => {
  let registry: ComponentRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it("treeGroupsByCategory", () => {
    registerDef(registry, "And", ComponentCategory.LOGIC);
    registerDef(registry, "Or", ComponentCategory.LOGIC);
    registerDef(registry, "In", ComponentCategory.IO);

    const palette = new ComponentPalette(registry);
    const tree = palette.getTree();

    expect(tree).toHaveLength(2);

    const logicNode = tree.find((n) => n.category === ComponentCategory.LOGIC);
    const ioNode = tree.find((n) => n.category === ComponentCategory.IO);

    expect(logicNode).toBeDefined();
    expect(logicNode!.children).toHaveLength(2);
    expect(logicNode!.children.map((d) => d.name)).toEqual(["And", "Or"]);

    expect(ioNode).toBeDefined();
    expect(ioNode!.children).toHaveLength(1);
    expect(ioNode!.children[0]!.name).toBe("In");
  });

  it("filterMatchesPartialName", () => {
    registerDef(registry, "And", ComponentCategory.LOGIC);
    registerDef(registry, "NAnd", ComponentCategory.LOGIC);
    registerDef(registry, "Or", ComponentCategory.LOGIC);

    const palette = new ComponentPalette(registry);
    const filtered = palette.filter("An");

    expect(filtered).toHaveLength(1);
    const logicNode = filtered[0]!;
    expect(logicNode.category).toBe(ComponentCategory.LOGIC);
    expect(logicNode.children.map((d) => d.name)).toContain("And");
    expect(logicNode.children.map((d) => d.name)).toContain("NAnd");
    expect(logicNode.children.map((d) => d.name)).not.toContain("Or");
  });

  it("filterIsCaseInsensitive", () => {
    registerDef(registry, "And", ComponentCategory.LOGIC);
    registerDef(registry, "Or", ComponentCategory.LOGIC);

    const palette = new ComponentPalette(registry);
    const filtered = palette.filter("and");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.children).toHaveLength(1);
    expect(filtered[0]!.children[0]!.name).toBe("And");
  });

  it("recentHistoryTracksLastTen", () => {
    // Register 12 unique component types
    for (let i = 0; i < 12; i++) {
      registerDef(registry, `Comp${i}`, ComponentCategory.LOGIC);
    }

    const palette = new ComponentPalette(registry);

    // Place all 12
    for (let i = 0; i < 12; i++) {
      palette.recordPlacement(`Comp${i}`);
    }

    const history = palette.getRecentHistory();
    expect(history).toHaveLength(10);

    // Most recent placements should be at the front
    expect(history[0]!.name).toBe("Comp11");
    expect(history[1]!.name).toBe("Comp10");
    expect(history[9]!.name).toBe("Comp2");
  });

  it("recentHistoryDeduplicates", () => {
    registerDef(registry, "And", ComponentCategory.LOGIC);
    registerDef(registry, "Or", ComponentCategory.LOGIC);

    const palette = new ComponentPalette(registry);

    palette.recordPlacement("And");
    palette.recordPlacement("Or");
    palette.recordPlacement("And"); // duplicate — should move to front

    const history = palette.getRecentHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.name).toBe("And");
    expect(history[1]!.name).toBe("Or");
  });

  it("collapseHidesPalette", () => {
    const palette = new ComponentPalette(registry);

    expect(palette.isCollapsed()).toBe(false);

    palette.setCollapsed(true);
    expect(palette.isCollapsed()).toBe(true);

    palette.setCollapsed(false);
    expect(palette.isCollapsed()).toBe(false);
  });
});
