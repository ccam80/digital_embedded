/**
 * PresentationMode- fullscreen canvas mode for projection/lecture use.
 *
 * Toggled by F4 (registered in the default shortcut bindings).
 * On enter: palette and property panel collapse, viewport fits to circuit
 * content, a simplified toolbar with only simulation controls is available.
 * On exit: panel visibility is restored to its pre-enter state and the
 * previous zoom/pan is restored.
 *
 * PresentationMode is engine-agnostic. It receives a PanelSet and a Viewport
 * as plain collaborators so the mode can be used and tested without a DOM
 * environment.
 */

import type { Viewport } from "./viewport.js";
import type { MenuAction } from "./context-menu.js";
import type { CircuitElement } from "@/core/element";

// ---------------------------------------------------------------------------
// PanelSet- the pair of collapsible side panels
// ---------------------------------------------------------------------------

/**
 * Abstracts a collapsible panel (palette or property panel).
 * Callers implement this with real DOM panels; tests use stubs.
 */
export interface CollapsiblePanel {
  /** Collapse the panel (hide its content). */
  collapse(): void;
  /** Expand the panel (show its content). */
  expand(): void;
  /** Returns true when the panel is currently collapsed. */
  isCollapsed(): boolean;
}

/**
 * The pair of side panels controlled by PresentationMode.
 */
export interface PanelSet {
  readonly palette: CollapsiblePanel;
  readonly propertyPanel: CollapsiblePanel;
}

// ---------------------------------------------------------------------------
// CanvasSize- width/height needed by fitToContent
// ---------------------------------------------------------------------------

export interface CanvasSize {
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// PresentationMode
// ---------------------------------------------------------------------------

/**
 * Manages presentation mode state and panel/viewport transitions.
 *
 * Usage:
 *   const mode = new PresentationMode(panels, canvasSize);
 *   mode.enter(viewport);    // hide panels, fit viewport
 *   mode.isActive();         // true
 *   mode.exit();             // restore panels and previous viewport
 *   mode.isActive();         // false
 *   mode.getToolbarActions() // play, pause, step, reset
 */
export class PresentationMode {
  private readonly _panels: PanelSet;
  private _canvasSize: CanvasSize;

  private _active = false;

  private _savedPaletteCollapsed = false;
  private _savedPropertyPanelCollapsed = false;
  private _savedZoom = 1.0;
  private _savedPan: { x: number; y: number } = { x: 0, y: 0 };

  private readonly _toolbarCallbacks: PresentationCallbacks;

  constructor(
    panels: PanelSet,
    canvasSize: CanvasSize,
    callbacks: PresentationCallbacks = {},
  ) {
    this._panels = panels;
    this._canvasSize = canvasSize;
    this._toolbarCallbacks = callbacks;
  }

  /**
   * Update the canvas size (call when the canvas is resized).
   */
  setCanvasSize(size: CanvasSize): void {
    this._canvasSize = { ...size };
  }

  /**
   * Enter presentation mode.
   *
   * Saves the current panel collapse state and viewport, collapses both
   * panels, and calls viewport.fitToContent() with the current canvas size.
   *
   * @param viewport  The circuit viewport. fitToContent is called on it.
   * @param elements  Circuit elements to fit- if omitted, fitToContent is
   *                  still called with an empty array so it resets to zoom=1.
   */
  enter(viewport: Viewport, elements: readonly CircuitElement[] = []): void {
    if (this._active) {
      return;
    }

    // Save current state
    this._savedPaletteCollapsed = this._panels.palette.isCollapsed();
    this._savedPropertyPanelCollapsed = this._panels.propertyPanel.isCollapsed();
    this._savedZoom = viewport.zoom;
    this._savedPan = { x: viewport.pan.x, y: viewport.pan.y };

    // Hide panels
    this._panels.palette.collapse();
    this._panels.propertyPanel.collapse();

    // Fit viewport to circuit content
    viewport.fitToContent(elements, this._canvasSize);

    this._active = true;
  }

  /**
   * Exit presentation mode.
   *
   * Restores panel visibility to the pre-enter state and restores the
   * previous zoom/pan on the viewport.
   *
   * @param viewport  The circuit viewport. Zoom and pan are restored.
   */
  exit(viewport?: Viewport): void {
    if (!this._active) {
      return;
    }

    // Restore panels
    if (!this._savedPaletteCollapsed) {
      this._panels.palette.expand();
    }
    if (!this._savedPropertyPanelCollapsed) {
      this._panels.propertyPanel.expand();
    }

    // Restore viewport
    if (viewport !== undefined) {
      viewport.zoom = this._savedZoom;
      viewport.pan = { x: this._savedPan.x, y: this._savedPan.y };
    }

    this._active = false;
  }

  /**
   * Returns true when presentation mode is active.
   */
  isActive(): boolean {
    return this._active;
  }

  /**
   * Returns the simplified toolbar actions for presentation mode.
   *
   * Only simulation controls are included: play, pause, step, reset.
   * Each action calls the corresponding callback from the constructor if
   * provided, otherwise the action is a no-op.
   */
  getToolbarActions(): MenuAction[] {
    const noop = () => {};
    return [
      {
        label: "play",
        action: this._toolbarCallbacks.play ?? noop,
        enabled: true,
      },
      {
        label: "pause",
        action: this._toolbarCallbacks.pause ?? noop,
        enabled: true,
      },
      {
        label: "step",
        action: this._toolbarCallbacks.step ?? noop,
        enabled: true,
      },
      {
        label: "reset",
        action: this._toolbarCallbacks.reset ?? noop,
        enabled: true,
      },
    ];
  }

  /**
   * Toggle presentation mode. Convenience wrapper for F4 binding.
   */
  toggle(viewport: Viewport, elements: readonly CircuitElement[] = []): void {
    if (this._active) {
      this.exit(viewport);
    } else {
      this.enter(viewport, elements);
    }
  }
}

// ---------------------------------------------------------------------------
// PresentationCallbacks- simulation control callbacks for the toolbar
// ---------------------------------------------------------------------------

export interface PresentationCallbacks {
  play?: () => void;
  pause?: () => void;
  step?: () => void;
  reset?: () => void;
}
