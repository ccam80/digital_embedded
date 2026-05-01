/**
 * HexGrid- virtualized hex grid renderer for the memory editor.
 *
 * Renders only visible rows from a DataField, supporting large memories
 * (64KB+) without constructing DOM nodes for every address.
 *
 * Layout per row:
 *   [address] [hex columns...] [ascii decode]
 *
 * Data width modes:
 *   8-bit - 16 bytes per row, each displayed as 2 hex digits
 *   16-bit- 8 words per row, each displayed as 4 hex digits
 *   32-bit- 4 dwords per row, each displayed as 8 hex digits
 */

import type { DataField } from "../components/memory/ram.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Display unit width in bits. */
export type DataWidth = 8 | 16 | 32;

/** A rendered hex grid row (data only, not DOM). */
export interface HexRow {
  /** Base address of this row (first word address in the row). */
  baseAddress: number;
  /** Formatted address string (e.g. "0x00FF"). */
  addressStr: string;
  /** Hex cell strings, one per column. */
  hexCells: string[];
  /** Raw word values for each cell. */
  values: number[];
  /** ASCII decode string for byte-width display. Empty for wider widths. */
  ascii: string;
}

// ---------------------------------------------------------------------------
// HexGrid
// ---------------------------------------------------------------------------

/**
 * Virtualized hex grid renderer.
 *
 * Generates HexRow objects for the visible address window without allocating
 * DOM nodes for the entire memory.
 */
export class HexGrid {
  private _dataField: DataField;
  private _dataWidth: DataWidth;
  /** Number of data-width units per row. */
  private _columnsPerRow: number;
  /** Total number of rows (addresses / columnsPerRow). */
  private _totalRows: number;
  /** Index of the first visible row. */
  private _scrollRow: number;
  /** Maximum number of rows to render at once. */
  private _visibleRowCount: number;

  constructor(dataField: DataField, dataWidth: DataWidth = 8, visibleRowCount: number = 16) {
    this._dataField = dataField;
    this._dataWidth = dataWidth;
    this._visibleRowCount = visibleRowCount;
    this._scrollRow = 0;
    this._columnsPerRow = this._computeColumnsPerRow(dataWidth);
    this._totalRows = Math.ceil(dataField.size / this._columnsPerRow);
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /** Change the data width display mode. Resets scroll to top. */
  setDataWidth(width: DataWidth): void {
    this._dataWidth = width;
    this._columnsPerRow = this._computeColumnsPerRow(width);
    this._totalRows = Math.ceil(this._dataField.size / this._columnsPerRow);
    this._scrollRow = 0;
  }

  /** Return the current data width. */
  getDataWidth(): DataWidth {
    return this._dataWidth;
  }

  /** Return total number of rows for the current data field and width. */
  getTotalRows(): number {
    return this._totalRows;
  }

  /** Return the current first visible row index. */
  getScrollRow(): number {
    return this._scrollRow;
  }

  /** Return the number of columns per row for the current data width. */
  getColumnsPerRow(): number {
    return this._columnsPerRow;
  }

  // ---------------------------------------------------------------------------
  // Scrolling
  // ---------------------------------------------------------------------------

  /**
   * Scroll to make the row containing the given address visible.
   * The address is a word index into the DataField.
   */
  scrollToAddress(address: number): void {
    const safeAddr = Math.max(0, Math.min(address, this._dataField.size - 1));
    const targetRow = Math.floor(safeAddr / this._columnsPerRow);
    this._scrollRow = Math.max(0, Math.min(targetRow, this._totalRows - 1));
  }

  /**
   * Return the row index that contains the given address.
   */
  rowForAddress(address: number): number {
    return Math.floor(address / this._columnsPerRow);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Generate HexRow objects for the currently visible window.
   * Only rows from _scrollRow up to (_scrollRow + _visibleRowCount - 1)
   * are generated, clamped to _totalRows.
   */
  renderVisible(): HexRow[] {
    const rows: HexRow[] = [];
    const endRow = Math.min(this._scrollRow + this._visibleRowCount, this._totalRows);
    for (let rowIdx = this._scrollRow; rowIdx < endRow; rowIdx++) {
      rows.push(this._buildRow(rowIdx));
    }
    return rows;
  }

  /**
   * Generate a single HexRow by row index.
   */
  renderRow(rowIdx: number): HexRow {
    return this._buildRow(rowIdx);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _computeColumnsPerRow(width: DataWidth): number {
    switch (width) {
      case 8:  return 16;
      case 16: return 8;
      case 32: return 4;
    }
  }

  private _hexDigits(width: DataWidth): number {
    switch (width) {
      case 8:  return 2;
      case 16: return 4;
      case 32: return 8;
    }
  }

  private _buildRow(rowIdx: number): HexRow {
    const baseAddress = rowIdx * this._columnsPerRow;
    const addrDigits = this._addrDigits();
    const addressStr = "0x" + baseAddress.toString(16).toUpperCase().padStart(addrDigits, "0");

    const hexCells: string[] = [];
    const values: number[] = [];
    const hexWidth = this._hexDigits(this._dataWidth);

    for (let col = 0; col < this._columnsPerRow; col++) {
      const addr = baseAddress + col;
      const value = addr < this._dataField.size ? this._dataField.read(addr) : 0;
      values.push(value);
      hexCells.push(value.toString(16).toUpperCase().padStart(hexWidth, "0"));
    }

    const ascii = this._dataWidth === 8 ? this._buildAscii(values) : "";

    return { baseAddress, addressStr, hexCells, values, ascii };
  }

  private _addrDigits(): number {
    const size = this._dataField.size;
    if (size <= 0x100)   return 2;
    if (size <= 0x10000) return 4;
    return 6;
  }

  private _buildAscii(values: number[]): string {
    return values
      .map((v) => {
        const byte = v & 0xFF;
        return byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : ".";
      })
      .join("");
  }
}
