/**
 * Actual-to-Default and Fuse Reset menu actions.
 *
 * captureRuntimeToDefaults — snapshot current simulation values onto component
 *   property defaults. Components that expose a "value" property (registers,
 *   counters, etc.) have that property's stored default updated to the live
 *   signal value so the circuit boots into its last-observed state.
 *
 * restoreAllFuses — traverse all Fuse components in the circuit and reset their
 *   "blown" property to false.
 *
 * Both operations return an EditCommand so they integrate with UndoRedoStack.
 */

import type { Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { EditCommand } from "./undo-redo.js";
import type { PropertyValue } from "@/core/properties";

// ---------------------------------------------------------------------------
// ElementSignalAccess — engine bridge for reading live element output values
// ---------------------------------------------------------------------------

/**
 * Abstraction over the live simulation engine, used only by
 * captureRuntimeToDefaults.
 *
 * Implementors in Phase 6 will bridge this to the running engine.
 * Tests provide a mock implementation.
 */
export interface ElementSignalAccess {
  /**
   * Returns the current output value for the given element, or undefined when
   * the element has no observable runtime output (e.g. purely combinatorial
   * gates with no state).
   */
  getElementValue(element: CircuitElement): number | undefined;
}

// ---------------------------------------------------------------------------
// captureRuntimeToDefaults
// ---------------------------------------------------------------------------

/**
 * Snapshot runtime signal values onto component property defaults.
 *
 * For each element that has a "value" property AND the signal access reports a
 * current value, the property default is overwritten with that value. The
 * returned command is undoable — undo restores the original property values.
 */
export function captureRuntimeToDefaults(
  circuit: Circuit,
  signalAccess: ElementSignalAccess,
): EditCommand {
  // Capture originals before any mutation.
  const snapshots: Array<{
    element: CircuitElement;
    originalValue: PropertyValue;
    newValue: number;
  }> = [];

  for (const element of circuit.elements) {
    const bag = element.getProperties();
    if (!bag.has("value")) continue;

    const liveValue = signalAccess.getElementValue(element);
    if (liveValue === undefined) continue;

    const original = bag.get<PropertyValue>("value");
    snapshots.push({ element, originalValue: original, newValue: liveValue });
  }

  return {
    description: "Capture runtime values to defaults",

    execute(): void {
      for (const { element, newValue } of snapshots) {
        element.getProperties().set("value", newValue);
      }
    },

    undo(): void {
      for (const { element, originalValue } of snapshots) {
        element.getProperties().set("value", originalValue);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// restoreAllFuses
// ---------------------------------------------------------------------------

/**
 * Reset every Fuse component's "blown" property to false.
 *
 * Returns an undoable EditCommand. Undo restores the pre-reset blown states.
 */
export function restoreAllFuses(circuit: Circuit): EditCommand {
  const fuseElements = circuit.elements.filter(
    (el) => el.typeId === "Fuse",
  );

  // Capture originals before any mutation.
  const originals: Array<{ element: CircuitElement; wasBlown: boolean }> =
    fuseElements.map((el) => ({
      element: el,
      wasBlown: el.getProperties().getOrDefault<boolean>("blown", false),
    }));

  return {
    description: "Restore all fuses",

    execute(): void {
      for (const { element } of originals) {
        element.getProperties().set("blown", false);
      }
    },

    undo(): void {
      for (const { element, wasBlown } of originals) {
        element.getProperties().set("blown", wasBlown);
      }
    },
  };
}
