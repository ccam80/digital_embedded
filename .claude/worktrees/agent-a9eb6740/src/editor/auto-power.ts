/**
 * Auto Power Supply — convenience tool to add VDD/GND components for
 * unconnected power pins.
 *
 * A "power pin" is any pin whose label is "VDD" or "GND". This tool scans
 * the circuit for components that have power pins with no wire endpoint at
 * their world position, then provides an EditCommand that adds the missing
 * VDD/GND supply elements and connecting wires.
 *
 * This is a user-triggered action, not automatic — it should be exposed via
 * a menu item. The returned EditCommand is fully undoable.
 */

import type { CircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import { Circuit, Wire } from "@/core/circuit";
import type { EditCommand } from "@/editor/undo-redo";
import { AbstractCircuitElement } from "@/core/element";
import { PropertyBag } from "@/core/properties";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { SerializedElement } from "@/core/element";

// ---------------------------------------------------------------------------
// Power pin identification
// ---------------------------------------------------------------------------

const POWER_PIN_LABELS = new Set(["VDD", "GND"]);

/**
 * Returns true when the given pin is a power pin (label is VDD or GND).
 */
function isPowerPin(pin: Pin): boolean {
  return POWER_PIN_LABELS.has(pin.label);
}

/**
 * Returns true when any wire in the circuit has an endpoint at the given
 * world-space position.
 */
function isPinConnected(circuit: Circuit, worldX: number, worldY: number): boolean {
  for (const wire of circuit.wires) {
    if (
      (wire.start.x === worldX && wire.start.y === worldY) ||
      (wire.end.x === worldX && wire.end.y === worldY)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline VDD / GND element implementations
// ---------------------------------------------------------------------------

/**
 * A minimal VDD supply element placed by the auto-power tool.
 * Outputs a constant logic-high on its single pin.
 */
class VddElement extends AbstractCircuitElement {
  private readonly _pin: Pin;

  constructor(instanceId: string, pinWorldX: number, pinWorldY: number) {
    super("VDD", instanceId, { x: pinWorldX, y: pinWorldY - 1 }, 0, false, new PropertyBag());
    this._pin = {
      direction: PinDirection.OUTPUT,
      position: { x: 0, y: 1 },
      label: "VDD",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    };
  }

  getPins(): readonly Pin[] {
    return [this._pin];
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 1, height: 1 };
  }

  getHelpText(): string {
    return "VDD power supply — outputs logic high.";
  }

  serialize(): SerializedElement {
    return {
      typeId: this.typeId,
      instanceId: this.instanceId,
      position: { x: this.position.x, y: this.position.y },
      rotation: this.rotation,
      mirror: this.mirror,
      properties: {},
    };
  }
}

/**
 * A minimal GND supply element placed by the auto-power tool.
 * Outputs a constant logic-low on its single pin.
 */
class GndElement extends AbstractCircuitElement {
  private readonly _pin: Pin;

  constructor(instanceId: string, pinWorldX: number, pinWorldY: number) {
    super("GND", instanceId, { x: pinWorldX, y: pinWorldY + 1 }, 0, false, new PropertyBag());
    this._pin = {
      direction: PinDirection.OUTPUT,
      position: { x: 0, y: -1 },
      label: "GND",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
    };
  }

  getPins(): readonly Pin[] {
    return [this._pin];
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 1, height: 1 };
  }

  getHelpText(): string {
    return "GND power supply — outputs logic low.";
  }

  serialize(): SerializedElement {
    return {
      typeId: this.typeId,
      instanceId: this.instanceId,
      position: { x: this.position.x, y: this.position.y },
      rotation: this.rotation,
      mirror: this.mirror,
      properties: {},
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UnconnectedPowerPin {
  readonly element: CircuitElement;
  readonly pin: Pin;
}

/**
 * Scan the circuit for components with power pins (VDD or GND) that have no
 * wire endpoint at their world position.
 *
 * @returns Array of { element, pin } pairs for each unconnected power pin.
 */
export function findUnconnectedPowerPins(circuit: Circuit): UnconnectedPowerPin[] {
  const results: UnconnectedPowerPin[] = [];

  for (const element of circuit.elements) {
    for (const pin of element.getPins()) {
      if (!isPowerPin(pin)) {
        continue;
      }
      const worldX = element.position.x + pin.position.x;
      const worldY = element.position.y + pin.position.y;
      if (!isPinConnected(circuit, worldX, worldY)) {
        results.push({ element, pin });
      }
    }
  }

  return results;
}

let _supplyIdCounter = 0;

function nextSupplyId(): string {
  return `supply-${++_supplyIdCounter}`;
}

/**
 * Build and return an EditCommand that adds VDD/GND supply elements and
 * connecting wires for every unconnected power pin in the circuit.
 *
 * The command is fully undoable: undo() removes all added elements and wires.
 *
 * @param circuit  The circuit to modify.
 */
export function autoConnectPower(circuit: Circuit): EditCommand {
  const added: CircuitElement[] = [];
  const wires: Wire[] = [];

  return {
    description: "Auto Power Supply",

    execute(): void {
      added.length = 0;
      wires.length = 0;

      const unconnected = findUnconnectedPowerPins(circuit);

      for (const { element, pin } of unconnected) {
        const worldX = element.position.x + pin.position.x;
        const worldY = element.position.y + pin.position.y;

        let supply: CircuitElement;
        let supplyPinX: number;
        let supplyPinY: number;

        if (pin.label === "VDD") {
          const el = new VddElement(nextSupplyId(), worldX, worldY);
          supply = el;
          supplyPinX = el.position.x + el.getPins()[0]!.position.x;
          supplyPinY = el.position.y + el.getPins()[0]!.position.y;
        } else {
          const el = new GndElement(nextSupplyId(), worldX, worldY);
          supply = el;
          supplyPinX = el.position.x + el.getPins()[0]!.position.x;
          supplyPinY = el.position.y + el.getPins()[0]!.position.y;
        }

        circuit.addElement(supply);
        added.push(supply);

        const wire = new Wire(
          { x: supplyPinX, y: supplyPinY },
          { x: worldX, y: worldY },
        );
        circuit.addWire(wire);
        wires.push(wire);
      }
    },

    undo(): void {
      for (const wire of wires) {
        circuit.removeWire(wire);
      }
      for (const el of added) {
        circuit.removeElement(el);
      }
    },
  };
}
