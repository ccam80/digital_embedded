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

const COMP_WIDTH = 4;
const COMP_HEIGHT = 5;

function buildComparatorPinDeclarations(bitWidth: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 2, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 3, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "a", defaultBitWidth: bitWidth, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "b", defaultBitWidth: bitWidth, position: inputPositions[1], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: ">", defaultBitWidth: 1, position: outputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "=", defaultBitWidth: 1, position: outputPositions[1], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "<", defaultBitWidth: 1, position: outputPositions[2], isNegatable: false, isClockCapable: false },
  ];
}

export class ComparatorElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _signed: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Comparator", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._signed = props.getOrDefault<boolean>("signed", false);
    const decls = buildComparatorPinDeclarations(this._bitWidth);
    this._pins = resolvePins(decls, position, rotation, createInverterConfig([]), { clockPins: new Set<string>() });
  }

  getPins(): readonly Pin[] { return this._pins; }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });
    ctx.drawText("A=B", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });
    ctx.restore();
  }

  getHelpText(): string {
    return "Comparator — compares two N-bit values. Outputs: > (a greater), = (equal), < (a less). Supports signed and unsigned modes.";
  }
}

export function makeExecuteComparator(
  bitWidth: number,
  signed: boolean,
): (index: number, state: Uint32Array, layout: ComponentLayout) => void {
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);
  const signBit = 1 << (bitWidth - 1);

  return function executeComparator(index: number, state: Uint32Array, layout: ComponentLayout): void {
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);

    const rawA = state[inBase] & mask;
    const rawB = state[inBase + 1] & mask;

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
      state[outBase] = 0;     // >
      state[outBase + 1] = 1; // =
      state[outBase + 2] = 0; // <
    } else if (a < b) {
      state[outBase] = 0;     // >
      state[outBase + 1] = 0; // =
      state[outBase + 2] = 1; // <
    } else {
      state[outBase] = 1;     // >
      state[outBase + 1] = 0; // =
      state[outBase + 2] = 0; // <
    }
  };
}

export function executeComparator(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const bitWidth = (layout.getProperty?.(index, "bitWidth") as number | undefined) ?? 1;
  const signed = (layout.getProperty?.(index, "signed") as boolean | undefined) ?? false;
  makeExecuteComparator(bitWidth, signed)(index, state, layout);
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
