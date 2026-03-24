/**
 * Comparator component — compares two N-bit values.
 *
 * Ports from Digital's Comparator.java:
 *   Inputs: a (bitWidth), b (bitWidth)
 *   Outputs: > (1-bit), = (1-bit), < (1-bit)
 *
 * Output order matches Java: agrb (>), equals (=), aklb (<).
 * Supports signed and unsigned modes.
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

// Java GenericShape: 2 inputs, 3 outputs, symmetric, width=3
// 2 inputs (even), symmetric: correct=1 for i>=1, offs=floor(2/2)=1
const COMP_WIDTH = 3;

// Java GenericShape: 2 inputs, 3 outputs → symmetric=false (outputs!=1)
// Non-symmetric: no gap correction, offs=0
// Inputs at y=0,1; Outputs at y=0,1,2
function buildComparatorPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "a", defaultBitWidth: bitWidth, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "b", defaultBitWidth: bitWidth, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: ">", defaultBitWidth: 1, position: { x: COMP_WIDTH, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "=", defaultBitWidth: 1, position: { x: COMP_WIDTH, y: 1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "<", defaultBitWidth: 1, position: { x: COMP_WIDTH, y: 2 }, isNegatable: false, isClockCapable: false },
  ];
}

export class ComparatorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Comparator", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildComparatorPinDeclarations(bitWidth), []);
  }

  getBoundingBox(): Rect {
    // Java GenericShape: max(2,3)=3, non-symmetric (3 outputs), no even-input gap
    // yBottom = (3-1) + 0.5 = 2.5, height = 2.5 + 0.5 = 3
    const TOP = 0.5;
    return { x: this.position.x + 0.05, y: this.position.y - TOP, width: (COMP_WIDTH - 0.05) - 0.05, height: 3 };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["a", "b"],
      outputLabels: [">", "=", "<"],
      clockInputIndices: [],
      componentName: null,
      width: 3,
      label: this._properties.getOrDefault<string>("label", ""),
      rotation: this.rotation,
    });
  }

  getHelpText(): string {
    return "Comparator — compares two N-bit values. Outputs: > (a greater), = (equal), < (a less). Supports signed and unsigned modes.";
  }
}

export function makeExecuteComparator(
  bitWidth: number,
  signed: boolean,
): (index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout) => void {
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);
  const signBit = 1 << (bitWidth - 1);

  return function executeComparator(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
    const wt = layout.wiringTable;
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);

    const rawA = state[wt[inBase]] & mask;
    const rawB = state[wt[inBase + 1]] & mask;

    let a: number;
    let b: number;

    if (signed) {
      a = (rawA & signBit) !== 0 ? rawA - (signBit << 1) : rawA;
      b = (rawB & signBit) !== 0 ? rawB - (signBit << 1) : rawB;
    } else {
      a = rawA >>> 0;
      b = rawB >>> 0;
    }

    if (a === b) {
      state[wt[outBase]] = 0;     // >
      state[wt[outBase + 1]] = 1; // =
      state[wt[outBase + 2]] = 0; // <
    } else if (a < b) {
      state[wt[outBase]] = 0;     // >
      state[wt[outBase + 1]] = 0; // =
      state[wt[outBase + 2]] = 1; // <
    } else {
      state[wt[outBase]] = 1;     // >
      state[wt[outBase + 1]] = 0; // =
      state[wt[outBase + 2]] = 0; // <
    }
  };
}

export function executeComparator(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  makeExecuteComparator(
    (layout.getProperty(index, "bitWidth") as number | undefined) ?? 1,
    (layout.getProperty(index, "signed") as boolean | undefined) ?? false,
  )(index, state, _highZs, layout);
}

export const COMPARATOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "signed", propertyKey: "signed", convert: (v) => v === "true" },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

const COMPARATOR_PROPERTY_DEFS: PropertyDefinition[] = [
  { key: "bitWidth", type: PropertyType.BIT_WIDTH, label: "Bits", defaultValue: 1, min: 1, max: 32 },
  { key: "signed", type: PropertyType.BOOLEAN, label: "Signed", defaultValue: false },
  { key: "label", type: PropertyType.STRING, label: "Label", defaultValue: "" },
];

export const ComparatorDefinition: ComponentDefinition = {
  name: "Comparator",
  typeId: -1,
  factory: (props) => new ComparatorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props),
  executeFn: executeComparator,
  pinLayout: buildComparatorPinDeclarations(1),
  propertyDefs: COMPARATOR_PROPERTY_DEFS,
  attributeMap: COMPARATOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText: "Comparator — compares two N-bit values. Outputs: > (a greater), = (equal), < (a less).",
  defaultDelay: 10,
};
