/**
 * ComponentPalette- tree-based component palette logic.
 *
 * Manages the tree structure of components grouped by category,
 * search/filter state, recent placement history, and collapsed state.
 * Pure logic- no DOM dependencies.
 */

import type { ComponentDefinition } from "@/core/registry";
import { ComponentCategory, ComponentRegistry } from "@/core/registry";
import { buildSubcircuitComponentDef } from "../components/subcircuit/subcircuit.js";

// ---------------------------------------------------------------------------
// PaletteNode- one category tree node
// ---------------------------------------------------------------------------

export interface PaletteNode {
  category: ComponentCategory;
  label: string;
  children: ComponentDefinition[];
  expanded: boolean;
}

// ---------------------------------------------------------------------------
// Human-readable labels for each category
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<ComponentCategory, string> = {
  [ComponentCategory.LOGIC]: "Logic",
  [ComponentCategory.IO]: "I/O",
  [ComponentCategory.FLIP_FLOPS]: "Flip-Flops",
  [ComponentCategory.MEMORY]: "Memory",
  [ComponentCategory.ARITHMETIC]: "Arithmetic",
  [ComponentCategory.WIRING]: "Wiring",
  [ComponentCategory.SWITCHING]: "Switching",
  [ComponentCategory.PLD]: "PLD",
  [ComponentCategory.MISC]: "Miscellaneous",
  [ComponentCategory.GRAPHICS]: "Graphics",
  [ComponentCategory.TERMINAL]: "Terminal",
  [ComponentCategory.SEVENTY_FOUR_XX]: "74xx",
  [ComponentCategory.SUBCIRCUIT]: "Subcircuits",
  [ComponentCategory.PASSIVES]: "Passives",
  [ComponentCategory.SEMICONDUCTORS]: "Semiconductors",
  [ComponentCategory.SOURCES]: "Sources",
  [ComponentCategory.ACTIVE]: "Active",
};

/** Category order- analog categories promoted for unified palette. */
const CATEGORIES_ANALOG: readonly ComponentCategory[] = [
  ComponentCategory.PASSIVES,
  ComponentCategory.SEMICONDUCTORS,
  ComponentCategory.SOURCES,
  ComponentCategory.ACTIVE,
  ComponentCategory.IO,
  ComponentCategory.WIRING,
  ComponentCategory.LOGIC,
  ComponentCategory.SWITCHING,
  ComponentCategory.FLIP_FLOPS,
  ComponentCategory.MEMORY,
  ComponentCategory.ARITHMETIC,
  ComponentCategory.PLD,
  ComponentCategory.MISC,
  ComponentCategory.GRAPHICS,
  ComponentCategory.TERMINAL,
  ComponentCategory.SEVENTY_FOUR_XX,
  ComponentCategory.SUBCIRCUIT,
];

/** All categories for initialization. */
const ALL_CATEGORIES = CATEGORIES_ANALOG;

/**
 * Default palette inclusion set per category. When no allowlist is active,
 * only these components are shown, in the order listed here. Categories
 * not listed fall through to PALETTE_HIDDEN_CATEGORIES for visibility.
 */
const PALETTE_DEFAULT_COMPONENTS: ReadonlyMap<ComponentCategory, readonly string[]> = new Map([
  [ComponentCategory.IO, ["In", "Out", "Clock", "Const", "Ground", "VDD"]],
  [ComponentCategory.WIRING, ["Tunnel", "Driver", "Splitter", "Multiplexer", "Demultiplexer"]],
  [ComponentCategory.LOGIC, ["And", "Or", "Not", "NAnd", "NOr", "XOr", "XNOr"]],
  [ComponentCategory.SWITCHING, ["NFET", "PFET", "Switch", "SwitchDT"]],
  [ComponentCategory.FLIP_FLOPS, ["D_FF", "JK_FF", "RS_FF", "T_FF", "D_FF_AS", "JK_FF_AS", "RS_FF_AS"]],
  [ComponentCategory.MEMORY, ["Counter", "CounterPreset", "Register", "RegisterFile", "ROM", "EEPROM", "LookUpTable", "RAMSinglePort"]],
  // No defaults for analog categories- show all registered components.
]);

const MAX_RECENT_HISTORY = 10;

// ---------------------------------------------------------------------------
// ComponentPalette
// ---------------------------------------------------------------------------

/**
 * Palette state: tree of categories, search filter, recent history, and
 * collapsed flag for iframe-embedded mode.
 */
/** Categories hidden from the sidebar palette (available via Insert menu). */
const PALETTE_HIDDEN_CATEGORIES: ReadonlySet<ComponentCategory> = new Set([
  ComponentCategory.ARITHMETIC,
  ComponentCategory.GRAPHICS,
  ComponentCategory.TERMINAL,
  ComponentCategory.PLD,
  ComponentCategory.SEVENTY_FOUR_XX,
  ComponentCategory.MISC,
  ComponentCategory.SUBCIRCUIT,
]);

export class ComponentPalette {
  private readonly _registry: ComponentRegistry;
  /** Per-category expanded state. True = expanded (showing children). */
  private readonly _expandedCategories: Map<ComponentCategory, boolean> = new Map();
  /** Recent placements- most recent first. Max 10 unique type names. */
  private readonly _recentHistory: string[] = [];
  private _collapsed = false;
  /**
   * When non-null, only component types whose names are in this set appear
   * in the palette. Null means show everything (default behavior).
   */
  private _allowlist: Set<string> | null = null;
  /**
   * Categories that are normally hidden but should be force-shown when they
   * have registered components. Populated by refreshCategories().
   */
  private readonly _forceVisibleCategories: Set<ComponentCategory> = new Set();
  /** Active circuit for reading circuit-scoped subcircuit definitions. */
  private _activeCircuit: import("../core/circuit.js").Circuit | null = null;

  constructor(registry: ComponentRegistry) {
    this._registry = registry;

    // All categories start expanded.
    for (const category of ALL_CATEGORIES) {
      this._expandedCategories.set(category as ComponentCategory, true);
    }
  }

  /** Returns the underlying registry for Insert menu building. */
  getRegistry(): ComponentRegistry {
    return this._registry;
  }

  // ---------------------------------------------------------------------------
  // Allowlist (palette override)
  // ---------------------------------------------------------------------------

  /**
   * Set an allowlist of component type names. When set, only these types
   * appear in the palette tree and search results. Pass null to clear.
   */
  setAllowlist(typeNames: string[] | null): void {
    this._allowlist = typeNames !== null ? new Set(typeNames) : null;
  }

  /**
   * Returns the current allowlist as an array of type names, or null if
   * no override is active (all components shown).
   */
  getAllowlist(): string[] | null {
    return this._allowlist !== null ? Array.from(this._allowlist) : null;
  }

  /** Apply the allowlist filter to a list of component definitions. */
  private _applyAllowlist(defs: ComponentDefinition[]): ComponentDefinition[] {
    if (this._allowlist === null) return defs;
    return defs.filter((d) => this._allowlist!.has(d.name));
  }

  // ---------------------------------------------------------------------------
  // Tree access
  // ---------------------------------------------------------------------------

  /**
   * Returns the full tree structure, one node per category that has at least
   * one registered component. Categories appear in the order defined by
   * ComponentCategory. Expanded state reflects toggleCategory() calls.
   */
  getTree(): PaletteNode[] {
    const nodes: PaletteNode[] = [];

    for (const category of CATEGORIES_ANALOG) {
      // When an allowlist is active, show all categories that have matching
      // components- don't hide the default-hidden categories since the
      // allowlist is the explicit override.
      if (this._allowlist === null && PALETTE_HIDDEN_CATEGORIES.has(category) && !this._forceVisibleCategories.has(category)) continue;
      let all = this._registry.getByCategory(category);
      // Merge circuit-scoped subcircuit definitions into the SUBCIRCUIT category
      if (category === ComponentCategory.SUBCIRCUIT) {
        const circuitDefs = this._getCircuitScopedSubcircuits();
        if (circuitDefs.length > 0) {
          const registryNames = new Set(all.map(d => d.name));
          const merged = [...all];
          for (const def of circuitDefs) {
            if (!registryNames.has(def.name)) merged.push(def);
          }
          all = merged;
        }
      }
      let children: ComponentDefinition[];
      if (this._allowlist !== null) {
        children = this._applyAllowlist(all);
      } else {
        // Apply default inclusion set with ordering
        const defaults = PALETTE_DEFAULT_COMPONENTS.get(category);
        if (defaults !== undefined) {
          const byName = new Map(all.map(d => [d.name, d]));
          children = [];
          for (const name of defaults) {
            const def = byName.get(name);
            if (def) children.push(def);
          }
        } else {
          children = [...all];
        }
      }
      if (children.length === 0) {
        continue;
      }
      nodes.push({
        category,
        label: CATEGORY_LABELS[category] ?? category,
        children,
        expanded: this._expandedCategories.get(category) ?? true,
      });
    }

    return nodes;
  }

  /**
   * Returns a filtered tree. Only components whose names contain the query
   * (case-insensitive) are included. Categories with at least one match are
   * auto-expanded; categories with no matches are omitted entirely.
   *
   * When query is empty, returns the same result as getTree().
   */
  filter(query: string): PaletteNode[] {
    if (query === "") {
      return this.getTree();
    }

    const lowerQuery = query.toLowerCase();
    const nodes: PaletteNode[] = [];

    for (const category of CATEGORIES_ANALOG) {
      const cat = category as ComponentCategory;
      let registryDefs = this._registry.getByCategory(cat);
      if (cat === ComponentCategory.SUBCIRCUIT) {
        const circuitDefs = this._getCircuitScopedSubcircuits();
        if (circuitDefs.length > 0) {
          const registryNames = new Set(registryDefs.map(d => d.name));
          const merged = [...registryDefs];
          for (const def of circuitDefs) {
            if (!registryNames.has(def.name)) merged.push(def);
          }
          registryDefs = merged;
        }
      }
      const all = this._applyAllowlist(registryDefs);
      const matched = all.filter((def) =>
        def.name.toLowerCase().includes(lowerQuery),
      );
      if (matched.length === 0) {
        continue;
      }
      nodes.push({
        category: cat,
        label: CATEGORY_LABELS[cat] ?? cat,
        children: matched,
        expanded: true,
      });
    }

    return nodes;
  }

  // ---------------------------------------------------------------------------
  // Recent history
  // ---------------------------------------------------------------------------

  /**
   * Record that a component of the given type name was placed.
   * Moves existing entry to front if already present. Trims to last 10.
   */
  recordPlacement(typeName: string): void {
    const existing = this._recentHistory.indexOf(typeName);
    if (existing !== -1) {
      this._recentHistory.splice(existing, 1);
    }
    this._recentHistory.unshift(typeName);
    if (this._recentHistory.length > MAX_RECENT_HISTORY) {
      this._recentHistory.length = MAX_RECENT_HISTORY;
    }
  }

  /**
   * Returns the last 10 uniquely placed component types, most recent first.
   * Types that are no longer registered are omitted.
   */
  getRecentHistory(): ComponentDefinition[] {
    const result: ComponentDefinition[] = [];
    for (const name of this._recentHistory) {
      const def = this._registry.get(name);
      if (def !== undefined) {
        result.push(def);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Category expand/collapse
  // ---------------------------------------------------------------------------

  /**
   * Toggle expanded state for a single category.
   */
  toggleCategory(category: ComponentCategory): void {
    const current = this._expandedCategories.get(category) ?? true;
    this._expandedCategories.set(category, !current);
  }

  // ---------------------------------------------------------------------------
  // Category refresh
  // ---------------------------------------------------------------------------

  /**
   * Re-reads the SUBCIRCUIT category from the registry and updates palette
   * visibility. When subcircuits are registered, makes the SUBCIRCUIT category
   * visible even though it is in PALETTE_HIDDEN_CATEGORIES by default.
   *
   * Called after a subcircuit is created or deleted so the category tree picks
   * up the change on the next getTree() call.
   */
  /**
   * Set the active circuit so the palette can read circuit-scoped subcircuit
   * definitions. Call when the active circuit changes (load, new, etc.).
   */
  setActiveCircuit(circuit: import("../core/circuit.js").Circuit | null): void {
    this._activeCircuit = circuit;
  }

  /**
   * Build ComponentDefinition array for circuit-scoped subcircuits.
   */
  private _getCircuitScopedSubcircuits(): ComponentDefinition[] {
    if (!this._activeCircuit?.metadata.subcircuits?.size) return [];
    const defs: ComponentDefinition[] = [];
    for (const [name, subDef] of this._activeCircuit.metadata.subcircuits) {
      defs.push(buildSubcircuitComponentDef(name, subDef));
    }
    return defs;
  }

  refreshCategories(): void {
    const registrySubcircuits = this._registry.getByCategory(ComponentCategory.SUBCIRCUIT);
    const circuitSubcircuits = this._getCircuitScopedSubcircuits();
    const hasSubcircuits = registrySubcircuits.length > 0 || circuitSubcircuits.length > 0;
    if (hasSubcircuits) {
      this._forceVisibleCategories.add(ComponentCategory.SUBCIRCUIT);
      if (!this._expandedCategories.has(ComponentCategory.SUBCIRCUIT)) {
        this._expandedCategories.set(ComponentCategory.SUBCIRCUIT, true);
      }
    } else {
      this._forceVisibleCategories.delete(ComponentCategory.SUBCIRCUIT);
    }
  }

  // ---------------------------------------------------------------------------
  // Panel collapse (iframe-embedded mode)
  // ---------------------------------------------------------------------------

  /**
   * Show or hide the entire palette panel.
   */
  setCollapsed(collapsed: boolean): void {
    this._collapsed = collapsed;
  }

  /**
   * Returns true when the palette panel is hidden.
   */
  isCollapsed(): boolean {
    return this._collapsed;
  }
}
