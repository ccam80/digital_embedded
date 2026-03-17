/**
 * BarrelShifter component — configurable shift/rotate.
 *
 * Ports from Digital's BarrelShifter.java:
 *   Inputs: in (bitWidth), shift (shiftBits)
 *   Output: out (bitWidth)
 *
 * Modes: logical (shift, fill with 0), rotate, arithmetic (shift, fill MSB for right)
 * Direction: left or right
 * Signed: if true, shift input is treated as signed (and shiftBits is incremented by 1)
 *
 * shiftBits = ceil(log2(bitWidth)) + (signed ? 1 : 0)
 *
 * Positive shift = left; negative shift = right (after direction flip for 'right').
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { drawGenericShape } from "../generic-shape.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Shift bit width calculation (mirrors Java's Bits.binLn2)
// ceil(log2(n)) — number of bits needed to address n positions
// ---------------------------------------------------------------------------

function shiftBitsFor(bitWidth: number): number {
  let n = bitWidth - 1;
  let bits = 0;
  while (n > 0) {
    bits++;
    n >>= 1;
  }
  return Math.max(1, bits);
}

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

// GenericShape: 2 inputs, 1 output, symmetric=true, even=true, offs=floor(2/2)=1
// in@(0,0), shift@(0,2) [gap at i=1], out@(3,1)
function buildBarrelShifterPinDeclarations(bitWidth: number, signed: boolean): PinDeclaration[] {
  const sBits = shiftBitsFor(bitWidth) + (signed ? 1 : 0);
  return [
    { direction: PinDirection.INPUT, label: "in", defaultBitWidth: bitWidth, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "shift", defaultBitWidth: sBits, position: { x: 0, y: 2 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: bitWidth, position: { x: 3, y: 1 }, isNegatable: false, isClockCapable: false },
  ];
}

export type BarrelShifterMode = "logical" | "rotate" | "arithmetic";
export type ShiftDirection = "left" | "right";

export class BarrelShifterElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BarrelShifter", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 8);
    const signed = this._properties.getOrDefault<boolean>("signed", false);
    return this.derivePins(buildBarrelShifterPinDeclarations(bitWidth, signed), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x + 0.05, y: this.position.y - 0.5, width: (COMP_WIDTH - 0.05) - 0.05, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["in", "shift"],
      outputLabels: ["out"],
      clockInputIndices: [],
      componentName: "Shift",
      width: 3,
      label: this._properties.getOrDefault<string>("label", ""),
      rotation: this.rotation,
    });
  }

  getHelpText(): string {
    return "BarrelShifter — configurable shift/rotate. Modes: logical, rotate, arithmetic. Directions: left, right. Signed shift amount supported.";
  }
}

// ---------------------------------------------------------------------------
// Barrel shift helpers — mirror Java's Bits.up / Bits.down
//
// bitsUp(val, shift, width): shift left by `shift` bits, mask to `width` bits
// bitsDown(val, shift, width): shift right by `shift` bits (logical), mask to `width` bits
// ---------------------------------------------------------------------------

function bitsUp(val: number, shift: number, width: number): number {
  if (shift <= 0) return val >>> 0;
  if (shift >= 32) return 0;
  const mask = width >= 32 ? 0xFFFFFFFF : ((1 << width) - 1);
  return ((val << shift) & mask) >>> 0;
}

function bitsDown(val: number, shift: number, width: number): number {
  if (shift <= 0) return val >>> 0;
  if (shift >= 32) return 0;
  const mask = width >= 32 ? 0xFFFFFFFF : ((1 << width) - 1);
  return ((val >>> shift) & mask) >>> 0;
}

function isNegative(val: number, width: number): boolean {
  if (width >= 32) return (val & 0x80000000) !== 0;
  return (val & (1 << (width - 1))) !== 0;
}

export function makeExecuteBarrelShifter(
  bitWidth: number,
  signed: boolean,
  mode: BarrelShifterMode,
  direction: ShiftDirection,
): (index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout) => void {
  const shiftSignBit = shiftBitsFor(bitWidth) + (signed ? 1 : 0) - 1;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);

  return function executeBarrelShifter(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
    const wt = layout.wiringTable;
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);

    const inVal = state[wt[inBase]] & mask;
    const rawShift = state[wt[inBase + 1]];

    let shiftVal: number;
    if (signed) {
      // Sign-extend the shift amount
      const signBit = 1 << shiftSignBit;
      shiftVal = (rawShift & signBit) !== 0 ? rawShift - (signBit << 1) : rawShift;
    } else {
      shiftVal = rawShift >>> 0;
    }

    // Direction flip: right direction inverts the shift amount
    if (direction === "right") {
      shiftVal = -shiftVal;
    }

    let result = 0;

    if (shiftVal < 0) {
      // Shift/rotate right
      const absShift = -shiftVal;
      if (mode === "rotate") {
        const effectiveShift = absShift % bitWidth;
        result |= bitsUp(inVal, bitWidth - effectiveShift, bitWidth);
        result |= bitsDown(inVal, effectiveShift, bitWidth);
      } else {
        result |= bitsDown(inVal, absShift, bitWidth);
        if (mode === "arithmetic" && isNegative(inVal, bitWidth)) {
          // Fill high bits with 1s
          const fillCount = Math.min(absShift, bitWidth);
          const fillMask = fillCount >= bitWidth
            ? mask
            : (mask ^ ((mask >>> fillCount))) >>> 0;
          result |= fillMask;
        }
      }
    } else {
      // Shift/rotate left
      if (mode === "rotate") {
        const effectiveShift = shiftVal % bitWidth;
        result |= bitsDown(inVal, bitWidth - effectiveShift, bitWidth);
        result |= bitsUp(inVal, effectiveShift, bitWidth);
      } else {
        result |= bitsUp(inVal, shiftVal, bitWidth);
      }
    }

    state[wt[outBase]] = (result & mask) >>> 0;
  };
}

export function executeBarrelShifter(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const bw = layout.getProperty(index, "bitWidth");
  const bitWidth = typeof bw === "number" ? bw : 8;
  const sg = layout.getProperty(index, "signed");
  const signed = typeof sg === "boolean" ? sg : false;
  const md = layout.getProperty(index, "mode");
  const mode: BarrelShifterMode = typeof md === "string" ? md as BarrelShifterMode : "logical";
  const dr = layout.getProperty(index, "direction");
  const direction: ShiftDirection = typeof dr === "string" ? dr as ShiftDirection : "left";
  makeExecuteBarrelShifter(bitWidth, signed, mode, direction)(index, state, _highZs, layout);
}

export const BARREL_SHIFTER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Barrel_Signed", propertyKey: "signed", convert: (v) => v === "true" },
  { xmlName: "Direction", propertyKey: "direction", convert: (v) => v },
  { xmlName: "Barrel_Shifter_Mode", propertyKey: "mode", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

const BARREL_SHIFTER_PROPERTY_DEFS: PropertyDefinition[] = [
  { key: "bitWidth", type: PropertyType.BIT_WIDTH, label: "Bits", defaultValue: 8, min: 1, max: 32 },
  { key: "signed", type: PropertyType.BOOLEAN, label: "Signed shift", defaultValue: false },
  { key: "direction", type: PropertyType.ENUM, label: "Direction", defaultValue: "left", enumValues: ["left", "right"] },
  { key: "mode", type: PropertyType.ENUM, label: "Mode", defaultValue: "logical", enumValues: ["logical", "rotate", "arithmetic"] },
  { key: "label", type: PropertyType.STRING, label: "Label", defaultValue: "" },
];

export const BarrelShifterDefinition: ComponentDefinition = {
  name: "BarrelShifter",
  typeId: -1,
  factory: (props) => new BarrelShifterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props),
  executeFn: executeBarrelShifter,
  pinLayout: buildBarrelShifterPinDeclarations(8, false),
  propertyDefs: BARREL_SHIFTER_PROPERTY_DEFS,
  attributeMap: BARREL_SHIFTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText: "BarrelShifter — configurable shift/rotate. Modes: logical, rotate, arithmetic. Directions: left, right.",
  defaultDelay: 10,
};
