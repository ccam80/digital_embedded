/**
 * LookUpTable — combinational configurable truth-table component.
 *
 * N 1-bit inputs form an N-bit address into a user-editable data table.
 * Output = table[input_address]. Output bit width is configurable.
 *
 * The input address is formed by treating input 0 as bit 0 (LSB),
 * input 1 as bit 1, etc. (matching Digital's LookUpTable.java readInputs()).
 *
 * Backing store: datafield (table[addr] = output value).
 * internalStateCount: 0 (fully combinational).
 *
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/memory/LookUpTable.java
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import { drawGenericShape } from "../generic-shape.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { getBackingStore } from "./ram.js";

export { DataField, registerBackingStore, clearBackingStores } from "./ram.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;

// ---------------------------------------------------------------------------
// Pin layout helper
// ---------------------------------------------------------------------------

// GenericShape formula: 1 output → symmetric=true
// even = inputCount % 2 === 0; offs = floor(inputCount/2)
// Input i: y = i + (symmetric && even && i >= floor(inputCount/2) ? 1 : 0)
// Output:  y = offs = floor(inputCount/2)
function buildLUTPins(inputCount: number, dataBits: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [];
  const even = inputCount % 2 === 0;
  const offs = Math.floor(inputCount / 2);
  for (let i = 0; i < inputCount; i++) {
    const gap = even && i >= offs ? 1 : 0;
    decls.push({
      direction: PinDirection.INPUT,
      label: String(i),
      defaultBitWidth: 1,
      position: { x: 0, y: i + gap },
      isNegatable: false,
      isClockCapable: false,
    });
  }
  decls.push({
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: dataBits,
    position: { x: COMP_WIDTH, y: offs },
    isNegatable: false,
    isClockCapable: false,
  });
  return decls;
}

// ---------------------------------------------------------------------------
// LookUpTableElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class LookUpTableElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LookUpTable", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const dataBits = this._properties.getOrDefault<number>("dataBits", 1);
    return resolvePins(
      buildLUTPins(inputCount, dataBits),
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getBoundingBox(): Rect {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const even = inputCount % 2 === 0;
    const height = inputCount + (even ? 1 : 0);
    return { x: this.position.x + 0.05, y: this.position.y - 0.5, width: (COMP_WIDTH - 0.05) - 0.05, height };
  }

  draw(ctx: RenderContext): void {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const inputLabels: string[] = [];
    for (let i = 0; i < inputCount; i++) {
      inputLabels.push(String(i));
    }
    drawGenericShape(ctx, {
      inputLabels,
      outputLabels: ["out"],
      clockInputIndices: [],
      componentName: "LUT",
      width: 3,
      label: this._properties.getOrDefault<string>("label", ""),
    });
  }

  getHelpText(): string {
    return (
      "LookUpTable — user-configurable combinational truth table.\n" +
      "N 1-bit inputs form an address into the data table.\n" +
      "Output = table[address]. The table is editable at design time.\n" +
      "Input 0 is the LSB of the address, input N-1 is the MSB."
    );
  }
}

// ---------------------------------------------------------------------------
// executeLookUpTable — flat simulation function
//
// Input layout:  [in0=0, in1=1, ..., inN-1=N-1]
// Output layout: [out=0]
// No state.
//
// Address = in0 | (in1 << 1) | ... | (inN-1 << N-1)
// Output  = backing_store[address]
// ---------------------------------------------------------------------------

export function executeLookUpTable(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  // The number of inputs is not directly available in the flat function, but
  // we can reconstruct it from the output offset minus the input offset.
  // Instead, we rely on the backing store size: 2^N entries.
  const mem = getBackingStore(index);
  if (mem === undefined) {
    state[wt[outBase]] = 0;
    return;
  }

  // Build address from inputs. We read until we've covered all 2^N entries
  // worth of address bits. The size of the DataField tells us N.
  const tableSize = mem.size;
  let addr = 0;
  let mask = 1;
  // tableSize = 2^N, so N = log2(tableSize)
  const n = Math.round(Math.log2(tableSize));
  for (let i = 0; i < n; i++) {
    if (state[wt[inBase + i]] & 1) {
      addr |= mask;
    }
    mask <<= 1;
  }

  state[wt[outBase]] = mem.read(addr) >>> 0;
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const LUT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "dataBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "LutInputCount", propertyKey: "inputCount", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

const LUT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "inputCount",
    type: PropertyType.INT,
    label: "Input count",
    defaultValue: 2,
    min: 1,
    max: 8,
    description: "Number of 1-bit input pins (table has 2^inputCount entries)",
  },
  {
    key: "dataBits",
    type: PropertyType.BIT_WIDTH,
    label: "Data bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the output value",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

function lutFactory(props: PropertyBag): LookUpTableElement {
  return new LookUpTableElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const LookUpTableDefinition: ComponentDefinition = {
  name: "LookUpTable",
  typeId: -1,
  factory: lutFactory,
  executeFn: executeLookUpTable,
  pinLayout: buildLUTPins(2, 1),
  propertyDefs: LUT_PROPERTY_DEFS,
  attributeMap: LUT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText: "LookUpTable — user-configurable combinational truth table. Output = table[input_address].",
  stateSlotCount: 0,
  defaultDelay: 10,
};
