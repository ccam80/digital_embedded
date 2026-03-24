/**
 * Tests for EditorBinding — engine-editor integration layer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createEditorBinding } from "../editor-binding";
import type { EditorBinding } from "../editor-binding";
import { MockEngine } from "@/test-utils/mock-engine";
import { Wire, Circuit } from "@/core/circuit";
import { BitVector } from "@/core/signal";
import type { CircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { PropertyBag, PropertyValue } from "@/core/properties";
import type { SerializedElement } from "@/core/element";

// ---------------------------------------------------------------------------
// Minimal CircuitElement stub for tests
// ---------------------------------------------------------------------------

class StubElement implements CircuitElement {
  readonly typeId = "In";
  readonly instanceId: string;
  position = { x: 0, y: 0 };
  rotation = 0 as const;
  mirror = false;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  getPins(): readonly Pin[] { return []; }
  getProperties(): PropertyBag { return new Map() as unknown as PropertyBag; }
  draw(_ctx: RenderContext): void { /* no-op */ }
  getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; }
  serialize(): SerializedElement {
    return { typeId: this.typeId, instanceId: this.instanceId, position: this.position, rotation: this.rotation, mirror: this.mirror, properties: {} };
  }
  getHelpText(): string { return ""; }
  getAttribute(_name: string): PropertyValue | undefined { return undefined; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EditorBinding", () => {
  let binding: EditorBinding;
  let circuit: Circuit;
  let engine: MockEngine;
  let wire: Wire;
  let element: StubElement;
  let wireNetMap: Map<Wire, number>;
  let pinNetMap: Map<string, number>;

  beforeEach(() => {
    binding = createEditorBinding();
    circuit = new Circuit();
    engine = new MockEngine();
    engine.init({ netCount: 8, componentCount: 2 });

    wire = new Wire({ x: 0, y: 0 }, { x: 10, y: 0 });
    element = new StubElement("elem-1");

    wireNetMap = new Map([[wire, 3]]);
    pinNetMap = new Map([["elem-1:A", 3]]);
  });

  it("bind — bind circuit + engine, assert isBound is true", () => {
    expect(binding.isBound).toBe(false);
    binding.bind(circuit, engine, wireNetMap, pinNetMap);
    expect(binding.isBound).toBe(true);
  });

  it("unbind — unbind, assert isBound is false, engine is null", () => {
    binding.bind(circuit, engine, wireNetMap, pinNetMap);
    expect(binding.isBound).toBe(true);
    binding.unbind();
    expect(binding.isBound).toBe(false);
    expect(binding.engine).toBeNull();
  });

  it("getWireValue — bind with known wireNetMap, mock engine returns specific value for net ID", () => {
    // Set net 3 to value 42
    engine.setSignalRaw(3, 42);
    binding.bind(circuit, engine, wireNetMap, pinNetMap);

    const value = binding.getWireValue(wire);
    expect(value).toBe(42);

    // Verify the engine was called with net ID 3
    const rawCall = engine.calls.find(
      (c) => c.method === "getSignalRaw" && c.netId === 3,
    );
    expect(rawCall).toBeDefined();
  });

  it("setInput — call setInput(), verify engine.setSignalValue() called with correct net ID", () => {
    binding.bind(circuit, engine, wireNetMap, pinNetMap);
    const value = BitVector.fromNumber(1, 1);
    binding.setInput(element, "A", value);

    const setCall = engine.calls.find(
      (c) => c.method === "setSignalValue" && c.netId === 3,
    );
    expect(setCall).toBeDefined();
    if (setCall?.method === "setSignalValue") {
      expect(setCall.value).toBe(value);
    }
  });

  it("unboundThrows — calling getWireValue() when unbound throws", () => {
    expect(() => binding.getWireValue(wire)).toThrow();
  });
});
