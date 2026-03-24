/**
 * Terminal component — serial text terminal.
 *
 * Receives character data on its input pins and appends characters to an
 * internal scrollback buffer. The buffer is displayed in a floating terminal
 * panel. The terminal also provides a keyboard input path: key codes queued
 * via the panel are exposed as output data + ready flag.
 *
 * Pin layout:
 *   Inputs:
 *     - din  (8-bit): character code to write
 *     - wr   (1-bit): write strobe — character is latched when wr goes high
 *   Outputs:
 *     - dout (8-bit): key code from keyboard input queue
 *     - rdy  (1-bit): 1 when a key is waiting in the queue, 0 when empty
 *
 * Simulation behavior:
 *   - On each step, if wr=1 and din changed (rising wr edge), append
 *     char(din) to the buffer.
 *   - Always output the front of the keyboard queue on dout/rdy.
 *   - A key is dequeued when the circuit reads rdy=1 and asserts a "next"
 *     strobe (wr input repurposed — here represented by the rd input).
 *
 * internalStateCount: 1  (previous wr value for edge detection)
 *
 * The character buffer and keyboard queue live on the element (not in
 * Uint32Array) because they are variable-length. The engine accesses them
 * via the element reference for panel display updates.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import { drawGenericShape } from "../generic-shape.js";
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
// Java Terminal uses GenericShape: 3 inputs, 0 outputs, width=3
// → COMP_WIDTH=3, COMP_HEIGHT=3
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;
const MAX_BUFFER_CHARS = 4096;
const MAX_KEY_QUEUE = 64;

// ---------------------------------------------------------------------------
// Pin layout — Java GenericShape(3 inputs, 0 outputs, width=3):
//   D  at (0, 0)
//   C  at (0, 1)
//   en at (0, 2)
// No outputs.
// ---------------------------------------------------------------------------

function buildTerminalPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "D",
      defaultBitWidth: 8,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: true,
    },
    {
      direction: PinDirection.INPUT,
      label: "en",
      defaultBitWidth: 1,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// TerminalElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TerminalElement extends AbstractCircuitElement {
  private readonly _charBuffer: number[];
  private readonly _keyQueue: number[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Terminal", instanceId, position, rotation, mirror, props);

    this._charBuffer = [];
    this._keyQueue = [];
  }

  get columns(): number {
    return this._properties.getOrDefault<number>("columns", 80);
  }

  get rows(): number {
    return this._properties.getOrDefault<number>("rows", 24);
  }

  /** Append a character code to the display buffer. Called by the engine step. */
  appendChar(code: number): void {
    this._charBuffer.push(code & 0xff);
    if (this._charBuffer.length > MAX_BUFFER_CHARS) {
      this._charBuffer.shift();
    }
  }

  /** Enqueue a key code for circuit consumption (called by the terminal panel). */
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

  /** Return a copy of the display buffer (character codes). */
  getCharBuffer(): readonly number[] {
    return this._charBuffer;
  }

  /** Clear the display buffer and keyboard queue (called on simulation reset). */
  clearBuffers(): void {
    this._charBuffer.length = 0;
    this._keyQueue.length = 0;
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTerminalPinDeclarations(), ["C"]);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");
    drawGenericShape(ctx, {
      inputLabels: ["D", "C", "en"],
      outputLabels: [],
      clockInputIndices: [1],
      componentName: "Terminal",
      width: COMP_WIDTH,
      ...(label.length > 0 ? { label } : {}),
    });
  }

  getHelpText(): string {
    return (
      "Terminal — serial text terminal with keyboard input.\n" +
      "din (8-bit): character code to display.\n" +
      "wr (1-bit): rising edge latches din into the display buffer.\n" +
      "rd (1-bit): rising edge dequeues one key from the keyboard queue.\n" +
      "dout (8-bit): key code from keyboard queue.\n" +
      "rdy (1-bit): 1 when a key is waiting, 0 when queue is empty.\n" +
      "The display buffer and keyboard queue are shown in a floating panel."
    );
  }
}

// ---------------------------------------------------------------------------
// executeTerminal — latch character on wr edge, expose keyboard queue
//
// State layout (Uint32Array slots relative to component):
//   Internal state slot 0: previous wr value (for edge detection)
//   Internal state slot 1: previous rd value (for edge detection)
//
// The actual char buffer and key queue live on the TerminalElement instance
// and are managed via side-channel calls from the engine step loop.
// Here we only manage the output signals (dout, rdy) from the engine's
// perspective using the state array.
//
// Input layout:  [din, wr, rd]
// Output layout: [dout, rdy]
// ---------------------------------------------------------------------------

export function executeTerminal(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // Terminal has no outputs — it is a display-only sink component.
  // The display panel reads inputs D, C, en directly via the engine's
  // post-step hook accessing the element. No output slots to write.
}

// ---------------------------------------------------------------------------
// TERMINAL_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const TERMINAL_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Columns",
    propertyKey: "columns",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Rows",
    propertyKey: "rows",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TERMINAL_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown below the terminal component",
  },
  {
    key: "columns",
    type: PropertyType.INT,
    label: "Columns",
    defaultValue: 80,
    min: 1,
    max: 256,
    description: "Number of character columns in the terminal panel",
  },
  {
    key: "rows",
    type: PropertyType.INT,
    label: "Rows",
    defaultValue: 24,
    min: 1,
    max: 128,
    description: "Number of character rows in the terminal panel",
  },
];

// ---------------------------------------------------------------------------
// TerminalDefinition
// ---------------------------------------------------------------------------

function terminalFactory(props: PropertyBag): TerminalElement {
  return new TerminalElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TerminalDefinition: ComponentDefinition = {
  name: "Terminal",
  typeId: -1,
  factory: terminalFactory,
  executeFn: executeTerminal,
  pinLayout: buildTerminalPinDeclarations(),
  propertyDefs: TERMINAL_PROPERTY_DEFS,
  attributeMap: TERMINAL_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.TERMINAL,
  helpText:
    "Terminal — serial text terminal with keyboard input.\n" +
    "din (8-bit): character code to display.\n" +
    "wr (1-bit): rising edge latches din into the display buffer.\n" +
    "rd (1-bit): rising edge dequeues one key from the keyboard queue.\n" +
    "dout (8-bit): key code from keyboard queue.\n" +
    "rdy (1-bit): 1 when a key is waiting, 0 when queue is empty.\n" +
    "The display buffer and keyboard queue are shown in a floating panel.",
};
