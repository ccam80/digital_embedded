/**
 * PaletteUI — DOM rendering for the component palette.
 *
 * Renders the tree view, search input, and recent section.
 * Depends on ComponentPalette (logic) and the browser DOM.
 * Separated from palette.ts so the logic layer is testable without DOM.
 */

import { createSeededBag, type ComponentDefinition } from "@/core/registry";
import type { ComponentCategory } from "@/core/registry";
import type { ComponentPalette, PaletteNode } from "./palette.js";
import type { ColorScheme, Point } from "@/core/renderer-interface";
import { CanvasRenderer } from "./canvas-renderer.js";
import { PaletteDragController } from "./palette-drag.js";
import type { Viewport } from "./viewport.js";

export type AllowlistChangeHandler = (typeNames: string[] | null) => void;

export type PlacementHandler = (def: ComponentDefinition) => void;

export type TouchDropHandler = (def: ComponentDefinition, worldPt: Point) => void;

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
  private _colorScheme: ColorScheme | null;
  private _placementHandler: PlacementHandler | null = null;
  private _allowlistChangeHandler: AllowlistChangeHandler | null = null;
  private _touchDropHandler: TouchDropHandler | null = null;
  private readonly _dragController = new PaletteDragController();
  private _canvas: HTMLCanvasElement | null = null;
  private _viewport: Viewport | null = null;

  constructor(palette: ComponentPalette, container: HTMLElement, colorScheme?: ColorScheme) {
    this._palette = palette;
    this._container = container;
    this._colorScheme = colorScheme ?? null;
  }

  /**
   * Provide the canvas and viewport needed for touch-drag coordinate conversion.
   * Call this from app-init after canvas/viewport are initialized.
   */
  setCanvas(canvas: HTMLCanvasElement, viewport: Viewport): void {
    this._canvas = canvas;
    this._viewport = viewport;
  }

  /**
   * Update the color scheme used for palette icons and re-render.
   */
  setColorScheme(scheme: ColorScheme): void {
    this._colorScheme = scheme;
    this.render();
  }

  /**
   * Register a callback invoked when a touch-drag results in a drop over the canvas.
   */
  onTouchDrop(handler: TouchDropHandler): void {
    this._touchDropHandler = handler;
  }

  /**
   * Register a callback invoked when the user clicks a component entry.
   */
  onPlace(handler: PlacementHandler): void {
    this._placementHandler = handler;
  }

  /**
   * Register a callback invoked when the user changes the palette allowlist
   * via the settings dialog.
   */
  onAllowlistChange(handler: AllowlistChangeHandler): void {
    this._allowlistChangeHandler = handler;
  }

  /**
   * Toggle a loading indicator on the palette item for the given component name.
   * Adds or removes the `palette-loading` CSS class on the matching item element.
   */
  setLoading(name: string, loading: boolean): void {
    const item = this._container.querySelector<HTMLElement>(`[data-component="${name}"]`);
    if (item) {
      item.classList.toggle('palette-loading', loading);
    }
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

    const gearBtn = document.createElement("button");
    gearBtn.className = "palette-settings-btn";
    gearBtn.title = "Configure visible components";
    gearBtn.textContent = "\u2699";
    gearBtn.addEventListener("click", () => this._openSettingsDialog());

    wrapper.appendChild(input);
    wrapper.appendChild(gearBtn);
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
    treeEl.setAttribute("role", "tree");

    for (const node of nodes) {
      treeEl.appendChild(this._buildCategoryNode(node));
    }

    // Arrow-key navigation across all treeitem elements
    treeEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const items = Array.from(
        treeEl.querySelectorAll<HTMLElement>('[role="treeitem"]')
      );
      if (items.length === 0) return;
      const focused = document.activeElement as HTMLElement | null;
      const idx = focused ? items.indexOf(focused) : -1;
      let next: HTMLElement | undefined;
      if (e.key === "ArrowDown") {
        next = idx < items.length - 1 ? items[idx + 1] : items[0];
      } else {
        next = idx > 0 ? items[idx - 1] : items[items.length - 1];
      }
      if (next) {
        e.preventDefault();
        next.focus();
      }
    });

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
    item.setAttribute("role", "treeitem");
    item.setAttribute("tabindex", "0");
    item.dataset["component"] = def.name;

    const icon = this._renderComponentIcon(def);
    item.appendChild(icon);

    const name = document.createElement("span");
    name.className = "palette-component-name";
    name.textContent = def.name;
    item.appendChild(name);

    // Mouse: keep existing click-to-place
    item.addEventListener("click", (e: MouseEvent) => {
      // Suppress click that follows a touch drag
      if (this._dragController.isDragging) return;
      if ((e as PointerEvent).pointerType === 'touch') return;
      this._palette.recordPlacement(def.name);
      if (this._placementHandler !== null) {
        this._placementHandler(def);
      }
    });

    // Keyboard: Enter or Space activates placement
    item.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._palette.recordPlacement(def.name);
        if (this._placementHandler !== null) {
          this._placementHandler(def);
        }
      }
    });

    // Touch: pointerdown → track, move to disambiguate, up to place/cancel
    this._addTouchDragHandlers(item, def);

    // Suppress browser context menu on palette items
    item.addEventListener("contextmenu", (e) => e.preventDefault());

    return item;
  }

  private _addTouchDragHandlers(item: HTMLElement, def: ComponentDefinition): void {
    let touchPointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let dragging = false;
    /** Whether a HOLD timer fired (≥150ms without movement). */
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    const DRAG_THRESHOLD_PX = 10;
    const HOLD_MS = 150;

    const beginDrag = (clientX: number, clientY: number): void => {
      dragging = true;
      if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
      item.setPointerCapture(touchPointerId!);
      this._dragController.start(def, item, clientX, clientY);
    };

    const cleanup = (): void => {
      dragging = false;
      touchPointerId = null;
      if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
    };

    item.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if (touchPointerId !== null) return; // already tracking
      touchPointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startTime = performance.now();
      dragging = false;

      // Hold timer: if held ≥150ms without significant movement, begin drag
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (!dragging && touchPointerId !== null) {
          beginDrag(e.clientX, e.clientY);
        }
      }, HOLD_MS);
    });

    item.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || e.pointerId !== touchPointerId) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const elapsed = performance.now() - startTime;

      if (!dragging) {
        // Vertical scroll: >10px vertical AND more vertical than horizontal → cancel
        if (Math.abs(dy) > DRAG_THRESHOLD_PX && Math.abs(dy) > Math.abs(dx)) {
          // Allow native scroll — release capture and cancel
          cleanup();
          this._dragController.cancel();
          return;
        }
        // Horizontal movement or elapsed ≥150ms → begin drag
        if (Math.abs(dx) > DRAG_THRESHOLD_PX || elapsed >= HOLD_MS) {
          beginDrag(e.clientX, e.clientY);
        }
      }

      if (dragging) {
        // Prevent browser back/forward gesture while dragging
        e.preventDefault();
        if (this._canvas) {
          const rect = this._canvas.getBoundingClientRect();
          const overCanvas =
            e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom;
          this._dragController.move(e.clientX, e.clientY, overCanvas);
        }
      }
    });

    const onEnd = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch' || e.pointerId !== touchPointerId) return;

      if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }

      if (dragging && this._canvas && this._viewport) {
        const worldPt = this._dragController.drop(
          e.clientX, e.clientY, this._canvas, this._viewport,
        );
        if (worldPt !== null && this._touchDropHandler !== null) {
          this._palette.recordPlacement(def.name);
          this._touchDropHandler(def, worldPt);
        } else {
          this._dragController.cancel();
        }
      } else if (!dragging) {
        // Short tap with no drag: treat as click-to-place
        this._palette.recordPlacement(def.name);
        if (this._placementHandler !== null) {
          this._placementHandler(def);
        }
      } else {
        this._dragController.cancel();
      }

      cleanup();
    };

    item.addEventListener('pointerup', onEnd);
    item.addEventListener('pointercancel', (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || e.pointerId !== touchPointerId) return;
      this._dragController.cancel();
      cleanup();
    });
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
    const size = 32;
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
      const element = def.factory(createSeededBag(def));
      const bb = element.getBoundingBox();
      const maxDim = Math.max(bb.width, bb.height, 1);
      const scale = (size * dpr * 0.8) / maxDim;
      const offsetX = (size * dpr - bb.width * scale) / 2 - bb.x * scale;
      const offsetY = (size * dpr - bb.height * scale) / 2 - bb.y * scale;

      ctx2d.translate(offsetX, offsetY);
      ctx2d.scale(scale, scale);

      const renderer = new CanvasRenderer(ctx2d, this._colorScheme);
      // Ensure lines are at least 1.5 device pixels wide even at small icon scale
      const minLineScale = (1.5 * dpr) / scale;
      renderer.setGridScale(Math.min(scale, 1 / minLineScale));
      element.draw(renderer);
    } catch (e) {
      // Surface icon-rendering failure so a broken component doesn't
      // produce a silent blank-tile palette. Per
      // spec/i1-suppression-backlog.md §4.2 replaced prior silent swallow.
      console.warn(`[palette-ui] Failed to render palette icon for "${def.name}".`, e);
    }

    return canvas;
  }

  // ---------------------------------------------------------------------------
  // Settings dialog
  // ---------------------------------------------------------------------------

  /**
   * Open a modal dialog that lets the user toggle which component types
   * appear in the palette. Grouped by category with select-all toggles.
   */
  private _openSettingsDialog(): void {
    const registry = this._palette.getRegistry();
    const currentAllowlist = this._palette.getAllowlist();
    const allDefs = registry.getAll();

    // Build a mutable checked set — start from allowlist or all
    const checked = new Set<string>(
      currentAllowlist !== null ? currentAllowlist : allDefs.map((d) => d.name),
    );

    // --- overlay ---
    const overlay = document.createElement("div");
    overlay.className = "test-dialog-overlay";

    const dialog = document.createElement("div");
    dialog.className = "test-dialog";
    dialog.style.width = "500px";

    // --- header ---
    const header = document.createElement("div");
    header.className = "test-dialog-header";
    const title = document.createElement("span");
    title.textContent = "Palette Components";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u00D7";
    closeBtn.style.cssText = "background:none;border:none;color:inherit;font-size:18px;cursor:pointer;";
    closeBtn.addEventListener("click", () => overlay.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);

    // --- body ---
    const body = document.createElement("div");
    body.style.cssText = "flex:1;overflow-y:auto;padding:8px 16px;max-height:60vh;";

    // "Show all" toggle
    const showAllRow = document.createElement("label");
    showAllRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 0;font-weight:600;font-size:12px;border-bottom:1px solid var(--panel-border);margin-bottom:8px;";
    const showAllCb = document.createElement("input");
    showAllCb.type = "checkbox";
    showAllCb.checked = currentAllowlist === null;
    showAllRow.appendChild(showAllCb);
    showAllRow.appendChild(document.createTextNode("Show all components (no filter)"));
    body.appendChild(showAllRow);

    // Container for per-category checkboxes
    const categoriesContainer = document.createElement("div");
    categoriesContainer.style.display = showAllCb.checked ? "none" : "";

    // Group definitions by category
    const byCategory = new Map<string, ComponentDefinition[]>();
    for (const def of allDefs) {
      const cat = def.category;
      let list = byCategory.get(cat);
      if (!list) { list = []; byCategory.set(cat, list); }
      list.push(def);
    }

    const categoryCheckboxes: { catCb: HTMLInputElement; items: HTMLInputElement[] }[] = [];

    for (const [cat, defs] of byCategory) {
      const section = document.createElement("div");
      section.style.cssText = "margin-bottom:6px;";

      // Category header with select-all checkbox
      const catLabel = document.createElement("label");
      catLabel.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 0;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;opacity:0.8;cursor:pointer;";
      const catCb = document.createElement("input");
      catCb.type = "checkbox";
      const allChecked = defs.every((d) => checked.has(d.name));
      const someChecked = defs.some((d) => checked.has(d.name));
      catCb.checked = allChecked;
      catCb.indeterminate = someChecked && !allChecked;
      catLabel.appendChild(catCb);
      catLabel.appendChild(document.createTextNode(cat));
      section.appendChild(catLabel);

      // Individual component checkboxes
      const itemCbs: HTMLInputElement[] = [];
      const itemsDiv = document.createElement("div");
      itemsDiv.style.cssText = "padding-left:20px;";
      for (const def of defs) {
        const itemLabel = document.createElement("label");
        itemLabel.style.cssText = "display:flex;align-items:center;gap:6px;padding:1px 0;font-size:12px;cursor:pointer;";
        const itemCb = document.createElement("input");
        itemCb.type = "checkbox";
        itemCb.checked = checked.has(def.name);
        itemCb.dataset["typeName"] = def.name;
        itemCb.addEventListener("change", () => {
          if (itemCb.checked) checked.add(def.name);
          else checked.delete(def.name);
          // Update category checkbox
          const allNow = defs.every((d) => checked.has(d.name));
          const someNow = defs.some((d) => checked.has(d.name));
          catCb.checked = allNow;
          catCb.indeterminate = someNow && !allNow;
        });
        itemLabel.appendChild(itemCb);
        itemLabel.appendChild(document.createTextNode(def.name));
        itemsDiv.appendChild(itemLabel);
        itemCbs.push(itemCb);
      }

      // Category checkbox toggles all items in that category
      catCb.addEventListener("change", () => {
        for (const cb of itemCbs) {
          cb.checked = catCb.checked;
          const name = cb.dataset["typeName"]!;
          if (catCb.checked) checked.add(name);
          else checked.delete(name);
        }
        catCb.indeterminate = false;
      });

      section.appendChild(itemsDiv);
      categoriesContainer.appendChild(section);
      categoryCheckboxes.push({ catCb, items: itemCbs });
    }

    // "Show all" toggles the category container visibility
    showAllCb.addEventListener("change", () => {
      categoriesContainer.style.display = showAllCb.checked ? "none" : "";
    });

    body.appendChild(categoriesContainer);

    // --- footer ---
    const footer = document.createElement("div");
    footer.className = "test-dialog-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => overlay.remove());

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply";
    applyBtn.className = "primary";
    applyBtn.addEventListener("click", () => {
      if (showAllCb.checked) {
        this._palette.setAllowlist(null);
        if (this._allowlistChangeHandler) this._allowlistChangeHandler(null);
      } else {
        const names = Array.from(checked);
        this._palette.setAllowlist(names.length > 0 ? names : null);
        if (this._allowlistChangeHandler) {
          this._allowlistChangeHandler(names.length > 0 ? names : null);
        }
      }
      this.render();
      overlay.remove();
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    // Close on backdrop click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }
}
