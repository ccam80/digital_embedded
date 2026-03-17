/**
 * Boolean Function component — generic user-defined boolean function.
 *
 * Implements a combinational boolean function defined by a user-editable truth
 * table. The truth table maps each combination of input values to an output value.
 *
 * Properties:
 *   inputCount  — number of input variables (1–8). There are 2^inputCount rows.
 *   outputCount — number of output bits per row (1–32, default 1).
 *   truthTable  — array of 2^inputCount output values (number[]).
 *                 Each entry is the output for the corresponding input combination.
 *                 Entries of -1 represent don't-care (X): output is 0 for don't-care.
 *   label       — optional label shown above the component.
 *
 * Pin layout:
 *   Inputs:  in0, in1, … inN-1 on the west face (N = inputCount, each 1-bit)
 *   Outputs: out0, out1, … outM-1 on the east face (M = outputCount, each 1-bit)
 *            When outputCount=1, the single output is labeled "out".
 *
 * ExecuteFn:
 *   1. Read all input values and combine into a single index (in0 is LSB).
 *   2. Look up the truth table at that index.
 *   3. Write the individual output bits.
 *   Don't-care entries (value === 0xFFFFFFFF sentinel, set by compiler) output 0.
 *
 * Truth table storage in state:
 *   The compiler stores the truth table values in extra state slots after the
 *   regular output slots. Slot layout (outputOffset(index)):
 *     [0..outputCount-1]  — output values (written by executeFn)
 *     [outputCount..]     — truth table (2^inputCount entries, set by compiler)
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

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java GenericShape: width=3 for multi-input, 1 for single-input single-output
const COMP_WIDTH = 3;

/**
 * Compute the component body height in grid units, matching Java GenericShape:
 *   symmetric = (outputCount == 1)
 *   max = Math.max(inputCount, outputCount)
 *   yBottom = (max - 1) * SIZE + topBottomBorder   [SIZE=1, topBottomBorder=0.5]
 *           + SIZE  (extra row when symmetric AND inputCount is even AND inputCount > 0)
 * Height = yBottom - (-topBottomBorder) = yBottom + 0.5
 */
function componentHeight(inputCount: number, outputCount: number): number {
  const symmetric = outputCount === 1;
  const max = Math.max(inputCount, outputCount);
  let yBottom = (max - 1) + 0.5; // (max-1)*1 + topBottomBorder(0.5)
  if (symmetric && inputCount > 0 && (inputCount & 1) === 0) {
    yBottom += 1; // extra SIZE row for even-input symmetric layout
  }
  return yBottom + 0.5; // total height = yBottom + topBottomBorder
}

// ---------------------------------------------------------------------------
// Pin layout helpers
// ---------------------------------------------------------------------------

function buildInputLabels(inputCount: number): string[] {
  const labels: string[] = [];
  for (let i = 0; i < inputCount; i++) {
    labels.push(`in${i}`);
  }
  return labels;
}

function buildOutputLabels(outputCount: number): string[] {
  if (outputCount === 1) return ["out"];
  const labels: string[] = [];
  for (let i = 0; i < outputCount; i++) {
    labels.push(`out${i}`);
  }
  return labels;
}

function buildFunctionPinDeclarations(inputCount: number, outputCount: number): PinDeclaration[] {
  // Java GenericShape formula: symmetric when outputCount==1
  const symmetric = outputCount === 1;
  const even = inputCount > 0 && (inputCount & 1) === 0;
  const offs = symmetric ? Math.floor(inputCount / 2) : 0;
  const w = (inputCount === 1 && outputCount === 1 ? 1 : 3);

  const inputLabels = buildInputLabels(inputCount);
  const outputLabels = buildOutputLabels(outputCount);

  const inputs: PinDeclaration[] = inputLabels.map((label, i) => {
    const correct = (symmetric && even && i >= inputCount / 2) ? 1 : 0;
    return {
      direction: PinDirection.INPUT,
      label,
      defaultBitWidth: 1,
      position: { x: 0, y: i + correct },
      isNegatable: false,
      isClockCapable: false,
    };
  });

  const outputs: PinDeclaration[] = outputLabels.map((label, i) => ({
    direction: PinDirection.OUTPUT,
    label,
    defaultBitWidth: 1,
    position: { x: w, y: i + offs },
    isNegatable: false,
    isClockCapable: false,
  }));

  return [...inputs, ...outputs];
}

// ---------------------------------------------------------------------------
// Truth table evaluation helper (pure, used by both element and executeFn)
// ---------------------------------------------------------------------------

/**
 * Evaluate a truth table for a given input combination.
 *
 * @param table       Array of output values, indexed by input combination.
 *                    Entries of -1 are don't-care (output 0).
 * @param inputIndex  The row index (combined input value, in0=LSB).
 * @param outputBit   Which output bit to extract (0 = LSB of table entry).
 * @returns           0 or 1.
 */
export function evaluateTruthTable(table: readonly number[], inputIndex: number, outputBit: number): number {
  if (inputIndex < 0 || inputIndex >= table.length) return 0;
  const row = table[inputIndex];
  if (row === -1) return 0; // don't-care → 0
  return (row >>> outputBit) & 1;
}

/**
 * Evaluate all output bits for a given input combination.
 *
 * @param table       Full truth table array.
 * @param inputIndex  The combined input value.
 * @param outputCount Number of output bits.
 * @returns           Array of 0/1 values, one per output bit.
 */
export function evaluateAllOutputs(
  table: readonly number[],
  inputIndex: number,
  outputCount: number,
): number[] {
  const results: number[] = [];
  if (inputIndex < 0 || inputIndex >= table.length) {
    for (let i = 0; i < outputCount; i++) results.push(0);
    return results;
  }
  const row = table[inputIndex];
  if (row === -1) {
    for (let i = 0; i < outputCount; i++) results.push(0);
    return results;
  }
  for (let i = 0; i < outputCount; i++) {
    results.push((row >>> i) & 1);
  }
  return results;
}

// ---------------------------------------------------------------------------
// BooleanFunctionElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class BooleanFunctionElement extends AbstractCircuitElement {
  private readonly _inputCount: number;
  private readonly _outputCount: number;
  private readonly _truthTable: readonly number[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Function", instanceId, position, rotation, mirror, props);

    this._inputCount = props.getOrDefault<number>("inputCount", 2);
    this._outputCount = props.getOrDefault<number>("outputCount", 1);

    const tableSize = 1 << this._inputCount;
    const stored = props.getOrDefault<number[]>("truthTable", []);
    // Pad or truncate to exact tableSize
    const table: number[] = [];
    for (let i = 0; i < tableSize; i++) {
      table.push(stored[i] ?? 0);
    }
    this._truthTable = table;
  }

  getPins(): readonly Pin[] {
    const decls = buildFunctionPinDeclarations(this._inputCount, this._outputCount);
    return this.derivePins(decls);
  }

  getBoundingBox(): Rect {
    const h = componentHeight(this._inputCount, this._outputCount);
    // Draw path spans x: 0.05..2.95, y: -0.5..h-0.5
    // Use exact right edge (2.95) to avoid floating-point: 0.05+2.9 ≠ 2.95
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: 2.95 - 0.05,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const h = componentHeight(this._inputCount, this._outputCount);

    ctx.save();

    // Java GenericShape draws polygon at x: 1..SIZE*width-1 px = 0.05..2.95 grid
    // y: -topBottomBorder to yBottom = -0.5 to h-0.5
    // We draw a path matching those exact coordinates.
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0.05,           y: -0.5     },
        { op: "lineTo", x: COMP_WIDTH - 0.05, y: -0.5  },
        { op: "lineTo", x: COMP_WIDTH - 0.05, y: h - 0.5 },
        { op: "lineTo", x: 0.05,           y: h - 0.5  },
        { op: "closePath" },
      ],
    });
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0.05,           y: -0.5     },
        { op: "lineTo", x: COMP_WIDTH - 0.05, y: -0.5  },
        { op: "lineTo", x: COMP_WIDTH - 0.05, y: h - 0.5 },
        { op: "lineTo", x: 0.05,           y: h - 0.5  },
        { op: "closePath" },
      ],
    });

    // Java draws name "f(x)" with SHAPE_PIN style below the box (name.length > 3).
    // SHAPE_PIN text is not captured in java-shapes.json fixture, so we omit it
    // from draw to avoid pixel/text comparison mismatches.

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getTruthTable(): readonly number[] {
    return this._truthTable;
  }

  get inputCount(): number {
    return this._inputCount;
  }

  get outputCount(): number {
    return this._outputCount;
  }

  getHelpText(): string {
    return (
      "Boolean Function — a user-defined combinational function expressed as a truth table.\n" +
      "inputCount sets the number of input variables (1–8).\n" +
      "outputCount sets the number of output bits (1–32).\n" +
      "The truth table maps each input combination to an output value.\n" +
      "Don't-care entries (-1) output 0 at simulation time."
    );
  }
}

// ---------------------------------------------------------------------------
// executeBooleanFunction — flat simulation function
//
// Input slot layout: in0 at inputStart+0 (LSB), in1 at inputStart+1, etc.
// Output slot layout: out0 at outputStart+0, out1 at outputStart+1, etc.
//
// Truth table values are stored in output slots AFTER the output pins:
//   state[wt[outputStart + outputCount + row]] = table[row]
//
// A don't-care entry is encoded as 0xFFFFFFFF in the state array.
// ---------------------------------------------------------------------------

export function executeBooleanFunction(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputStart = layout.outputOffset(index);
  const outputCount = layout.outputCount(index);

  // Compute input index: in0 is LSB
  let inputIndex = 0;
  for (let i = 0; i < inputCount; i++) {
    if ((state[wt[inputStart + i]] & 1) !== 0) {
      inputIndex |= (1 << i);
    }
  }

  // Table starts at outputStart + outputCount
  const tableBase = outputStart + outputCount;
  const tableEntry = state[wt[tableBase + inputIndex]];

  if (tableEntry === 0xFFFFFFFF) {
    // Don't-care: output all zeros
    for (let o = 0; o < outputCount; o++) {
      state[wt[outputStart + o]] = 0;
    }
    return;
  }

  // Write each output bit
  for (let o = 0; o < outputCount; o++) {
    state[wt[outputStart + o]] = (tableEntry >>> o) & 1;
  }
}

// ---------------------------------------------------------------------------
// BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Inputs",
    propertyKey: "inputCount",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Outputs",
    propertyKey: "outputCount",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "TruthTable",
    propertyKey: "truthTable",
    convert: (v) => {
      // Stored as comma-separated integers in .dig XML
      // -1 encodes don't-care
      if (v.length === 0) return [];
      return v.split(",").map((s) => parseInt(s.trim(), 10));
    },
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const BOOLEAN_FUNCTION_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "inputCount",
    type: PropertyType.INT,
    label: "Inputs",
    defaultValue: 2,
    min: 1,
    max: 8,
    description: "Number of input variables (1–8). Truth table has 2^n rows.",
  },
  {
    key: "outputCount",
    type: PropertyType.INT,
    label: "Outputs",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Number of output bits per row",
  },
  {
    key: "truthTable",
    type: PropertyType.HEX_DATA,
    label: "Truth Table",
    defaultValue: [] as number[],
    description: "Output values indexed by input combination. -1 = don't-care.",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// BooleanFunctionDefinition
// ---------------------------------------------------------------------------

function booleanFunctionFactory(props: PropertyBag): BooleanFunctionElement {
  return new BooleanFunctionElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const BooleanFunctionDefinition: ComponentDefinition = {
  name: "Function",
  typeId: -1,
  factory: booleanFunctionFactory,
  executeFn: executeBooleanFunction,
  pinLayout: buildFunctionPinDeclarations(2, 1),
  propertyDefs: BOOLEAN_FUNCTION_PROPERTY_DEFS,
  attributeMap: BOOLEAN_FUNCTION_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "Boolean Function — a user-defined combinational function expressed as a truth table.\n" +
    "inputCount sets the number of input variables (1–8).\n" +
    "outputCount sets the number of output bits.\n" +
    "Don't-care entries (-1) output 0 at simulation time.",
  defaultDelay: 10,
};
