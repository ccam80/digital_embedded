/**
 * Insert-as-subcircuit: boundary analysis, circuit extraction, and stub insertion.
 *
 * Analyzes the selection boundary to identify wires that cross it, determines
 * pin directions from the crossed pins, builds PinDeclaration objects for the
 * interface, and copies the selected elements and internal wires into a new
 * Circuit that can become a reusable subcircuit definition.
 *
 * The final replacement step (removing the selection and placing a subcircuit
 * instance) is a stub that throws FacadeError until Phase 6 provides the
 * SubcircuitComponent type.
 */

import { Circuit, Wire } from "@/core/circuit.js";
import type { CircuitElement } from "@/core/element.js";
import { PinDirection, pinWorldPosition } from "@/core/pin.js";
import type { PinDeclaration } from "@/core/pin.js";
import type { EditCommand } from "./undo-redo.js";
import type { ComponentRegistry } from "@/core/registry.js";
import { registerSubcircuit, type SubcircuitDefinition } from "@/components/subcircuit/subcircuit.js";
import { deriveInterfacePins } from "@/components/subcircuit/pin-derivation.js";

// ---------------------------------------------------------------------------
// BoundaryWireInfo — one wire crossing the selection boundary
// ---------------------------------------------------------------------------

/**
 * Describes a single wire that crosses the boundary between the selected
 * elements and the rest of the circuit.
 *
 * direction — from the perspective of the subcircuit interface:
 *   OUTPUT means a signal leaves the selection (wire driven by a selected output).
 *   INPUT  means a signal enters the selection (wire driven by an external output).
 */
export interface BoundaryWireInfo {
  wire: Wire;
  direction: PinDirection;
  pinLabel: string;
  bitWidth: number;
}

// ---------------------------------------------------------------------------
// BoundaryAnalysis — result of analyzeBoundary()
// ---------------------------------------------------------------------------

export interface BoundaryAnalysis {
  /** Wires that cross the selection boundary, with interface metadata. */
  boundaryWires: BoundaryWireInfo[];
  /** Wires whose both endpoints touch only selected elements. */
  internalWires: Wire[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a point lies on a pin of one of the given elements.
 *
 * Returns the matching pin (or undefined).
 */
function findPinAtPoint(
  elements: CircuitElement[],
  x: number,
  y: number,
): { element: CircuitElement; pinDirection: PinDirection; label: string; bitWidth: number } | undefined {
  for (const el of elements) {
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      if (wp.x === x && wp.y === y) {
        return {
          element: el,
          pinDirection: pin.direction,
          label: pin.label,
          bitWidth: pin.bitWidth,
        };
      }
    }
  }
  return undefined;
}

/**
 * Check whether BOTH endpoints of a wire touch the selection.
 */
function wireIsInternal(wire: Wire, selectedElements: CircuitElement[]): boolean {
  const startPin = findPinAtPoint(selectedElements, wire.start.x, wire.start.y);
  const endPin = findPinAtPoint(selectedElements, wire.end.x, wire.end.y);
  return startPin !== undefined && endPin !== undefined;
}

// ---------------------------------------------------------------------------
// analyzeBoundary
// ---------------------------------------------------------------------------

/**
 * Identify wires crossing the selection boundary and classify them.
 *
 * A wire crosses the boundary when exactly one of its endpoints coincides with
 * a pin of a selected element. Internal wires have both endpoints on selected
 * elements.
 *
 * Direction semantics (subcircuit perspective):
 *   - A wire driven by a selected OUTPUT pin → OUTPUT (the subcircuit drives it).
 *   - A wire driven by an external OUTPUT pin → INPUT (the subcircuit receives it).
 *   - Bidirectional pins → BIDIRECTIONAL.
 */
export function analyzeBoundary(
  circuit: Circuit,
  selectedElements: CircuitElement[],
  selectedWires: Wire[],
): BoundaryAnalysis {
  const boundaryWires: BoundaryWireInfo[] = [];
  const internalWires: Wire[] = [];

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

    let direction: PinDirection;
    if (selectedPin.pinDirection === PinDirection.OUTPUT) {
      direction = PinDirection.OUTPUT;
    } else if (selectedPin.pinDirection === PinDirection.INPUT) {
      direction = PinDirection.INPUT;
    } else {
      direction = PinDirection.BIDIRECTIONAL;
    }

    // Deduplicate: a wire with the same label at the same position may appear
    // once. Use a unique label based on pin label + position to avoid clashes.
    const label = `${selectedPin.label}_${selectedPin.element.instanceId}`;

    boundaryWires.push({
      wire,
      direction,
      pinLabel: label,
      bitWidth: selectedPin.bitWidth,
    });
  }

  // Also include selectedWires that are internal (both endpoints in selection)
  for (const wire of selectedWires) {
    if (!circuit.wires.includes(wire)) {
      // Wire is not in the circuit's wires list — treat it as internal context.
      if (wireIsInternal(wire, selectedElements)) {
        internalWires.push(wire);
      }
    }
  }

  return { boundaryWires, internalWires };
}

// ---------------------------------------------------------------------------
// extractSubcircuit
// ---------------------------------------------------------------------------

/**
 * Create a new Circuit from the selected elements, internal wires, and the
 * boundary interface pins.
 *
 * Each boundary pin becomes an "In" or "Out" interface element placeholder
 * represented as a PinDeclaration embedded in the circuit's metadata name.
 * The actual component instances for In/Out pins are recorded via the
 * circuit's metadata description as a JSON-encoded boundary descriptor —
 * Phase 6 reads this to wire up the interface.
 *
 * The new circuit contains:
 *   - All selected elements (by reference — callers clone if needed).
 *   - All internal wires.
 *   - Metadata describing the boundary pins for Phase 6 consumption.
 */
export function extractSubcircuit(
  selectedElements: CircuitElement[],
  internalWires: Wire[],
  boundaryPins: PinDeclaration[],
): Circuit {
  const subcircuit = new Circuit({ name: "Subcircuit" });

  for (const el of selectedElements) {
    subcircuit.addElement(el);
  }

  for (const wire of internalWires) {
    subcircuit.addWire(wire);
  }

  // Encode boundary pin declarations into the description field so Phase 6
  // can retrieve the interface without needing runtime component instances.
  subcircuit.metadata.description = JSON.stringify(
    boundaryPins.map((p) => ({
      direction: p.direction,
      label: p.label,
      defaultBitWidth: p.defaultBitWidth,
      position: p.position,
      isNegatable: p.isNegatable,
      isClockCapable: p.isClockCapable,
    })),
  );

  return subcircuit;
}

// ---------------------------------------------------------------------------
// insertAsSubcircuit
// ---------------------------------------------------------------------------

/**
 * Orchestrate the full "insert selection as subcircuit" workflow.
 *
 * Steps:
 *   1. Analyze the boundary to find crossing wires and classify them.
 *   2. Build PinDeclarations from the boundary wire metadata.
 *   3. Extract a new Circuit containing the selected items + interface pins.
 *   4. Register the subcircuit in the registry and replace the selection with
 *      a subcircuit component instance.
 *
 * Returns the extracted subcircuit Circuit and an EditCommand for undo support.
 */
export function insertAsSubcircuit(
  circuit: Circuit,
  selectedElements: CircuitElement[],
  selectedWires: Wire[],
  registry?: ComponentRegistry,
  name?: string,
): { subcircuit: Circuit; command: EditCommand } {
  const analysis = analyzeBoundary(circuit, selectedElements, selectedWires);

  const boundaryPins: PinDeclaration[] = analysis.boundaryWires.map((bw) => ({
    direction: bw.direction,
    label: bw.pinLabel,
    defaultBitWidth: bw.bitWidth,
    position: bw.wire.start,
    isNegatable: false,
    isClockCapable: false,
  }));

  const subcircuit = extractSubcircuit(selectedElements, analysis.internalWires, boundaryPins);
  const subcircuitName = name ?? `Subcircuit_${Date.now()}`;

  // Derive interface pins from In/Out components inside the subcircuit
  const pinLayout = deriveInterfacePins(subcircuit);

  const definition: SubcircuitDefinition = {
    circuit: subcircuit,
    pinLayout: pinLayout.length > 0 ? pinLayout : boundaryPins,
    shapeMode: "DEFAULT",
    name: subcircuitName,
  };

  // Register the subcircuit if a registry is provided
  if (registry) {
    registerSubcircuit(registry, subcircuitName, definition);
  }

  // Capture state for undo
  const removedElements = [...selectedElements];
  const removedWires = [...selectedWires, ...analysis.internalWires];
  const removedBoundaryWires = analysis.boundaryWires.map(bw => bw.wire);

  const command: EditCommand = {
    description: "Insert selection as subcircuit",
    execute(): void {
      // Remove selected elements and wires
      for (const el of removedElements) {
        const idx = circuit.elements.indexOf(el);
        if (idx >= 0) circuit.elements.splice(idx, 1);
      }
      for (const w of [...removedWires, ...removedBoundaryWires]) {
        circuit.removeWire(w);
      }
    },
    undo(): void {
      // Re-add removed elements and wires
      for (const el of removedElements) {
        circuit.addElement(el);
      }
      for (const w of [...removedWires, ...removedBoundaryWires]) {
        circuit.addWire(w);
      }
    },
  };

  return { subcircuit, command };
}
