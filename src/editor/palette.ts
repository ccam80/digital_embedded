/**
 * ComponentPalette- config-driven component palette logic.
 *
 * The palette is an ordered list of groups. A group is either a `category`
 * group backed by a `ComponentCategory`, or a `custom` group (e.g. "Common
 * Components") that curates components by name across categories. Each group
 * holds an ordered, individually-show/hide-able list of component names, plus a
 * collapsed flag. A persisted `recent` list of the last 10 placed components is
 * pinned above the groups by the UI.
 *
 * All of this lives in a `PaletteConfig` persisted through an injected
 * `PaletteConfigStore` (localStorage in the app, absent in tests). On every
 * read the stored config is reconciled against the live registry so components
 * registered after the config was saved (lazy 74xx, new code) appear in their
 * category group, and components that no longer resolve are skipped at render.
 *
 * Pure logic- no DOM dependencies.
 */

import type { StandaloneComponentDefinition } from "@/core/registry";
import { ComponentCategory, displayNameOf } from "@/core/registry";
import type { ComponentRegistry } from "@/core/registry";
import type { Circuit } from "../core/circuit.js";
import { buildSubcircuitComponentDef } from "../components/subcircuit/subcircuit.js";

// ---------------------------------------------------------------------------
// Persisted config shapes
// ---------------------------------------------------------------------------

/** One component entry within a group: its registry name + visibility. */
export interface PaletteItemConfig {
  name: string;
  visible: boolean;
}

/** One palette group: category-backed or a curated custom group. */
export interface PaletteGroupConfig {
  /** Stable id. For category groups this is the category enum value; the
   *  Common group uses `"common"`. */
  id: string;
  /** Editable display label. */
  label: string;
  kind: "category" | "custom";
  /** Backing category when `kind === "category"`; drives reconcile. */
  category?: ComponentCategory;
  collapsed: boolean;
  items: PaletteItemConfig[];
}

/** Full persisted palette configuration. */
export interface PaletteConfig {
  version: number;
  groups: PaletteGroupConfig[];
  /** Component names, most-recent-first, max {@link MAX_RECENT_HISTORY}. */
  recent: string[];
}

/** Persistence boundary. The app backs this with AppSettings/localStorage;
 *  tests pass nothing and the palette runs in-memory from the seeded default. */
export interface PaletteConfigStore {
  load(): PaletteConfig | null;
  save(config: PaletteConfig): void;
}

export const PALETTE_CONFIG_VERSION = 1;
const COMMON_GROUP_ID = "common";
const MAX_RECENT_HISTORY = 10;

// ---------------------------------------------------------------------------
// PaletteNode- one rendered group node (sidebar view)
// ---------------------------------------------------------------------------

export interface PaletteNode {
  /** Group id (category enum value, `"common"`, or `SUBCIRCUIT`). */
  id: string;
  /** Backing category, when this node is a category group. */
  category?: ComponentCategory;
  label: string;
  /** Resolved, available, visible component definitions in configured order. */
  children: StandaloneComponentDefinition[];
  /** True when the group is expanded (children list shown). */
  expanded: boolean;
}

// ---------------------------------------------------------------------------
// Editable group view (settings modal)
// ---------------------------------------------------------------------------

export interface PaletteItemView {
  def: StandaloneComponentDefinition;
  visible: boolean;
}

export interface PaletteGroupView {
  id: string;
  label: string;
  kind: "category" | "custom";
  collapsed: boolean;
  /** Every resolved, available item (visible and hidden) in configured order. */
  items: PaletteItemView[];
}

// ---------------------------------------------------------------------------
// Default-layout seed inputs
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

/**
 * Seed group order. The leading run is the explicitly-requested default order;
 * the remaining categories follow so nothing is hidden- the user can reorder or
 * hide any of them in the settings modal. SUBCIRCUIT is excluded: it is a
 * dynamic group sourced live from the active circuit and appended last by
 * getTree().
 */
const SEED_CATEGORY_ORDER: readonly ComponentCategory[] = [
  ComponentCategory.SOURCES,
  ComponentCategory.IO,
  ComponentCategory.WIRING,
  ComponentCategory.SEMICONDUCTORS,
  ComponentCategory.ACTIVE,
  ComponentCategory.SWITCHING,
  ComponentCategory.LOGIC,
  ComponentCategory.FLIP_FLOPS,
  ComponentCategory.MEMORY,
  ComponentCategory.PASSIVES,
  ComponentCategory.ARITHMETIC,
  ComponentCategory.PLD,
  ComponentCategory.GRAPHICS,
  ComponentCategory.TERMINAL,
  ComponentCategory.SEVENTY_FOUR_XX,
  ComponentCategory.MISC,
];

/**
 * "Common Components" curated group seeded at the top of the default layout.
 * References primitives by registry name across several categories.
 */
const COMMON_COMPONENT_NAMES: readonly string[] = [
  "Resistor", "Inductor", "Capacitor", "Diode",
  "DcVoltageSource", "AcVoltageSource", "DcCurrentSource", "AcCurrentSource",
  "In", "Out", "Tunnel",
];

/**
 * Per-category preferred ordering: these names are seeded first (in this order),
 * then the category's remaining components in registration order. Affects the
 * default layout only- never visibility (every component seeds visible) and
 * never the live render path. Categories absent here seed in registration order.
 */
const SEED_CURATED_COMPONENTS: ReadonlyMap<ComponentCategory, readonly string[]> = new Map([
  [ComponentCategory.IO, ["In", "Out", "Clock", "Const", "Ground", "VDD"]],
  [ComponentCategory.WIRING, ["Tunnel", "Driver", "Splitter", "Multiplexer", "Demultiplexer"]],
  [ComponentCategory.LOGIC, ["And", "Or", "Not", "NAnd", "NOr", "XOr", "XNOr"]],
  [ComponentCategory.SWITCHING, ["NFET", "PFET", "Switch", "SwitchDT"]],
  [ComponentCategory.FLIP_FLOPS, ["D_FF", "JK_FF", "RS_FF", "T_FF", "D_FF_AS", "JK_FF_AS", "RS_FF_AS"]],
  [ComponentCategory.MEMORY, ["Counter", "CounterPreset", "Register", "RegisterFile", "ROM", "EEPROM", "LookUpTable", "RAMSinglePort"]],
]);

/**
 * Order a category's registry definitions for seeding: preferred names first (in
 * listed order), then the remaining definitions in registration order.
 */
function seedOrderedNames(category: ComponentCategory, defs: StandaloneComponentDefinition[]): string[] {
  const curated = SEED_CURATED_COMPONENTS.get(category);
  if (curated === undefined) return defs.map((d) => d.name);
  const present = new Set(defs.map((d) => d.name));
  const head = curated.filter((n) => present.has(n));
  const headSet = new Set(head);
  const tail = defs.map((d) => d.name).filter((n) => !headSet.has(n));
  return [...head, ...tail];
}

/**
 * Build the factory-default PaletteConfig from the seed constants and the
 * current registry. Used on first boot (no stored config) and on reset.
 */
export function buildDefaultPaletteConfig(registry: ComponentRegistry): PaletteConfig {
  const groups: PaletteGroupConfig[] = [];

  // Common Components- curated, top of the list, expanded by default.
  groups.push({
    id: COMMON_GROUP_ID,
    label: "Common Components",
    kind: "custom",
    collapsed: false,
    items: COMMON_COMPONENT_NAMES.map((name) => ({ name, visible: true })),
  });

  for (const category of SEED_CATEGORY_ORDER) {
    const defs = registry.getByCategory(category);
    const orderedNames = seedOrderedNames(category, defs);
    groups.push({
      id: category,
      label: CATEGORY_LABELS[category] ?? category,
      kind: "category",
      category,
      collapsed: true,
      items: orderedNames.map((name) => ({ name, visible: true })),
    });
  }

  return { version: PALETTE_CONFIG_VERSION, groups, recent: [] };
}

// ---------------------------------------------------------------------------
// ComponentPalette
// ---------------------------------------------------------------------------

export class ComponentPalette {
  private readonly _registry: ComponentRegistry;
  private readonly _store: PaletteConfigStore | null;
  private _config: PaletteConfig;
  private _collapsed = false;
  /**
   * External override (embed/tutorial). When non-null, only these component
   * names are "available"- they limit both the sidebar render and the set
   * shown in the settings modal. Null means no restriction.
   */
  private _allowlist: Set<string> | null = null;
  /** Active circuit for reading circuit-scoped subcircuit definitions. */
  private _activeCircuit: Circuit | null = null;

  constructor(registry: ComponentRegistry, store: PaletteConfigStore | null = null) {
    this._registry = registry;
    this._store = store;

    const loaded = store?.load() ?? null;
    this._config = loaded !== null && this._isValidConfig(loaded)
      ? loaded
      : buildDefaultPaletteConfig(registry);
    this._reconcile();
  }

  /** Returns the underlying registry for Insert menu building. */
  getRegistry(): ComponentRegistry {
    return this._registry;
  }

  // ---------------------------------------------------------------------------
  // Allowlist (external embed/tutorial override)
  // ---------------------------------------------------------------------------

  setAllowlist(typeNames: string[] | null): void {
    this._allowlist = typeNames !== null ? new Set(typeNames) : null;
  }

  getAllowlist(): string[] | null {
    return this._allowlist !== null ? Array.from(this._allowlist) : null;
  }

  /** Whether a component name is available given the active allowlist. */
  private _available(name: string): boolean {
    return this._allowlist === null || this._allowlist.has(name);
  }

  // ---------------------------------------------------------------------------
  // Config persistence + reconcile
  // ---------------------------------------------------------------------------

  private _isValidConfig(cfg: unknown): cfg is PaletteConfig {
    if (typeof cfg !== "object" || cfg === null) return false;
    const c = cfg as Partial<PaletteConfig>;
    return c.version === PALETTE_CONFIG_VERSION && Array.isArray(c.groups) && Array.isArray(c.recent);
  }

  private _save(): void {
    this._store?.save(this._config);
  }

  /**
   * Merge live registry state into the in-memory config: append components that
   * exist in the registry but are missing from their category group (with seed-
   * default visibility), and add a fresh group for any category that gained
   * components but has no group yet. Never removes entries (a component that
   * stops resolving is simply skipped at render, so re-adding it restores its
   * saved slot). Custom groups (Common) are left untouched. Mutates in memory
   * only- user actions are what persist.
   */
  private _reconcile(): void {
    const groupByCategory = new Map<ComponentCategory, PaletteGroupConfig>();
    for (const g of this._config.groups) {
      if (g.kind === "category" && g.category !== undefined) groupByCategory.set(g.category, g);
    }

    for (const category of SEED_CATEGORY_ORDER) {
      const defs = this._registry.getByCategory(category);
      if (defs.length === 0) continue;
      let group = groupByCategory.get(category);
      if (group === undefined) {
        group = {
          id: category,
          label: CATEGORY_LABELS[category] ?? category,
          kind: "category",
          category,
          collapsed: true,
          items: [],
        };
        this._config.groups.push(group);
        groupByCategory.set(category, group);
      }
      const present = new Set(group.items.map((i) => i.name));
      for (const name of seedOrderedNames(category, defs)) {
        if (!present.has(name)) {
          group.items.push({ name, visible: true });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sidebar tree
  // ---------------------------------------------------------------------------

  /** Resolve a config item to its registry definition, or undefined. */
  private _resolve(name: string): StandaloneComponentDefinition | undefined {
    return this._registry.getStandalone(name);
  }

  /**
   * Returns the rendered tree: one node per configured group that has at least
   * one resolved, available, visible component, followed by the dynamic
   * SUBCIRCUIT group when subcircuits exist. Children honor configured order
   * and the active allowlist. Collapsed groups still carry their children;
   * the UI decides whether to render the list.
   */
  getTree(): PaletteNode[] {
    const nodes: PaletteNode[] = [];

    for (const group of this._config.groups) {
      const children: StandaloneComponentDefinition[] = [];
      for (const item of group.items) {
        if (!item.visible) continue;
        if (!this._available(item.name)) continue;
        const def = this._resolve(item.name);
        if (def !== undefined) children.push(def);
      }
      if (children.length === 0) continue;
      nodes.push(this._makeNode(group.id, group.category, group.label, children, !group.collapsed));
    }

    const subNode = this._buildSubcircuitNode();
    if (subNode !== null) nodes.push(subNode);

    return nodes;
  }

  /** Construct a PaletteNode, omitting `category` when absent (custom group). */
  private _makeNode(
    id: string,
    category: ComponentCategory | undefined,
    label: string,
    children: StandaloneComponentDefinition[],
    expanded: boolean,
  ): PaletteNode {
    return category !== undefined
      ? { id, category, label, children, expanded }
      : { id, label, children, expanded };
  }

  /**
   * Returns a filtered tree. Components whose display name or registry name
   * contains the query (case-insensitive) are included. Matching groups are
   * returned expanded; groups with no match are omitted. Empty query defers to
   * getTree().
   */
  filter(query: string): PaletteNode[] {
    if (query === "") return this.getTree();
    const q = query.toLowerCase();

    const matches = (def: StandaloneComponentDefinition): boolean =>
      def.name.toLowerCase().includes(q) || displayNameOf(def).toLowerCase().includes(q);

    const nodes: PaletteNode[] = [];
    for (const group of this._config.groups) {
      const children: StandaloneComponentDefinition[] = [];
      for (const item of group.items) {
        if (!item.visible) continue;
        if (!this._available(item.name)) continue;
        const def = this._resolve(item.name);
        if (def !== undefined && matches(def)) children.push(def);
      }
      if (children.length === 0) continue;
      nodes.push(this._makeNode(group.id, group.category, group.label, children, true));
    }

    const subNode = this._buildSubcircuitNode();
    if (subNode !== null) {
      const filtered = subNode.children.filter(matches);
      if (filtered.length > 0) nodes.push({ ...subNode, children: filtered, expanded: true });
    }

    return nodes;
  }

  // ---------------------------------------------------------------------------
  // Settings-modal editable view
  // ---------------------------------------------------------------------------

  /**
   * Full editable view of the configured groups for the settings modal: every
   * resolved, available item (visible and hidden) in configured order. Groups
   * with no available items are omitted. The dynamic SUBCIRCUIT group is not
   * included- it is not user-reorderable.
   */
  getConfigGroups(): PaletteGroupView[] {
    const views: PaletteGroupView[] = [];
    for (const group of this._config.groups) {
      const items: PaletteItemView[] = [];
      for (const item of group.items) {
        if (!this._available(item.name)) continue;
        const def = this._resolve(item.name);
        if (def !== undefined) items.push({ def, visible: item.visible });
      }
      if (items.length === 0) continue;
      views.push({ id: group.id, label: group.label, kind: group.kind, collapsed: group.collapsed, items });
    }
    return views;
  }

  private _findGroup(groupId: string): PaletteGroupConfig | undefined {
    return this._config.groups.find((g) => g.id === groupId);
  }

  /** Set a single component's visibility within a group and persist. */
  setItemVisible(groupId: string, name: string, visible: boolean): void {
    const group = this._findGroup(groupId);
    const item = group?.items.find((i) => i.name === name);
    if (item === undefined) return;
    item.visible = visible;
    this._save();
  }

  /**
   * Reorder within a group: remove the source component and reinsert it
   * immediately before the target component. Addressed by name so the modal's
   * filtered view maps cleanly onto the stored config. Persists on change.
   */
  moveItem(groupId: string, sourceName: string, targetName: string): void {
    const group = this._findGroup(groupId);
    if (group === undefined || sourceName === targetName) return;
    if (this._moveBefore(group.items, (i) => i.name === sourceName, (i) => i.name === targetName)) {
      this._save();
    }
  }

  /**
   * Reorder groups: remove the source group and reinsert it immediately before
   * the target group. Addressed by id. Persists on change.
   */
  moveGroup(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    if (this._moveBefore(this._config.groups, (g) => g.id === sourceId, (g) => g.id === targetId)) {
      this._save();
    }
  }

  /** Set a group's collapsed state and persist. */
  setGroupCollapsed(groupId: string, collapsed: boolean): void {
    const group = this._findGroup(groupId);
    if (group === undefined || group.collapsed === collapsed) return;
    group.collapsed = collapsed;
    this._save();
  }

  /** Toggle a group's collapsed state and persist. */
  toggleGroup(groupId: string): void {
    const group = this._findGroup(groupId);
    if (group === undefined) return;
    group.collapsed = !group.collapsed;
    this._save();
  }

  /** Restore the factory-default layout (seeded from the registry) and persist. */
  resetToDefaults(): void {
    const recent = this._config.recent;
    this._config = buildDefaultPaletteConfig(this._registry);
    this._config.recent = recent; // recent history survives a layout reset
    this._reconcile();
    this._save();
  }

  /**
   * In-place move: pull the first element matching `isSource` out and reinsert
   * it immediately before the first element matching `isTarget`. Returns true
   * when the array changed.
   */
  private _moveBefore<T>(arr: T[], isSource: (x: T) => boolean, isTarget: (x: T) => boolean): boolean {
    const from = arr.findIndex(isSource);
    if (from < 0) return false;
    if (arr[from] !== undefined && isTarget(arr[from]!)) return false;
    const [moved] = arr.splice(from, 1);
    const to = arr.findIndex(isTarget);
    if (to < 0) {
      arr.splice(from, 0, moved!); // target gone- restore, no change
      return false;
    }
    arr.splice(to, 0, moved!);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Recent history
  // ---------------------------------------------------------------------------

  /**
   * Record that a component of the given name was placed. Moves an existing
   * entry to the front, trims to the last 10, and persists.
   */
  recordPlacement(name: string): void {
    const existing = this._config.recent.indexOf(name);
    if (existing !== -1) this._config.recent.splice(existing, 1);
    this._config.recent.unshift(name);
    if (this._config.recent.length > MAX_RECENT_HISTORY) {
      this._config.recent.length = MAX_RECENT_HISTORY;
    }
    this._save();
  }

  /**
   * Returns the last 10 placed component types, most recent first. Entries that
   * no longer resolve or are excluded by the active allowlist are omitted.
   */
  getRecentHistory(): StandaloneComponentDefinition[] {
    const result: StandaloneComponentDefinition[] = [];
    for (const name of this._config.recent) {
      if (!this._available(name)) continue;
      const def = this._resolve(name);
      if (def !== undefined) result.push(def);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Dynamic subcircuit group
  // ---------------------------------------------------------------------------

  /**
   * Set the active circuit so the palette can read circuit-scoped subcircuit
   * definitions. Call when the active circuit changes (load, new, etc.).
   */
  setActiveCircuit(circuit: Circuit | null): void {
    this._activeCircuit = circuit;
  }

  /** Build StandaloneComponentDefinition array for circuit-scoped subcircuits. */
  private _getCircuitScopedSubcircuits(): StandaloneComponentDefinition[] {
    if (!this._activeCircuit?.metadata.subcircuits?.size) return [];
    const defs: StandaloneComponentDefinition[] = [];
    for (const [name, subDef] of this._activeCircuit.metadata.subcircuits) {
      defs.push(buildSubcircuitComponentDef(name, subDef));
    }
    return defs;
  }

  /**
   * The SUBCIRCUIT group is dynamic- its members come live from the registry
   * and the active circuit, never from persisted config. Returns null when no
   * subcircuits exist.
   */
  private _buildSubcircuitNode(): PaletteNode | null {
    const registryDefs = this._registry.getByCategory(ComponentCategory.SUBCIRCUIT);
    const circuitDefs = this._getCircuitScopedSubcircuits();
    if (registryDefs.length === 0 && circuitDefs.length === 0) return null;

    const seen = new Set<string>();
    const children: StandaloneComponentDefinition[] = [];
    for (const def of [...registryDefs, ...circuitDefs]) {
      if (seen.has(def.name)) continue;
      if (!this._available(def.name)) continue;
      seen.add(def.name);
      children.push(def);
    }
    if (children.length === 0) return null;

    const collapsed = this._subcircuitCollapsed;
    return {
      id: ComponentCategory.SUBCIRCUIT,
      category: ComponentCategory.SUBCIRCUIT,
      label: CATEGORY_LABELS[ComponentCategory.SUBCIRCUIT],
      children,
      expanded: !collapsed,
    };
  }

  /** Collapsed state for the dynamic SUBCIRCUIT group (in-memory; the group is
   *  not persisted). Starts expanded so a freshly-created subcircuit is visible. */
  private _subcircuitCollapsed = false;

  /**
   * Re-read subcircuit availability. Kept for callers that mutate subcircuits
   * and then re-render; the SUBCIRCUIT node is computed live from the registry
   * and active circuit, so this is a no-op beyond signalling intent.
   */
  refreshCategories(): void {
    // Intentionally empty: getTree()/_buildSubcircuitNode() read live state.
  }

  // ---------------------------------------------------------------------------
  // Group toggle (sidebar header click)
  // ---------------------------------------------------------------------------

  /** Toggle expanded/collapsed for the group with the given id (sidebar). */
  toggleNode(id: string): void {
    if (id === ComponentCategory.SUBCIRCUIT) {
      this._subcircuitCollapsed = !this._subcircuitCollapsed;
      return;
    }
    this.toggleGroup(id);
  }

  // ---------------------------------------------------------------------------
  // Panel collapse (iframe-embedded mode)
  // ---------------------------------------------------------------------------

  setCollapsed(collapsed: boolean): void {
    this._collapsed = collapsed;
  }

  isCollapsed(): boolean {
    return this._collapsed;
  }
}
