/**
 * Shared mutable state for canvas interaction handlers.
 *
 * All pointer/drag/touch state that must be accessible across
 * pointerdown, pointermove, pointerup, and dblclick handlers lives here
 * as a single context object passed to each handler module.
 */

import { TouchGestureTracker } from '../editor/touch-gestures.js';

// ---------------------------------------------------------------------------
// Drag state machine
// ---------------------------------------------------------------------------

export type DragMode = 'none' | 'pan' | 'select-drag' | 'wire-drag' | 'box-select';

// ---------------------------------------------------------------------------
// Shared canvas interaction state
// ---------------------------------------------------------------------------

export interface CanvasState {
  // Drag state machine
  dragMode: DragMode;
  dragStart: { x: number; y: number };
  dragStartScreen: { x: number; y: number };

  // Pointer tracking (mouse/pen)
  activePointerId: number | null;
  pointerType: string;

  // Long-press context menu (touch only)
  longPressTimer: ReturnType<typeof setTimeout> | null;
  longPressStartX: number;
  longPressStartY: number;
  longPressClientX: number;
  longPressClientY: number;

  // Touch gesture tracker
  touchGestures: TouchGestureTracker;
}

export function createCanvasState(): CanvasState {
  return {
    dragMode: 'none',
    dragStart: { x: 0, y: 0 },
    dragStartScreen: { x: 0, y: 0 },
    activePointerId: null,
    pointerType: 'mouse',
    longPressTimer: null,
    longPressStartX: 0,
    longPressStartY: 0,
    longPressClientX: 0,
    longPressClientY: 0,
    touchGestures: new TouchGestureTracker(),
  };
}

// ---------------------------------------------------------------------------
// Hit-test thresholds (shared constants)
// ---------------------------------------------------------------------------

export const HIT_THRESHOLD = 0.5;
export const TOUCH_HIT_THRESHOLD = 1.5;
export const TOUCH_HIT_MARGIN = 0.5;
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_MOVE_THRESHOLD = 10;
