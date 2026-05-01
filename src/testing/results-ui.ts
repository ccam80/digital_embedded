/**
 * TestResultsPanel- browser UI for displaying test execution results.
 *
 * Renders test vectors as a table with pass/fail coloring.
 * Summary bar shows pass/fail counts.
 * Follows the PropertyPanel pattern from Phase 2.
 */

import type { TestResults, TestVector } from "@/headless/types.js";

/**
 * Test results display panel.
 *
 * Renders into a DOM container. Takes TestResults as input.
 * Displays test vectors in a table with:
 * - Input columns (signal names)
 * - Expected output columns (signal names)
 * - Actual output columns (signal names)
 * - Pass/fail row coloring
 * - Summary bar with pass/fail counts
 */
export class TestResultsPanel {
  private readonly _container: HTMLElement;

  constructor(container: HTMLElement) {
    this._container = container;
  }

  /**
   * Render test results into the panel.
   */
  render(results: TestResults): void {
    this._container.innerHTML = "";

    if (results.total === 0) {
      this._renderNoVectors();
      return;
    }

    this._renderSummary(results);
    this._renderTable(results);
  }

  /**
   * Show "No test vectors" message when results are empty.
   */
  private _renderNoVectors(): void {
    const message = document.createElement("div");
    message.className = "test-no-vectors";
    message.textContent = "No test vectors";
    this._container.appendChild(message);
  }

  /**
   * Render the summary bar showing pass/fail counts.
   */
  private _renderSummary(results: TestResults): void {
    const summary = document.createElement("div");
    summary.className = "test-summary";

    if (results.failed === 0) {
      summary.classList.add("test-all-pass");
    }

    summary.textContent = `${results.passed}/${results.total} passed`;

    this._container.appendChild(summary);
  }

  /**
   * Render the results table.
   */
  private _renderTable(results: TestResults): void {
    const table = document.createElement("table");
    table.className = "test-results-table";

    const thead = this._buildTableHead(results);
    const tbody = this._buildTableBody(results);

    table.appendChild(thead);
    table.appendChild(tbody);
    this._container.appendChild(table);
  }

  /**
   * Build the table header row with signal names.
   */
  private _buildTableHead(results: TestResults): HTMLTableSectionElement {
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    if (results.vectors.length === 0) {
      return thead;
    }

    const firstVector = results.vectors[0];

    const inputNames = Object.keys(firstVector.inputs).sort();
    const outputNames = Object.keys(firstVector.expectedOutputs).sort();

    for (const name of inputNames) {
      const th = document.createElement("th");
      th.className = "test-input-header";
      th.textContent = name;
      headerRow.appendChild(th);
    }

    for (const name of outputNames) {
      const th = document.createElement("th");
      th.className = "test-output-header";
      th.textContent = name;
      headerRow.appendChild(th);
    }

    thead.appendChild(headerRow);
    return thead;
  }

  /**
   * Build the table body with test vector rows.
   */
  private _buildTableBody(results: TestResults): HTMLTableSectionElement {
    const tbody = document.createElement("tbody");

    if (results.vectors.length === 0) {
      return tbody;
    }

    const firstVector = results.vectors[0];
    const inputNames = Object.keys(firstVector.inputs).sort();
    const outputNames = Object.keys(firstVector.expectedOutputs).sort();

    for (const vector of results.vectors) {
      const row = this._buildTableRow(vector, inputNames, outputNames);
      tbody.appendChild(row);
    }

    return tbody;
  }

  /**
   * Build a single table row for a test vector.
   */
  private _buildTableRow(
    vector: TestVector,
    inputNames: string[],
    outputNames: string[]
  ): HTMLTableRowElement {
    const row = document.createElement("tr");

    if (!vector.passed) {
      row.classList.add("test-failed");
    }

    for (const name of inputNames) {
      const cell = document.createElement("td");
      cell.className = "test-input";
      const value = vector.inputs[name];
      cell.textContent = String(value);
      row.appendChild(cell);
    }

    for (const name of outputNames) {
      const cell = document.createElement("td");
      cell.className = "test-output";

      const expected = vector.expectedOutputs[name];
      const actual = vector.actualOutputs[name];

      if (expected !== actual) {
        cell.classList.add("test-output-fail");
        cell.textContent = `Expected: ${expected}, Got: ${actual}`;
        cell.title = `Expected: ${expected}, Got: ${actual}`;
      } else {
        cell.classList.add("test-output-pass");
        cell.textContent = String(actual);
      }

      row.appendChild(cell);
    }

    return row;
  }
}
