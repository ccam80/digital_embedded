/**
 * Tests for SimulationCoordinator visualization context methods (section 1.6):
 * getPinVoltages, getWireAnalogNodeId, voltageRange, updateVoltageTracking.
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulationCoordinator } from '../coordinator.js';
import { DefaultSimulatorFacade } from '../../headless/default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { AbstractCircuitElement } from '../../core/element.js';
import { PropertyBag } from '../../core/properties.js';
import { PinDirection } from '../../core/pin.js';
import { ComponentRegistry } from '../../core/registry.js';
import { ResistorDefinition } from '../../components/passives/resistor.js';
import { DcVoltageSourceDefinition } from '../../components/sources/dc-voltage-source.js';
import { GroundDefinition } from '../../components/io/ground.js';
import { compileUnified } from '../../compile/compile.js';
import type { Pin, Rotation } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { CircuitElement, SerializedElement } from '../../core/element.js';
import type { PropertyValue } from '../../core/properties.js';

// ---------------------------------------------------------------------------
// Minimal element helpers
// ---------------------------------------------------------------------------

class MockElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];
  constructor(typeId: string, instanceId: string, position: { x: number; y: number }, pins: Pin[]) {
    super(typeId, instanceId, position, 0 as Rotation, false, new PropertyBag());
    this._pins = pins;
  }
  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: this.position.x, y: this.position.y, width: 4, height: 4 }; }
  getHelpText(): string { return ''; }
}

function makeAnalogEl(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string }>,
  propsMap: Map<string, PropertyValue> = new Map(),
): CircuitElement {
  const resolvedPins: Pin[] = pins.map(p => ({
    position: { x: p.x, y: p.y },
    label: p.label ?? '',
    direction: PinDirection.BIDIRECTIONAL,
    isNegated: false,
    isClock: false,
    bitWidth: 1,
  }));
  const propertyBag = new PropertyBag(propsMap.entries());
  const serialized: SerializedElement = {
    typeId, instanceId, position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement['rotation'], mirror: false, properties: {},
  };
  return {
    typeId, instanceId, position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement['rotation'], mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) {},
    serialize() { return serialized; },
    getHelpText() { return ''; },
    getAttribute(k: string) { return propsMap.get(k); },
  };
}

// ---------------------------------------------------------------------------
// RC circuit fixture (Vcc=5V, R=1k, C=1uF, GND)
// ---------------------------------------------------------------------------

function buildRcCoordinator() {
  const registry = new ComponentRegistry();
  registry.register(GroundDefinition);
  registry.register(ResistorDefinition);
  registry.register(DcVoltageSourceDefinition);

  const circuit = new Circuit();

  // Resistor divider: VCC=5V -> R1=1k -> mid-node -> R2=1k -> GND.
  // DC steady state: mid-node = 2.5V, VCC node = 5V.
  // This gives two distinct non-ground voltages so voltageRange spans a non-zero range.
  //
  // DcVoltageSource pin layout: neg at local {x:0,y:0} (index 0), pos at local {x:4,y:0} (index 1).
  // With element.position={x:0,y:0} the neg world position is (0,0) and pos is (4,0).
  // gnd at (0,0) clamps neg to 0V; pos at (4,0) is the +5V rail.
  const vcc = makeAnalogEl('DcVoltageSource', 'vcc1',
    [{ x: 0, y: 0 }, { x: 4, y: 0 }],
    new Map<string, PropertyValue>([['voltage', 5]]),
  );
  const r1 = makeAnalogEl('Resistor', 'r1',
    [{ x: 4, y: 0 }, { x: 8, y: 0 }],
    new Map<string, PropertyValue>([['resistance', 1000]]),
  );
  const r2 = makeAnalogEl('Resistor', 'r2',
    [{ x: 8, y: 0 }, { x: 12, y: 0 }],
    new Map<string, PropertyValue>([['resistance', 1000]]),
  );
  const gnd = makeAnalogEl('Ground', 'gnd1', [{ x: 0, y: 0 }]);
  const gnd2 = makeAnalogEl('Ground', 'gnd2', [{ x: 12, y: 0 }]);

  circuit.addElement(vcc);
  circuit.addElement(r1);
  circuit.addElement(r2);
  circuit.addElement(gnd);
  circuit.addElement(gnd2);

  // Non-zero-length wires so addWire() does not silently drop them.
  // Each wire has one endpoint at a pin position so it joins the correct node.
  const wire1 = new Wire({ x: 4, y: 0 }, { x: 4, y: 1 });
  const wire2 = new Wire({ x: 8, y: 0 }, { x: 8, y: 1 });
  const wire3 = new Wire({ x: 0, y: 0 }, { x: 0, y: 1 });
  const wire4 = new Wire({ x: 12, y: 0 }, { x: 12, y: 1 });

  circuit.addWire(wire1);
  circuit.addWire(wire2);
  circuit.addWire(wire3);
  circuit.addWire(wire4);

  const unified = compileUnified(circuit, registry);
  const coordinator = new DefaultSimulationCoordinator(unified);
  return { coordinator, circuit, elements: { vcc, res: r1, cap: r2, gnd, gnd2 }, wires: { wire1, wire2, wire3, wire4 } };
}

function buildDigitalCoordinator() {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: 'A',    type: 'In',  props: { label: 'A', bitWidth: 1 } },
      { id: 'B',    type: 'In',  props: { label: 'B', bitWidth: 1 } },
      { id: 'gate', type: 'And' },
      { id: 'Y',    type: 'Out', props: { label: 'Y', bitWidth: 1 } },
    ],
    connections: [
      ['A:out', 'gate:In_1'],
      ['B:out', 'gate:In_2'],
      ['gate:out', 'Y:in'],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { facade, circuit, coordinator };
}

// ---------------------------------------------------------------------------
// Section 1.6 getPinVoltages
// ---------------------------------------------------------------------------

describe('getPinVoltages -- digital-only coordinator', () => {
  it('returns null for any circuit element', () => {
    const { coordinator, circuit } = buildDigitalCoordinator();
    const element = circuit.elements[0]!;
    expect(coordinator.getPinVoltages(element)).toBeNull();
    coordinator.dispose();
  });
});

describe('getPinVoltages -- analog coordinator', () => {
  it('returns null for an element not in the analog domain', () => {
    const { coordinator } = buildRcCoordinator();
    const foreignEl = makeAnalogEl('Unknown', 'foreign-1', [{ x: 999, y: 999 }]);
    expect(coordinator.getPinVoltages(foreignEl)).toBeNull();
    coordinator.dispose();
  });

  it('returns a Map for an analog domain element', () => {
    const { coordinator, elements } = buildRcCoordinator();
    const voltages = coordinator.getPinVoltages(elements.res);
    expect(voltages).not.toBeNull();
    expect(voltages).toBeInstanceOf(Map);
    coordinator.dispose();
  });

  it('returned map contains at least one pin entry', () => {
    const { coordinator, elements } = buildRcCoordinator();
    const voltages = coordinator.getPinVoltages(elements.res);
    expect(voltages!.size).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it('all pin voltage values are finite numbers', () => {
    const { coordinator, elements } = buildRcCoordinator();
    const voltages = coordinator.getPinVoltages(elements.vcc);
    expect(voltages).not.toBeNull();
    for (const [, v] of voltages!) {
      expect(Number.isFinite(v)).toBe(true);
    }
    coordinator.dispose();
  });

  it('voltage source pins span a non-zero potential after DC op', () => {
    const { coordinator, elements } = buildRcCoordinator();
    const voltages = coordinator.getPinVoltages(elements.vcc);
    expect(voltages).not.toBeNull();
    const values = Array.from(voltages!.values());
    const maxV = Math.max(...values);
    const minV = Math.min(...values);
    expect(maxV - minV).toBeGreaterThan(0);
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.6 getWireAnalogNodeId
// ---------------------------------------------------------------------------

describe('getWireAnalogNodeId -- digital-only coordinator', () => {
  it('returns undefined for any wire', () => {
    const { coordinator } = buildDigitalCoordinator();
    const wire = new Wire({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(coordinator.getWireAnalogNodeId(wire)).toBeUndefined();
    coordinator.dispose();
  });
});

describe('getWireAnalogNodeId -- analog coordinator', () => {
  it('returns undefined for a wire not in the circuit', () => {
    const { coordinator } = buildRcCoordinator();
    const foreignWire = new Wire({ x: 999, y: 999 }, { x: 1000, y: 999 });
    expect(coordinator.getWireAnalogNodeId(foreignWire)).toBeUndefined();
    coordinator.dispose();
  });

  it('at least one circuit wire maps to an analog node ID', () => {
    const { coordinator, wires } = buildRcCoordinator();
    const ids = [wires.wire1, wires.wire2, wires.wire3, wires.wire4]
      .map(w => coordinator.getWireAnalogNodeId(w));
    const hasAtLeastOne = ids.some(id => id !== undefined);
    expect(hasAtLeastOne).toBe(true);
    coordinator.dispose();
  });

  it('mapped wire node IDs are non-negative integers (0 = ground node)', () => {
    const { coordinator, wires } = buildRcCoordinator();
    for (const w of [wires.wire1, wires.wire2, wires.wire3, wires.wire4]) {
      const id = coordinator.getWireAnalogNodeId(w);
      if (id !== undefined) {
        expect(Number.isInteger(id)).toBe(true);
        expect(id).toBeGreaterThanOrEqual(0);
      }
    }
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.6 voltageRange and updateVoltageTracking
// ---------------------------------------------------------------------------

describe('voltageRange -- digital-only coordinator', () => {
  it('returns null', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.voltageRange).toBeNull();
    coordinator.dispose();
  });
});

describe('voltageRange and updateVoltageTracking -- analog coordinator', () => {
  it('voltageRange is { min: 0, max: 0 } before any tracking', () => {
    const { coordinator } = buildRcCoordinator();
    const range = coordinator.voltageRange;
    expect(range).not.toBeNull();
    expect(range!.min).toBe(0);
    expect(range!.max).toBe(0);
    coordinator.dispose();
  });

  it('updateVoltageTracking does not throw', () => {
    const { coordinator } = buildRcCoordinator();
    expect(() => coordinator.updateVoltageTracking()).not.toThrow();
    coordinator.dispose();
  });

  it('voltageRange max is positive after tracking a 5V DC circuit', () => {
    const { coordinator } = buildRcCoordinator();
    coordinator.updateVoltageTracking();
    const range = coordinator.voltageRange;
    expect(range!.max).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it('voltageRange min <= max after tracking', () => {
    const { coordinator } = buildRcCoordinator();
    coordinator.updateVoltageTracking();
    const range = coordinator.voltageRange;
    expect(range!.min).toBeLessThanOrEqual(range!.max);
    coordinator.dispose();
  });

  it('voltageRange spans a non-zero range for circuit with voltage differences', () => {
    const { coordinator } = buildRcCoordinator();
    coordinator.updateVoltageTracking();
    const range = coordinator.voltageRange;
    expect(range!.max - range!.min).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it('voltageRange resets to { min: 0, max: 0 } after coordinator.reset()', () => {
    const { coordinator } = buildRcCoordinator();
    coordinator.updateVoltageTracking();
    expect(coordinator.voltageRange!.max).toBeGreaterThan(0);
    coordinator.reset();
    const range = coordinator.voltageRange;
    expect(range!.min).toBe(0);
    expect(range!.max).toBe(0);
    coordinator.dispose();
  });

  it('updateVoltageTracking is a no-op on digital-only coordinator', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(() => coordinator.updateVoltageTracking()).not.toThrow();
    expect(coordinator.voltageRange).toBeNull();
    coordinator.dispose();
  });

  it('voltageRange does not shrink after additional tracking', () => {
    const { coordinator } = buildRcCoordinator();
    coordinator.updateVoltageTracking();
    const range1 = { ...coordinator.voltageRange! };
    coordinator.step();
    coordinator.updateVoltageTracking();
    const range2 = coordinator.voltageRange!;
    expect(range2.min).toBeLessThanOrEqual(range1.min);
    expect(range2.max).toBeGreaterThanOrEqual(range1.max);
    coordinator.dispose();
  });
});
