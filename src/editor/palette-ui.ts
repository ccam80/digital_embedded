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
  private _placementHandler: PlacementHandler | null = null;

  /** Search input element, created once in render(). */
  private _searchInput: HTMLInputElement | null = null;

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
    this._searchInput = input;

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
    header.textContent = node.label;
    header.setAttribute("aria-expanded", String(node.expanded));

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
    item.textContent = def.name;
    item.title = def.helpText;

    item.addEventListener("click", () => {
      this._palette.recordPlacement(def.name);
      if (this._placementHandler !== null) {
        this._placementHandler(def);
      }
    });

    return item;
  }
}
