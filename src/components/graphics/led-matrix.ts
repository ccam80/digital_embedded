/**
 * LedMatrix component — NxN LED grid display.
 *
 * Inputs:
 *   - r-data: rowDataBits-wide — row data (one bit per LED row in the addressed column)
 *   - c-addr: colAddrBits-wide — column address selector
 *
 * The matrix has (2^colAddrBits) columns and (rowDataBits) rows.
 * On each simulation step, the row data is written into data[c-addr].
 * A floating display panel shows the full matrix state.
 *
 * internalStateCount: 0 (pixel data stored in the element's own buffer,
 * accessed via the element reference from the engine's post-step hook).
 *
 * The executeFn reads r-data and c-addr inputs, updates the internal data
 * buffer. The display panel reads the buffer via getMatrixData().
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

const COMP_WIDTH = 4;

function componentHeight(): number {
  return 4;
}

// ---------------------------------------------------------------------------
// Pin layout — r-data (input 0) and c-addr (input 1) on west face
// ---------------------------------------------------------------------------

function buildLedMatrixPinDeclarations(
  rowDataBits: number,
  colAddrBits: number,
): PinDeclaration[] {
  const h = componentHeight();
  const positions = layoutPinsOnFace("west", 2, COMP_WIDTH, h);

  return [
    {
      direction: PinDirection.INPUT,
      label: "r-data",
      defaultBitWidth: rowDataBits,
      position: positions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "c-addr",
      defaultBitWidth: colAddrBits,
      position: positions[1],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// LedMatrixElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class LedMatrixElement extends AbstractCircuitElement {
  private readonly _rowDataBits: number;
  private readonly _colAddrBits: number;
  private readonly _numCols: number;
  private readonly _pins: readonly Pin[];
  /** Column-addressed pixel data: data[col] is a bitmask of row bits. */
  private readonly _data: Uint32Array;

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LedMatrix", instanceId, position, rotation, mirror, props);

    this._rowDataBits = props.getOrDefault<number>("rowDataBits", 8);
    this._colAddrBits = props.getOrDefault<number>("colAddrBits", 3);
    this._numCols = 1 << this._colAddrBits;
    this._data = new Uint32Array(this._numCols);

    const decls = buildLedMatrixPinDeclarations(this._rowDataBits, this._colAddrBits);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  get rowDataBits(): number {
    return this._rowDataBits;
  }

  get colAddrBits(): number {
    return this._colAddrBits;
  }

  get numCols(): number {
    return this._numCols;
  }

  /**
   * Write row data to the addressed column.
   * Called by the engine post-step hook after executeLedMatrix runs.
   */
  setColumnData(col: number, rowData: number): void {
    if (col >= 0 && col < this._numCols) {
      this._data[col] = rowData >>> 0;
    }
  }

  /**
   * Returns a snapshot of the full matrix data buffer.
   * data[col] is a bitmask of lit rows in that column.
   */
  getMatrixData(): Uint32Array {
    return new Uint32Array(this._data);
  }

  /** Clear all pixel data (called on simulation reset). */
  clearData(): void {
    this._data.fill(0);
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: componentHeight(),
    };
  }

  draw(ctx: RenderContext): void {
    const h = componentHeight();

    ctx.save();

    // Component body
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, h, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, h, false);

    // LED grid icon (simplified 3x3 dot pattern)
    const dotSpacing = (COMP_WIDTH - 1) / 3;
    const dotRadius = 0.15;
    ctx.setColor("COMPONENT");
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const cx = 0.5 + col * dotSpacing;
        const cy = 1.0 + row * dotSpacing;
        ctx.drawCircle(cx, cy, dotRadius, true);
      }
    }

    // Label
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText("LED Matrix", COMP_WIDTH / 2, h + 0.3, {
      horizontal: "center",
      vertical: "top",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "LedMatrix — NxN LED grid display.\n" +
      "r-data input selects which rows are lit in the addressed column.\n" +
      "c-addr input selects the column to update.\n" +
      "Matrix has (2^colAddrBits) columns and rowDataBits rows.\n" +
      "Display shown in a floating panel."
    );
  }
}

// ---------------------------------------------------------------------------
// executeLedMatrix — read r-data and c-addr, update data buffer
//
// The execute function writes r-data into a designated output slot so the
// engine can track state. The actual matrix buffer update is performed by
// the engine's post-step hook which calls element.setColumnData().
// ---------------------------------------------------------------------------

export function executeLedMatrix(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  // input 0: r-data, input 1: c-addr
  const rowData = state[wt[inputStart]] >>> 0;
  const colAddr = state[wt[inputStart + 1]] >>> 0;
  // Write the addressed col and row data to output slot for engine tracking
  const outputIdx = layout.outputOffset(index);
  state[wt[outputIdx]] = (colAddr & 0xFFFF) | ((rowData & 0xFFFF) << 16);
}

// ---------------------------------------------------------------------------
// LED_MATRIX_ATTRIBUTE_MAPPINGS — .dig XML attribute → PropertyBag conversions
// ---------------------------------------------------------------------------

export const LED_MATRIX_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "rowDataBits",
    propertyKey: "rowDataBits",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "colAddrBits",
    propertyKey: "colAddrBits",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const LED_MATRIX_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "rowDataBits",
    type: PropertyType.BIT_WIDTH,
    label: "Row data bits",
    defaultValue: 8,
    min: 1,
    max: 32,
    description: "Number of LED rows (bit width of r-data input)",
  },
  {
    key: "colAddrBits",
    type: PropertyType.INT,
    label: "Column address bits",
    defaultValue: 3,
    min: 1,
    max: 8,
    description: "Number of address bits for column selection (2^n columns)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label for the component",
  },
];

// ---------------------------------------------------------------------------
// LedMatrixDefinition — ComponentDefinition for registry registration
// ---------------------------------------------------------------------------

function ledMatrixFactory(props: PropertyBag): LedMatrixElement {
  return new LedMatrixElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const LedMatrixDefinition: ComponentDefinition = {
  name: "LedMatrix",
  typeId: -1,
  factory: ledMatrixFactory,
  executeFn: executeLedMatrix,
  pinLayout: buildLedMatrixPinDeclarations(8, 3),
  propertyDefs: LED_MATRIX_PROPERTY_DEFS,
  attributeMap: LED_MATRIX_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.GRAPHICS,
  helpText:
    "LedMatrix — NxN LED grid display.\n" +
    "r-data input selects which rows are lit in the addressed column.\n" +
    "c-addr input selects the column to update.\n" +
    "Matrix has (2^colAddrBits) columns and rowDataBits rows.\n" +
    "Display shown in a floating panel.",
};
