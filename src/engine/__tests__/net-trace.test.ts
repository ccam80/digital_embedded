/**
 * Unit tests for src/engine/net-trace.ts
 *
 * Tests verify:
 * - Pins at the same world position are merged into one net
 * - A wire connecting two pins merges them into one net
 * - Two separate groups remain in separate nets
 * - Tunnel components with the same label are merged (no wire needed)
 * - Pin world position uses rotation (pinWorldPosition, not raw addition)
 */

import { describe, it, expect } from 'vitest';
import { traceNets } from '../net-trace.js';
import { Circuit, Wire } from '@/core/circuit.js';
import { AbstractCircuitElement } from '@/core/element.js';
import { PinDirection, type Pin, type Rotation } from '@/core/pin.js';
import { PropertyBag } from '@/core/properties.js';
import { ComponentRegistry } from '@/core/registry.js';
import type { ComponentDefinition } from '@/core/registry.js';
import { ComponentCategory } from '@/core/registry.js';
import type { RenderContext, Rect } from '@/core/renderer-interface.js';

// ---------------------------------------------------------------------------
// Minimal test CircuitElement
// ---------------------------------------------------------------------------

class TestElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pins: Pin[],
    rotation: Rotation = 0,
    mirror = false,
    props?: PropertyBag,
  ) {
    super(typeId, instanceId, position, rotation, mirror, props ?? new PropertyBag());
    this._pins = pins;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 2 };
  }

  getHelpText(): string {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Pin helpers — positions are LOCAL (relative to element origin)
// ---------------------------------------------------------------------------

function inputPin(x: number, y: number, label = 'in', bitWidth = 1): Pin {
  return { direction: PinDirection.INPUT, position: { x, y }, label, bitWidth, isNegated: false, isClock: false };
}

function outputPin(x: number, y: number, label = 'out', bitWidth = 1): Pin {
  return { direction: PinDirection.OUTPUT, position: { x, y }, label, bitWidth, isNegated: false, isClock: false };
}

// ---------------------------------------------------------------------------
// Minimal registry helper
// ---------------------------------------------------------------------------

const NOOP_EXEC = () => {};

function makeRegistry(...names: string[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of names) {
    const def: ComponentDefinition = {
      name,
      typeId: -1,
      factory: () => { throw new Error('not needed in test'); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: '',
      models: {
        digital: { executeFn: NOOP_EXEC },
      },
    };
    registry.register(def);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('traceNets', () => {

  // -------------------------------------------------------------------------
  // Two components with pins at the same world position → same net
  // -------------------------------------------------------------------------
  it('pinsAtSameWorldPositionAreMerged', () => {
    // Both pins sit at world position (5, 3) (element at origin, pin at 5,3)
    const a = new TestElement('G', 'ea', { x: 0, y: 0 }, [outputPin(5, 3)]);
    const b = new TestElement('G', 'eb', { x: 0, y: 0 }, [inputPin(5, 3)]);

    const circuit = new Circuit();
    circuit.addElement(a);
    circuit.addElement(b);

    const registry = makeRegistry('G');
    const traced = traceNets(circuit.elements, circuit.wires, registry);

    // Slot 0 = element 0 pin 0; Slot 1 = element 1 pin 0 — same net
    expect(traced.slotToNetId[0]).toBe(traced.slotToNetId[1]);
  });

  // -------------------------------------------------------------------------
  // Wire connecting two pins → same net
  // -------------------------------------------------------------------------
  it('wireConnectsTwoPins', () => {
    // Element A has output pin at world (0,0); element B has input pin at world (4,0)
    // A wire runs from (0,0) to (4,0)
    const a = new TestElement('G', 'ea', { x: 0, y: 0 }, [outputPin(0, 0)]);
    const b = new TestElement('G', 'eb', { x: 4, y: 0 }, [inputPin(0, 0)]);

    const circuit = new Circuit();
    circuit.addElement(a);
    circuit.addElement(b);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 4, y: 0 }));

    const registry = makeRegistry('G');
    const traced = traceNets(circuit.elements, circuit.wires, registry);

    // Slots: 0 = a:pin0, 1 = b:pin0 — same net via wire
    expect(traced.slotToNetId[0]).toBe(traced.slotToNetId[1]);
  });

  // -------------------------------------------------------------------------
  // Two separate groups → different nets
  // -------------------------------------------------------------------------
  it('separateGroupsHaveDifferentNets', () => {
    // Two unconnected pairs of elements
    const a = new TestElement('G', 'ea', { x: 0, y: 0 }, [outputPin(0, 0)]);
    const b = new TestElement('G', 'eb', { x: 4, y: 0 }, [inputPin(0, 0)]);
    const c = new TestElement('G', 'ec', { x: 0, y: 5 }, [outputPin(0, 0)]);
    const d = new TestElement('G', 'ed', { x: 4, y: 5 }, [inputPin(0, 0)]);

    const circuit = new Circuit();
    circuit.addElement(a);
    circuit.addElement(b);
    circuit.addElement(c);
    circuit.addElement(d);
    // Wire first pair only
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 4, y: 0 }));

    const registry = makeRegistry('G');
    const traced = traceNets(circuit.elements, circuit.wires, registry);

    // Slots: 0=a, 1=b, 2=c, 3=d
    expect(traced.slotToNetId[0]).toBe(traced.slotToNetId[1]);   // wired together
    expect(traced.slotToNetId[2]).not.toBe(traced.slotToNetId[3]);  // not wired — each isolated
    expect(traced.slotToNetId[0]).not.toBe(traced.slotToNetId[2]);  // different groups
  });

  // -------------------------------------------------------------------------
  // Tunnel components with the same label → merged (no wire needed)
  // -------------------------------------------------------------------------
  it('tunnelsSameLabelAreMerged', () => {
    const propsA = new PropertyBag();
    propsA.set('label', 'Bus0');
    const propsB = new PropertyBag();
    propsB.set('label', 'Bus0');

    // Place tunnels at different world positions so they can only merge via label
    const tunnelA = new TestElement('Tunnel', 'ta', { x: 0, y: 0 }, [outputPin(0, 0)], 0, false, propsA);
    const tunnelB = new TestElement('Tunnel', 'tb', { x: 20, y: 20 }, [inputPin(0, 0)], 0, false, propsB);

    const circuit = new Circuit();
    circuit.addElement(tunnelA);
    circuit.addElement(tunnelB);
    // No wire between them

    const registry = makeRegistry('Tunnel');
    const traced = traceNets(circuit.elements, circuit.wires, registry);

    // Slots: 0 = tunnelA pin 0, 1 = tunnelB pin 0 — same net via label
    expect(traced.slotToNetId[0]).toBe(traced.slotToNetId[1]);
  });

  // -------------------------------------------------------------------------
  // Tunnel components with different labels → NOT merged
  // -------------------------------------------------------------------------
  it('tunnelsDifferentLabelsNotMerged', () => {
    const propsA = new PropertyBag();
    propsA.set('label', 'Bus0');
    const propsB = new PropertyBag();
    propsB.set('label', 'Bus1');

    const tunnelA = new TestElement('Tunnel', 'ta', { x: 0, y: 0 }, [outputPin(0, 0)], 0, false, propsA);
    const tunnelB = new TestElement('Tunnel', 'tb', { x: 20, y: 20 }, [inputPin(0, 0)], 0, false, propsB);

    const circuit = new Circuit();
    circuit.addElement(tunnelA);
    circuit.addElement(tunnelB);

    const registry = makeRegistry('Tunnel');
    const traced = traceNets(circuit.elements, circuit.wires, registry);

    expect(traced.slotToNetId[0]).not.toBe(traced.slotToNetId[1]);
  });

  // -------------------------------------------------------------------------
  // Pin world position uses rotation: a rotated element's pin ends up at
  // a different world position than raw (el.position + pin.position) would give.
  // -------------------------------------------------------------------------
  it('rotationIsAppliedViaPinWorldPosition', () => {
    // A component at world (10, 10), rotation=1 (90° CW).
    // Local pin at (2, 0).
    // rotatePoint({x:2, y:0}, 1): case 1 → {x: p.y||0, y: (-p.x)||0} = {x:0, y:-2}
    // World position = (10+0, 10+(-2)) = (10, 8).
    // Raw addition would give (10+2, 10+0) = (12, 10) — WRONG.
    //
    // We place a second element with its pin at world (10, 8) (no rotation).
    // They should merge if pinWorldPosition is used (correct), but NOT if
    // raw addition is used (wrong world pos = (12,10) wouldn't match).

    const rotatedElem = new TestElement('G', 'rotated', { x: 10, y: 10 }, [outputPin(2, 0)], 1 as Rotation);
    const targetElem = new TestElement('G', 'target', { x: 10, y: 8 }, [inputPin(0, 0)]);

    const circuit = new Circuit();
    circuit.addElement(rotatedElem);
    circuit.addElement(targetElem);

    const registry = makeRegistry('G');
    const traced = traceNets(circuit.elements, circuit.wires, registry);

    // With correct rotation: rotated pin lands at (10,8) → same as targetElem pin → merged
    expect(traced.slotToNetId[0]).toBe(traced.slotToNetId[1]);

    // Verify that raw addition would NOT produce the same result:
    // raw = (10+2, 10+0) = (12, 10), which differs from targetElem pin at (10, 8)
    // So if the implementation used raw addition, slotToNetId[0] !== slotToNetId[1].
    // The above assertion passing proves pinWorldPosition() is being used correctly.
  });

  // -------------------------------------------------------------------------
  // netCount is correct for multi-pin elements
  // -------------------------------------------------------------------------
  it('netCountIsComputedCorrectly', () => {
    // Element 0 has 2 pins (isolated), element 1 has 3 pins (isolated) → 5 nets total
    const a = new TestElement('G', 'ea', { x: 0, y: 0 }, [
      outputPin(0, 0, 'out'),
      inputPin(0, 1, 'in'),
    ]);
    const b = new TestElement('G', 'eb', { x: 10, y: 0 }, [
      outputPin(0, 0, 'q'),
      inputPin(0, 1, 'a'),
      inputPin(0, 2, 'b'),
    ]);

    const circuit = new Circuit();
    circuit.addElement(a);
    circuit.addElement(b);

    const registry = makeRegistry('G');
    const traced = traceNets(circuit.elements, circuit.wires, registry);

    expect(traced.netCount).toBe(5);
    expect(traced.slotToNetId).toHaveLength(5);
  });

  // -------------------------------------------------------------------------
  // Chained wires: A --w1-- mid --w2-- B all in one net
  // -------------------------------------------------------------------------
  it('chainedWiresFormOneNet', () => {
    const a = new TestElement('G', 'ea', { x: 0, y: 0 }, [outputPin(0, 0)]);
    const b = new TestElement('G', 'eb', { x: 6, y: 0 }, [inputPin(0, 0)]);

    const circuit = new Circuit();
    circuit.addElement(a);
    circuit.addElement(b);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 3, y: 0 }));
    circuit.addWire(new Wire({ x: 3, y: 0 }, { x: 6, y: 0 }));

    const registry = makeRegistry('G');
    const traced = traceNets(circuit.elements, circuit.wires, registry);

    // Slots: 0 = a pin 0, 1 = b pin 0 — same net via chained wires
    expect(traced.slotToNetId[0]).toBe(traced.slotToNetId[1]);
  });

  // -------------------------------------------------------------------------
  // nets array has correct membership
  // -------------------------------------------------------------------------
  it('netsArrayHasCorrectMembership', () => {
    const a = new TestElement('G', 'ea', { x: 0, y: 0 }, [outputPin(0, 0)]);
    const b = new TestElement('G', 'eb', { x: 4, y: 0 }, [inputPin(0, 0)]);

    const circuit = new Circuit();
    circuit.addElement(a);
    circuit.addElement(b);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 4, y: 0 }));

    const registry = makeRegistry('G');
    const traced = traceNets(circuit.elements, circuit.wires, registry);

    // Only 1 net (both pins merged by wire)
    expect(traced.netCount).toBe(1);
    expect(traced.nets).toHaveLength(1);
    expect(traced.nets[0]!.slots).toContain(0);
    expect(traced.nets[0]!.slots).toContain(1);
  });
});
