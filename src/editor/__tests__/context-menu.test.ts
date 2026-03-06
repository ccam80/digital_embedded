/**
 * Tests for context menu action factories.
 *
 * Tests the factory functions (buildMenuForElement, buildMenuForWire,
 * buildMenuForCanvas) directly — they return plain MenuAction[] arrays
 * with no DOM dependency.
 */

import { describe, it, expect } from "vitest";
import {
  buildMenuForElement,
  buildMenuForWire,
  buildMenuForCanvas,
} from "../context-menu.js";
import { Wire } from "@/core/circuit";
import { PropertyBag } from "@/core/properties";

// ---------------------------------------------------------------------------
// Stub element
// ---------------------------------------------------------------------------

function makeStubElement() {
  return {
    typeId: "And",
    instanceId: "and-1",
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins: () => [],
    getProperties: () => new PropertyBag(),
    draw: () => {},
    getBoundingBox: () => ({ x: 0, y: 0, width: 2, height: 2 }),
    serialize: () => ({
      typeId: "And",
      instanceId: "and-1",
      position: { x: 0, y: 0 },
      rotation: 0 as const,
      mirror: false,
      properties: {},
    }),
    getHelpText: () => "",
    getAttribute: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextMenu", () => {
  it("elementMenuHasRotateDelete", () => {
    const el = makeStubElement();
    const actions = buildMenuForElement(el as any);
    const labels = actions.map((a) => a.label);

    expect(labels).toContain("Rotate");
    expect(labels).toContain("Mirror");
    expect(labels).toContain("Delete");
    expect(labels).toContain("Copy");
    expect(labels).toContain("Properties");
    expect(labels).toContain("Help");
  });

  it("wireMenuHasDelete", () => {
    const wire = new Wire({ x: 0, y: 0 }, { x: 1, y: 0 });
    const actions = buildMenuForWire(wire);
    const labels = actions.map((a) => a.label);

    expect(labels).toContain("Delete");
  });

  it("canvasMenuHasPaste", () => {
    const actions = buildMenuForCanvas();
    const labels = actions.map((a) => a.label);

    expect(labels).toContain("Paste");
    expect(labels).toContain("Select All");
  });
});
