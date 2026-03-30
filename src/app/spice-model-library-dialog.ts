/**
 * Circuit-level SPICE model library dialog.
 *
 * Opened from the main menu ("SPICE Models...").
 */

import type { Circuit } from '../core/circuit.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open the circuit-level SPICE model library dialog.
 *
 * @param circuit   The active circuit whose metadata holds the model library.
 * @param container The DOM container to attach the overlay to.
 * @param onChange  Called whenever the library is modified (add/remove).
 */
export function openSpiceModelLibraryDialog(
  _circuit: Circuit,
  _container: HTMLElement,
  _onChange: () => void,
): void {
  throw new Error("openSpiceModelLibraryDialog: pending reimplementation with unified model system");
}
