/**
 * ComponentPalette — tree-based component palette logic.
 *
 * Manages the tree structure of components grouped by category,
 * search/filter state, recent placement history, and collapsed state.
 * Pure logic — no DOM dependencies.
 */

import type { ComponentDefinition } from "@/core/registry";
import { ComponentCategory, ComponentRegistry } from "@/core/registry";

// ---------------------------------------------------------------------------
// PaletteNode — one category tree node
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
};

/** All ComponentCategory values in display order. Used instead of Object.values() which doesn't work with const enums. */
const ALL_CATEGORIES: readonly ComponentCategory[] = [
  ComponentCategory.WIRING,
  ComponentCategory.IO,
  ComponentCategory.LOGIC,
  ComponentCategory.FLIP_FLOPS,
  ComponentCategory.ARITHMETIC,
  ComponentCategory.SWITCHING,
  ComponentCategory.MEMORY,
  ComponentCategory.PLD,
  ComponentCategory.MISC,
  ComponentCategory.GRAPHICS,
  ComponentCategory.TERMINAL,
  ComponentCategory.SEVENTY_FOUR_XX,
  ComponentCategory.SUBCIRCUIT,
];

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
  /** Recent placements — most recent first. Max 10 unique type names. */
  private readonly _recentHistory: string[] = [];
  private _collapsed = false;

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
  // Tree access
  // ---------------------------------------------------------------------------

  /**
   * Returns the full tree structure, one node per category that has at least
   * one registered component. Categories appear in the order defined by
   * ComponentCategory. Expanded state reflects toggleCategory() calls.
   */
  getTree(): PaletteNode[] {
    const nodes: PaletteNode[] = [];

    for (const category of ALL_CATEGORIES) {
      if (PALETTE_HIDDEN_CATEGORIES.has(category)) continue;
      const children = this._registry.getByCategory(category);
      if (children.length === 0) {
        continue;
      }
      nodes.push({
        category,
        label: CATEGORY_LABELS[category] ?? category,
        children: [...children],
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

    for (const category of ALL_CATEGORIES) {
      const cat = category as ComponentCategory;
      const all = this._registry.getByCategory(cat);
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
