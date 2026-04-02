/**
 * Keyboard component — keyboard input source.
 *
 * Reads key codes from a keyboard input dialog (floating panel). The circuit
 * can read the current key code from dout and detect when a key is available
 * via the rdy output. After consuming the key, the circuit asserts rd (read
 * strobe) to advance to the next key.
 *
 * Pin layout:
 *   Inputs:
 *     - rd   (1-bit): read strobe — rising edge dequeues front key
 *   Outputs:
 *     - dout (8-bit): current key code (front of queue)
 *     - rdy  (1-bit): 1 when a key is waiting, 0 when queue is empty
 *
 * Simulation behavior:
 *   - dout reflects the key code at the front of the queue.
 *   - rdy is 1 when queue is non-empty, 0 when empty.
 *   - On rising edge of rd, the front key is dequeued.
 *   - The keyboard queue is populated by user key presses in the panel.
 *
 * internalStateCount: 1  (previous rd value for edge detection)
 *
 * The key queue lives on the element (not Uint32Array) because it is
 * variable-length. The engine reads dout/rdy from the element each step.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import { drawGenericShape, genericShapeBounds } from "../generic-shape.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// Java Keyboard uses GenericShape: 2 inputs (C, en), 2 outputs (D, av), width=3
// Non-symmetric (2 outputs) → offs=0
// Input C@(0,0), en@(0,1); Output D@(3,0), av@(3,1)
// → COMP_WIDTH=3, COMP_HEIGHT=2
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 2;
const MAX_KEY_QUEUE = 64;

// ---------------------------------------------------------------------------
// Pin layout — Java GenericShape(2 inputs, 2 outputs, width=3, non-symmetric):
//   C  (input)  at (0, 0)
//   en (input)  at (0, 1)
//   D  (output) at (3, 0)
//   av (output) at (3, 1)
// ---------------------------------------------------------------------------

function buildKeyboardPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: true,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "en",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D",
      defaultBitWidth: 16,
      position: { x: COMP_WIDTH, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "av",
      defaultBitWidth: 1,
      position: { x: COMP_WIDTH, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// KeyboardElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class KeyboardElement extends AbstractCircuitElement {
  private readonly _keyQueue: number[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Keyboard", instanceId, position, rotation, mirror, props);

    this._keyQueue = [];
  }

  /** Enqueue a key code (called by the keyboard panel on user key press). */
  enqueueKey(code: number): void {
    if (this._keyQueue.length < MAX_KEY_QUEUE) {
      this._keyQueue.push(code & 0xff);
    }
  }

  /** Dequeue the front key code. Returns -1 if the queue is empty. */
  dequeueKey(): number {
    if (this._keyQueue.length === 0) {
      return -1;
    }
    return this._keyQueue.shift()!;
  }

  /** Peek at the front key code without removing it. Returns -1 if empty. */
  peekKey(): number {
    return this._keyQueue.length > 0 ? this._keyQueue[0] : -1;
  }

  /** Number of keys waiting in the queue. */
  keyQueueLength(): number {
    return this._keyQueue.length;
  }

  /** Current key code for circuit output (0 if queue is empty). */
  currentKeyCode(): number {
    return this._keyQueue.length > 0 ? this._keyQueue[0] : 0;
  }

  /** 1 when a key is available, 0 when queue is empty. */
  readyFlag(): number {
    return this._keyQueue.length > 0 ? 1 : 0;
  }

  /** Clear the keyboard queue (called on simulation reset). */
  clearQueue(): void {
    this._keyQueue.length = 0;
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildKeyboardPinDeclarations(), ["C"]);
  }

  getBoundingBox(): Rect {
    const b = genericShapeBounds(2, 2, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();
    drawGenericShape(ctx, {
      inputLabels: ["C", "en"],
      outputLabels: ["D", "av"],
      clockInputIndices: [0],
      componentName: "Keyboard",
      width: COMP_WIDTH,
      ...(label.length > 0 ? { label } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// executeKeyboard — output current key code and ready flag
//
// State layout (Uint32Array slots relative to component):
//   Input  slot 0: rd strobe
//   Output slot 0: dout (current key code)
//   Output slot 1: rdy  (1 if queue non-empty)
//   Output slot 2: prev_rd (previous rd value for edge detection — scratch)
//
// The key queue lives on KeyboardElement. The engine's step loop calls
// element.dequeueKey() after detecting a rising rd edge (outBase+2 changed)
// and then calls element.currentKeyCode() / element.readyFlag() to refresh
// the output slots.
//
// This function manages the edge-detection state and the output signals.
// It reads the queue state via the scratch slots that the engine keeps
// synchronized with the element.
// ---------------------------------------------------------------------------

export function executeKeyboard(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  // Inputs: C (clock, inBase+0), en (enable, inBase+1)
  const clk = state[wt[inBase]] & 1;
  const en  = state[wt[inBase + 1]] & 1;

  // Outputs: D (key code, outBase+0), av (available, outBase+1)
  // D and av are kept up to date by the engine's step loop which calls
  // element.currentKeyCode() / element.readyFlag() and writes back.
  // On rising clock edge with en=1, signal a dequeue request.
  const prevClk = state[wt[outBase + 2]] & 1;

  if (clk === 1 && prevClk === 0 && en === 1) {
    state[wt[outBase + 3]] = 1; // pending_rd flag for engine side-channel
  }

  // Update previous clock value
  state[wt[outBase + 2]] = clk;
}

// ---------------------------------------------------------------------------
// KEYBOARD_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const KEYBOARD_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const KEYBOARD_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown below the keyboard component",
  },
];

// ---------------------------------------------------------------------------
// KeyboardDefinition
// ---------------------------------------------------------------------------

function keyboardFactory(props: PropertyBag): KeyboardElement {
  return new KeyboardElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const KeyboardDefinition: ComponentDefinition = {
  name: "Keyboard",
  typeId: -1,
  factory: keyboardFactory,
  pinLayout: buildKeyboardPinDeclarations(),
  propertyDefs: KEYBOARD_PROPERTY_DEFS,
  attributeMap: KEYBOARD_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.TERMINAL,
  models: {
    digital: {
      executeFn: executeKeyboard,
      inputSchema: ["C", "en"],
      outputSchema: ["D", "av"],
    },
  },
  helpText:
    "Keyboard — keyboard input source.\n" +
    "rd (1-bit): rising edge dequeues the front key from the queue.\n" +
    "dout (8-bit): current key code at the front of the queue.\n" +
    "rdy (1-bit): 1 when a key is waiting, 0 when queue is empty.\n" +
    "Key codes are enqueued via the floating keyboard panel.",
};
