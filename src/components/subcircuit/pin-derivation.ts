/**
 * Pin derivation for subcircuit interface pins.
 *
 * Walks a circuit's In/Out elements and produces PinDeclaration[] that
 * describes the subcircuit's external interface. The derived pins are used
 * by SubcircuitElement for rendering and by the compiler for flattening.
 *
 * Face assignment follows Digital's convention based on element rotation:
 *   In/Clock  rotation 0 → LEFT,   1 → BOTTOM, 2 → RIGHT, 3 → TOP
 *   Out       rotation 0 → RIGHT,  1 → TOP,    2 → LEFT,  3 → BOTTOM
 */

import type { Circuit } from "../../core/circuit.js";
import type { PinDeclaration } from "../../core/pin.js";
import type { Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

/** Which face of the chip a pin is assigned to. */
type Face = "left" | "right" | "top" | "bottom";

interface FacedPin {
  face: Face;
  label: string;
  bitWidth: number;
  direction: PinDirection;
  /** Sort key: element position along the face axis. */
  sortPos: number;
}

/**
 * Determine which face an In/Clock element maps to based on its rotation.
 */
function inputFace(rotation: Rotation): Face {
  switch (rotation) {
    case 0: return "left";
    case 1: return "bottom";
    case 2: return "right";
    case 3: return "top";
    default: return "left";
  }
}

/**
 * Determine which face an Out element maps to based on its rotation.
 */
function outputFace(rotation: Rotation): Face {
  switch (rotation) {
    case 0: return "right";
    case 1: return "top";
    case 2: return "left";
    case 3: return "bottom";
    default: return "right";
  }
}

/**
 * Derive the interface PinDeclarations for a subcircuit from its In/Out
 * components, respecting element rotation for face assignment.
 *
 * IMPORTANT: The result array preserves **document order** (the order In/Out
 * elements appear in the circuit's element list). Java Digital's
 * getInputDescription/getOutputDescriptions returns pins in document order,
 * and DEFAULT-mode subcircuits use array position to assign pin y-coordinates.
 * Emitting in face-grouped order (left, right, top, bottom) would swap pins
 * when a subcircuit has inputs on multiple faces (e.g. sysreg with left + top
 * inputs).
 *
 * Each pin is tagged with its face (from In/Out rotation) and a sortPos
 * (element position along the face axis) so that LAYOUT mode can sort within
 * each face independently.
 *
 * @param circuit  The loaded subcircuit definition.
 * @returns        PinDeclaration[] in document order, with face tags.
 */
export function deriveInterfacePins(circuit: Circuit): PinDeclaration[] {
  const facedPins: FacedPin[] = [];

  for (const element of circuit.elements) {
    if (element.typeId === "In" || element.typeId === "Clock") {
      const label = element.getProperties().getOrDefault<string>("label", "");
      const bitWidth = element.getProperties().getOrDefault<number>("bitWidth", 1);
      const rot = (element.rotation ?? 0) as Rotation;
      const face = inputFace(rot);

      // Sort key: element position along the face axis (y for left/right, x for top/bottom)
      const sortPos = (face === "left" || face === "right")
        ? element.position.y
        : element.position.x;

      facedPins.push({
        face,
        label: label || `in${facedPins.length}`,
        bitWidth,
        direction: PinDirection.INPUT,
        sortPos,
      });
    } else if (element.typeId === "Out") {
      const label = element.getProperties().getOrDefault<string>("label", "");
      const bitWidth = element.getProperties().getOrDefault<number>("bitWidth", 1);
      const rot = (element.rotation ?? 0) as Rotation;
      const face = outputFace(rot);

      const sortPos = (face === "left" || face === "right")
        ? element.position.y
        : element.position.x;

      facedPins.push({
        face: face,
        label: label || `out${facedPins.length}`,
        bitWidth,
        direction: PinDirection.OUTPUT,
        sortPos,
      });
    } else if (element.typeId === "Port") {
      const label = element.getProperties().getOrDefault<string>("label", "");
      const bitWidth = element.getProperties().getOrDefault<number>("bitWidth", 1);
      const face = element.getProperties().getOrDefault<string>("face", "left") as Face;
      const sortPos = element.getProperties().getOrDefault<number>("sortOrder", 0);

      facedPins.push({
        face,
        label: label || `port${facedPins.length}`,
        bitWidth,
        direction: PinDirection.BIDIRECTIONAL,
        sortPos,
      });
    }
  }

  // Emit in document order. Store sortPos in placeholder position.y so that
  // buildLayoutPositions can sort within each face group for LAYOUT mode.
  return facedPins.map(p => ({
    kind: "signal" as const,
    direction: p.direction,
    label: p.label,
    defaultBitWidth: p.bitWidth,
    position: { x: 0, y: p.sortPos }, // sortPos placeholder- overwritten by subcircuit
    isNegatable: false,
    isClockCapable: false,
    face: p.face,
  }));
}

/**
 * Count pins on each face for chip dimension calculation.
 */
export function countPinsByFace(pins: readonly PinDeclaration[]): {
  left: number; right: number; top: number; bottom: number;
} {
  const counts = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const p of pins) {
    const face = (p as PinDeclaration & { face?: Face }).face ??
      (p.direction === PinDirection.INPUT ? "left" : "right");
    counts[face]++;
  }
  return counts;
}
