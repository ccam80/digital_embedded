/**
 * Tests for MeasurementOrderPanel — signal ordering and visibility management.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MeasurementOrderPanel } from "../measurement-order.js";
import type { MeasurementOrderState } from "../measurement-order.js";
import type { SignalDescriptor } from "../data-table.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNALS: SignalDescriptor[] = [
  { name: "A", netId: 0, width: 1, group: "input" },
  { name: "B", netId: 1, width: 1, group: "input" },
  { name: "Y", netId: 2, width: 1, group: "output" },
  { name: "P", netId: 3, width: 1, group: "probe" },
];

// ---------------------------------------------------------------------------
// initialOrder — signals listed in default order (inputs, outputs, probes)
// ---------------------------------------------------------------------------

describe("MeasurementOrderPanel", () => {
  describe("initialOrder", () => {
    it("lists signals in default order: inputs, outputs, probes", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      const entries = panel.getEntries();

      expect(entries.length).toBe(4);

      // inputs before outputs before probes
      const names = entries.map((e) => e.name);
      expect(names.indexOf("A")).toBeLessThan(names.indexOf("Y"));
      expect(names.indexOf("B")).toBeLessThan(names.indexOf("Y"));
      expect(names.indexOf("Y")).toBeLessThan(names.indexOf("P"));
    });

    it("all signals are visible by default", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      const entries = panel.getEntries();
      for (const e of entries) {
        expect(e.visible).toBe(true);
      }
    });

    it("getVisibleSignals returns all signals when none hidden", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      expect(panel.getVisibleSignals().length).toBe(4);
    });

    it("getCount returns correct count", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      expect(panel.getCount()).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // reorder — move signal from position 0 to position 2
  // -------------------------------------------------------------------------

  describe("reorder", () => {
    it("moves signal from position 0 to position 2", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      // Initial: [A, B, Y, P]
      panel.moveEntry(0, 2);
      // After: [B, Y, A, P]
      const names = panel.getEntries().map((e) => e.name);
      expect(names[0]).toBe("B");
      expect(names[1]).toBe("Y");
      expect(names[2]).toBe("A");
      expect(names[3]).toBe("P");
    });

    it("moving to same position is a no-op", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      const before = panel.getEntries().map((e) => e.name);
      panel.moveEntry(1, 1);
      const after = panel.getEntries().map((e) => e.name);
      expect(after).toEqual(before);
    });

    it("moves last entry to first position", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      // Initial: [A, B, Y, P]
      panel.moveEntry(3, 0);
      // After: [P, A, B, Y]
      const names = panel.getEntries().map((e) => e.name);
      expect(names[0]).toBe("P");
      expect(names[1]).toBe("A");
    });

    it("throws on out-of-range fromIndex", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      expect(() => panel.moveEntry(-1, 0)).toThrow(RangeError);
      expect(() => panel.moveEntry(99, 0)).toThrow(RangeError);
    });

    it("throws on out-of-range toIndex", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      expect(() => panel.moveEntry(0, -1)).toThrow(RangeError);
      expect(() => panel.moveEntry(0, 99)).toThrow(RangeError);
    });

    it("fires change listener after reorder", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      let fired = false;
      panel.addChangeListener(() => { fired = true; });
      panel.moveEntry(0, 2);
      expect(fired).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // toggleVisibility — hide signal, verify data table excludes it
  // -------------------------------------------------------------------------

  describe("toggleVisibility", () => {
    it("hides a signal by name", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      panel.setVisibleByName("B", false);

      const visible = panel.getVisibleSignals();
      expect(visible.map((e) => e.name)).not.toContain("B");
      expect(visible.length).toBe(3);
    });

    it("shows a previously hidden signal", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      panel.setVisibleByName("B", false);
      panel.setVisibleByName("B", true);

      const visible = panel.getVisibleSignals();
      expect(visible.map((e) => e.name)).toContain("B");
      expect(visible.length).toBe(4);
    });

    it("hideAll hides all signals", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      panel.hideAll();
      expect(panel.getVisibleSignals().length).toBe(0);
      for (const e of panel.getEntries()) {
        expect(e.visible).toBe(false);
      }
    });

    it("showAll makes all signals visible", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      panel.hideAll();
      panel.showAll();
      expect(panel.getVisibleSignals().length).toBe(4);
    });

    it("setVisible by index toggles correct entry", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      // Index 0 in grouped order is "A"
      panel.setVisible(0, false);
      const visible = panel.getVisibleSignals();
      expect(visible.map((e) => e.name)).not.toContain("A");
    });

    it("setVisibleByName throws for unknown signal", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      expect(() => panel.setVisibleByName("MISSING", false)).toThrow();
    });

    it("setVisible throws on out-of-range index", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      expect(() => panel.setVisible(99, false)).toThrow(RangeError);
    });

    it("fires change listener after visibility toggle", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      let callCount = 0;
      panel.addChangeListener(() => { callCount++; });
      panel.setVisibleByName("A", false);
      expect(callCount).toBe(1);
      panel.showAll();
      expect(callCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // persistRoundTrip — save ordering to metadata, reload, verify preserved
  // -------------------------------------------------------------------------

  describe("persistRoundTrip", () => {
    it("round-trips ordering and visibility through JSON", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);

      // Reorder: move A (index 0) to index 2 → [B, Y, A, P]
      panel.moveEntry(0, 2);
      // Hide Y
      panel.setVisibleByName("Y", false);

      const state: MeasurementOrderState = panel.toJSON();

      // Create a fresh panel and restore
      const panel2 = new MeasurementOrderPanel(SIGNALS);
      panel2.fromJSON(state);

      const entries2 = panel2.getEntries();
      const names2 = entries2.map((e) => e.name);

      expect(names2[0]).toBe("B");
      expect(names2[1]).toBe("Y");
      expect(names2[2]).toBe("A");
      expect(names2[3]).toBe("P");

      // Y should still be hidden
      const yEntry = entries2.find((e) => e.name === "Y");
      expect(yEntry?.visible).toBe(false);

      // All others visible
      const aEntry = entries2.find((e) => e.name === "A");
      expect(aEntry?.visible).toBe(true);
    });

    it("toJSON returns all entries", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      const state = panel.toJSON();
      expect(state.entries.length).toBe(4);
    });

    it("fromJSON with unknown signals silently ignores them", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);

      const state: MeasurementOrderState = {
        entries: [
          { name: "GHOST", netId: 99, width: 1, group: "probe", visible: true },
          { name: "A", netId: 0, width: 1, group: "input", visible: true },
        ],
      };

      // Should not throw; GHOST is ignored; A ends up first, others appended
      panel.fromJSON(state);
      const names = panel.getEntries().map((e) => e.name);
      expect(names).not.toContain("GHOST");
      expect(names).toContain("A");
      expect(panel.getCount()).toBe(4);
    });

    it("fromJSON fires change listener", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      let fired = false;
      panel.addChangeListener(() => { fired = true; });
      panel.fromJSON(panel.toJSON());
      expect(fired).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // change listeners
  // -------------------------------------------------------------------------

  describe("changeListeners", () => {
    it("addChangeListener receives current entries on change", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      let received: readonly { name: string }[] = [];
      panel.addChangeListener((entries) => { received = entries; });
      panel.moveEntry(0, 1);
      expect(received.length).toBe(4);
    });

    it("removeChangeListener stops notifications", () => {
      const panel = new MeasurementOrderPanel(SIGNALS);
      let callCount = 0;
      const listener = () => { callCount++; };
      panel.addChangeListener(listener);
      panel.moveEntry(0, 1);
      expect(callCount).toBe(1);
      panel.removeChangeListener(listener);
      panel.moveEntry(0, 1);
      expect(callCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // DOM rendering
  // -------------------------------------------------------------------------

  describe("domRendering", () => {
    it("mounts a list of signal rows into the container", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      const panel = new MeasurementOrderPanel(SIGNALS);
      panel.mount(container);

      const items = container.querySelectorAll(".measurement-order-item");
      expect(items.length).toBe(4);

      const labels = container.querySelectorAll(".measurement-order-label");
      const names = Array.from(labels).map((l) => l.textContent);
      expect(names).toContain("A");
      expect(names).toContain("Y");

      panel.dispose();
      container.remove();
    });

    it("Show All and Hide All buttons are rendered", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      const panel = new MeasurementOrderPanel(SIGNALS);
      panel.mount(container);

      const showAll = container.querySelector(".measurement-order-show-all");
      const hideAll = container.querySelector(".measurement-order-hide-all");
      expect(showAll).not.toBeNull();
      expect(hideAll).not.toBeNull();

      panel.dispose();
      container.remove();
    });

    it("clicking Hide All button hides all signals", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      const panel = new MeasurementOrderPanel(SIGNALS);
      panel.mount(container);

      const hideAll = container.querySelector<HTMLButtonElement>(".measurement-order-hide-all");
      hideAll!.click();

      expect(panel.getVisibleSignals().length).toBe(0);

      panel.dispose();
      container.remove();
    });
  });
});
