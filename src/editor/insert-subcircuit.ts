/**
 * Insert-as-subcircuit: boundary analysis, circuit extraction, and stub insertion.
 *
 * Analyzes the selection boundary to identify wires that cross it, derives
 * domain-agnostic port labels and bit widths, builds Port elements for the
 * interface, and copies the selected elements and internal wires into a new
 * Circuit that can become a reusable subcircuit definition.
 */

import { Circuit, Wire } from "@/core/circuit.js";
import type { CircuitElement } from "@/core/element.js";
import { pinWorldPosition } from "@/core/pin.js";
import type { Point } from "@/core/renderer-interface.js";
import type { EditCommand } from "./undo-redo.js";
import type { ComponentRegistry } from "@/core/registry.js";
import {
  SubcircuitElement,
  registerSubcircuit,
  type SubcircuitDefinition,
} from "@/components/subcircuit/subcircuit.js";
import { deriveInterfacePins } from "@/components/subcircuit/pin-derivation.js";
import { PortElement } from "@/components/io/port.js";
import { PropertyBag } from "@/core/properties.js";

// ---------------------------------------------------------------------------
// BoundaryPort — one wire crossing the selection boundary
// ---------------------------------------------------------------------------

/**
 * Describes a single wire that crosses the boundary between the selected
 * elements and the rest of the circuit. Domain-agnostic: no direction field.
 *
 * label    — derived from pin label + element label, deduplicated across ports
 * bitWidth — from the pin declaration on the selected element
 * position — world coordinate of the selected-element-side wire endpoint
 */
export interface BoundaryPort {
  wire: Wire;
  label: string;
  bitWidth: number;
  position: Point;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a point lies on a pin of one of the given elements.
 *
 * Returns the matching pin info (or undefined).
 */
function findPinAtPoint(
  elements: CircuitElement[],
  x: number,
  y: number,
): { element: CircuitElement; label: string; bitWidth: number } | undefined {
  for (const el of elements) {
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      if (wp.x === x && wp.y === y) {
        return {
          element: el,
          label: pin.label,
          bitWidth: pin.bitWidth,
        };
      }
    }
  }
  return undefined;
}

/**
 * Derive a port label from a pin label and element label.
 * Prefers the pin label; falls back to element label or "port".
 */
function deriveBaseLabel(pinLabel: string, elementLabel: string): string {
  if (pinLabel && pinLabel.length > 0) return pinLabel;
  if (elementLabel && elementLabel.length > 0) return elementLabel;
  return "port";
}

/**
 * Deduplicate a candidate label against an already-used set.
 * First occurrence keeps the base label; subsequent occurrences get _2, _3, etc.
 */
function deduplicateLabel(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}_${n}`)) {
    n++;
  }
  const unique = `${base}_${n}`;
  used.add(unique);
  return unique;
}

/**
 * Determine which face a position belongs to relative to a selection centroid.
 */
function assignFace(
  position: Point,
  centroid: Point,
): "left" | "right" | "top" | "bottom" {
  const dx = position.x - centroid.x;
  const dy = position.y - centroid.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "bottom" : "top";
}

/**
 * Compute the centroid of a set of elements.
 */
function selectionCentroid(elements: CircuitElement[]): Point {
  if (elements.length === 0) return { x: 0, y: 0 };
  let sumX = 0;
  let sumY = 0;
  for (const el of elements) {
    sumX += el.position.x;
    sumY += el.position.y;
  }
  return { x: sumX / elements.length, y: sumY / elements.length };
}

// ---------------------------------------------------------------------------
// analyzeBoundary
// ---------------------------------------------------------------------------

/**
 * Identify wires crossing the selection boundary without classifying direction.
 *
 * A wire crosses the boundary when exactly one of its endpoints coincides with
 * a pin of a selected element. Internal wires have both endpoints on selected
 * elements.
 *
 * Labels are derived from the connected pin's label and deduplicated: if two
 * boundary wires touch pins both labeled "out", the ports are labeled "out"
 * and "out_2".
 */
export function analyzeBoundary(
  circuit: Circuit,
  selectedElements: CircuitElement[],
  selectedWires: Wire[],
): { boundaryPorts: BoundaryPort[]; internalWires: Wire[] } {
  const boundaryPorts: BoundaryPort[] = [];
  const internalWires: Wire[] = [];
  const usedLabels = new Set<string>();

  for (const wire of circuit.wires) {
    const startPin = findPinAtPoint(selectedElements, wire.start.x, wire.start.y);
    const endPin = findPinAtPoint(selectedElements, wire.end.x, wire.end.y);

    const startSelected = startPin !== undefined;
    const endSelected = endPin !== undefined;

    if (startSelected && endSelected) {
      internalWires.push(wire);
      continue;
    }

    if (!startSelected && !endSelected) {
      continue;
    }

    // Exactly one endpoint touches a selected element — this is a boundary wire.
    const selectedPin = startSelected ? startPin! : endPin!;
    const position = startSelected ? wire.start : wire.end;

    const elementLabel = selectedPin.element.getProperties().getOrDefault<string>("label", "");
    const baseLabel = deriveBaseLabel(selectedPin.label, elementLabel);
    const label = deduplicateLabel(baseLabel, usedLabels);

    boundaryPorts.push({
      wire,
      label,
      bitWidth: selectedPin.bitWidth,
      position,
    });
  }

  // Also include selectedWires that are internal (both endpoints in selection)
  for (const wire of selectedWires) {
    if (!circuit.wires.includes(wire)) {
      const startPin = findPinAtPoint(selectedElements, wire.start.x, wire.start.y);
      const endPin = findPinAtPoint(selectedElements, wire.end.x, wire.end.y);
      if (startPin !== undefined && endPin !== undefined) {
        internalWires.push(wire);
      }
    }
  }

  return { boundaryPorts, internalWires };
}

// ---------------------------------------------------------------------------
// extractSubcircuit
// ---------------------------------------------------------------------------

/**
 * Create a new Circuit from the selected elements, internal wires, and Port
 * elements at each boundary crossing position.
 *
 * Each boundary port becomes a Port element positioned at the selected-element-
 * side endpoint of the boundary wire. Face is assigned based on the port's
 * position relative to the selection centroid.
 *
 * The new circuit contains:
 *   - All selected elements (by reference — callers clone if needed).
 *   - All internal wires.
 *   - One Port element per boundary crossing.
 */
export function extractSubcircuit(
  selectedElements: CircuitElement[],
  internalWires: Wire[],
  boundaryPorts: BoundaryPort[],
): Circuit {
  const subcircuit = new Circuit({ name: "Subcircuit" });

  for (const el of selectedElements) {
    subcircuit.addElement(el);
  }

  for (const wire of internalWires) {
    subcircuit.addWire(wire);
  }

  const centroid = selectionCentroid(selectedElements);

  for (const bp of boundaryPorts) {
    const face = assignFace(bp.position, centroid);
    const props = new PropertyBag();
    props.set("label", bp.label);
    props.set("bitWidth", bp.bitWidth);
    props.set("face", face);
    props.set("sortOrder", 0);

    const portEl = new PortElement(
      crypto.randomUUID(),
      bp.position,
      0,
      false,
      props,
    );
    subcircuit.addElement(portEl);
  }

  return subcircuit;
}

// ---------------------------------------------------------------------------
// Grid snapping helper
// ---------------------------------------------------------------------------

/**
 * Snap a position to the nearest integer grid unit.
 */
function snapToGrid(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

// ---------------------------------------------------------------------------
// insertAsSubcircuit
// ---------------------------------------------------------------------------

/**
 * Orchestrate the full "insert selection as subcircuit" workflow.
 *
 * Steps:
 *   1. Analyze the boundary to find crossing wires (domain-agnostic).
 *   2. Extract a new Circuit containing the selected items + Port elements.
 *   3. Derive interface pins from Port elements in the extracted circuit.
 *   4. Register the subcircuit in the registry.
 *   5. Create a SubcircuitElement at the selection centroid and reconnect
 *      boundary wires to its pins.
 *
 * Returns the extracted subcircuit Circuit and an atomic EditCommand for
 * undo/redo. Undo restores the original elements and wires; redo replaces
 * them with the subcircuit instance.
 */
export function insertAsSubcircuit(
  circuit: Circuit,
  selectedElements: CircuitElement[],
  selectedWires: Wire[],
  registry?: ComponentRegistry,
  name?: string,
): { subcircuit: Circuit; command: EditCommand; instance: SubcircuitElement } {
  const { boundaryPorts, internalWires } = analyzeBoundary(circuit, selectedElements, selectedWires);

  const subcircuit = extractSubcircuit(selectedElements, internalWires, boundaryPorts);
  const subcircuitName = name ?? `Subcircuit_${Date.now()}`;

  const pinLayout = deriveInterfacePins(subcircuit);

  const definition: SubcircuitDefinition = {
    circuit: subcircuit,
    pinLayout,
    shapeMode: "DEFAULT",
    name: subcircuitName,
  };

  if (registry) {
    registerSubcircuit(registry, subcircuitName, definition);
  }

  // Create the SubcircuitElement instance at the selection centroid.
  const centroid = selectionCentroid(selectedElements);
  const instancePosition = snapToGrid(centroid);

  const instanceProps = new PropertyBag();
  instanceProps.set("label", "");
  instanceProps.set("shapeType", "DEFAULT");

  const instance = new SubcircuitElement(
    `Subcircuit:${subcircuitName}`,
    crypto.randomUUID(),
    instancePosition,
    0,
    false,
    instanceProps,
    definition,
  );

  // Build reconnected wires: for each boundary port, find the matching pin on
  // the subcircuit instance by label and wire from the external endpoint to
  // the pin's world position.
  const reconnectedWires: Wire[] = [];
  const instancePins = instance.getPins();

  for (const bp of boundaryPorts) {
    const matchPin = instancePins.find(p => p.label === bp.label);
    if (!matchPin) continue;

    const pinWorld = pinWorldPosition(instance, matchPin);

    // The external endpoint is the endpoint of the boundary wire that does NOT
    // touch the selected elements (i.e., the opposite end from bp.position).
    const externalEndpoint =
      (bp.wire.start.x === bp.position.x && bp.wire.start.y === bp.position.y)
        ? bp.wire.end
        : bp.wire.start;

    reconnectedWires.push(new Wire(externalEndpoint, pinWorld, bp.bitWidth));
  }

  // Capture state for undo
  const removedElements = [...selectedElements];
  const removedWires = [...selectedWires, ...internalWires];
  const removedBoundaryWires = boundaryPorts.map(bp => bp.wire);

  const command: EditCommand = {
    description: "Insert selection as subcircuit",
    execute(): void {
      for (const el of removedElements) {
        const idx = circuit.elements.indexOf(el);
        if (idx >= 0) circuit.elements.splice(idx, 1);
      }
      for (const w of [...removedWires, ...removedBoundaryWires]) {
        circuit.removeWire(w);
      }
      circuit.addElement(instance);
      for (const w of reconnectedWires) {
        circuit.addWire(w);
      }
    },
    undo(): void {
      circuit.elements.splice(circuit.elements.indexOf(instance), 1);
      for (const w of reconnectedWires) {
        circuit.removeWire(w);
      }
      for (const el of removedElements) {
        circuit.addElement(el);
      }
      for (const w of [...removedWires, ...removedBoundaryWires]) {
        circuit.addWire(w);
      }
    },
  };

  return { subcircuit, command, instance };
}
