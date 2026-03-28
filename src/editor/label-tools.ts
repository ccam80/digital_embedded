/**
 * label-tools.ts — Batch label manipulation utilities.
 *
 * All operations return reversible EditCommand objects for undo/redo support.
 * The "label" property key is the standard property name for component labels.
 */

import type { CircuitElement } from "@/core/element";
import type { EditCommand } from "./undo-redo.js";

// ---------------------------------------------------------------------------
// autoNumberLabels
// ---------------------------------------------------------------------------

/**
 * Assign sequential labels to the given elements: `prefix + startFrom`,
 * `prefix + (startFrom + 1)`, etc.
 *
 * Returns a reversible EditCommand. execute() applies the new labels;
 * undo() restores the previous labels.
 */
export function autoNumberLabels(
  elements: CircuitElement[],
  prefix: string,
  startFrom: number,
): EditCommand {
  const previousLabels = elements.map((el) => {
    const bag = el.getProperties();
    return bag.has("label") ? String(bag.get("label")) : "";
  });

  return {
    description: `Auto-number labels with prefix "${prefix}" from ${startFrom}`,

    execute(): void {
      elements.forEach((el, i) => {
        el.getProperties().set("label", `${prefix}${startFrom + i}`);
      });
    },

    undo(): void {
      elements.forEach((el, i) => {
        el.getProperties().set("label", previousLabels[i] ?? "");
      });
    },
  };
}

