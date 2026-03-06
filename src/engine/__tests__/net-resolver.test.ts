/**
 * Unit tests for net-resolver.ts
 *
 * Tests verify:
 * - Wire endpoint matching correctly merges pins into nets
 * - Chained wire series forms one net
 * - Tunnel name-based merging works (no direct wire needed)
 * - Bit-width validation catches mismatches (throws BitsException)
 * - Multi-driver nets are flagged with needsBus: true
 * - Unconnected input pins produce a warning (not an error)
 */

import { describe, it, expect } from "vitest";
import { resolveNets } from "../net-resolver.js";
import type { NetResolution } from "../net-resolver.js";
import { Circuit, Wire } from "@/core/circuit.js";
import { AbstractCircuitElement } from "@/core/element.js";
import { PinDirection, type Pin, type Rotation } from "@/core/pin.js";
import type { PropertyBag } from "@/core/properties.js";
import { PropertyBag as PropBag } from "@/core/properties.js";
import { ComponentRegistry } from "@/core/registry.js";
import type { ComponentDefinition } from "@/core/registry.js";
import { ComponentCategory } from "@/core/registry.js";
import type { RenderContext, Rect } from "@/core/renderer-interface.js";
import { BitsException } from "@/core/errors.js";

// ---------------------------------------------------------------------------
// Minimal stub RenderContext (draw calls not tested here)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// TestElement — minimal CircuitElement for tests
// ---------------------------------------------------------------------------

class TestElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    pins: Pin[],
    props?: PropertyBag,
  ) {
    super(typeId, instanceId, { x: 0, y: 0 }, 0 as Rotation, false, props ?? new PropBag());
    this._pins = pins;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: 0, y: 0, width: 4, height: 2 };
  }

  getHelpText(): string {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Helpers to build Pin objects
// ---------------------------------------------------------------------------

function inputPin(x: number, y: number, label = "in", bitWidth = 1): Pin {
  return {
    direction: PinDirection.INPUT,
    position: { x, y },
    label,
    bitWidth,
    isNegated: false,
    isClock: false,
  };
}

function outputPin(x: number, y: number, label = "out", bitWidth = 1): Pin {
  return {
    direction: PinDirection.OUTPUT,
    position: { x, y },
    label,
    bitWidth,
    isNegated: false,
    isClock: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers to build a minimal ComponentRegistry
// ---------------------------------------------------------------------------

const NOOP_EXECUTE = () => {};

function makeRegistry(...names: string[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of names) {
    const def: ComponentDefinition = {
      name,
      typeId: -1,
      factory: () => { throw new Error("factory not needed in test"); },
      executeFn: NOOP_EXECUTE,
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "",
    };
    registry.register(def);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// NetResolver Tests
// ---------------------------------------------------------------------------

describe("NetResolver", () => {
  // -------------------------------------------------------------------------
  // directWireConnection
  // -------------------------------------------------------------------------
  it("directWireConnection", () => {
    // Layout: outElem(output at 4,1) --wire--> inElem(input at 6,1)
    const outElem = new TestElement("Buf", "out-1", [outputPin(4, 1, "Q")]);
    const inElem = new TestElement("Buf", "in-1", [inputPin(6, 1, "A")]);

    const circuit = new Circuit();
    circuit.addElement(outElem);
    circuit.addElement(inElem);
    circuit.addWire(new Wire({ x: 4, y: 1 }, { x: 6, y: 1 }));

    const registry = makeRegistry("Buf");
    const result: NetResolution = resolveNets(circuit, registry);

    // There should be exactly one net containing both pins
    const connectedNet = result.nets.find((n) => n.pins.length === 2);
    expect(connectedNet).toBeDefined();
    expect(connectedNet!.pins.some((p) => p.element === outElem)).toBe(true);
    expect(connectedNet!.pins.some((p) => p.element === inElem)).toBe(true);
    expect(connectedNet!.driverCount).toBe(1);
    expect(connectedNet!.needsBus).toBe(false);
  });

  // -------------------------------------------------------------------------
  // chainedWires — 3 wires in series, all endpoints on the same net
  // -------------------------------------------------------------------------
  it("chainedWires", () => {
    // A(output@0,0) --w1-- (2,0) --w2-- (4,0) --w3-- B(input@6,0)
    const srcElem = new TestElement("Src", "src-1", [outputPin(0, 0, "Q")]);
    const dstElem = new TestElement("Dst", "dst-1", [inputPin(6, 0, "A")]);

    const circuit = new Circuit();
    circuit.addElement(srcElem);
    circuit.addElement(dstElem);
    // Three wires forming a chain
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 2, y: 0 }));
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.addWire(new Wire({ x: 4, y: 0 }, { x: 6, y: 0 }));

    const registry = makeRegistry("Src", "Dst");
    const result = resolveNets(circuit, registry);

    const connectedNet = result.nets.find((n) => n.pins.length === 2);
    expect(connectedNet).toBeDefined();
    expect(connectedNet!.pins.some((p) => p.element === srcElem)).toBe(true);
    expect(connectedNet!.pins.some((p) => p.element === dstElem)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // tunnelsMergeSameNameNets — two Tunnel elements with the same label
  // are merged without a direct wire between them
  // -------------------------------------------------------------------------
  it("tunnelsMergeSameNameNets", () => {
    // Build a PropertyBag with label "Data"
    const labelPropA = new PropBag();
    labelPropA.set("label", "Data");
    const labelPropB = new PropBag();
    labelPropB.set("label", "Data");

    const tunnelA = new TestElement("Tunnel", "tun-a", [outputPin(0, 0, "T")], labelPropA);
    const tunnelB = new TestElement("Tunnel", "tun-b", [inputPin(10, 5, "T")], labelPropB);

    const circuit = new Circuit();
    circuit.addElement(tunnelA);
    circuit.addElement(tunnelB);
    // No wire between them — tunnel label merging must do the work

    const registry = makeRegistry("Tunnel");
    const result = resolveNets(circuit, registry);

    // Both tunnel pins should be in the same net
    const mergedNet = result.nets.find((n) => n.pins.length === 2);
    expect(mergedNet).toBeDefined();
    expect(mergedNet!.pins.some((p) => p.element === tunnelA)).toBe(true);
    expect(mergedNet!.pins.some((p) => p.element === tunnelB)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // bitWidthMismatchThrows — 1-bit output connected to 8-bit input
  // -------------------------------------------------------------------------
  it("bitWidthMismatchThrows", () => {
    // 1-bit output pin and 8-bit input pin on the same wire → BitsException
    const narrowElem = new TestElement("Narrow", "narrow-1", [outputPin(0, 0, "Q", 1)]);
    const wideElem = new TestElement("Wide", "wide-1", [inputPin(4, 0, "A", 8)]);

    const circuit = new Circuit();
    circuit.addElement(narrowElem);
    circuit.addElement(wideElem);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 4, y: 0 }));

    const registry = makeRegistry("Narrow", "Wide");

    expect(() => resolveNets(circuit, registry)).toThrow(BitsException);
  });

  // -------------------------------------------------------------------------
  // multiDriverDetected — two output pins on the same net → needsBus: true
  // -------------------------------------------------------------------------
  it("multiDriverDetected", () => {
    // Two output pins connected to the same wire → multi-driver net
    const driverA = new TestElement("Driver", "drv-a", [outputPin(0, 0, "Q")]);
    const driverB = new TestElement("Driver", "drv-b", [outputPin(4, 0, "Q")]);

    const circuit = new Circuit();
    circuit.addElement(driverA);
    circuit.addElement(driverB);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 4, y: 0 }));

    const registry = makeRegistry("Driver");
    const result = resolveNets(circuit, registry);

    const busNet = result.nets.find((n) => n.pins.length === 2);
    expect(busNet).toBeDefined();
    expect(busNet!.needsBus).toBe(true);
    expect(busNet!.driverCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // unconnectedInputWarns — input pin with no wire → warning, not error
  // -------------------------------------------------------------------------
  it("unconnectedInputWarns", () => {
    // A single input pin with no wire attached
    const floatingElem = new TestElement("Gate", "gate-1", [inputPin(5, 5, "A")]);

    const circuit = new Circuit();
    circuit.addElement(floatingElem);

    const registry = makeRegistry("Gate");
    const result = resolveNets(circuit, registry);

    // No exception thrown
    expect(result.warnings.length).toBeGreaterThan(0);
    const warning = result.warnings.find((w) => w.includes("gate-1") && w.includes("A"));
    expect(warning).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Additional: isolated pins each get their own net
  // -------------------------------------------------------------------------
  it("isolatedPinsGetSeparateNets", () => {
    const elem1 = new TestElement("G", "e1", [outputPin(0, 0, "Q")]);
    const elem2 = new TestElement("G", "e2", [inputPin(10, 10, "A")]);

    const circuit = new Circuit();
    circuit.addElement(elem1);
    circuit.addElement(elem2);
    // No wires

    const registry = makeRegistry("G");
    const result = resolveNets(circuit, registry);

    // Each pin is its own net
    expect(result.nets.length).toBe(2);
    for (const net of result.nets) {
      expect(net.pins.length).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // Additional: net IDs are assigned sequentially starting from 0
  // -------------------------------------------------------------------------
  it("netIdsAreSequential", () => {
    const elems = [
      new TestElement("G", "e1", [outputPin(0, 0, "Q")]),
      new TestElement("G", "e2", [inputPin(2, 0, "A")]),
      new TestElement("G", "e3", [outputPin(5, 0, "Q")]),
    ];

    const circuit = new Circuit();
    for (const e of elems) circuit.addElement(e);
    // Wire first two together; third is isolated
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 2, y: 0 }));

    const registry = makeRegistry("G");
    const result = resolveNets(circuit, registry);

    const ids = result.nets.map((n) => n.netId).sort((a, b) => a - b);
    // IDs should be 0, 1, 2, ... (no gaps)
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(i);
    }
  });

  // -------------------------------------------------------------------------
  // Additional: pins at the same position are merged into one net (junction)
  // -------------------------------------------------------------------------
  it("pinsAtSamePositionMerged", () => {
    // Three pins at the exact same grid position form one net (junction)
    const a = new TestElement("G", "ea", [outputPin(3, 3, "Q")]);
    const b = new TestElement("G", "eb", [inputPin(3, 3, "A")]);
    const c = new TestElement("G", "ec", [inputPin(3, 3, "B")]);

    const circuit = new Circuit();
    circuit.addElement(a);
    circuit.addElement(b);
    circuit.addElement(c);

    const registry = makeRegistry("G");
    const result = resolveNets(circuit, registry);

    const junctionNet = result.nets.find((n) => n.pins.length === 3);
    expect(junctionNet).toBeDefined();
    expect(junctionNet!.driverCount).toBe(1); // only the output pin
  });

  // -------------------------------------------------------------------------
  // Additional: tunnels with different labels are NOT merged
  // -------------------------------------------------------------------------
  it("tunnelsDifferentLabelsNotMerged", () => {
    const propA = new PropBag();
    propA.set("label", "Bus0");
    const propB = new PropBag();
    propB.set("label", "Bus1");

    const tA = new TestElement("Tunnel", "ta", [outputPin(0, 0, "T")], propA);
    const tB = new TestElement("Tunnel", "tb", [inputPin(10, 0, "T")], propB);

    const circuit = new Circuit();
    circuit.addElement(tA);
    circuit.addElement(tB);

    const registry = makeRegistry("Tunnel");
    const result = resolveNets(circuit, registry);

    // Each tunnel should be in its own separate net
    const nets2 = result.nets.filter((n) => n.pins.length === 2);
    expect(nets2.length).toBe(0);
    expect(result.nets.length).toBe(2);
  });
});
