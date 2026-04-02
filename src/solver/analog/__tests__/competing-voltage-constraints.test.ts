/**
 * Tests for compile-time diagnostic: competing voltage constraints on the same net.
 *
 * Two ideal voltage sources on the same node make the MNA matrix singular.
 * The compiler must detect this and emit a clear error diagnostic.
 */

import { describe, it, expect } from "vitest";
import { compileUnified } from "@/compile/compile.js";
import { Circuit, Wire } from "../../../core/circuit.js";
import { ComponentRegistry } from "../../../core/registry.js";
import type { PropertyValue } from "../../../core/properties.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type Pin } from "../../../core/pin.js";
import type { CircuitElement } from "../../../core/element.js";
import type { SerializedElement } from "../../../core/element.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import { DcVoltageSourceDefinition } from "../../../components/sources/dc-voltage-source.js";
import { ResistorDefinition } from "../../../components/passives/resistor.js";
import { GroundDefinition } from "../../../components/io/ground.js";

function makePin(x: number, y: number, label: string = ""): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isNegated: false,
    isClock: false,
    bitWidth: 1,
    kind: "signal" as const,
  };
}

function makeElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string }>,
  propsMap: Map<string, PropertyValue> = new Map(),
  registry: ComponentRegistry,
): CircuitElement {
  const def = registry.get(typeId);
  const resolvedPins = pins.map((p, i) => makePin(p.x, p.y, p.label || def?.pinLayout[i]?.label || ""));
  const propertyBag = new PropertyBag(propsMap.entries());
  const _mp: Record<string, number> = {};
  for (const [k, v] of propsMap) if (typeof v === 'number') _mp[k] = v;
  propertyBag.replaceModelParams(_mp);

  const serialized: SerializedElement = {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    properties: {},
  };

  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement["rotation"],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) { /* no-op */ },
    serialize() { return serialized; },
    getAttribute(k: string) { return propsMap.get(k); },
    setAttribute(k: string, v: PropertyValue) { propsMap.set(k, v); },
  };
}

function buildRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(GroundDefinition);
  registry.register(DcVoltageSourceDefinition);
  registry.register(ResistorDefinition);
  return registry;
}

function addWire(circuit: Circuit, x1: number, y1: number, x2: number, y2: number): void {
  circuit.addWire(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }));
}

describe("competing voltage constraints diagnostic", () => {
  it("two voltage sources on same net emits competing-voltage-constraints error", () => {
    // VS1: neg(x=0,y=0) → pos(x=10,y=0)
    // VS2: neg(x=0,y=10) → pos(x=10,y=10)
    // Wire connecting VS1.pos to VS2.pos (shared positive net at x=10)
    // Wire connecting VS1.neg to VS2.neg to GND (shared ground at x=0)
    // R1 from shared positive to ground (so the positive node isn't floating)
    const registry = buildRegistry();
    const circuit = new Circuit();

    const vs1 = makeElement("DcVoltageSource", "vs1",
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 5]]),
      registry,
    );
    const vs2 = makeElement("DcVoltageSource", "vs2",
      [{ x: 0, y: 10 }, { x: 10, y: 10 }],
      new Map<string, PropertyValue>([["voltage", 3]]),
      registry,
    );
    const r1 = makeElement("Resistor", "r1",
      [{ x: 10, y: 20 }, { x: 0, y: 20 }],
      new Map<string, PropertyValue>([["resistance", 1000]]),
      registry,
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 20 }], new Map(), registry);

    circuit.addElement(vs1);
    circuit.addElement(vs2);
    circuit.addElement(r1);
    circuit.addElement(gnd);

    // Ground net: VS1.neg — VS2.neg — R1.B — GND
    addWire(circuit, 0, 0, 0, 10);
    addWire(circuit, 0, 10, 0, 20);
    // Shared positive net: VS1.pos — VS2.pos — R1.A
    addWire(circuit, 10, 0, 10, 10);
    addWire(circuit, 10, 10, 10, 20);

    const result = compileUnified(circuit, registry);
    expect(result.analog).not.toBeNull();
    const diags = result.analog!.diagnostics;
    const competing = diags.filter(d => d.code === "competing-voltage-constraints");

    expect(competing.length).toBeGreaterThanOrEqual(1);
    expect(competing[0].severity).toBe("error");
    expect(competing[0].message).toContain("Two competing voltage sources");
  });

  it("single voltage source on net emits no competing-voltage-constraints", () => {
    // VS1: neg=GND(x=0), pos=nodeA(x=10) → R1 → GND
    const registry = buildRegistry();
    const circuit = new Circuit();

    const vs = makeElement("DcVoltageSource", "vs1",
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 5]]),
      registry,
    );
    const r1 = makeElement("Resistor", "r1",
      [{ x: 10, y: 0 }, { x: 0, y: 0 }],
      new Map<string, PropertyValue>([["resistance", 1000]]),
      registry,
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }], new Map(), registry);

    circuit.addElement(vs);
    circuit.addElement(r1);
    circuit.addElement(gnd);

    addWire(circuit, 0, 0, 0, 0);
    addWire(circuit, 10, 0, 10, 0);

    const result = compileUnified(circuit, registry);
    const diags = result.analog?.diagnostics ?? [];
    const competing = diags.filter(d => d.code === "competing-voltage-constraints");

    expect(competing).toHaveLength(0);
  });

  it("voltage source plus resistor on same net emits no diagnostic", () => {
    // VS: neg=GND(x=0), pos=nodeA(x=10) → R1(x=10 to x=20) → R2(x=20 to x=0)
    const registry = buildRegistry();
    const circuit = new Circuit();

    const vs = makeElement("DcVoltageSource", "vs1",
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      new Map<string, PropertyValue>([["voltage", 5]]),
      registry,
    );
    const r1 = makeElement("Resistor", "r1",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>([["resistance", 1000]]),
      registry,
    );
    const r2 = makeElement("Resistor", "r2",
      [{ x: 20, y: 0 }, { x: 0, y: 0 }],
      new Map<string, PropertyValue>([["resistance", 1000]]),
      registry,
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 0, y: 0 }], new Map(), registry);

    circuit.addElement(vs);
    circuit.addElement(r1);
    circuit.addElement(r2);
    circuit.addElement(gnd);

    addWire(circuit, 0, 0, 0, 0);
    addWire(circuit, 10, 0, 10, 0);
    addWire(circuit, 20, 0, 20, 0);

    const result = compileUnified(circuit, registry);
    const diags = result.analog?.diagnostics ?? [];
    const competing = diags.filter(d => d.code === "competing-voltage-constraints");

    expect(competing).toHaveLength(0);
  });
});
