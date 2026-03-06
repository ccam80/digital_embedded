/**
 * Pin derivation for subcircuit interface pins.
 *
 * Walks a circuit's In/Out elements and produces PinDeclaration[] that
 * describes the subcircuit's external interface. The derived pins are used
 * by SubcircuitElement for rendering and by the compiler for flattening.
 */

import type { Circuit } from "../../core/circuit.js";
import type { PinDeclaration } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

/**
 * Derive the interface PinDeclarations for a subcircuit from its In/Out
 * components.
 *
 * In components become OUTPUT pins on the subcircuit boundary (they drive
 * signals into the subcircuit from the parent). Out components become INPUT
 * pins on the subcircuit boundary (they receive signals from inside and
 * expose them to the parent).
 *
 * Pin positions are assigned in declaration order along the left (inputs)
 * and right (outputs) faces of a chip rectangle. The caller is responsible
 * for computing final world positions when rendering.
 *
 * @param circuit  The loaded subcircuit definition.
 * @returns        PinDeclaration[] in the order In elements appear first,
 *                 then Out elements, preserving element order within each group.
 */
export function deriveInterfacePins(circuit: Circuit): PinDeclaration[] {
  const inputPins: PinDeclaration[] = [];
  const outputPins: PinDeclaration[] = [];

  let inputSlot = 0;
  let outputSlot = 0;

  for (const element of circuit.elements) {
    if (element.typeId === "In") {
      const label = element.getProperties().getOrDefault<string>("label", `in${inputSlot}`);
      const bitWidth = element.getProperties().getOrDefault<number>("bitWidth", 1);

      inputPins.push({
        direction: PinDirection.INPUT,
        label,
        defaultBitWidth: bitWidth,
        position: { x: 0, y: inputSlot + 1 },
        isNegatable: false,
        isClockCapable: false,
      });
      inputSlot++;
    } else if (element.typeId === "Out") {
      const label = element.getProperties().getOrDefault<string>("label", `out${outputSlot}`);
      const bitWidth = element.getProperties().getOrDefault<number>("bitWidth", 1);

      outputPins.push({
        direction: PinDirection.OUTPUT,
        label,
        defaultBitWidth: bitWidth,
        position: { x: 0, y: outputSlot + 1 },
        isNegatable: false,
        isClockCapable: false,
      });
      outputSlot++;
    }
  }

  return [...inputPins, ...outputPins];
}
