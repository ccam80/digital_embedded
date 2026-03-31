/**
 * Tests for SelectionModel.
 */

import { describe, it, expect, vi } from "vitest";
import { SelectionModel } from "@/editor/selection";
import type { CircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { PropertyBag, PropertyValue } from "@/core/properties";
import type { SerializedElement } from "@/core/element";
import { Wire, Circuit } from "@/core/circuit";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeElement(): CircuitElement {
  const id = `el-${++_idCounter}`;
  return {
    typeId: "stub",
    instanceId: id,
    position: { x: 0, y: 0 },
    rotation: 0,
    mirror: false,
    getPins: (): readonly Pin[] => [],
    getProperties: () => ({} as PropertyBag),
    draw: (_ctx: RenderContext) => {},
    getBoundingBox: (): Rect => ({ x: 0, y: 0, width: 4, height: 4 }),
    serialize: () => ({} as SerializedElement),
    getAttribute: (_name: string): PropertyValue | undefined => undefined,
    setAttribute: (_name: string, _value: PropertyValue): void => {},
  };
}

function makeWire(): Wire {
  return new Wire({ x: 0, y: 0 }, { x: 10, y: 0 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SelectionModel", () => {
  it("selectClearsPrevious", () => {
    const model = new SelectionModel();
    const a = makeElement();
    const b = makeElement();

    model.select(a);
    model.select(b);

    expect(model.isSelected(a)).toBe(false);
    expect(model.isSelected(b)).toBe(true);
    expect(model.getSelectedElements().size).toBe(1);
  });

  it("toggleAdds", () => {
    const model = new SelectionModel();
    const a = makeElement();

    model.toggleSelect(a);

    expect(model.isSelected(a)).toBe(true);
  });

  it("toggleRemoves", () => {
    const model = new SelectionModel();
    const a = makeElement();

    model.select(a);
    model.toggleSelect(a);

    expect(model.isSelected(a)).toBe(false);
    expect(model.isEmpty()).toBe(true);
  });

  it("boxSelectReplacesAll", () => {
    const model = new SelectionModel();
    const a = makeElement();
    const b = makeElement();
    const c = makeElement();

    model.select(a);
    model.boxSelect([b, c], []);

    expect(model.isSelected(a)).toBe(false);
    expect(model.isSelected(b)).toBe(true);
    expect(model.isSelected(c)).toBe(true);
  });

  it("selectAllGetsEverything", () => {
    const model = new SelectionModel();
    const circuit = new Circuit();
    const el1 = makeElement();
    const el2 = makeElement();
    const el3 = makeElement();
    const w1 = makeWire();
    const w2 = makeWire();

    circuit.addElement(el1);
    circuit.addElement(el2);
    circuit.addElement(el3);
    circuit.addWire(w1);
    circuit.addWire(w2);

    model.selectAll(circuit);

    expect(model.getSelectedElements().size).toBe(3);
    expect(model.getSelectedWires().size).toBe(2);
    expect(model.isSelected(el1)).toBe(true);
    expect(model.isSelected(w1)).toBe(true);
  });

  it("clearDeselectsAll", () => {
    const model = new SelectionModel();
    const a = makeElement();
    const w = makeWire();

    model.select(a);
    model.toggleSelect(w);
    model.clear();

    expect(model.isEmpty()).toBe(true);
    expect(model.getSelectedElements().size).toBe(0);
    expect(model.getSelectedWires().size).toBe(0);
  });

  it("onChangeFiresOnMutation", () => {
    const model = new SelectionModel();
    const callback = vi.fn();
    model.onChange(callback);

    const a = makeElement();
    model.select(a);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("onChangeFiresOnToggle", () => {
    const model = new SelectionModel();
    const callback = vi.fn();
    model.onChange(callback);

    const a = makeElement();
    model.toggleSelect(a);
    model.toggleSelect(a);

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("onChangeFiresOnClear", () => {
    const model = new SelectionModel();
    const callback = vi.fn();
    model.onChange(callback);

    model.clear();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("wireSelectionTrackedSeparately", () => {
    const model = new SelectionModel();
    const wire = makeWire();

    model.toggleSelect(wire);

    expect(model.isSelected(wire)).toBe(true);
    expect(model.getSelectedWires().has(wire)).toBe(true);
    expect(model.getSelectedElements().size).toBe(0);
  });
});
