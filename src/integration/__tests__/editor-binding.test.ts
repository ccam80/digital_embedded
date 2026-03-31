/**
 * Tests for EditorBinding — coordinator-editor integration layer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createEditorBinding } from "../editor-binding";
import type { EditorBinding } from "../editor-binding";
import { MockCoordinator } from "@/test-utils/mock-coordinator";
import { Wire, Circuit } from "@/core/circuit";
import { BitVector } from "@/core/signal";
import type { CircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { PropertyBag, PropertyValue } from "@/core/properties";
import type { SerializedElement } from "@/core/element";
import type { SignalAddress, SignalValue } from "@/compile/types";

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
  getAttribute(_name: string): PropertyValue | undefined { return undefined; }
  setAttribute(_name: string, _value: PropertyValue): void {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EditorBinding", () => {
  let binding: EditorBinding;
  let circuit: Circuit;
  let coordinator: MockCoordinator;
  let wire: Wire;
  let element: StubElement;
  let wireSignalMap: Map<Wire, SignalAddress>;
  let pinSignalMap: Map<string, SignalAddress>;
  const wireAddr: SignalAddress = { domain: "digital", netId: 3, bitWidth: 1 };
  const pinAddr: SignalAddress = { domain: "digital", netId: 3, bitWidth: 1 };

  beforeEach(() => {
    binding = createEditorBinding();
    circuit = new Circuit();
    coordinator = new MockCoordinator();

    wire = new Wire({ x: 0, y: 0 }, { x: 10, y: 0 });
    element = new StubElement("elem-1");

    wireSignalMap = new Map([[wire, wireAddr]]);
    pinSignalMap = new Map([["elem-1:A", pinAddr]]);
  });

  it("bind — bind circuit + coordinator, assert isBound is true", () => {
    expect(binding.isBound).toBe(false);
    binding.bind(circuit, coordinator, wireSignalMap, pinSignalMap);
    expect(binding.isBound).toBe(true);
  });

  it("unbind — unbind, assert isBound is false, coordinator is null", () => {
    binding.bind(circuit, coordinator, wireSignalMap, pinSignalMap);
    expect(binding.isBound).toBe(true);
    binding.unbind();
    expect(binding.isBound).toBe(false);
    expect(binding.coordinator).toBeNull();
  });

  it("getWireSignal — returns SignalValue from coordinator for the wire's address", () => {
    const expected: SignalValue = { type: "digital", value: 42 };
    coordinator.setSignal(wireAddr, expected);
    binding.bind(circuit, coordinator, wireSignalMap, pinSignalMap);

    const sv = binding.getWireSignal(wire);
    expect(sv).toEqual(expected);
  });

  it("getWireValue — returns raw number extracted from digital SignalValue", () => {
    coordinator.setSignal(wireAddr, { type: "digital", value: 42 });
    binding.bind(circuit, coordinator, wireSignalMap, pinSignalMap);

    const value = binding.getWireValue(wire);
    expect(value).toBe(42);
  });

  it("getWireValue — returns voltage for analog SignalValue", () => {
    const analogAddr: SignalAddress = { domain: "analog", nodeId: 5 };
    const analogWire = new Wire({ x: 0, y: 0 }, { x: 20, y: 0 });
    const analogWireMap = new Map([[analogWire, analogAddr]]);
    coordinator.setSignal(analogAddr, { type: "analog", voltage: 3.3 });
    binding.bind(circuit, coordinator, analogWireMap, pinSignalMap);

    const value = binding.getWireValue(analogWire);
    expect(value).toBe(3.3);
  });

  it("setInput — calls coordinator.writeSignal() with correct address and digital SignalValue", () => {
    binding.bind(circuit, coordinator, wireSignalMap, pinSignalMap);
    const bv = BitVector.fromNumber(1, 1);
    binding.setInput(element, "A", bv);

    expect(coordinator.writeCalls).toHaveLength(1);
    expect(coordinator.writeCalls[0]!.addr).toEqual(pinAddr);
    expect((coordinator.writeCalls[0]!.value as { type: string; value: number }).value).toBe(1);
  });

  it("unboundThrows — calling getWireValue() when unbound throws", () => {
    expect(() => binding.getWireValue(wire)).toThrow();
  });

  it("unboundThrows — calling getWireSignal() when unbound throws", () => {
    expect(() => binding.getWireSignal(wire)).toThrow();
  });

  it("engine property removed — binding does not expose engine, use coordinator directly", () => {
    binding.bind(circuit, coordinator, wireSignalMap, pinSignalMap);
    expect("engine" in binding).toBe(false);
  });
});
