/**
 * PaletteUI- DOM rendering for the component palette.
 *
 * Renders the tree view, search input, and recent section.
 * Depends on ComponentPalette (logic) and the browser DOM.
 * Separated from palette.ts so the logic layer is testable without DOM.
 */

import { constructElement, displayNameOf, type StandaloneComponentDefinition } from "@/core/registry";
import type { ComponentPalette, PaletteNode } from "./palette.js";
import type { ColorScheme, Point } from "@/core/renderer-interface";
import { CanvasRenderer } from "./canvas-renderer.js";
import { PaletteDragController } from "./palette-drag.js";
import { openPaletteSettingsModal } from "./palette-settings-modal.js";
import type { Viewport } from "./viewport.js";

export type PlacementHandler = (def: StandaloneComponentDefinition) => void;

export type TouchDropHandler = (def: StandaloneComponentDefinition, worldPt: Point) => void;

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
    gearBtn.title = "Configure palette- reorder & show/hide components";
    gearBtn.textContent = "\u2699";
    gearBtn.addEventListener("click", () =>
      openPaletteSettingsModal(this._palette, () => this.render()),
    );

    wrapper.appendChild(input);
    wrapper.appendChild(gearBtn);
    return wrapper;
  }

  private _buildRecentSection(recent: StandaloneComponentDefinition[]): HTMLElement {
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
    categoryEl.dataset["group"] = node.id;
    if (node.category !== undefined) categoryEl.dataset["category"] = node.category;

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
      this._palette.toggleNode(node.id);
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

  private _buildComponentItem(def: StandaloneComponentDefinition): HTMLElement {
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
    name.textContent = displayNameOf(def);
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

  private _addTouchDragHandlers(item: HTMLElement, def: StandaloneComponentDefinition): void {
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
          // Allow native scroll- release capture and cancel
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
  private _renderComponentIcon(def: StandaloneComponentDefinition): HTMLElement {
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
      const element = constructElement(def, {});
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
      // spec/architectural-alignment.md ssI1 replaced prior silent swallow.
      console.warn(`[palette-ui] Failed to render palette icon for "${def.name}".`, e);
    }

    return canvas;
  }
}
