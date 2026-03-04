/**
 * label-tools.ts — Batch label manipulation utilities.
 *
 * All operations return reversible EditCommand objects for undo/redo support.
 * The "label" property key is the standard property name for component labels.
 */

import type { CircuitElement } from "@/core/element";
import type { Circuit } from "@/core/circuit";
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

// ---------------------------------------------------------------------------
// addLabelPrefix
// ---------------------------------------------------------------------------

/**
 * Prepend `prefix` to each element's current label.
 *
 * Elements without an existing label get a label equal to just the prefix.
 */
export function addLabelPrefix(
  elements: CircuitElement[],
  prefix: string,
): EditCommand {
  const previousLabels = elements.map((el) => {
    const bag = el.getProperties();
    return bag.has("label") ? String(bag.get("label")) : "";
  });

  return {
    description: `Add label prefix "${prefix}"`,

    execute(): void {
      elements.forEach((el, i) => {
        el.getProperties().set("label", `${prefix}${previousLabels[i] ?? ""}`);
      });
    },

    undo(): void {
      elements.forEach((el, i) => {
        el.getProperties().set("label", previousLabels[i] ?? "");
      });
    },
  };
}

// ---------------------------------------------------------------------------
// removeLabelPrefix
// ---------------------------------------------------------------------------

/**
 * Remove `prefix` from the start of each element's label.
 *
 * Labels that do not start with the prefix are left unchanged.
 */
export function removeLabelPrefix(
  elements: CircuitElement[],
  prefix: string,
): EditCommand {
  const previousLabels = elements.map((el) => {
    const bag = el.getProperties();
    return bag.has("label") ? String(bag.get("label")) : "";
  });

  return {
    description: `Remove label prefix "${prefix}"`,

    execute(): void {
      elements.forEach((el, i) => {
        const current = previousLabels[i] ?? "";
        const next = current.startsWith(prefix)
          ? current.slice(prefix.length)
          : current;
        el.getProperties().set("label", next);
      });
    },

    undo(): void {
      elements.forEach((el, i) => {
        el.getProperties().set("label", previousLabels[i] ?? "");
      });
    },
  };
}

// ---------------------------------------------------------------------------
// renameTunnel
// ---------------------------------------------------------------------------

/**
 * Rename all Tunnel components in the circuit whose label equals `oldName`
 * to `newName`.
 *
 * Tunnels are identified by typeId === "Tunnel" and their net name stored
 * in the "label" property.
 */
export function renameTunnel(
  circuit: Circuit,
  oldName: string,
  newName: string,
): EditCommand {
  const tunnels = circuit.elements.filter(
    (el) =>
      el.typeId === "Tunnel" &&
      el.getProperties().has("label") &&
      String(el.getProperties().get("label")) === oldName,
  );

  return {
    description: `Rename tunnel "${oldName}" to "${newName}"`,

    execute(): void {
      for (const el of tunnels) {
        el.getProperties().set("label", newName);
      }
    },

    undo(): void {
      for (const el of tunnels) {
        el.getProperties().set("label", oldName);
      }
    },
  };
}
