/**
 * TruthTable data model — source-of-truth for the analysis dialog.
 *
 * Stores input/output signal specs and output values for every input
 * combination. Output values use a ternary encoding:
 *   0n = logic low, 1n = logic high, -1n = don't-care (X).
 *
 * The truth table emits change events so the expressions tab, K-map tab,
 * and synthesis pipeline stay synchronised.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalSpec {
  readonly name: string;
  readonly bitWidth: number;
}

/** Ternary output value: 0 = low, 1 = high, -1 = don't-care. */
export type TernaryValue = 0n | 1n | -1n;

export type TruthTableChangeListener = () => void;

// ---------------------------------------------------------------------------
// TruthTable
// ---------------------------------------------------------------------------

export class TruthTable {
  private _inputs: SignalSpec[];
  private _outputs: SignalSpec[];

  /**
   * Flat array of output values.  Layout: row-major, one entry per
   * (output-signal × row).  Index = row * outputCount + outputIndex.
   */
  private _data: TernaryValue[];

  private readonly _listeners = new Set<TruthTableChangeListener>();

  constructor(inputs: SignalSpec[], outputs: SignalSpec[], data?: TernaryValue[]) {
    this._inputs = [...inputs];
    this._outputs = [...outputs];

    const rowCount = this._rowCount();
    const cellCount = rowCount * outputs.length;

    if (data !== undefined) {
      if (data.length !== cellCount) {
        throw new Error(
          `TruthTable: data length ${data.length} does not match expected ${cellCount}`,
        );
      }
      this._data = [...data];
    } else {
      // Default: all outputs X (don't-care)
      this._data = new Array<TernaryValue>(cellCount).fill(-1n);
    }
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get inputs(): readonly SignalSpec[] {
    return this._inputs;
  }

  get outputs(): readonly SignalSpec[] {
    return this._outputs;
  }

  get rowCount(): number {
    return this._rowCount();
  }

  /** Total input bit width (determines number of rows = 2^totalBits). */
  get totalInputBits(): number {
    return this._inputs.reduce((sum, s) => sum + s.bitWidth, 0);
  }

  // -------------------------------------------------------------------------
  // Data access
  // -------------------------------------------------------------------------

  /**
   * Get the output value for a given row and output index.
   */
  getOutput(row: number, outputIndex: number): TernaryValue {
    return this._data[row * this._outputs.length + outputIndex]!;
  }

  /**
   * Set the output value for a given row and output index.
   */
  setOutput(row: number, outputIndex: number, value: TernaryValue): void {
    const idx = row * this._outputs.length + outputIndex;
    if (this._data[idx] === value) return;
    this._data[idx] = value;
    this._emit();
  }

  /**
   * Get the input combination for a given row as an array of bigint values
   * (one per input signal).
   */
  getInputValues(row: number): bigint[] {
    const values: bigint[] = [];
    let bitOffset = this.totalInputBits - 1;

    for (const input of this._inputs) {
      let val = 0n;
      for (let b = input.bitWidth - 1; b >= 0; b--) {
        if ((row >> bitOffset) & 1) {
          val |= 1n << BigInt(b);
        }
        bitOffset--;
      }
      values.push(val);
    }

    return values;
  }

  /**
   * Get all output values for a given row.
   */
  getOutputRow(row: number): TernaryValue[] {
    const start = row * this._outputs.length;
    return this._data.slice(start, start + this._outputs.length);
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /**
   * Add an input signal. Doubles the number of rows.
   * New rows are initialised with don't-care outputs.
   */
  addInput(spec: SignalSpec): void {
    this._inputs.push(spec);
    this._rebuildData();
    this._emit();
  }

  /**
   * Remove an input signal by index. Halves the number of rows.
   */
  removeInput(index: number): void {
    if (index < 0 || index >= this._inputs.length) {
      throw new RangeError(`removeInput: index ${index} out of range`);
    }
    this._inputs.splice(index, 1);
    this._rebuildData();
    this._emit();
  }

  /**
   * Reorder input columns by providing new indices.
   * Example: [1, 0] swaps two input columns.
   */
  reorderInputColumns(newOrder: number[]): void {
    if (newOrder.length !== this._inputs.length) {
      throw new Error('reorderInputColumns: order length must match input count');
    }

    const oldInputs = this._inputs;
    const oldData = this._data;
    const outCount = this._outputs.length;
    const oldRowCount = this._rowCount();

    // Rearrange inputs
    this._inputs = newOrder.map((i) => oldInputs[i]!);

    // Rearrange data: for each new row, find the corresponding old row
    const totalBits = this.totalInputBits;
    const newData = new Array<TernaryValue>(oldData.length);

    for (let newRow = 0; newRow < oldRowCount; newRow++) {
      // Decompose newRow into per-input bit values using new input order
      const bitValues = this._decomposeBits(newRow, this._inputs);

      // Compose oldRow using old input order
      const reorderedBits: bigint[] = new Array(oldInputs.length);
      for (let i = 0; i < newOrder.length; i++) {
        reorderedBits[newOrder[i]!] = bitValues[i]!;
      }
      const oldRow = this._composeBits(reorderedBits, oldInputs, totalBits);

      // Copy output values from old row to new row
      for (let o = 0; o < outCount; o++) {
        newData[newRow * outCount + o] = oldData[oldRow * outCount + o]!;
      }
    }

    this._data = newData;
    this._emit();
  }

  /**
   * Reorder output columns by providing new indices.
   */
  reorderOutputColumns(newOrder: number[]): void {
    if (newOrder.length !== this._outputs.length) {
      throw new Error('reorderOutputColumns: order length must match output count');
    }

    const oldOutputs = this._outputs;
    const oldData = this._data;
    const rowCount = this._rowCount();
    const outCount = oldOutputs.length;

    this._outputs = newOrder.map((i) => oldOutputs[i]!);

    const newData = new Array<TernaryValue>(oldData.length);
    for (let r = 0; r < rowCount; r++) {
      for (let newO = 0; newO < outCount; newO++) {
        newData[r * outCount + newO] = oldData[r * outCount + newOrder[newO]!]!;
      }
    }

    this._data = newData;
    this._emit();
  }

  // -------------------------------------------------------------------------
  // Change events
  // -------------------------------------------------------------------------

  addChangeListener(listener: TruthTableChangeListener): void {
    this._listeners.add(listener);
  }

  removeChangeListener(listener: TruthTableChangeListener): void {
    this._listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Static factory
  // -------------------------------------------------------------------------

  /**
   * Create a blank truth table with specified inputs and outputs.
   * All output cells are initialised to don't-care (X).
   */
  static blank(inputs: SignalSpec[], outputs: SignalSpec[]): TruthTable {
    return new TruthTable(inputs, outputs);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _rowCount(): number {
    return 1 << this.totalInputBits;
  }

  private _rebuildData(): void {
    const rowCount = this._rowCount();
    const cellCount = rowCount * this._outputs.length;
    this._data = new Array<TernaryValue>(cellCount).fill(-1n);
  }

  private _decomposeBits(row: number, inputs: SignalSpec[]): bigint[] {
    const values: bigint[] = [];
    let bitOffset = this.totalInputBits - 1;
    for (const input of inputs) {
      let val = 0n;
      for (let b = input.bitWidth - 1; b >= 0; b--) {
        if ((row >> bitOffset) & 1) {
          val |= 1n << BigInt(b);
        }
        bitOffset--;
      }
      values.push(val);
    }
    return values;
  }

  private _composeBits(values: bigint[], inputs: SignalSpec[], _totalBits: number): number {
    let row = 0;
    let bitOffset = this.totalInputBits - 1;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      const val = values[i]!;
      for (let b = input.bitWidth - 1; b >= 0; b--) {
        if ((val >> BigInt(b)) & 1n) {
          row |= 1 << bitOffset;
        }
        bitOffset--;
      }
    }
    return row;
  }

  private _emit(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}
