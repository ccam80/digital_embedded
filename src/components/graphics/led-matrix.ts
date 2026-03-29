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

// ---------------------------------------------------------------------------
// Layout constants
// Java LedMatrix uses GenericShape: 2 inputs (r-data, c-addr), 0 outputs, width=3
// Non-symmetric → offs=0. r-data@(0,0), c-addr@(0,1)
// → COMP_WIDTH=3, COMP_HEIGHT=2
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;

function componentHeight(): number {
  return 2;
}

// ---------------------------------------------------------------------------
// Pin layout — Java GenericShape(2 inputs, 0 outputs, width=3):
//   r-data at (0, 0)
//   c-addr at (0, 1)
// ---------------------------------------------------------------------------

function buildLedMatrixPinDeclarations(
  rowDataBits: number,
  colAddrBits: number,
): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "r-data",
      defaultBitWidth: rowDataBits,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "c-addr",
      defaultBitWidth: colAddrBits,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// LedMatrixElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class LedMatrixElement extends AbstractCircuitElement {
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

    const colAddrBits = props.getOrDefault<number>("colAddrBits", 3);
    const numCols = 1 << colAddrBits;
    this._data = new Uint32Array(numCols);
  }

  get rowDataBits(): number {
    return this._properties.getOrDefault<number>("rowDataBits", 8);
  }

  get colAddrBits(): number {
    return this._properties.getOrDefault<number>("colAddrBits", 3);
  }

  get numCols(): number {
    return 1 << this._properties.getOrDefault<number>("colAddrBits", 3);
  }

  /**
   * Write row data to the addressed column.
   * Called by the engine post-step hook after executeLedMatrix runs.
   */
  setColumnData(col: number, rowData: number): void {
    if (col >= 0 && col < this.numCols) {
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
    return resolvePins(
      buildLedMatrixPinDeclarations(this.rowDataBits, this.colAddrBits),
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: componentHeight(),
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();
    drawGenericShape(ctx, {
      inputLabels: ["r-data", "c-addr"],
      outputLabels: [],
      clockInputIndices: [],
      componentName: "LED-Matrix",
      width: COMP_WIDTH,
      ...(label.length > 0 ? { label } : {}),
    });
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
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // LedMatrix has no outputs — it is a display-only sink component.
  // The display panel reads r-data and c-addr inputs via the engine's
  // post-step hook accessing the element. No output slots to write.
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
  pinLayout: buildLedMatrixPinDeclarations(8, 3),
  propertyDefs: LED_MATRIX_PROPERTY_DEFS,
  attributeMap: LED_MATRIX_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.GRAPHICS,
  models: {
    digital: {
      executeFn: executeLedMatrix,
      inputSchema: ["r-data", "c-addr"],
      outputSchema: [],
    },
  },
  helpText:
    "LedMatrix — NxN LED grid display.\n" +
    "r-data input selects which rows are lit in the addressed column.\n" +
    "c-addr input selects the column to update.\n" +
    "Matrix has (2^colAddrBits) columns and rowDataBits rows.\n" +
    "Display shown in a floating panel.",
};
