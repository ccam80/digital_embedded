/**
 * Tests for ComponentPalette- config-driven groups, ordering, visibility,
 * persistence, recent history, displayName, and the dynamic subcircuit group.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ComponentPalette,
  buildDefaultPaletteConfig,
  type PaletteConfig,
  type PaletteConfigStore,
} from "../palette.js";
import { ComponentRegistry, ComponentCategory } from "@/core/registry";
import type { StandaloneComponentDefinition } from "@/core/registry";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRegistry(): ComponentRegistry {
  return new ComponentRegistry();
}

function stubDef(
  name: string,
  category: ComponentCategory,
  displayName?: string,
): StandaloneComponentDefinition {
  const base: StandaloneComponentDefinition = {
    name,
    typeId: -1,
    category,
    helpText: `${name} help`,
    propertyDefs: [],
    pinLayout: [],
    attributeMap: [],
    factory: () => {
      throw new Error("not needed in palette tests");
    },
    models: { digital: { executeFn: () => {} } },
  };
  return displayName !== undefined ? { ...base, displayName } : base;
}

function registerDef(
  registry: ComponentRegistry,
  name: string,
  category: ComponentCategory,
  displayName?: string,
): void {
  registry.register(stubDef(name, category, displayName));
}

/** In-memory PaletteConfigStore for persistence round-trip tests. */
class FakeStore implements PaletteConfigStore {
  saved: PaletteConfig | null = null;
  constructor(private readonly initial: PaletteConfig | null = null) {}
  load(): PaletteConfig | null {
    return this.saved ?? this.initial;
  }
  save(config: PaletteConfig): void {
    this.saved = JSON.parse(JSON.stringify(config)) as PaletteConfig;
  }
}

const findNode = (palette: ComponentPalette, id: string) =>
  palette.getTree().find((n) => n.id === id);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Palette", () => {
  let registry: ComponentRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it("groups components by category, with a Common group on top", () => {
    registerDef(registry, "And", ComponentCategory.LOGIC);
    registerDef(registry, "Or", ComponentCategory.LOGIC);
    registerDef(registry, "In", ComponentCategory.IO);

    const palette = new ComponentPalette(registry);
    const tree = palette.getTree();

    // Common Components (resolves "In"), then category groups in seed order
    // (I/O precedes Logic).
    expect(tree.map((n) => n.id)).toEqual(["common", ComponentCategory.IO, ComponentCategory.LOGIC]);

    const logicNode = findNode(palette, ComponentCategory.LOGIC)!;
    expect(logicNode.children.map((d) => d.name)).toEqual(["And", "Or"]);

    const ioNode = findNode(palette, ComponentCategory.IO)!;
    expect(ioNode.children.map((d) => d.name)).toEqual(["In"]);

    // "In" is curated into the Common group as well.
    const commonNode = findNode(palette, "common")!;
    expect(commonNode.children.map((d) => d.name)).toContain("In");
  });

  it("starts Common Components expanded and category groups collapsed", () => {
    registerDef(registry, "And", ComponentCategory.LOGIC);
    registerDef(registry, "In", ComponentCategory.IO);

    const palette = new ComponentPalette(registry);
    for (const node of palette.getTree()) {
      expect(node.expanded).toBe(node.id === "common");
    }
  });

  it("filters on displayName as well as name", () => {
    registerDef(registry, "In", ComponentCategory.IO, "Digital Input");
    registerDef(registry, "Out", ComponentCategory.IO, "Digital Output");
    registerDef(registry, "Clock", ComponentCategory.IO);

    const palette = new ComponentPalette(registry);

    const byDisplay = palette.filter("digital");
    const names = byDisplay.flatMap((n) => n.children.map((d) => d.name));
    expect(names).toContain("In");
    expect(names).toContain("Out");
    expect(names).not.toContain("Clock");

    // Still matches the registry name.
    const byName = palette.filter("clock");
    expect(byName.flatMap((n) => n.children.map((d) => d.name))).toEqual(["Clock"]);
  });

  it("hides a component from the tree when visibility is toggled off", () => {
    // PASSIVES is an analog category- every member seeds visible.
    registerDef(registry, "R1", ComponentCategory.PASSIVES);
    registerDef(registry, "R2", ComponentCategory.PASSIVES);

    const palette = new ComponentPalette(registry);
    expect(findNode(palette, ComponentCategory.PASSIVES)!.children.map((d) => d.name)).toEqual(["R1", "R2"]);

    palette.setItemVisible(ComponentCategory.PASSIVES, "R1", false);
    expect(findNode(palette, ComponentCategory.PASSIVES)!.children.map((d) => d.name)).toEqual(["R2"]);
  });

  it("reorders components within a group", () => {
    registerDef(registry, "R1", ComponentCategory.PASSIVES);
    registerDef(registry, "R2", ComponentCategory.PASSIVES);
    registerDef(registry, "R3", ComponentCategory.PASSIVES);

    const palette = new ComponentPalette(registry);
    // Drop R3 before R1.
    palette.moveItem(ComponentCategory.PASSIVES, "R3", "R1");

    expect(findNode(palette, ComponentCategory.PASSIVES)!.children.map((d) => d.name)).toEqual(["R3", "R1", "R2"]);
  });

  it("reorders groups", () => {
    registerDef(registry, "R1", ComponentCategory.PASSIVES);
    registerDef(registry, "A1", ComponentCategory.ACTIVE);

    const palette = new ComponentPalette(registry);
    const before = palette.getConfigGroups().map((g) => g.id);
    // Default seed order places ACTIVE ahead of PASSIVES.
    expect(before.indexOf(ComponentCategory.ACTIVE)).toBeLessThan(before.indexOf(ComponentCategory.PASSIVES));

    // Drop PASSIVES before ACTIVE.
    palette.moveGroup(ComponentCategory.PASSIVES, ComponentCategory.ACTIVE);
    const after = palette.getConfigGroups().map((g) => g.id);
    expect(after.indexOf(ComponentCategory.PASSIVES)).toBeLessThan(after.indexOf(ComponentCategory.ACTIVE));
  });

  it("persists config across instances via the store", () => {
    registerDef(registry, "R1", ComponentCategory.PASSIVES);
    registerDef(registry, "R2", ComponentCategory.PASSIVES);

    const store = new FakeStore();
    const palette1 = new ComponentPalette(registry, store);
    palette1.moveItem(ComponentCategory.PASSIVES, "R2", "R1");
    palette1.setItemVisible(ComponentCategory.PASSIVES, "R2", false);
    palette1.recordPlacement("R1");

    // A fresh instance backed by the same store restores the saved layout.
    const palette2 = new ComponentPalette(registry, store);
    expect(findNode(palette2, ComponentCategory.PASSIVES)!.children.map((d) => d.name)).toEqual(["R1"]);
    expect(palette2.getRecentHistory().map((d) => d.name)).toEqual(["R1"]);
  });

  it("resets to the factory-default layout but keeps recent history", () => {
    registerDef(registry, "R1", ComponentCategory.PASSIVES);
    registerDef(registry, "R2", ComponentCategory.PASSIVES);

    const palette = new ComponentPalette(registry);
    palette.moveItem(ComponentCategory.PASSIVES, "R2", "R1");
    palette.recordPlacement("R1");

    palette.resetToDefaults();
    expect(findNode(palette, ComponentCategory.PASSIVES)!.children.map((d) => d.name)).toEqual(["R1", "R2"]);
    expect(palette.getRecentHistory().map((d) => d.name)).toEqual(["R1"]);
  });

  it("reconciles newly-registered components into their category group", () => {
    registerDef(registry, "R1", ComponentCategory.PASSIVES);
    const store = new FakeStore();
    const palette1 = new ComponentPalette(registry, store);
    palette1.recordPlacement("R1"); // forces a save of the current config

    // A component registered after the config was saved must still appear.
    registerDef(registry, "R2", ComponentCategory.PASSIVES);
    const palette2 = new ComponentPalette(registry, store);
    expect(findNode(palette2, ComponentCategory.PASSIVES)!.children.map((d) => d.name)).toContain("R2");
  });

  // -------------------------------------------------------------------------
  // Recent history
  // -------------------------------------------------------------------------

  it("tracks the last ten placements, most recent first", () => {
    for (let i = 0; i < 12; i++) registerDef(registry, `Comp${i}`, ComponentCategory.LOGIC);
    const palette = new ComponentPalette(registry);

    for (let i = 0; i < 12; i++) palette.recordPlacement(`Comp${i}`);

    const history = palette.getRecentHistory();
    expect(history).toHaveLength(10);
    expect(history[0]!.name).toBe("Comp11");
    expect(history[9]!.name).toBe("Comp2");
  });

  it("deduplicates recent history, moving repeats to the front", () => {
    registerDef(registry, "And", ComponentCategory.LOGIC);
    registerDef(registry, "Or", ComponentCategory.LOGIC);
    const palette = new ComponentPalette(registry);

    palette.recordPlacement("And");
    palette.recordPlacement("Or");
    palette.recordPlacement("And");

    expect(palette.getRecentHistory().map((d) => d.name)).toEqual(["And", "Or"]);
  });

  // -------------------------------------------------------------------------
  // Allowlist (embed/tutorial override)
  // -------------------------------------------------------------------------

  it("limits the settings-modal set and the tree to the allowlist", () => {
    registerDef(registry, "R1", ComponentCategory.PASSIVES);
    registerDef(registry, "R2", ComponentCategory.PASSIVES);
    registerDef(registry, "A1", ComponentCategory.ACTIVE);

    const palette = new ComponentPalette(registry);
    palette.setAllowlist(["R1"]);

    // Modal view restricted to allowed components only.
    const groups = palette.getConfigGroups();
    const allNames = groups.flatMap((g) => g.items.map((i) => i.def.name));
    expect(allNames).toEqual(["R1"]);

    // Sidebar tree likewise.
    const treeNames = palette.getTree().flatMap((n) => n.children.map((d) => d.name));
    expect(treeNames).toEqual(["R1"]);

    // Clearing the allowlist restores the full set.
    palette.setAllowlist(null);
    expect(palette.getConfigGroups().flatMap((g) => g.items.map((i) => i.def.name))).toContain("A1");
  });

  // -------------------------------------------------------------------------
  // Panel collapse
  // -------------------------------------------------------------------------

  it("toggles whole-panel collapse independently of group state", () => {
    const palette = new ComponentPalette(registry);
    expect(palette.isCollapsed()).toBe(false);
    palette.setCollapsed(true);
    expect(palette.isCollapsed()).toBe(true);
    palette.setCollapsed(false);
    expect(palette.isCollapsed()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Dynamic subcircuit group
  // -------------------------------------------------------------------------

  it("shows the SUBCIRCUIT group dynamically once a subcircuit is registered", () => {
    const palette = new ComponentPalette(registry);
    expect(findNode(palette, ComponentCategory.SUBCIRCUIT)).toBeUndefined();

    registerDef(registry, "MyAdder", ComponentCategory.SUBCIRCUIT);
    palette.refreshCategories();

    const subNode = findNode(palette, ComponentCategory.SUBCIRCUIT);
    expect(subNode).toBeDefined();
    expect(subNode!.children.some((d) => d.name === "MyAdder")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Default config seed
  // -------------------------------------------------------------------------

  it("seeds the Common group first (expanded), category groups collapsed, nothing hidden", () => {
    registerDef(registry, "Resistor", ComponentCategory.PASSIVES);
    registerDef(registry, "Potentiometer", ComponentCategory.PASSIVES);
    const config = buildDefaultPaletteConfig(registry);

    const common = config.groups[0]!;
    expect(common.id).toBe("common");
    expect(common.collapsed).toBe(false);
    expect(common.items.map((i) => i.name)).toContain("Resistor");

    // Category groups are collapsed; every seeded item is visible.
    const passives = config.groups.find((g) => g.id === ComponentCategory.PASSIVES)!;
    expect(passives.collapsed).toBe(true);
    expect(config.groups.slice(1).every((g) => g.collapsed)).toBe(true);
    expect(config.groups.flatMap((g) => g.items).every((i) => i.visible)).toBe(true);
  });
});
