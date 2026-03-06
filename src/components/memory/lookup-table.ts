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
import { getBackingStore } from "./ram.js";

export { DataField, registerBackingStore, clearBackingStores } from "./ram.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;
const COMP_HEIGHT = 5;

// ---------------------------------------------------------------------------
// Pin layout helper
// ---------------------------------------------------------------------------

function buildLUTPins(inputCount: number, dataBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", inputCount, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  const decls: PinDeclaration[] = [];
  for (let i = 0; i < inputCount; i++) {
    decls.push({
      direction: PinDirection.INPUT,
      label: String(i),
      defaultBitWidth: 1,
      position: inputPositions[i],
      isNegatable: false,
      isClockCapable: false,
    });
  }
  decls.push({
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: dataBits,
    position: outputPositions[0],
    isNegatable: false,
    isClockCapable: false,
  });
  return decls;
}

// ---------------------------------------------------------------------------
// LookUpTableElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class LookUpTableElement extends AbstractCircuitElement {
  private readonly _inputCount: number;
  private readonly _dataBits: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LookUpTable", instanceId, position, rotation, mirror, props);
    this._inputCount = props.getOrDefault<number>("inputCount", 2);
    this._dataBits = props.getOrDefault<number>("dataBits", 1);
    this._pins = resolvePins(
      buildLUTPins(this._inputCount, this._dataBits),
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

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
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText("LUT", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.9 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
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

export function executeLookUpTable(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);

  // The number of inputs is not directly available in the flat function, but
  // we can reconstruct it from the output offset minus the input offset.
  // Instead, we rely on the backing store size: 2^N entries.
  const mem = getBackingStore(index);
  if (mem === undefined) {
    state[outBase] = 0;
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
    if (state[inBase + i] & 1) {
      addr |= mask;
    }
    mask <<= 1;
  }

  state[outBase] = mem.read(addr) >>> 0;
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
  defaultDelay: 10,
};
