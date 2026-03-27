/**
 * Edit operations — all mutations to the circuit model.
 *
 * Each function returns an EditCommand: an object with execute() and undo()
 * that the UndoRedoStack can push, undo, and redo.
 *
 * Grid-snap is applied to all position changes (gridSize=1).
 */

import type { CircuitElement } from "@/core/element";
import type { Rotation } from "@/core/pin";
import { Wire, Circuit } from "@/core/circuit";
import type { ComponentDefinition } from "@/core/registry";
import { PropertyBag } from "@/core/properties";
import { snapToGrid } from "@/editor/coordinates";
import { renameLabelsOnCopy } from "@/editor/label-renamer";
import type { EditCommand } from "@/editor/undo-redo";


export type { EditCommand };

// ---------------------------------------------------------------------------
// ClipboardData — internal clipboard for cut/copy/paste
// ---------------------------------------------------------------------------

/**
 * Internal clipboard entry for one element on the clipboard.
 * Stores the element's type definition and a snapshot of its state.
 */
export interface ClipboardEntry {
  /** The component definition, used to call factory() when pasting. */
  readonly definition: ComponentDefinition;
  /** Snapshot of property values at time of copy. */
  readonly properties: PropertyBag;
  /** Position relative to the first element in the clipboard (for group paste). */
  readonly relativePosition: { x: number; y: number };
  /** Rotation at copy time. */
  readonly rotation: Rotation;
  /** Mirror at copy time. */
  readonly mirror: boolean;
  /** Label at time of copy (may be renamed on paste). */
  readonly label: string | undefined;
}

/**
 * A clipboard snapshot holding a group of elements and wires.
 * Not the system clipboard — purely in-memory.
 */
export interface ClipboardData {
  readonly entries: ClipboardEntry[];
  /** Wire topology within the clipboard group (as relative offsets). */
  readonly wires: Array<{ startRel: { x: number; y: number }; endRel: { x: number; y: number } }>;
}

// ---------------------------------------------------------------------------
// moveSelection
// ---------------------------------------------------------------------------

/**
 * Move all selected elements and wires by the given delta (grid-snapped).
 * Returns a reversible EditCommand.
 */
export function moveSelection(
  elements: CircuitElement[],
  wires: Wire[],
  delta: { x: number; y: number },
): EditCommand {
  const snapped = snapToGrid(delta, 1);
  const dx = snapped.x;
  const dy = snapped.y;

  // Snapshot original positions for undo
  const originalPositions = elements.map((el) => ({ x: el.position.x, y: el.position.y }));
  const originalWirePoints = wires.map((w) => ({
    start: { x: w.start.x, y: w.start.y },
    end: { x: w.end.x, y: w.end.y },
  }));

  return {
    description: "Move",
    execute(): void {
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i]!;
        el.position = { x: el.position.x + dx, y: el.position.y + dy };
      }
      for (const wire of wires) {
        wire.start = { x: wire.start.x + dx, y: wire.start.y + dy };
        wire.end = { x: wire.end.x + dx, y: wire.end.y + dy };
      }
    },
    undo(): void {
      for (let i = 0; i < elements.length; i++) {
        elements[i]!.position = { x: originalPositions[i]!.x, y: originalPositions[i]!.y };
      }
      for (let i = 0; i < wires.length; i++) {
        wires[i]!.start = { x: originalWirePoints[i]!.start.x, y: originalWirePoints[i]!.start.y };
        wires[i]!.end = { x: originalWirePoints[i]!.end.x, y: originalWirePoints[i]!.end.y };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// rotateSelection
// ---------------------------------------------------------------------------

/**
 * Rotate all selected elements by one quarter-turn clockwise (0→1→2→3→0).
 * Returns a reversible EditCommand.
 */
export function rotateSelection(elements: CircuitElement[]): EditCommand {
  const originalRotations = elements.map((el) => el.rotation);

  return {
    description: "Rotate",
    execute(): void {
      for (const el of elements) {
        el.rotation = ((el.rotation + 1) % 4) as Rotation;
      }
    },
    undo(): void {
      for (let i = 0; i < elements.length; i++) {
        elements[i]!.rotation = originalRotations[i]!;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// mirrorSelection
// ---------------------------------------------------------------------------

/**
 * Toggle the mirror flag on all selected elements.
 * Returns a reversible EditCommand.
 */
export function mirrorSelection(elements: CircuitElement[]): EditCommand {
  const originalMirrors = elements.map((el) => el.mirror);

  return {
    description: "Mirror",
    execute(): void {
      for (const el of elements) {
        el.mirror = !el.mirror;
      }
    },
    undo(): void {
      for (let i = 0; i < elements.length; i++) {
        elements[i]!.mirror = originalMirrors[i]!;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// deleteSelection
// ---------------------------------------------------------------------------

/**
 * Remove selected elements and wires from the circuit.
 * Only removes explicitly selected items — does not cascade to connected wires.
 * Returns a reversible EditCommand.
 */
export function deleteSelection(
  circuit: Circuit,
  elements: CircuitElement[],
  wires: Wire[],
): EditCommand {
  // Only delete explicitly selected wires — do NOT cascade to wires
  // connected to deleted elements. The user's selection is authoritative.
  const allWiresToDelete = [...wires];

  // Snapshot positions in the circuit arrays for undo
  const elementIndices = elements.map((el) => circuit.elements.indexOf(el));
  const wireIndices = allWiresToDelete.map((w) => circuit.wires.indexOf(w));

  // Zero-length wires orphaned by element deletion are captured at execute
  // time and removed. Undo restores them (they were part of the original
  // circuit state, even if degenerate).
  let orphanedZeroLengthWires: Wire[] = [];

  return {
    description: "Delete",
    execute(): void {
      for (const el of elements) {
        circuit.removeElement(el);
      }
      for (const wire of allWiresToDelete) {
        circuit.removeWire(wire);
      }
      // After removing elements/wires, clean up any zero-length wires that
      // were previously masked by a component pin at the same position.
      orphanedZeroLengthWires = circuit.wires.filter(
        (w) => w.start.x === w.end.x && w.start.y === w.end.y,
      );
      for (const w of orphanedZeroLengthWires) {
        circuit.removeWire(w);
      }
    },
    undo(): void {
      // Re-insert zero-length wires first (they existed before deletion)
      for (const w of orphanedZeroLengthWires) {
        circuit.wires.push(w);
      }
      // Re-insert at original indices (in reverse deletion order)
      for (let i = elements.length - 1; i >= 0; i--) {
        const idx = elementIndices[i]!;
        if (idx >= 0 && idx <= circuit.elements.length) {
          circuit.elements.splice(idx, 0, elements[i]!);
        } else {
          circuit.elements.push(elements[i]!);
        }
      }
      for (let i = allWiresToDelete.length - 1; i >= 0; i--) {
        const idx = wireIndices[i]!;
        if (idx >= 0 && idx <= circuit.wires.length) {
          circuit.wires.splice(idx, 0, allWiresToDelete[i]!);
        } else {
          circuit.wires.push(allWiresToDelete[i]!);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// copyToClipboard
// ---------------------------------------------------------------------------

/**
 * Snapshot selected elements and wires into an internal ClipboardData.
 * This does NOT modify the circuit.
 *
 * Element positions are stored relative to the first element's position
 * so that paste can place them relative to the target position.
 */
export function copyToClipboard(
  elements: CircuitElement[],
  wires: Wire[],
  definitionResolver: (typeId: string) => ComponentDefinition | undefined,
): ClipboardData {
  if (elements.length === 0) {
    return { entries: [], wires: [] };
  }

  const origin = elements[0]!.position;

  const entries: ClipboardEntry[] = [];
  for (const el of elements) {
    const def = definitionResolver(el.typeId);
    if (def === undefined) {
      continue;
    }
    const props = el.getProperties().clone();
    const label = props.has("label") ? String(props.get("label")) : undefined;
    entries.push({
      definition: def,
      properties: props,
      relativePosition: {
        x: el.position.x - origin.x,
        y: el.position.y - origin.y,
      },
      rotation: el.rotation,
      mirror: el.mirror,
      label,
    });
  }

  const clipWires = wires.map((w) => ({
    startRel: { x: w.start.x - origin.x, y: w.start.y - origin.y },
    endRel: { x: w.end.x - origin.x, y: w.end.y - origin.y },
  }));

  return { entries, wires: clipWires };
}

// ---------------------------------------------------------------------------
// pasteFromClipboard
// ---------------------------------------------------------------------------

/**
 * Paste clipboard contents at the given position.
 * Each element gets a new unique instanceId.
 * Labels are renamed via renameLabelsOnCopy.
 * Returns a reversible EditCommand.
 */
export function pasteFromClipboard(
  circuit: Circuit,
  clipboard: ClipboardData,
  position: { x: number; y: number },
): EditCommand {
  const snappedPos = snapToGrid(position, 1);
  const newElements: CircuitElement[] = [];
  const newWires: Wire[] = [];

  return {
    description: "Paste",
    execute(): void {
      newElements.length = 0;
      newWires.length = 0;

      for (const entry of clipboard.entries) {
        const props = entry.properties.clone();
        const el = entry.definition.factory(props);
        el.position = {
          x: snappedPos.x + entry.relativePosition.x,
          y: snappedPos.y + entry.relativePosition.y,
        };
        el.rotation = entry.rotation;
        el.mirror = entry.mirror;
        newElements.push(el);
        circuit.addElement(el);
      }

      renameLabelsOnCopy(newElements, circuit.elements);

      for (const wireTemplate of clipboard.wires) {
        const wire = new Wire(
          { x: snappedPos.x + wireTemplate.startRel.x, y: snappedPos.y + wireTemplate.startRel.y },
          { x: snappedPos.x + wireTemplate.endRel.x, y: snappedPos.y + wireTemplate.endRel.y },
        );
        newWires.push(wire);
        circuit.addWire(wire);
      }
    },
    undo(): void {
      for (const el of newElements) {
        circuit.removeElement(el);
      }
      for (const wire of newWires) {
        circuit.removeWire(wire);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// placeComponent
// ---------------------------------------------------------------------------

/**
 * Place a new component in the circuit.
 * Returns a reversible EditCommand.
 */
export function placeComponent(
  circuit: Circuit,
  element: CircuitElement,
): EditCommand {
  return {
    description: "Place component",
    execute(): void {
      circuit.addElement(element);
    },
    undo(): void {
      circuit.removeElement(element);
    },
  };
}

