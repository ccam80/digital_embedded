/**
 * TruthTableTab — editable truth table grid for the analysis dialog.
 *
 * Renders a TruthTable as an HTML table with clickable output cells
 * that cycle through 0 → 1 → X → 0. Input cells are read-only.
 */

import type { TruthTable, TernaryValue } from './truth-table.js';

// ---------------------------------------------------------------------------
// TruthTableTab
// ---------------------------------------------------------------------------

export class TruthTableTab {
  private readonly _table: TruthTable;
  private _container: HTMLElement | null = null;

  constructor(table: TruthTable) {
    this._table = table;
  }

  get table(): TruthTable {
    return this._table;
  }

  /**
   * Render the truth table grid into the given container element.
   * Replaces any existing content.
   */
  render(container: HTMLElement): void {
    this._container = container;
    container.innerHTML = '';

    const tableEl = document.createElement('table');
    tableEl.className = 'truth-table-grid';

    // Header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    for (const input of this._table.inputs) {
      const th = document.createElement('th');
      th.className = 'tt-input-header';
      th.textContent = input.name;
      headerRow.appendChild(th);
    }

    for (const output of this._table.outputs) {
      const th = document.createElement('th');
      th.className = 'tt-output-header';
      th.textContent = output.name;
      headerRow.appendChild(th);
    }

    thead.appendChild(headerRow);
    tableEl.appendChild(thead);

    // Data rows
    const tbody = document.createElement('tbody');

    for (let row = 0; row < this._table.rowCount; row++) {
      const tr = document.createElement('tr');
      tr.className = 'tt-row';

      // Input cells (read-only)
      const inputValues = this._table.getInputValues(row);
      for (let i = 0; i < this._table.inputs.length; i++) {
        const td = document.createElement('td');
        td.className = 'tt-input-cell';
        td.textContent = inputValues[i]!.toString();
        tr.appendChild(td);
      }

      // Output cells (editable)
      for (let o = 0; o < this._table.outputs.length; o++) {
        const td = document.createElement('td');
        td.className = 'tt-output-cell';
        td.dataset.row = String(row);
        td.dataset.col = String(o);
        td.textContent = formatTernary(this._table.getOutput(row, o));

        td.addEventListener('click', () => {
          this._cycleCell(row, o, td);
        });

        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    tableEl.appendChild(tbody);
    container.appendChild(tableEl);
  }

  /**
   * Get all rendered row elements.
   */
  getRows(): HTMLElement[] {
    if (!this._container) return [];
    return Array.from(this._container.querySelectorAll('.tt-row')) as HTMLElement[];
  }

  /**
   * Get a specific output cell element.
   */
  getOutputCell(row: number, outputIndex: number): HTMLElement | null {
    if (!this._container) return null;
    return this._container.querySelector(
      `.tt-output-cell[data-row="${row}"][data-col="${outputIndex}"]`,
    ) as HTMLElement | null;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _cycleCell(row: number, outputIndex: number, td: HTMLElement): void {
    const current = this._table.getOutput(row, outputIndex);
    const next = cycleTernary(current);
    this._table.setOutput(row, outputIndex, next);
    td.textContent = formatTernary(next);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTernary(value: TernaryValue): string {
  if (value === -1n) return 'X';
  return value.toString();
}

function cycleTernary(value: TernaryValue): TernaryValue {
  switch (value) {
    case 0n:
      return 1n;
    case 1n:
      return -1n;
    case -1n:
      return 0n;
  }
}
