/**
 * Tests for statistics.ts (task 8.3.3).
 *
 * Tests:
 *   - componentCounts: circuit with 3 AND + 2 OR → counts correct
 *   - wireCount: circuit with 5 wires → wireCount = 5
 *   - emptyCircuit: empty circuit → all counts zero
 */

import { describe, expect, it } from 'vitest';
import { computeStatistics } from '../statistics.js';
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
}

function makePin(label: string, direction: PinDirection, x: number, y: number): Pin {
  return { label, direction, position: { x, y }, bitWidth: 1, isNegated: false, isClock: false };
}

function noop(_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void {}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

function buildRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    name: 'In',
    typeId: -1,
    factory: (props) => new StubElement('In', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 1),
    ], props),
    pinLayout: [],
    propertyDefs: [{ key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' }],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
    models: { digital: { executeFn: noop } },
  });

  registry.register({
    name: 'Out',
    typeId: -1,
    factory: (props) => new StubElement('Out', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in', PinDirection.INPUT, 0, 1),
    ], props),
    pinLayout: [],
    propertyDefs: [{ key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' }],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
    models: { digital: { executeFn: noop } },
  });

  registry.register({
    name: 'And',
    typeId: -1,
    factory: (props) => new StubElement('And', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in0', PinDirection.INPUT, 0, 0),
      makePin('in1', PinDirection.INPUT, 0, 1),
      makePin('out', PinDirection.OUTPUT, 4, 0),
    ], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
    models: { digital: { executeFn: noop } },
  });

  registry.register({
    name: 'Or',
    typeId: -1,
    factory: (props) => new StubElement('Or', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in0', PinDirection.INPUT, 0, 0),
      makePin('in1', PinDirection.INPUT, 0, 1),
      makePin('out', PinDirection.OUTPUT, 4, 0),
    ], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
    models: { digital: { executeFn: noop } },
  });

  return registry;
}

function emptyProps(): PropertyBag {
  return new PropertyBag();
}

function labelProps(label: string): PropertyBag {
  const bag = new PropertyBag();
  bag.set('label', label);
  return bag;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('statistics', () => {
  // -------------------------------------------------------------------------
  // componentCounts: 3 AND + 2 OR → counts correct
  // -------------------------------------------------------------------------

  it('componentCounts — 3 AND + 2 OR → correct counts per typeId', () => {
    const registry = buildRegistry();
    const circuit = new Circuit();

    // Add 3 AND gates
    for (let i = 0; i < 3; i++) {
      circuit.addElement(new StubElement('And', `and${i}`, { x: i * 6, y: 0 }, [
        makePin('in0', PinDirection.INPUT, i * 6, 0),
        makePin('in1', PinDirection.INPUT, i * 6, 1),
        makePin('out', PinDirection.OUTPUT, i * 6 + 4, 0),
      ], emptyProps()));
    }

    // Add 2 OR gates
    for (let i = 0; i < 2; i++) {
      circuit.addElement(new StubElement('Or', `or${i}`, { x: i * 6, y: 6 }, [
        makePin('in0', PinDirection.INPUT, i * 6, 6),
        makePin('in1', PinDirection.INPUT, i * 6, 7),
        makePin('out', PinDirection.OUTPUT, i * 6 + 4, 6),
      ], emptyProps()));
    }

    const stats = computeStatistics(circuit, registry);

    expect(stats.componentCounts.get('And')).toBe(3);
    expect(stats.componentCounts.get('Or')).toBe(2);
    expect(stats.totalGateCount).toBe(5); // 3 AND + 2 OR
    expect(stats.inputCount).toBe(0);
    expect(stats.outputCount).toBe(0);
    expect(stats.wireCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // wireCount: circuit with 5 wires → wireCount = 5
  // -------------------------------------------------------------------------

  it('wireCount — circuit with 5 wires → wireCount = 5', () => {
    const registry = buildRegistry();
    const circuit = new Circuit();

    // Add In and Out with a chain of 5 wires connecting them
    circuit.addElement(new StubElement('In', 'inA', { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], labelProps('A')));

    circuit.addElement(new StubElement('Out', 'outY', { x: 12, y: 0 }, [
      makePin('in', PinDirection.INPUT, 12, 0),
    ], labelProps('Y')));

    // 5 wire segments
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.addWire(new Wire({ x: 4, y: 0 }, { x: 6, y: 0 }));
    circuit.addWire(new Wire({ x: 6, y: 0 }, { x: 8, y: 0 }));
    circuit.addWire(new Wire({ x: 8, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 12, y: 0 }));

    const stats = computeStatistics(circuit, registry);

    expect(stats.wireCount).toBe(5);
    expect(stats.inputCount).toBe(1);
    expect(stats.outputCount).toBe(1);

    // All 5 wire segments are chained → they form 1 net (connected group)
    expect(stats.netCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // emptyCircuit: empty circuit → all counts zero
  // -------------------------------------------------------------------------

  it('emptyCircuit — empty circuit → all counts zero', () => {
    const registry = buildRegistry();
    const circuit = new Circuit();

    const stats = computeStatistics(circuit, registry);

    expect(stats.componentCounts.size).toBe(0);
    expect(stats.totalGateCount).toBe(0);
    expect(stats.wireCount).toBe(0);
    expect(stats.netCount).toBe(0);
    expect(stats.inputCount).toBe(0);
    expect(stats.outputCount).toBe(0);
    expect(stats.subcircuitCount).toBe(0);
    expect(stats.circuitDepth).toBe(0);
  });
});
