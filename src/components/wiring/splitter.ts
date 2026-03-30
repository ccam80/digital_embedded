/**
 * Splitter component — splits a multi-bit bus into sub-buses or merges sub-buses into a bus.
 *
 * Faithful port of hneemann/Digital Splitter.java + SplitterShape.java.
 *
 * - Input Splitting  → pins on the LEFT  side (x = 0)
 * - Output Splitting → pins on the RIGHT side (x = 1 grid unit)
 * - Width = 1 grid unit; height = (max(in, out) - 1) * spreading grid units
 * - Spine is a filled rectangle at x = 0.5, drawn from top to bottom
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
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
import { createSplitterAnalogElement } from "../../solver/analog/behavioral-remaining.js";

// ---------------------------------------------------------------------------
// Port type
// ---------------------------------------------------------------------------

export interface SplitterPort {
  pos: number;   // starting bit position
  bits: number;  // width in bits
  name: string;  // display name (Java naming convention)
}

// ---------------------------------------------------------------------------
// Port name — mirrors Java Port constructor logic
// ---------------------------------------------------------------------------

function portName(pos: number, bits: number): string {
  if (bits === 1) return `${pos}`;
  if (bits === 2) return `${pos},${pos + 1}`;
  return `${pos}-${pos + bits - 1}`;
}

// ---------------------------------------------------------------------------
// parsePorts — mirrors Java Ports(String definition) constructor
//
// Supports three token forms (comma-separated):
//   "4"    → port at running bit position, 4 bits wide
//   "4*2"  → two ports each 4 bits wide (repeat shorthand)
//   "4-7"  → port from bit 4 to bit 7 (4 bits, explicit range)
// ---------------------------------------------------------------------------

export function parsePorts(definition: string): SplitterPort[] {
  const ports: SplitterPort[] = [];
  let runningPos = 0;

  const tokens = definition.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  for (const token of tokens) {
    const starIdx = token.indexOf("*");
    if (starIdx >= 0) {
      // "bits*count" — repeat shorthand
      const bits = parseInt(token.substring(0, starIdx).trim(), 10);
      const count = parseInt(token.substring(starIdx + 1).trim(), 10);
      for (let i = 0; i < count; i++) {
        ports.push({ pos: runningPos, bits, name: portName(runningPos, bits) });
        runningPos += bits;
      }
    } else {
      const dashIdx = token.indexOf("-");
      if (dashIdx >= 0) {
        // "from-to" — explicit range (from and to are bit indices, inclusive)
        let from = parseInt(token.substring(0, dashIdx).trim(), 10);
        let to = parseInt(token.substring(dashIdx + 1).trim(), 10);
        if (to < from) { const z = to; to = from; from = z; }
        const bits = to - from + 1;
        ports.push({ pos: from, bits, name: portName(from, bits) });
        // runningPos not used for range tokens (pos is explicit)
        runningPos = from + bits;
      } else {
        // plain number — bits wide at running position
        const bits = parseInt(token, 10);
        ports.push({ pos: runningPos, bits, name: portName(runningPos, bits) });
        runningPos += bits;
      }
    }
  }

  // Java: if empty after parsing, add a single 1-bit port
  if (ports.length === 0) {
    ports.push({ pos: 0, bits: 1, name: "0" });
  }

  return ports;
}

/** Total bits from an array of widths. */
export function totalBitsFromPattern(parts: number[]): number {
  return parts.reduce((sum, n) => sum + n, 0);
}

// ---------------------------------------------------------------------------
// Bit manipulation helpers
// ---------------------------------------------------------------------------

/** Extract bits [startBit, startBit + width) from a 32-bit value. */
export function extractBits(value: number, startBit: number, width: number): number {
  if (width >= 32) return value >>> 0;
  const mask = (1 << width) - 1;
  return ((value >>> startBit) & mask) >>> 0;
}

/** Insert bits into a value at [startBit, startBit + width). */
export function insertBits(
  target: number,
  value: number,
  startBit: number,
  width: number,
): number {
  if (width >= 32) return value >>> 0;
  const mask = ((1 << width) - 1) << startBit;
  return ((target & ~mask) | ((value << startBit) & mask)) >>> 0;
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

/**
 * Build pin declarations for a Splitter.
 *
 * Input ports → left side  (x = 0), direction INPUT
 * Output ports → right side (x = 1), direction OUTPUT
 * Vertical spacing = spreading grid units per port
 */
export function buildSplitterPinDeclarations(
  inputPorts: SplitterPort[],
  outputPorts: SplitterPort[],
  spreading: number,
): PinDeclaration[] {
  const decls: PinDeclaration[] = [];

  for (let i = 0; i < inputPorts.length; i++) {
    const p = inputPorts[i];
    decls.push({
      kind: "signal",
      direction: PinDirection.INPUT,
      label: p.name,
      defaultBitWidth: p.bits,
      position: { x: 0, y: i * spreading },
      isNegatable: false,
      isClockCapable: false,
    });
  }

  for (let i = 0; i < outputPorts.length; i++) {
    const p = outputPorts[i];
    decls.push({
      kind: "signal",
      direction: PinDirection.OUTPUT,
      label: p.name,
      defaultBitWidth: p.bits,
      position: { x: 1, y: i * spreading },
      isNegatable: false,
      isClockCapable: false,
    });
  }

  return decls;
}

// ---------------------------------------------------------------------------
// Shape constants
// ---------------------------------------------------------------------------

/** Font spec for splitter port labels (SHAPE_SPLITTER style). */
const SPLITTER_LABEL_FONT = { family: "sans-serif", size: 0.35, weight: "normal" as const };

// ---------------------------------------------------------------------------
// SplitterElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class SplitterElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Splitter", instanceId, position, rotation, mirror, props);
  }

  /** Re-parse input ports from current property bag on every access. */
  get inputPorts(): SplitterPort[] {
    return parsePorts(this._properties.getOrDefault<string>("input splitting", "4,4"));
  }
  /** Re-parse output ports from current property bag on every access. */
  get outputPorts(): SplitterPort[] {
    return parsePorts(this._properties.getOrDefault<string>("output splitting", "8"));
  }
  get spreading(): number { return this._properties.getOrDefault<number>("spreading", 1); }

  get parts(): number[] { return this.outputPorts.map((p) => p.bits); }
  get totalBits(): number { return totalBitsFromPattern(this.parts); }

  getPins(): readonly Pin[] {
    const spreading = this._properties.getOrDefault<number>("spreading", 1);
    return this.derivePins(buildSplitterPinDeclarations(
      this.inputPorts,
      this.outputPorts,
      spreading,
    ));
  }

  getBoundingBox(): Rect {
    const spreading = this._properties.getOrDefault<number>("spreading", 1);
    const maxCount = Math.max(this.inputPorts.length, this.outputPorts.length);
    const maxY = (maxCount - 1) * spreading;
    const spineBottom = Math.max(maxY, 1) + 0.1;
    // Spine rect extends from y=-0.1 to y=spineBottom. Pin lines: x=0 to x=1.
    // height = spineBottom + 0.1 so that bbox.y + bbox.height = -0.1 + (spineBottom+0.1)
    // = -0.1 + spineBottom + 0.1. Adding spineBottom+0.1 first (which rounds up for
    // integer maxY) then subtracting 0.1 yields spineBottom exactly in IEEE 754.
    return {
      x: this.position.x,
      y: this.position.y - 0.1,
      width: 1,
      height: spineBottom + 0.1,
    };
  }

  draw(ctx: RenderContext): void {
    const inCount = this.inputPorts.length;
    const outCount = this.outputPorts.length;
    const sp = this._properties.getOrDefault<number>("spreading", 1);
    const maxY = (Math.max(inCount, outCount) - 1) * sp;
    const rot = this.rotation;

    ctx.save();

    // --- Input pins (left side): line from x=0 to x=0.5, label to the left ---
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1 / 20); // thin line (~1px at 20px/grid)

    for (let i = 0; i < inCount; i++) {
      const y = i * sp;
      ctx.drawLine(0, y, 0.5, y);
      ctx.setFont(SPLITTER_LABEL_FONT);
      ctx.setColor("TEXT");
      this._drawUprightText(ctx, this.inputPorts[i].name, -0.1, y - 0.15,
        { horizontal: "right", vertical: "bottom" }, rot);
      ctx.setColor("COMPONENT");
    }

    // --- Output pins (right side): line from x=1 to x=0.5, label to the right ---
    for (let i = 0; i < outCount; i++) {
      const y = i * sp;
      ctx.drawLine(1, y, 0.5, y);
      ctx.setFont(SPLITTER_LABEL_FONT);
      ctx.setColor("TEXT");
      this._drawUprightText(ctx, this.outputPorts[i].name, 1.1, y - 0.15,
        { horizontal: "left", vertical: "bottom" }, rot);
      ctx.setColor("COMPONENT");
    }

    // --- Spine: filled rectangle from (0.4, -0.1) to (0.6, maxY+0.1) ---
    // Use drawPolygon with explicit coords to avoid drawRect float error
    // (0.4+0.2 != 0.6 and -0.1+(maxY+0.2) != maxY+0.1 in IEEE 754).
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 0.4, y: -0.1 },
      { x: 0.6, y: -0.1 },
      { x: 0.6, y: maxY + 0.1 },
      { x: 0.4, y: maxY + 0.1 },
    ], true);

    ctx.restore();
  }

  /**
   * Draw text that stays upright regardless of component rotation.
   * When rotation is 2 (180°), counter-rotates the text and flips alignment.
   */
  private _drawUprightText(
    ctx: RenderContext,
    text: string,
    x: number,
    y: number,
    align: { horizontal: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" },
    rotation: Rotation,
  ): void {
    if (rotation === 2) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI);
      const flipped = {
        horizontal: align.horizontal === "left" ? "right" as const
          : align.horizontal === "right" ? "left" as const
          : "center" as const,
        vertical: align.vertical === "top" ? "bottom" as const
          : align.vertical === "bottom" ? "top" as const
          : "middle" as const,
      };
      ctx.drawText(text, 0, 0, flipped);
      ctx.restore();
    } else {
      ctx.drawText(text, x, y, align);
    }
  }
}

// ---------------------------------------------------------------------------
// executeSplitter — copies bits between wide and narrow ports
// ---------------------------------------------------------------------------

export function executeSplitter(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const inCount = layout.inputCount(index);
  const outBase = layout.outputOffset(index);
  const outCount = layout.outputCount(index);

  if (inCount === 1 && outCount >= 1) {
    // SPLIT mode: 1 wide input → N narrow outputs
    const outputProp = layout.getProperty(index, "output splitting");
    const outputStr = typeof outputProp === "string" ? outputProp : undefined;
    const ports = outputStr ? parsePorts(outputStr) : undefined;
    const wideValue = state[wt[inBase]];
    let startBit = 0;
    for (let i = 0; i < outCount; i++) {
      const width = ports && i < ports.length ? ports[i].bits : 1;
      state[wt[outBase + i]] = extractBits(wideValue, startBit, width);
      startBit += width;
    }
  } else if (outCount === 1 && inCount >= 1) {
    // MERGE mode: N narrow inputs → 1 wide output
    const inputProp = layout.getProperty(index, "input splitting");
    const inputStr = typeof inputProp === "string" ? inputProp : undefined;
    const ports = inputStr ? parsePorts(inputStr) : undefined;
    let wideValue = 0;
    let startBit = 0;
    for (let i = 0; i < inCount; i++) {
      const width = ports && i < ports.length ? ports[i].bits : 1;
      wideValue = insertBits(wideValue, state[wt[inBase + i]], startBit, width);
      startBit += width;
    }
    state[wt[outBase]] = wideValue;
  }
}

/**
 * executeSplitterWithWidths — used when the engine supplies port widths.
 */
export function executeSplitterWithWidths(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
  partWidths: number[],
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  const wideValue = state[wt[inBase]];

  let startBit = 0;
  for (let i = 0; i < partWidths.length; i++) {
    const width = partWidths[i];
    state[wt[outBase + i]] = extractBits(wideValue, startBit, width);
    startBit += width;
  }
}

/**
 * executeSplitterMergeWithWidths — merge mode: narrow ports → wide bus.
 */
export function executeSplitterMergeWithWidths(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
  partWidths: number[],
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  let wideValue = 0;
  let startBit = 0;
  for (let i = 0; i < partWidths.length; i++) {
    const width = partWidths[i];
    wideValue = insertBits(wideValue, state[wt[inBase + i]], startBit, width);
    startBit += width;
  }
  state[wt[outBase]] = wideValue;
}

// ---------------------------------------------------------------------------
// SPLITTER_ATTRIBUTE_MAPPINGS — correct XML attribute name casing
// ---------------------------------------------------------------------------

export const SPLITTER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Input Splitting",
    propertyKey: "input splitting",
    convert: (v) => v,
  },
  {
    xmlName: "Output Splitting",
    propertyKey: "output splitting",
    convert: (v) => v,
  },
  {
    xmlName: "splitterSpreading",
    propertyKey: "spreading",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SPLITTER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "input splitting",
    type: PropertyType.STRING,
    label: "Input Splitting",
    defaultValue: "4,4",
    description: "Splitting pattern for the left (input) side ports (e.g. '4,4' or '1*8')",
  },
  {
    key: "output splitting",
    type: PropertyType.STRING,
    label: "Output Splitting",
    defaultValue: "8",
    description: "Splitting pattern for the right (output) side ports (e.g. '8' or '4,4')",
  },
  {
    key: "spreading",
    type: PropertyType.INT,
    label: "Pin Spreading",
    defaultValue: 1,
    description: "Vertical spacing between pins (1–20 grid units)",
  },
];

// ---------------------------------------------------------------------------
// SplitterDefinition
// ---------------------------------------------------------------------------

function splitterFactory(props: PropertyBag): SplitterElement {
  return new SplitterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

// Default pin layout uses Java defaults: input "4,4", output "8", spreading 1
const _defaultInputPorts = parsePorts("4,4");
const _defaultOutputPorts = parsePorts("8");

export const SplitterDefinition: ComponentDefinition = {
  name: "Splitter",
  typeId: -1,
  factory: splitterFactory,
  pinLayout: buildSplitterPinDeclarations(_defaultInputPorts, _defaultOutputPorts, 1),
  propertyDefs: SPLITTER_PROPERTY_DEFS,
  attributeMap: SPLITTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Splitter — splits a multi-bit bus into sub-buses or merges them.\n" +
    "Configure Input Splitting for the left pins and Output Splitting for the right pins.\n" +
    "Supports patterns like '4,4', '1*8', or '0-3'.",
  models: {
    digital: {
      executeFn: executeSplitter,
      inputSchema: (props) => {
        const inputSplitting = props.getOrDefault<string>("input splitting", "4,4");
        return parsePorts(inputSplitting).map((p) => p.name);
      },
      outputSchema: (props) => {
        const outputSplitting = props.getOrDefault<string>("output splitting", "8");
        return parsePorts(outputSplitting).map((p) => p.name);
      },
    },
    mnaModels: {
      behavioral: {
      factory: createSplitterAnalogElement,
    },
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createSplitterAnalogElement,
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
