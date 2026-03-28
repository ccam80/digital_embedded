/**
 * Tests for CircuitSearch.
 */

import { describe, it, expect, vi } from "vitest";
import { CircuitSearch } from "../search.js";
import { Circuit } from "@/core/circuit";
import { PropertyBag } from "@/core/properties";
import { Viewport } from "@/editor/viewport";

// ---------------------------------------------------------------------------
// Stub element factory
// ---------------------------------------------------------------------------

function makeElement(typeId: string, label?: string) {
  const bag = new PropertyBag();
  if (label !== undefined) {
    bag.set("label", label);
  }
  return {
    typeId,
    instanceId: `${typeId}-${Math.random()}`,
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins: () => [],
    getProperties: () => bag,
    draw: () => {},
    getBoundingBox: () => ({ x: 0, y: 0, width: 2, height: 2 }),
    serialize: () => ({
      typeId,
      instanceId: "x",
      position: { x: 0, y: 0 },
      rotation: 0 as const,
      mirror: false,
      properties: {},
    }),
    getAttribute: (name: string) => (bag.has(name) ? bag.get(name) : undefined),
  };
}

function makeCircuit(
  elements: ReturnType<typeof makeElement>[],
): Circuit {
  const circuit = new Circuit();
  for (const el of elements) {
    circuit.addElement(el as any);
  }
  return circuit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Search", () => {
  const searcher = new CircuitSearch();

  it("findsByLabel", () => {
    const counter = makeElement("Register", "Counter1");
    const other = makeElement("And", "Gate1");
    const circuit = makeCircuit([counter, other]);

    const results = searcher.search(circuit, "counter");

    expect(results).toHaveLength(1);
    expect(results[0]!.element).toBe(counter);
    expect(results[0]!.matchType).toBe("label");
    expect(results[0]!.matchText).toBe("Counter1");
  });

  it("findsByTypeName", () => {
    const and1 = makeElement("And");
    const and2 = makeElement("And");
    const or = makeElement("Or");
    const circuit = makeCircuit([and1, and2, or]);

    const results = searcher.search(circuit, "And");

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.matchType).toBe("typeName");
      expect(r.matchText).toBe("And");
    }
  });

  it("caseInsensitive", () => {
    const and = makeElement("And");
    const circuit = makeCircuit([and]);

    const results = searcher.search(circuit, "and");

    expect(results).toHaveLength(1);
    expect(results[0]!.element).toBe(and);
  });

  it("noMatchReturnsEmpty", () => {
    const and = makeElement("And");
    const circuit = makeCircuit([and]);

    const results = searcher.search(circuit, "xyz");

    expect(results).toHaveLength(0);
  });

  it("navigateToCentersViewport", () => {
    const el = makeElement("And", "MyGate");
    const circuit = makeCircuit([el]);
    const viewport = new Viewport();

    const results = searcher.search(circuit, "MyGate");
    expect(results).toHaveLength(1);

    const fitSpy = vi.spyOn(viewport, "fitToContent");
    searcher.navigateTo(results[0]!, viewport);

    expect(fitSpy).toHaveBeenCalledOnce();
    expect(fitSpy).toHaveBeenCalledWith([el], { width: 800, height: 600 });
  });
});
