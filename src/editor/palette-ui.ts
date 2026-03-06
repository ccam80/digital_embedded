/**
 * PaletteUI — DOM rendering for the component palette.
 *
 * Renders the tree view, search input, and recent section.
 * Depends on ComponentPalette (logic) and the browser DOM.
 * Separated from palette.ts so the logic layer is testable without DOM.
 */

import type { ComponentDefinition } from "@/core/registry";
import type { ComponentCategory } from "@/core/registry";
import type { ComponentPalette, PaletteNode } from "./palette.js";
import { CanvasRenderer } from "./canvas-renderer.js";
import { darkColorScheme } from "@/core/renderer-interface.js";
import { PropertyBag } from "@/core/properties.js";

export type PlacementHandler = (def: ComponentDefinition) => void;

// ---------------------------------------------------------------------------
// Icon rendering
// ---------------------------------------------------------------------------

/** Size of the palette icon canvas in CSS pixels. */
const ICON_SIZE = 24;

/** Draw a minimal placeholder square when the component cannot be rendered. */
function _drawPlaceholderIcon(ctx: CanvasRenderingContext2D): void {
  const pad = 4;
  ctx.strokeStyle = "#888";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad, pad, ICON_SIZE - pad * 2, ICON_SIZE - pad * 2);
}

/**
 * Render a ComponentDefinition to a small offscreen canvas and return it.
 *
 * The component is instantiated with default properties at origin (0,0).
 * Its bounding box is used to compute a scale+translate that fits the shape
 * into ICON_SIZE×ICON_SIZE with 2px padding on each side.
 *
 * Returns null if the canvas API is unavailable (e.g. SSR/test context).
 */
function renderComponentIcon(def: ComponentDefinition): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;

  const ctx2d = canvas.getContext("2d");
  if (ctx2d === null) return null;

  // Instantiate a temporary element with default properties.
  let element;
  try {
    element = def.factory(new PropertyBag());
  } catch {
    // Factory may throw for components that require specific props.
    _drawPlaceholderIcon(ctx2d);
    return canvas;
  }

  const bb = element.getBoundingBox();
  const pad = 2;
  const drawW = ICON_SIZE - pad * 2;
  const drawH = ICON_SIZE - pad * 2;

  // Guard against zero-size bounding boxes.
  const bbW = bb.width > 0 ? bb.width : 2;
  const bbH = bb.height > 0 ? bb.height : 2;

  const scale = Math.min(drawW / bbW, drawH / bbH);

  // Center the bounding box within the icon.
  const scaledW = bbW * scale;
  const scaledH = bbH * scale;
  const offsetX = pad + (drawW - scaledW) / 2 - bb.x * scale;
  const offsetY = pad + (drawH - scaledH) / 2 - bb.y * scale;

  ctx2d.save();
  ctx2d.translate(offsetX, offsetY);
  ctx2d.scale(scale, scale);

  const renderer = new CanvasRenderer(ctx2d, darkColorScheme);
  renderer.setGridScale(scale);

  try {
    element.draw(renderer);
  } catch {
    // Swallow rendering errors — icon is best-effort.
  }

  ctx2d.restore();
  return canvas;
}

// ---------------------------------------------------------------------------
// Icon cache
// ---------------------------------------------------------------------------

/** Cache: component type name → rendered canvas (or null on failure). */
const _iconCache = new Map<string, HTMLCanvasElement | null>();

function getOrCreateIcon(def: ComponentDefinition): HTMLCanvasElement | null {
  if (_iconCache.has(def.name)) {
    return _iconCache.get(def.name)!;
  }
  const icon = renderComponentIcon(def);
  _iconCache.set(def.name, icon);
  return icon;
}

// ---------------------------------------------------------------------------
// PaletteUI
// ---------------------------------------------------------------------------

/**
 * Renders the component palette into a container element.
 *
 * Usage:
 *   const ui = new PaletteUI(palette, container);
 *   ui.onPlace(def => editor.beginPlacement(def));
 *   ui.render();
 */
export class PaletteUI {
  private readonly _palette: ComponentPalette;
  private readonly _container: HTMLElement;
  private _placementHandler: PlacementHandler | null = null;

  constructor(palette: ComponentPalette, container: HTMLElement) {
    this._palette = palette;
    this._container = container;
  }

  /**
   * Register a callback invoked when the user clicks a component entry.
   */
  onPlace(handler: PlacementHandler): void {
    this._placementHandler = handler;
  }

  /**
   * Full initial render. Clears the container and builds the tree.
   */
  render(): void {
    this._container.innerHTML = "";

    if (this._palette.isCollapsed()) {
      this._container.style.display = "none";
      return;
    }

    this._container.style.display = "";

    // Search bar
    const searchBar = this._buildSearchBar();
    this._container.appendChild(searchBar);

    // Recent section
    const recent = this._palette.getRecentHistory();
    if (recent.length > 0) {
      const recentSection = this._buildRecentSection(recent);
      this._container.appendChild(recentSection);
    }

    // Category tree
    const tree = this._palette.getTree();
    const treeEl = this._buildTree(tree);
    this._container.appendChild(treeEl);
  }

  /**
   * Re-render with an active search query.
   */
  renderFiltered(query: string): void {
    // Remove everything below the search bar.
    while (this._container.children.length > 1) {
      this._container.removeChild(this._container.lastChild!);
    }

    const nodes = this._palette.filter(query);
    const treeEl = this._buildTree(nodes);
    this._container.appendChild(treeEl);
  }

  // ---------------------------------------------------------------------------
  // Private builders
  // ---------------------------------------------------------------------------

  private _buildSearchBar(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "palette-search";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search components…";
    input.className = "palette-search-input";

    input.addEventListener("input", () => {
      const query = input.value.trim();
      if (query === "") {
        this.render();
      } else {
        this.renderFiltered(query);
      }
    });

    wrapper.appendChild(input);
    return wrapper;
  }

  private _buildRecentSection(recent: ComponentDefinition[]): HTMLElement {
    const section = document.createElement("div");
    section.className = "palette-recent";

    const header = document.createElement("div");
    header.className = "palette-category-header";

    const arrow = document.createElement("span");
    arrow.className = "palette-category-arrow";
    arrow.textContent = "▾";
    arrow.setAttribute("aria-hidden", "true");
    header.appendChild(arrow);

    const labelSpan = document.createElement("span");
    labelSpan.textContent = "Recent";
    header.appendChild(labelSpan);

    section.appendChild(header);

    const list = document.createElement("ul");
    list.className = "palette-component-list";
    for (const def of recent) {
      list.appendChild(this._buildComponentItem(def));
    }
    section.appendChild(list);
    return section;
  }

  private _buildTree(nodes: PaletteNode[]): HTMLElement {
    const treeEl = document.createElement("div");
    treeEl.className = "palette-tree";

    for (const node of nodes) {
      treeEl.appendChild(this._buildCategoryNode(node));
    }

    return treeEl;
  }

  private _buildCategoryNode(node: PaletteNode): HTMLElement {
    const categoryEl = document.createElement("div");
    categoryEl.className = "palette-category";
    categoryEl.dataset["category"] = node.category;

    const header = document.createElement("div");
    header.className = "palette-category-header";
    header.setAttribute("aria-expanded", String(node.expanded));

    // Toggle arrow: ▸ collapsed, ▾ expanded
    const arrow = document.createElement("span");
    arrow.className = "palette-category-arrow";
    arrow.textContent = node.expanded ? "▾" : "▸";
    arrow.setAttribute("aria-hidden", "true");
    header.appendChild(arrow);

    const labelSpan = document.createElement("span");
    labelSpan.textContent = node.label;
    header.appendChild(labelSpan);

    header.addEventListener("click", () => {
      this._palette.toggleCategory(node.category as ComponentCategory);
      this.render();
    });

    categoryEl.appendChild(header);

    if (node.expanded) {
      const list = document.createElement("ul");
      list.className = "palette-component-list";
      for (const def of node.children) {
        list.appendChild(this._buildComponentItem(def));
      }
      categoryEl.appendChild(list);
    }

    return categoryEl;
  }

  private _buildComponentItem(def: ComponentDefinition): HTMLElement {
    const item = document.createElement("li");
    item.className = "palette-component-item";
    item.title = def.helpText;

    // Icon — rendered via offscreen canvas, cached per component type
    const icon = getOrCreateIcon(def);
    if (icon !== null) {
      icon.className = "palette-component-icon";
      icon.setAttribute("aria-hidden", "true");
      item.appendChild(icon);
    } else {
      // Placeholder span keeps flex layout consistent when canvas unavailable
      const placeholder = document.createElement("span");
      placeholder.className = "palette-component-icon palette-component-icon--placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      item.appendChild(placeholder);
    }

    // Component name label
    const nameSpan = document.createElement("span");
    nameSpan.className = "palette-component-name";
    nameSpan.textContent = def.name;
    item.appendChild(nameSpan);

    item.addEventListener("click", () => {
      this._palette.recordPlacement(def.name);
      if (this._placementHandler !== null) {
        this._placementHandler(def);
      }
    });

    return item;
  }
}
