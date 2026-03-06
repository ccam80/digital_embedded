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
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
  layoutPinsOnFace,
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
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 2;
const MAX_KEY_QUEUE = 64;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildKeyboardPinDeclarations(): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 1, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 2, COMP_WIDTH, COMP_HEIGHT);
  return [
    // Input
    {
      direction: PinDirection.INPUT,
      label: "rd",
      defaultBitWidth: 1,
      position: inputPositions[0],
      isNegatable: false,
      isClockCapable: true,
    },
    // Outputs
    {
      direction: PinDirection.OUTPUT,
      label: "dout",
      defaultBitWidth: 8,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "rdy",
      defaultBitWidth: 1,
      position: outputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// KeyboardElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class KeyboardElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _pins: readonly Pin[];
  private readonly _keyQueue: number[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Keyboard", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");
    this._keyQueue = [];

    const decls = buildKeyboardPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>(["rd"]) },
      1,
    );
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
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const { x, y } = this.position;

    ctx.save();
    ctx.translate(x, y);

    // Component body
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Keyboard symbol: three rows of small key rectangles
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Top row: 3 keys
    ctx.drawRect(0.3, 0.25, 0.45, 0.3, false);
    ctx.drawRect(0.85, 0.25, 0.45, 0.3, false);
    ctx.drawRect(1.4, 0.25, 0.45, 0.3, false);

    // Bottom row: 2 keys + spacebar
    ctx.drawRect(0.3, 0.7, 0.45, 0.3, false);
    ctx.drawRect(0.85, 0.7, 1.0, 0.3, false);

    if (this._label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.6 });
      ctx.drawText(this._label, COMP_WIDTH / 2, COMP_HEIGHT + 0.3, {
        horizontal: "center",
        vertical: "top",
      });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Keyboard — keyboard input source.\n" +
      "rd (1-bit): rising edge dequeues the front key from the queue.\n" +
      "dout (8-bit): current key code at the front of the queue.\n" +
      "rdy (1-bit): 1 when a key is waiting, 0 when queue is empty.\n" +
      "Key codes are enqueued via the floating keyboard panel."
    );
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
  layout: ComponentLayout,
): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const rd = state[inBase] & 1;
  const prevRd = state[outBase + 2] & 1;

  // Detect rising edge of rd strobe
  if (rd === 1 && prevRd === 0) {
    // Signal dequeue request via scratch slot
    state[outBase + 3] = 1; // pending_rd flag for engine side-channel
  }

  // Update previous rd value
  state[outBase + 2] = rd;

  // dout and rdy (outBase+0, outBase+1) are kept up to date by the engine's
  // step loop which calls element.currentKeyCode() / element.readyFlag()
  // and writes back to these slots after processing the pending_rd flag.
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
  executeFn: executeKeyboard,
  pinLayout: buildKeyboardPinDeclarations(),
  propertyDefs: KEYBOARD_PROPERTY_DEFS,
  attributeMap: KEYBOARD_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.TERMINAL,
  helpText:
    "Keyboard — keyboard input source.\n" +
    "rd (1-bit): rising edge dequeues the front key from the queue.\n" +
    "dout (8-bit): current key code at the front of the queue.\n" +
    "rdy (1-bit): 1 when a key is waiting, 0 when queue is empty.\n" +
    "Key codes are enqueued via the floating keyboard panel.",
};
