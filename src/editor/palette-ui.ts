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
import type { ColorScheme } from "@/core/renderer-interface";
import { CanvasRenderer } from "./canvas-renderer.js";
import { PropertyBag } from "@/core/properties.js";

export type PlacementHandler = (def: ComponentDefinition) => void;

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
  private readonly _colorScheme: ColorScheme | null;
  private _placementHandler: PlacementHandler | null = null;

  constructor(palette: ComponentPalette, container: HTMLElement, colorScheme?: ColorScheme) {
    this._palette = palette;
    this._container = container;
    this._colorScheme = colorScheme ?? null;
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
    input.placeholder = "Search components\u2026";
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
    header.textContent = "Recent";
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

    const arrow = document.createElement("span");
    arrow.className = "palette-category-arrow";
    arrow.textContent = node.expanded ? "\u25BC" : "\u25B6";
    header.appendChild(arrow);

    const label = document.createElement("span");
    label.textContent = node.label;
    header.appendChild(label);

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

    const icon = this._renderComponentIcon(def);
    item.appendChild(icon);

    const name = document.createElement("span");
    name.className = "palette-component-name";
    name.textContent = def.name;
    item.appendChild(name);

    item.addEventListener("click", () => {
      this._palette.recordPlacement(def.name);
      if (this._placementHandler !== null) {
        this._placementHandler(def);
      }
    });

    return item;
  }

  /**
   * Render a mini component preview onto a small canvas element.
   * Falls back to a placeholder div if no color scheme is available.
   */
  private _renderComponentIcon(def: ComponentDefinition): HTMLElement {
    if (this._colorScheme === null) {
      const placeholder = document.createElement("div");
      placeholder.className = "palette-component-icon--placeholder";
      return placeholder;
    }

    const canvas = document.createElement("canvas");
    canvas.className = "palette-component-icon";
    const size = 24;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) {
      const placeholder = document.createElement("div");
      placeholder.className = "palette-component-icon--placeholder";
      return placeholder;
    }

    try {
      const element = def.factory(new PropertyBag());
      const bb = element.getBoundingBox();
      const maxDim = Math.max(bb.width, bb.height, 1);
      const scale = (size * dpr * 0.8) / maxDim;
      const offsetX = (size * dpr - bb.width * scale) / 2;
      const offsetY = (size * dpr - bb.height * scale) / 2;

      ctx2d.translate(offsetX, offsetY);
      ctx2d.scale(scale, scale);

      const renderer = new CanvasRenderer(ctx2d, this._colorScheme);
      renderer.setGridScale(scale);
      element.draw(renderer);
    } catch {
      // If rendering fails, just return empty canvas
    }

    return canvas;
  }
}
