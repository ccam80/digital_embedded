/**
 * Tests for path-analysis.ts (task 8.3.2).
 *
 * Tests:
 *   - singleGate: one AND gate → path length = defaultDelay (10ns)
 *   - cascade: AND → OR → NOT → path length = sum of delays
 *   - parallelPaths: two paths of different length → reports the longer one
 *   - componentList: verify components listed in path order
 */

import { describe, expect, it } from 'vitest';
import { findCriticalPath } from '../path-analysis.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { ComponentRegistry } from '../../core/registry.js';
import { PropertyBag, PropertyType } from '../../core/properties.js';
import { AbstractCircuitElement } from '../../core/element.js';
import type { Pin, Rotation } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { ComponentLayout } from '../../core/registry.js';

// ---------------------------------------------------------------------------
// Stub element
// ---------------------------------------------------------------------------

class StubElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pins: Pin[],
    props: PropertyBag,
  ) {
    super(typeId, instanceId, position, 0 as Rotation, false, props);
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
  getHelpText(): string { return ''; }
}

function makePin(label: string, direction: PinDirection, x: number, y: number): Pin {
  return { label, direction, position: { x, y }, bitWidth: 1, isNegated: false, isClock: false };
}

function noop(_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void {}

// ---------------------------------------------------------------------------
// Registry factory with configurable delays
// ---------------------------------------------------------------------------

function buildRegistry(delays: Record<string, number> = {}): ComponentRegistry {
  const registry = new ComponentRegistry();

  const andDelay = delays['And'] ?? 10;
  const orDelay = delays['Or'] ?? 10;
  const notDelay = delays['Not'] ?? 10;

  registry.register({
    name: 'In',
    typeId: -1,
    factory: (props) => new StubElement('In', crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [{ key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' }],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
    models: { digital: { executeFn: noop, defaultDelay: 0 } },
    defaultDelay: 0,
  });

  registry.register({
    name: 'Out',
    typeId: -1,
    factory: (props) => new StubElement('Out', crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [{ key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' }],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
    models: { digital: { executeFn: noop, defaultDelay: 0 } },
    defaultDelay: 0,
  });

  registry.register({
    name: 'And',
    typeId: -1,
    factory: (props) => new StubElement('And', crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
    models: { digital: { executeFn: noop, defaultDelay: andDelay } },
    defaultDelay: andDelay,
  });

  registry.register({
    name: 'Or',
    typeId: -1,
    factory: (props) => new StubElement('Or', crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
    models: { digital: { executeFn: noop, defaultDelay: orDelay } },
    defaultDelay: orDelay,
  });

  registry.register({
    name: 'Not',
    typeId: -1,
    factory: (props) => new StubElement('Not', crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
    models: { digital: { executeFn: noop, defaultDelay: notDelay } },
    defaultDelay: notDelay,
  });

  return registry;
}

function makeProps(entries: Record<string, string | number | boolean> = {}): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(entries)) bag.set(k, v);
  return bag;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('path-analysis', () => {
  // -------------------------------------------------------------------------
  // singleGate: one AND gate → path length = defaultDelay (10ns)
  // -------------------------------------------------------------------------

  it('singleGate — one AND gate → pathLength = 10ns', () => {
    const registry = buildRegistry({ And: 10 });
    const circuit = new Circuit();

    // Positions chosen so pin matching works via wires:
    // InA output at (2,1), InB output at (2,3)
    // AND inputs at (4,1) and (4,3), output at (8,2)
    // Out input at (10,2)

    const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 1),
    ], makeProps({ label: 'A' }));

    const inB = new StubElement('In', 'inB', { x: 0, y: 2 }, [
      makePin('out', PinDirection.OUTPUT, 2, 1),
    ], makeProps({ label: 'B' }));

    const andGate = new StubElement('And', 'and1', { x: 4, y: 1 }, [
      makePin('in0', PinDirection.INPUT, 0, 0),
      makePin('in1', PinDirection.INPUT, 0, 2),
      makePin('out', PinDirection.OUTPUT, 4, 1),
    ], makeProps());

    const outEl = new StubElement('Out', 'outY', { x: 10, y: 2 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
    ], makeProps({ label: 'Y' }));

    circuit.addElement(inA);
    circuit.addElement(inB);
    circuit.addElement(andGate);
    circuit.addElement(outEl);

    circuit.addWire(new Wire({ x: 2, y: 1 }, { x: 4, y: 1 }));
    circuit.addWire(new Wire({ x: 2, y: 3 }, { x: 4, y: 3 }));
    circuit.addWire(new Wire({ x: 8, y: 2 }, { x: 10, y: 2 }));

    const result = findCriticalPath(circuit, registry);

    // AND gate contributes 10ns; In/Out contribute 0ns (defaultDelay=0)
    expect(result.pathLength).toBe(10);
    expect(result.gateCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // cascade: AND → OR → NOT → path length = sum of delays
  // -------------------------------------------------------------------------

  it('cascade — AND(15ns) → OR(20ns) → NOT(5ns) → pathLength = 40ns', () => {
    const registry = buildRegistry({ And: 15, Or: 20, Not: 5 });
    const circuit = new Circuit();

    // Layout: x positions spaced by 10 units for clarity
    // InA: out at (2,0), InB: out at (2,2)
    // AND: in at (4,0),(4,2), out at (8,1)
    // OR: in0 at (10,1), in1 at (10,3), out at (14,2)
    // NOT: in at (16,2), out at (20,2)
    // InC: out at (10,3) (second input to OR, different path)

    const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], makeProps({ label: 'A' }));

    const inB = new StubElement('In', 'inB', { x: 0, y: 2 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], makeProps({ label: 'B' }));

    const inC = new StubElement('In', 'inC', { x: 0, y: 3 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], makeProps({ label: 'C' }));

    const andGate = new StubElement('And', 'and1', { x: 4, y: 0 }, [
      makePin('in0', PinDirection.INPUT, 0, 0),
      makePin('in1', PinDirection.INPUT, 0, 2),
      makePin('out', PinDirection.OUTPUT, 4, 1),
    ], makeProps());

    const orGate = new StubElement('Or', 'or1', { x: 10, y: 1 }, [
      makePin('in0', PinDirection.INPUT, 0, 0),
      makePin('in1', PinDirection.INPUT, 0, 2),
      makePin('out', PinDirection.OUTPUT, 4, 1),
    ], makeProps());

    const notGate = new StubElement('Not', 'not1', { x: 16, y: 2 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
      makePin('out', PinDirection.OUTPUT, 4, 0),
    ], makeProps());

    const outEl = new StubElement('Out', 'outY', { x: 22, y: 2 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
    ], makeProps({ label: 'Y' }));

    circuit.addElement(inA);
    circuit.addElement(inB);
    circuit.addElement(inC);
    circuit.addElement(andGate);
    circuit.addElement(orGate);
    circuit.addElement(notGate);
    circuit.addElement(outEl);

    // Wires for AND inputs
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.addWire(new Wire({ x: 2, y: 2 }, { x: 4, y: 2 }));
    // AND → OR
    circuit.addWire(new Wire({ x: 8, y: 1 }, { x: 10, y: 1 }));
    // InC → OR (second input, shorter path)
    circuit.addWire(new Wire({ x: 2, y: 3 }, { x: 10, y: 3 }));
    // OR → NOT
    circuit.addWire(new Wire({ x: 14, y: 2 }, { x: 16, y: 2 }));
    // NOT → Out
    circuit.addWire(new Wire({ x: 20, y: 2 }, { x: 22, y: 2 }));

    const result = findCriticalPath(circuit, registry);

    // Cascade path: AND(15) + OR(20) + NOT(5) = 40ns
    expect(result.pathLength).toBe(40);
    expect(result.gateCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // parallelPaths: two paths of different length → reports the longer one
  // -------------------------------------------------------------------------

  it('parallelPaths — two paths (10ns vs 20ns) → reports longer one (20ns)', () => {
    const registry = buildRegistry({ And: 10, Or: 20 });
    const circuit = new Circuit();

    // Path 1: InA → AND(10ns) → Out
    // Path 2: InB → OR(20ns) → Out
    // Both converge at the Out component; critical path is OR path (20ns)

    const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], makeProps({ label: 'A' }));

    const inB = new StubElement('In', 'inB', { x: 0, y: 4 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], makeProps({ label: 'B' }));

    // AND gate on path 1: one input from inA, output at (8, 0)
    const andGate = new StubElement('And', 'and1', { x: 4, y: 0 }, [
      makePin('in0', PinDirection.INPUT, 0, 0),
      makePin('in1', PinDirection.INPUT, 0, 1), // dummy second input
      makePin('out', PinDirection.OUTPUT, 4, 0),
    ], makeProps());

    // OR gate on path 2: one input from inB, output at (8, 4)
    const orGate = new StubElement('Or', 'or1', { x: 4, y: 4 }, [
      makePin('in0', PinDirection.INPUT, 0, 0),
      makePin('in1', PinDirection.INPUT, 0, 1), // dummy second input
      makePin('out', PinDirection.OUTPUT, 4, 0),
    ], makeProps());

    // Two separate Out components to avoid merging the paths
    const outY1 = new StubElement('Out', 'outY1', { x: 10, y: 0 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
    ], makeProps({ label: 'Y1' }));

    const outY2 = new StubElement('Out', 'outY2', { x: 10, y: 4 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
    ], makeProps({ label: 'Y2' }));

    circuit.addElement(inA);
    circuit.addElement(inB);
    circuit.addElement(andGate);
    circuit.addElement(orGate);
    circuit.addElement(outY1);
    circuit.addElement(outY2);

    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.addWire(new Wire({ x: 8, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 2, y: 4 }, { x: 4, y: 4 }));
    circuit.addWire(new Wire({ x: 8, y: 4 }, { x: 10, y: 4 }));

    const result = findCriticalPath(circuit, registry);

    // Longer path: OR(20ns)
    expect(result.pathLength).toBe(20);
    expect(result.gateCount).toBe(1); // just the Or gate on the critical path
  });

  // -------------------------------------------------------------------------
  // componentList: verify components listed in path order
  // -------------------------------------------------------------------------

  it('componentList — cascade path lists components in topological order', () => {
    const registry = buildRegistry({ And: 10, Not: 5 });
    const circuit = new Circuit();

    // Path: InA → AND → NOT → OutY
    // InA: label "A", AND: no label → typeId "And", NOT: no label → typeId "Not"

    const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 1),
    ], makeProps({ label: 'A' }));

    const inB = new StubElement('In', 'inB', { x: 0, y: 2 }, [
      makePin('out', PinDirection.OUTPUT, 2, 1),
    ], makeProps({ label: 'B' }));

    const andGate = new StubElement('And', 'and1', { x: 4, y: 1 }, [
      makePin('in0', PinDirection.INPUT, 0, 0),
      makePin('in1', PinDirection.INPUT, 0, 2),
      makePin('out', PinDirection.OUTPUT, 4, 1),
    ], makeProps());

    const notGate = new StubElement('Not', 'not1', { x: 10, y: 2 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
      makePin('out', PinDirection.OUTPUT, 4, 0),
    ], makeProps());

    const outEl = new StubElement('Out', 'outY', { x: 16, y: 2 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
    ], makeProps({ label: 'Y' }));

    circuit.addElement(inA);
    circuit.addElement(inB);
    circuit.addElement(andGate);
    circuit.addElement(notGate);
    circuit.addElement(outEl);

    circuit.addWire(new Wire({ x: 2, y: 1 }, { x: 4, y: 1 }));
    circuit.addWire(new Wire({ x: 2, y: 3 }, { x: 4, y: 3 }));
    circuit.addWire(new Wire({ x: 8, y: 2 }, { x: 10, y: 2 }));
    circuit.addWire(new Wire({ x: 14, y: 2 }, { x: 16, y: 2 }));

    const result = findCriticalPath(circuit, registry);

    // Total delay: AND(10) + NOT(5) = 15 (In/Out have delay 0)
    expect(result.pathLength).toBe(15);

    // The components list should include elements in topological order
    // The critical path goes through: inA (or inB), And, Not, outY
    // We check that And and Not appear in that order
    const andIdx = result.components.indexOf('And');
    const notIdx = result.components.indexOf('Not');
    expect(andIdx).toBeGreaterThanOrEqual(0);
    expect(notIdx).toBeGreaterThanOrEqual(0);
    expect(andIdx).toBeLessThan(notIdx);
  });
});
