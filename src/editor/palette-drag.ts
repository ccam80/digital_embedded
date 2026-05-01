/**
 * PaletteDragController- manages touch-drag-to-canvas from the palette.
 *
 * Lifecycle:
 *   start(def, itemEl, startX, startY)- called when drag threshold is crossed
 *   move(clientX, clientY)            - update ghost position
 *   drop(clientX, clientY, canvas)    - drop over canvas → returns world point or null
 *   cancel()                          - animate back and clean up
 */

import type { ComponentDefinition } from "@/core/registry";
import type { Point } from "@/core/renderer-interface";
import { screenToWorld } from "./coordinates.js";
import type { Viewport } from "./viewport.js";

// ---------------------------------------------------------------------------
// PaletteDragController
// ---------------------------------------------------------------------------

export class PaletteDragController {
  private _ghost: HTMLElement | null = null;
  private _dimmedItem: HTMLElement | null = null;
  private _def: ComponentDefinition | null = null;
  private _originRect: DOMRect | null = null;

  get isDragging(): boolean {
    return this._ghost !== null;
  }

  get definition(): ComponentDefinition | null {
    return this._def;
  }

  /**
   * Begin drag. Creates the floating ghost element.
   *
   * @param def       The component definition being dragged.
   * @param itemEl    The palette item element (to dim + get origin).
   * @param clientX   Current touch client X.
   * @param clientY   Current touch client Y.
   */
  start(def: ComponentDefinition, itemEl: HTMLElement, clientX: number, clientY: number): void {
    this.cancel(); // Clean up any previous drag

    this._def = def;
    this._dimmedItem = itemEl;
    this._originRect = itemEl.getBoundingClientRect();

    // Dim the original item
    itemEl.style.opacity = '0.3';

    // Build ghost: clone the item for visual
    const ghost = document.createElement('div');
    ghost.className = 'palette-drag-ghost';
    ghost.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 1000;
      background: var(--panel-bg, #252526);
      border: 1px solid var(--accent, #569cd6);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      color: var(--fg, #d4d4d4);
      white-space: nowrap;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      transition: transform 0.05s ease;
      user-select: none;
      touch-action: none;
    `;
    ghost.textContent = def.name;

    document.body.appendChild(ghost);
    this._ghost = ghost;

    this._positionGhost(clientX, clientY, false);
  }

  /**
   * Move the ghost to follow the finger.
   *
   * @param clientX   Current touch client X.
   * @param clientY   Current touch client Y.
   * @param overCanvas Whether the finger is over the canvas element.
   */
  move(clientX: number, clientY: number, overCanvas: boolean): void {
    if (!this._ghost) return;
    this._positionGhost(clientX, clientY, overCanvas);
  }

  /**
   * Drop the component. Returns the snapped world-space point if dropped over
   * the canvas, otherwise null.
   *
   * @param clientX   Drop client X.
   * @param clientY   Drop client Y.
   * @param canvas    The circuit canvas element.
   * @param viewport  The current viewport (for coordinate conversion).
   */
  drop(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
    viewport: Viewport,
  ): Point | null {
    const rect = canvas.getBoundingClientRect();
    const overCanvas =
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom;

    this._cleanup();

    if (!overCanvas) return null;

    const screenPt: Point = { x: clientX - rect.left, y: clientY - rect.top };
    const worldPt = screenToWorld(screenPt, viewport.zoom, viewport.pan);
    // Snap to grid
    return {
      x: Math.round(worldPt.x),
      y: Math.round(worldPt.y),
    };
  }

  /**
   * Cancel the drag- animate ghost back to palette origin then clean up.
   */
  cancel(): void {
    if (!this._ghost) {
      this._restoreDimmedItem();
      return;
    }

    const ghost = this._ghost;
    const origin = this._originRect;

    if (origin) {
      // Animate back
      ghost.style.transition = 'left 0.2s ease, top 0.2s ease, opacity 0.2s ease';
      ghost.style.left = `${origin.left}px`;
      ghost.style.top = `${origin.top}px`;
      ghost.style.opacity = '0';
      setTimeout(() => {
        ghost.remove();
      }, 220);
    } else {
      ghost.remove();
    }

    this._ghost = null;
    this._restoreDimmedItem();
    this._def = null;
    this._originRect = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _positionGhost(clientX: number, clientY: number, overCanvas: boolean): void {
    if (!this._ghost) return;
    // Offset: 40px up, 20px right from finger tip
    const left = clientX + 20;
    const top = clientY - 40;
    this._ghost.style.left = `${left}px`;
    this._ghost.style.top = `${top}px`;

    if (overCanvas) {
      this._ghost.style.transform = 'scale(1.1)';
      this._ghost.style.boxShadow = '0 6px 24px rgba(86,156,214,0.5)';
    } else {
      this._ghost.style.transform = 'scale(1.0)';
      this._ghost.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
    }
  }

  private _cleanup(): void {
    if (this._ghost) {
      this._ghost.remove();
      this._ghost = null;
    }
    this._restoreDimmedItem();
    this._def = null;
    this._originRect = null;
  }

  private _restoreDimmedItem(): void {
    if (this._dimmedItem) {
      this._dimmedItem.style.opacity = '';
      this._dimmedItem = null;
    }
  }
}


