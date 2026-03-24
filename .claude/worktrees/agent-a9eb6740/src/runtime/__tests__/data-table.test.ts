/**
 * Tests for DataTablePanel — live tabular view of measured signals.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { DataTablePanel } from "../data-table.js";
import type { SignalDescriptor } from "../data-table.js";
import { MockEngine } from "@/test-utils/mock-engine";

// ---------------------------------------------------------------------------
// JSDOM helpers
// ---------------------------------------------------------------------------

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function teardown(el: HTMLElement): void {
  el.remove();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THREE_SIGNALS: SignalDescriptor[] = [
  { name: "A", netId: 0, width: 1, group: "input" },
  { name: "B", netId: 1, width: 1, group: "input" },
  { name: "Y", netId: 2, width: 1, group: "output" },
];

// ---------------------------------------------------------------------------
// rendersSignals — create with 3 signals, verify 3 rows rendered with names
// ---------------------------------------------------------------------------

describe("DataTablePanel", () => {
  describe("rendersSignals", () => {
    it("renders 3 rows with correct signal names", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);

      // There should be 3 data rows (excluding group separator rows)
      const dataRows = container.querySelectorAll(".data-table-row");
      expect(dataRows.length).toBe(3);

      // Verify signal names appear in name cells
      const nameCells = container.querySelectorAll(".data-table-cell-name");
      const names = Array.from(nameCells).map((td) => td.textContent);
      expect(names).toContain("A");
      expect(names).toContain("B");
      expect(names).toContain("Y");

      panel.dispose();
      teardown(container);
    });

    it("getSignalNames returns all signal names", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);
      const names = panel.getSignalNames();

      expect(names).toContain("A");
      expect(names).toContain("B");
      expect(names).toContain("Y");
      expect(names.length).toBe(3);

      panel.dispose();
      teardown(container);
    });

    it("registers as observer and table has header row", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);

      // Header row should contain Signal and Value columns
      const headers = container.querySelectorAll("th");
      const headerTexts = Array.from(headers).map((th) => th.textContent);
      expect(headerTexts).toContain("Signal");
      expect(headerTexts).toContain("Value");

      panel.dispose();
      teardown(container);
    });
  });

  // -------------------------------------------------------------------------
  // updatesOnStep — call onStep(), verify values refreshed from engine
  // -------------------------------------------------------------------------

  describe("updatesOnStep", () => {
    it("reads signal values from the engine after onStep()", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });
      engine.setNetWidth(0, 8);
      engine.setNetWidth(1, 8);
      engine.setNetWidth(2, 8);

      // Set up signal values in the engine
      engine.setSignalRaw(0, 7);
      engine.setSignalRaw(1, 42);
      engine.setSignalRaw(2, 255);

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);

      // Before step, values should be empty
      expect(panel.getDisplayValueByName("A")).toBe("");
      expect(panel.getDisplayValueByName("B")).toBe("");
      expect(panel.getDisplayValueByName("Y")).toBe("");

      // Trigger step
      panel.onStep(1);

      // After step, values should be read from engine
      // Default radix is dec
      expect(panel.getDisplayValueByName("A")).toBe("7");
      expect(panel.getDisplayValueByName("B")).toBe("42");
      expect(panel.getDisplayValueByName("Y")).toBe("255");

      panel.dispose();
      teardown(container);
    });

    it("value cells in DOM are updated after onStep()", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });
      engine.setNetWidth(0, 8);
      engine.setNetWidth(1, 8);
      engine.setNetWidth(2, 8);
      engine.setSignalRaw(0, 5);
      engine.setSignalRaw(1, 10);
      engine.setSignalRaw(2, 15);

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);
      panel.onStep(1);

      const valueCells = container.querySelectorAll(".data-table-cell-value");
      const values = Array.from(valueCells).map((td) => td.textContent);
      expect(values).toContain("5");
      expect(values).toContain("10");
      expect(values).toContain("15");

      panel.dispose();
      teardown(container);
    });
  });

  // -------------------------------------------------------------------------
  // radixSwitch — switch signal from decimal to hex, verify display format
  // -------------------------------------------------------------------------

  describe("radixSwitch", () => {
    it("switches from decimal to hex display format", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });
      engine.setNetWidth(0, 8);
      engine.setSignalRaw(0, 255);

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);
      panel.onStep(1);

      // Default radix is decimal
      expect(panel.getDisplayValueByName("A")).toBe("255");
      expect(panel.getRadixByName("A")).toBe("dec");

      // Switch to hex
      panel.setRadixByName("A", "hex");
      expect(panel.getRadixByName("A")).toBe("hex");
      expect(panel.getDisplayValueByName("A")).toBe("0xFF");

      panel.dispose();
      teardown(container);
    });

    it("switches from decimal to binary display format", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });
      engine.setNetWidth(0, 8);
      engine.setSignalRaw(0, 10);

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);
      panel.onStep(1);

      panel.setRadixByName("A", "bin");
      expect(panel.getDisplayValueByName("A")).toBe("0b00001010");

      panel.dispose();
      teardown(container);
    });

    it("setRadix by index changes the correct signal", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });
      engine.setNetWidth(0, 8);
      engine.setNetWidth(1, 8);
      engine.setSignalRaw(0, 16);
      engine.setSignalRaw(1, 32);

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);
      panel.onStep(1);

      // Index 0 in grouped order is "A" (first input)
      panel.setRadix(0, "hex");
      expect(panel.getDisplayValueByName("A")).toBe("0x10");
      // B remains decimal
      expect(panel.getDisplayValueByName("B")).toBe("32");

      panel.dispose();
      teardown(container);
    });

    it("DOM reflects radix change", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });
      engine.setNetWidth(0, 8);
      engine.setSignalRaw(0, 255);

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);
      panel.onStep(1);
      panel.setRadixByName("A", "hex");

      // Find the row for signal A and check its value cell
      const rows = container.querySelectorAll(".data-table-row");
      let foundHex = false;
      for (const row of Array.from(rows)) {
        if ((row as HTMLElement).dataset["signalName"] === "A") {
          const valueCell = row.querySelector(".data-table-cell-value");
          expect(valueCell?.textContent).toBe("0xFF");
          foundHex = true;
          break;
        }
      }
      expect(foundHex).toBe(true);

      panel.dispose();
      teardown(container);
    });
  });

  // -------------------------------------------------------------------------
  // onReset — call onReset(), verify values cleared/reset
  // -------------------------------------------------------------------------

  describe("onReset", () => {
    it("clears all values on reset", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });
      engine.setNetWidth(0, 8);
      engine.setNetWidth(1, 8);
      engine.setNetWidth(2, 8);
      engine.setSignalRaw(0, 42);
      engine.setSignalRaw(1, 100);
      engine.setSignalRaw(2, 7);

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);

      // Step to populate values
      panel.onStep(1);
      expect(panel.getDisplayValueByName("A")).toBe("42");
      expect(panel.getDisplayValueByName("B")).toBe("100");
      expect(panel.getDisplayValueByName("Y")).toBe("7");

      // Reset should clear all values
      panel.onReset();
      expect(panel.getDisplayValueByName("A")).toBe("");
      expect(panel.getDisplayValueByName("B")).toBe("");
      expect(panel.getDisplayValueByName("Y")).toBe("");

      panel.dispose();
      teardown(container);
    });

    it("DOM value cells are empty strings after reset", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });
      engine.setNetWidth(0, 8);
      engine.setSignalRaw(0, 5);

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);
      panel.onStep(1);

      // Verify some value shown
      const beforeReset = container.querySelectorAll(".data-table-cell-value");
      const beforeValues = Array.from(beforeReset).map((td) => td.textContent);
      expect(beforeValues).toContain("5");

      panel.onReset();

      // After reset all value cells should be empty
      const afterReset = container.querySelectorAll(".data-table-cell-value");
      const afterValues = Array.from(afterReset).map((td) => td.textContent);
      for (const v of afterValues) {
        expect(v).toBe("");
      }

      panel.dispose();
      teardown(container);
    });

    it("can step again after reset to repopulate values", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });
      engine.setNetWidth(0, 8);
      engine.setSignalRaw(0, 99);

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);
      panel.onStep(1);
      panel.onReset();

      // Step again — should repopulate from engine
      engine.setSignalRaw(0, 77);
      panel.onStep(2);
      expect(panel.getDisplayValueByName("A")).toBe("77");

      panel.dispose();
      teardown(container);
    });
  });

  // -------------------------------------------------------------------------
  // Sorting and grouping
  // -------------------------------------------------------------------------

  describe("sorting and grouping", () => {
    it("groups signals by input, output, probe in default order", () => {
      const signals: SignalDescriptor[] = [
        { name: "Y", netId: 2, width: 1, group: "output" },
        { name: "P", netId: 3, width: 1, group: "probe" },
        { name: "A", netId: 0, width: 1, group: "input" },
        { name: "B", netId: 1, width: 1, group: "input" },
      ];

      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 4, componentCount: 0 });

      const panel = new DataTablePanel(container, engine, signals);
      const names = panel.getSignalNames();

      // inputs first, then outputs, then probes
      const inputNames = names.filter((n) =>
        signals.find((s) => s.name === n)?.group === "input",
      );
      const outputNames = names.filter((n) =>
        signals.find((s) => s.name === n)?.group === "output",
      );
      const probeNames = names.filter((n) =>
        signals.find((s) => s.name === n)?.group === "probe",
      );

      expect(inputNames).toEqual(["A", "B"]);
      expect(outputNames).toEqual(["Y"]);
      expect(probeNames).toEqual(["P"]);

      // Verify order: all inputs before all outputs before all probes
      const inputLastIdx = Math.max(...inputNames.map((n) => names.indexOf(n)));
      const outputFirstIdx = Math.min(...outputNames.map((n) => names.indexOf(n)));
      const outputLastIdx = Math.max(...outputNames.map((n) => names.indexOf(n)));
      const probeFirstIdx = Math.min(...probeNames.map((n) => names.indexOf(n)));

      expect(inputLastIdx).toBeLessThan(outputFirstIdx);
      expect(outputLastIdx).toBeLessThan(probeFirstIdx);

      panel.dispose();
      teardown(container);
    });

    it("setSortByName sorts alphabetically", () => {
      const signals: SignalDescriptor[] = [
        { name: "C", netId: 2, width: 1, group: "output" },
        { name: "A", netId: 0, width: 1, group: "input" },
        { name: "B", netId: 1, width: 1, group: "probe" },
      ];

      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });

      const panel = new DataTablePanel(container, engine, signals);
      panel.setSortByName(true);

      const names = panel.getSignalNames();
      expect(names).toEqual(["A", "B", "C"]);

      panel.dispose();
      teardown(container);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("throws on out-of-range signal index", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);

      expect(() => panel.setRadix(99, "hex")).toThrow();
      expect(() => panel.getDisplayValue(99)).toThrow();

      panel.dispose();
      teardown(container);
    });

    it("throws when signal name not found", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 3, componentCount: 0 });

      const panel = new DataTablePanel(container, engine, THREE_SIGNALS);

      expect(() => panel.setRadixByName("MISSING", "hex")).toThrow();
      expect(() => panel.getDisplayValueByName("MISSING")).toThrow();

      panel.dispose();
      teardown(container);
    });

    it("handles empty signals list", () => {
      const container = makeContainer();
      const engine = new MockEngine();
      engine.init({ netCount: 0, componentCount: 0 });

      const panel = new DataTablePanel(container, engine, []);
      expect(panel.getSignalCount()).toBe(0);
      expect(panel.getSignalNames()).toEqual([]);

      // Should not throw on step/reset with no signals
      panel.onStep(1);
      panel.onReset();

      panel.dispose();
      teardown(container);
    });
  });
});
