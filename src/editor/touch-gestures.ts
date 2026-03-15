/**
 * Touch gesture tracker for multi-finger canvas interactions.
 *
 * State machine:
 *   IDLE → ONE_FINGER_WAIT (1 touch pointer down)
 *        → ONE_FINGER_PAN  (after 5px movement on empty canvas)
 *        → TWO_FINGER_PINCH (second touch pointer down)
 *
 * Only activated for pointerType === 'touch'. Mouse and pen bypass this tracker.
 *
 * setPointerCapture is NOT called here — deferred to Phase 3+.
 */

import type { Point } from "@/core/renderer-interface";
import type { Viewport } from "./viewport.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GestureState = 'IDLE' | 'ONE_FINGER_WAIT' | 'ONE_FINGER_PAN' | 'TWO_FINGER_PINCH';

interface PointerRecord {
  /** Current client position. */
  x: number;
  y: number;
  /** Position at time of pointerdown (for threshold check). */
  startX: number;
  startY: number;
  startTime: number;
}

/** Minimum pixel movement before one-finger pan activates. */
const PAN_THRESHOLD_PX = 5;

// ---------------------------------------------------------------------------
// TouchGestureTracker
// ---------------------------------------------------------------------------

export class TouchGestureTracker {
  private _state: GestureState = 'IDLE';
  private _pointers = new Map<number, PointerRecord>();

  /** Last midpoint used for pinch (client coords). */
  private _lastPinchMidpoint: Point = { x: 0, y: 0 };
  /** Last pinch distance in pixels. */
  private _lastPinchDistance = 0;

  /**
   * Whether the initial one-finger touch landed on empty canvas.
   * Set by the caller when registering the first pointer.
   */
  private _hitEmpty = false;

  get state(): GestureState {
    return this._state;
  }

  get isActive(): boolean {
    return this._state === 'ONE_FINGER_PAN' || this._state === 'TWO_FINGER_PINCH';
  }

  /**
   * Call on pointerdown for touch pointers.
   *
   * @param e        The pointer event.
   * @param hitEmpty Whether the touch landed on empty canvas (no element/pin).
   * @returns true if this tracker accepted the pointer.
   */
  onPointerDown(e: PointerEvent, hitEmpty: boolean): boolean {
    if (e.pointerType !== 'touch') return false;

    this._pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      startTime: performance.now(),
    });

    if (this._pointers.size === 1) {
      this._state = 'ONE_FINGER_WAIT';
      this._hitEmpty = hitEmpty;
    } else if (this._pointers.size === 2) {
      this._state = 'TWO_FINGER_PINCH';
      this._initPinch();
    }
    // 3+ fingers: ignore additional pointers

    return true;
  }

  /**
   * Call on pointermove for touch pointers.
   *
   * @returns true if the gesture consumed the event (caller should skip normal drag logic).
   */
  onPointerMove(
    e: PointerEvent,
    canvas: HTMLCanvasElement,
    viewport: Viewport,
    scheduleRender: () => void,
  ): boolean {
    if (e.pointerType !== 'touch') return false;

    const rec = this._pointers.get(e.pointerId);
    if (!rec) return false;

    // Capture previous position before updating
    const prevX = rec.x;
    const prevY = rec.y;

    // Update current position
    rec.x = e.clientX;
    rec.y = e.clientY;

    if (this._state === 'ONE_FINGER_WAIT') {
      const dx = e.clientX - rec.startX;
      const dy = e.clientY - rec.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= PAN_THRESHOLD_PX && this._hitEmpty) {
        this._state = 'ONE_FINGER_PAN';
        // Fall through to apply first pan delta
      } else {
        return false; // still waiting — let normal logic handle
      }
    }

    if (this._state === 'ONE_FINGER_PAN') {
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const prevScreenX = prevX - rect.left;
      const prevScreenY = prevY - rect.top;
      viewport.panBy({ x: screenX - prevScreenX, y: screenY - prevScreenY });
      scheduleRender();
      return true;
    }

    if (this._state === 'TWO_FINGER_PINCH') {
      this._applyPinch(canvas, viewport, scheduleRender);
      return true;
    }

    return false;
  }

  /** Call on pointerup/pointercancel for touch pointers. */
  onPointerUp(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    this._pointers.delete(e.pointerId);

    if (this._pointers.size === 0) {
      this._state = 'IDLE';
    } else if (this._pointers.size === 1 && this._state === 'TWO_FINGER_PINCH') {
      // One finger lifted from pinch — wait mode for remaining finger
      this._state = 'ONE_FINGER_WAIT';
      this._hitEmpty = true; // After pinch, treat as empty canvas pan
      for (const [, rec] of this._pointers) {
        rec.startX = rec.x;
        rec.startY = rec.y;
        rec.startTime = performance.now();
      }
    }
  }

  /** Reset all gesture state (e.g. on pointercancel). */
  reset(): void {
    this._pointers.clear();
    this._state = 'IDLE';
    this._lastPinchDistance = 0;
    this._hitEmpty = false;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _initPinch(): void {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = [pts[0]!, pts[1]!];
    this._lastPinchMidpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this._lastPinchDistance = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  }

  private _applyPinch(
    canvas: HTMLCanvasElement,
    viewport: Viewport,
    scheduleRender: () => void,
  ): void {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = [pts[0]!, pts[1]!];

    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const distance = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

    const rect = canvas.getBoundingClientRect();
    const screenMid: Point = { x: midX - rect.left, y: midY - rect.top };

    // Zoom toward/away from midpoint
    if (this._lastPinchDistance > 0) {
      const zoomDelta = distance / this._lastPinchDistance;
      viewport.zoomAt(screenMid, zoomDelta);
    }

    // Pan from midpoint drift
    const panDx = midX - this._lastPinchMidpoint.x;
    const panDy = midY - this._lastPinchMidpoint.y;
    if (panDx !== 0 || panDy !== 0) {
      viewport.panBy({ x: panDx, y: panDy });
    }

    this._lastPinchDistance = distance;
    this._lastPinchMidpoint = { x: midX, y: midY };

    scheduleRender();
  }
}
