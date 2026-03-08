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
 * @param circuit  The loaded subcircuit definition.
 * @returns        PinDeclaration[] with face-aware positions. Pin positions
 *                 are slot indices (0, 1, 2, ...) — the caller computes
 *                 final world positions using the chip dimensions.
 */
export function deriveInterfacePins(circuit: Circuit): PinDeclaration[] {
  const facedPins: FacedPin[] = [];

  for (const element of circuit.elements) {
    if (element.typeId === "In" || element.typeId === "Clock") {
      const label = element.getProperties().getOrDefault<string>("label", "");
      const bitWidth = element.getProperties().getOrDefault<number>("bitWidth", 1);
      const rot = (element.rotation ?? 0) as Rotation;
      const face = inputFace(rot);

      // Sort by position along the face axis (y for left/right, x for top/bottom)
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
    }
  }

  // Sort pins within each face by their position in the circuit
  facedPins.sort((a, b) => a.sortPos - b.sortPos);

  // Convert to PinDeclarations with slot-based positions.
  // The face is encoded in the position: left/right pins get x=0 or x=chipWidth
  // (assigned later by buildPositionedPinDeclarations), top/bottom get y=0 or y=chipHeight.
  // We use a convention: position.x < 0 means "use face" encoding.
  const result: PinDeclaration[] = [];

  // Group by face and assign sequential slot indices
  const faceGroups: Record<Face, FacedPin[]> = {
    left: [], right: [], top: [], bottom: [],
  };
  for (const p of facedPins) {
    faceGroups[p.face].push(p);
  }

  for (const [face, pins] of Object.entries(faceGroups) as [Face, FacedPin[]][]) {
    pins.forEach((p, i) => {
      result.push({
        direction: p.direction,
        label: p.label,
        defaultBitWidth: p.bitWidth,
        position: { x: 0, y: i }, // placeholder — real position set by subcircuit
        isNegatable: false,
        isClockCapable: false,
        face: face as Face, // extra field for face routing
      });
    });
  }

  return result;
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
