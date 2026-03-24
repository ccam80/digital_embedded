/**
 * Tests for MemoryEditorDialog and HexGrid — Task 7.2.1.
 *
 * Uses a minimal DOM stub so tests run in node environment without jsdom.
 *
 * Covers:
 *   - displaysData: first row shows addresses 0x00-0x0F with correct values
 *   - editByte: edit byte at address 0x10, verify DataField updated
 *   - virtualScroll: 64KB DataField, scroll to 0xFF00, verify correct row displayed
 *   - goToAddress: enter "0x100", verify view scrolls to that address
 *   - dataWidthSwitch: switch 8-bit → 16-bit, verify columns re-render
 */

import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal DOM stub — installed before importing DOM-dependent modules
// ---------------------------------------------------------------------------

class StubClassList {
  readonly _classes: Set<string> = new Set();

  add(...tokens: string[]): void {
    for (const t of tokens) this._classes.add(t);
  }

  remove(...tokens: string[]): void {
    for (const t of tokens) this._classes.delete(t);
  }

  contains(token: string): boolean {
    return this._classes.has(token);
  }

  toString(): string {
    return [...this._classes].join(" ");
  }
}

type AnyListener = (...args: unknown[]) => void;

class StubElement {
  tagName: string;
  private _className: string = "";
  textContent: string | null = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  type: string = "";
  value: string = "";
  maxLength: number = 0;
  readonly classList: StubClassList = new StubClassList();
  readonly children: StubElement[] = [];
  parentElement: StubElement | null = null;

  /**
   * className getter/setter — keeps classList in sync.
   * MemoryEditorDialog sets element.className = "hex-row" etc.
   * querySelectorAll uses classList.contains() to match.
   */
  get className(): string {
    return this._className;
  }

  set className(value: string) {
    this._className = value;
    // Sync classList: replace all tokens
    const tokens = value.split(/\s+/).filter((t) => t.length > 0);
    // Reset classList by rebuilding it
    (this.classList as unknown as { _classes: Set<string> })._classes.clear();
    for (const t of tokens) {
      this.classList.add(t);
    }
  }

  /** Setting innerHTML to "" clears all children (used by _render). */
  set innerHTML(_value: string) {
    this.children.length = 0;
  }

  get innerHTML(): string {
    return "";
  }

  private readonly _listeners: Map<string, AnyListener[]> = new Map();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: StubElement): StubElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceWith(_replacement: StubElement): void {
    // In tests we don't simulate full replacement; cell stays as-is
  }

  setAttribute(_name: string, _value: string): void {}

  addEventListener(event: string, cb: AnyListener): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(cb);
  }

  removeEventListener(_event: string, _cb: AnyListener): void {}

  focus(): void {}
  select(): void {}

  /**
   * Recursively find all descendants matching a CSS class selector (.name)
   * or element + class (div.name). Supports chained selectors separated by
   * space (simple descendant only, no combinators beyond that needed here).
   */
  querySelectorAll(selector: string): StubElement[] {
    const results: StubElement[] = [];
    this._collectMatching(selector.trim(), results);
    return results;
  }

  querySelector(selector: string): StubElement | null {
    const all = this.querySelectorAll(selector);
    return all[0] ?? null;
  }

  private _matchesSimple(selector: string): boolean {
    // Handles: ".classname" and "tag.classname" and "tag"
    const dotIdx = selector.indexOf(".");
    if (dotIdx === -1) {
      return this.tagName.toLowerCase() === selector.toLowerCase();
    }
    const tagPart = selector.slice(0, dotIdx);
    const classPart = selector.slice(dotIdx + 1);
    const tagMatch = tagPart === "" || this.tagName.toLowerCase() === tagPart.toLowerCase();
    const classMatch = this.classList.contains(classPart);
    return tagMatch && classMatch;
  }

  private _collectMatching(selector: string, results: StubElement[]): void {
    for (const child of this.children) {
      if (child._matchesSimple(selector)) {
        results.push(child);
      }
      child._collectMatching(selector, results);
    }
  }
}

const stubDocument = {
  body: new StubElement("body"),
  createElement(tagName: string): StubElement {
    return new StubElement(tagName);
  },
};

// Install stub globally before module imports
(globalThis as Record<string, unknown>)["document"] = stubDocument;

// ---------------------------------------------------------------------------
// Import modules AFTER installing stub
// ---------------------------------------------------------------------------

import { DataField } from "../../components/memory/ram.js";
import { MemoryEditorDialog } from "../memory-editor.js";
import { HexGrid } from "../hex-grid.js";

// ---------------------------------------------------------------------------
// HexGrid unit tests (no DOM needed)
// ---------------------------------------------------------------------------

describe("HexGrid", () => {
  it("generates correct first row for 256-byte DataField", () => {
    const df = new DataField(256);
    for (let i = 0; i < 16; i++) {
      df.write(i, i * 0x11);
    }

    const grid = new HexGrid(df, 8, 16);
    const rows = grid.renderVisible();

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const firstRow = rows[0];
    expect(firstRow.baseAddress).toBe(0);
    expect(firstRow.addressStr).toBe("0x00");
    expect(firstRow.hexCells.length).toBe(16);
    expect(firstRow.hexCells[0]).toBe("00");
    expect(firstRow.hexCells[1]).toBe("11");
    expect(firstRow.hexCells[2]).toBe("22");
  });

  it("generates correct address string for second row", () => {
    const df = new DataField(256);
    const grid = new HexGrid(df, 8, 16);
    const rows = grid.renderVisible();

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[1].baseAddress).toBe(16);
    expect(rows[1].addressStr).toBe("0x10");
  });

  it("generates ascii decode for 8-bit mode", () => {
    const df = new DataField(256);
    df.write(0, 0x41); // 'A'
    df.write(1, 0x42); // 'B'
    df.write(2, 0x01); // non-printable → '.'

    const grid = new HexGrid(df, 8, 1);
    const rows = grid.renderVisible();

    expect(rows[0].ascii).toMatch(/^AB\./);
  });

  it("scrolls to address 0xFF00 in a 64KB DataField", () => {
    const df = new DataField(65536);
    df.write(0xFF00, 0xAB);

    const grid = new HexGrid(df, 8, 16);
    grid.scrollToAddress(0xFF00);

    const rows = grid.renderVisible();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const baseAddresses = rows.map((r) => r.baseAddress);
    expect(baseAddresses[0]).toBeLessThanOrEqual(0xFF00);
    expect(baseAddresses[baseAddresses.length - 1]).toBeGreaterThanOrEqual(0xFF00);

    const targetRow = rows.find((r) =>
      r.baseAddress <= 0xFF00 && r.baseAddress + r.hexCells.length > 0xFF00,
    );
    expect(targetRow).toBeDefined();
    if (targetRow !== undefined) {
      const col = 0xFF00 - targetRow.baseAddress;
      expect(targetRow.hexCells[col]).toBe("AB");
    }
  });

  it("does not render all rows when scrolled (only visible window)", () => {
    const df = new DataField(65536);
    const grid = new HexGrid(df, 8, 16);
    grid.scrollToAddress(0xFF00);

    const rows = grid.renderVisible();
    expect(rows.length).toBeLessThanOrEqual(16);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("16-bit mode produces 8 columns per row", () => {
    const df = new DataField(256);
    const grid = new HexGrid(df, 16, 4);
    const rows = grid.renderVisible();

    expect(rows[0].hexCells.length).toBe(8);
    expect(rows[0].hexCells[0].length).toBe(4); // 4 hex digits for 16-bit
    expect(rows[0].ascii).toBe(""); // no ascii in 16-bit mode
  });

  it("32-bit mode produces 4 columns per row", () => {
    const df = new DataField(256);
    const grid = new HexGrid(df, 32, 4);
    const rows = grid.renderVisible();

    expect(rows[0].hexCells.length).toBe(4);
    expect(rows[0].hexCells[0].length).toBe(8); // 8 hex digits for 32-bit
  });
});

// ---------------------------------------------------------------------------
// MemoryEditorDialog tests
// ---------------------------------------------------------------------------

describe("MemoryEditorDialog", () => {
  let container: StubElement;
  let df: DataField;
  let editor: MemoryEditorDialog;

  beforeEach(() => {
    container = new StubElement("div");
    // Use 4096-word DataField so addresses like 0x100 (256) are in range
    df = new DataField(4096);
    editor = new MemoryEditorDialog(df as DataField, container as unknown as HTMLElement);
  });

  describe("displaysData", () => {
    it("renders hex-row elements for visible addresses", () => {
      for (let i = 0; i < 16; i++) {
        df.write(i, i);
      }

      editor.render();

      const rows = container.querySelectorAll(".hex-row");
      expect(rows.length).toBeGreaterThan(0);

      const firstRow = rows[0];
      const addrEl = firstRow.querySelector(".hex-addr") as StubElement;
      expect(addrEl).not.toBeNull();
      // 4096-word DataField uses 4-digit addresses: "0x0000"
      expect(addrEl.textContent).toBe("0x0000");

      const cells = firstRow.querySelectorAll(".hex-cell");
      expect(cells.length).toBe(16);
      expect(cells[0].textContent).toBe("00");
      expect(cells[1].textContent).toBe("01");
      expect(cells[2].textContent).toBe("02");
    });

    it("displays correct hex values for non-zero data", () => {
      df.write(0, 0xAB);
      df.write(1, 0xCD);
      df.write(15, 0xFF);

      editor.render();

      const cells = container.querySelectorAll(".hex-cell");
      expect(cells[0].textContent).toBe("AB");
      expect(cells[1].textContent).toBe("CD");
      expect(cells[15].textContent).toBe("FF");
    });
  });

  describe("editByte", () => {
    it("updates DataField when editCell is called", () => {
      editor.render();
      editor.editCell(0x10, 0xBE);
      expect(df.read(0x10)).toBe(0xBE);
    });

    it("updates DataField for address in first visible row", () => {
      editor.render();
      editor.editCell(0x05, 0x7F);
      expect(df.read(0x05)).toBe(0x7F);
    });
  });

  describe("virtualScroll", () => {
    it("scrolls to address 0xFF00 in a 64KB DataField without rendering all rows", () => {
      const bigDf = new DataField(65536);
      bigDf.write(0xFF00, 0x42);

      const bigContainer = new StubElement("div");
      const bigEditor = new MemoryEditorDialog(
        bigDf as DataField,
        bigContainer as unknown as HTMLElement,
      );
      bigEditor.render();
      bigEditor.goToAddress(0xFF00);

      const rows = bigContainer.querySelectorAll(".hex-row");
      expect(rows.length).toBeLessThanOrEqual(16);
      expect(rows.length).toBeGreaterThan(0);

      // Find the cell at address 0xFF00
      let foundTarget = false;
      for (const row of rows) {
        const cells = row.querySelectorAll(".hex-cell");
        for (const cell of cells) {
          const addrStr = (cell as StubElement).dataset["address"];
          if (addrStr !== undefined && parseInt(addrStr, 10) === 0xFF00) {
            foundTarget = true;
            expect(cell.textContent).toBe("42");
          }
        }
      }
      expect(foundTarget).toBe(true);
    });

    it("scroll row is updated when goToAddress is called", () => {
      const bigDf = new DataField(65536);
      const bigContainer = new StubElement("div");
      const bigEditor = new MemoryEditorDialog(
        bigDf as DataField,
        bigContainer as unknown as HTMLElement,
      );
      bigEditor.render();
      bigEditor.goToAddress(0xFF00);

      const scrollRow = bigEditor.getScrollRow();
      // In 8-bit mode, 16 bytes per row: row for 0xFF00 = 0xFF00 / 16 = 4080
      expect(scrollRow).toBe(Math.floor(0xFF00 / 16));
    });
  });

  describe("goToAddress", () => {
    it("scrolls view to address 0x100", () => {
      editor.render();
      editor.goToAddress(0x100);

      const scrollRow = editor.getScrollRow();
      // In 8-bit mode, 16 bytes per row: row for 0x100 = 0x100 / 16 = 16
      expect(scrollRow).toBe(Math.floor(0x100 / 16));
    });

    it("renders rows near the target address after goToAddress", () => {
      df.write(0x100, 0x55);
      editor.render();
      editor.goToAddress(0x100);

      const rows = container.querySelectorAll(".hex-row");
      expect(rows.length).toBeGreaterThan(0);

      const firstRow = rows[0];
      const addrEl = firstRow.querySelector(".hex-addr") as StubElement;
      // 4096-word DataField uses 4-digit addresses: "0x0100"
      expect(addrEl.textContent).toBe("0x0100");
    });
  });

  describe("dataWidthSwitch", () => {
    it("switches from 8-bit to 16-bit mode and updates column count", () => {
      editor.render();
      expect(editor.getDataWidth()).toBe(8);

      editor.setDataWidth(16);
      expect(editor.getDataWidth()).toBe(16);

      const rows = container.querySelectorAll(".hex-row");
      expect(rows.length).toBeGreaterThan(0);

      const firstRow = rows[0];
      const cells = firstRow.querySelectorAll(".hex-cell");
      // 16-bit mode: 8 columns per row
      expect(cells.length).toBe(8);
    });

    it("switches from 8-bit to 32-bit mode and updates column count", () => {
      editor.render();
      editor.setDataWidth(32);

      const rows = container.querySelectorAll(".hex-row");
      const firstRow = rows[0];
      const cells = firstRow.querySelectorAll(".hex-cell");
      // 32-bit mode: 4 columns per row
      expect(cells.length).toBe(4);
      // Each cell should show 8 hex digits
      expect(cells[0].textContent!.length).toBe(8);
    });

    it("scrolls back to top when data width changes", () => {
      editor.render();
      editor.goToAddress(0x80);
      expect(editor.getScrollRow()).toBeGreaterThan(0);

      editor.setDataWidth(16);
      expect(editor.getScrollRow()).toBe(0);
    });
  });
});
