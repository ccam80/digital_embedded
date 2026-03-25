/**
 * Tests for SimulationCoordinator section 1.7 (slider context), 1.8 (element/branch
 * current reading), and 1.9 (snapshot management).
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulationCoordinator } from "../coordinator.js";
import { DefaultSimulatorFacade } from "../../headless/default-facade.js";
import { createDefaultRegistry } from "../../components/register-all.js";
import { ComponentRegistry } from "../../core/registry.js";
import { ResistorDefinition } from "../../components/passives/resistor.js";
import { DcVoltageSourceDefinition } from "../../components/sources/dc-voltage-source.js";
import { GroundDefinition } from "../../components/io/ground.js";
import { compileUnified } from "../../compile/compile.js";
import { Circuit, Wire } from "../../core/circuit.js";
import { PropertyBag } from "../../core/properties.js";
import { PinDirection } from "../../core/pin.js";
import type { Pin } from "../../core/pin.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { CircuitElement, SerializedElement } from "../../core/element.js";
import type { PropertyValue } from "../../core/properties.js";

function makeAnalogEl(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number }>,
  propsMap: Map<string, PropertyValue> = new Map(),
): CircuitElement {
  const resolvedPins: Pin[] = pins.map(p => ({
    position: { x: p.x, y: p.y },
    label: '',
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

function buildAnalogCoordinator() {
  const registry = new ComponentRegistry();
  registry.register(GroundDefinition);
  registry.register(ResistorDefinition);
  registry.register(DcVoltageSourceDefinition);
  const circuit = new Circuit();
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
  circuit.addElement(vcc); circuit.addElement(r1); circuit.addElement(r2);
  circuit.addElement(gnd); circuit.addElement(gnd2);
  circuit.addWire(new Wire({ x: 4, y: 0 }, { x: 4, y: 1 }));
  circuit.addWire(new Wire({ x: 8, y: 0 }, { x: 8, y: 1 }));
  circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 1 }));
  circuit.addWire(new Wire({ x: 12, y: 0 }, { x: 12, y: 1 }));
  const unified = compileUnified(circuit, registry);
  const coordinator = new DefaultSimulationCoordinator(unified, registry);
  return { coordinator, elements: { vcc, r1, r2, gnd, gnd2 } };
}

function buildDigitalCoordinator() {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: 'A', type: 'In', props: { label: 'A', bitWidth: 1 } },
      { id: 'B', type: 'In', props: { label: 'B', bitWidth: 1 } },
      { id: 'gate', type: 'And' },
      { id: 'Y', type: 'Out', props: { label: 'Y', bitWidth: 1 } },
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
// Section 1.7 getSliderProperties
// ---------------------------------------------------------------------------

describe('getSliderProperties -- digital-only coordinator', () => {
  it('returns empty array for any element', () => {
    const { coordinator, circuit } = buildDigitalCoordinator();
    const element = circuit.elements[0]!;
    expect(coordinator.getSliderProperties(element)).toEqual([]);
    coordinator.dispose();
  });
});

describe('getSliderProperties -- analog coordinator', () => {
  it('returns empty array for element not in analog domain', () => {
    const { coordinator } = buildAnalogCoordinator();
    const foreign = makeAnalogEl('Resistor', 'foreign', [{ x: 999, y: 999 }],
      new Map<string, PropertyValue>([['resistance', 100]]));
    expect(coordinator.getSliderProperties(foreign)).toEqual([]);
    coordinator.dispose();
  });

  it('returns non-empty array for analog resistor element', () => {
    const { coordinator, elements } = buildAnalogCoordinator();
    expect(coordinator.getSliderProperties(elements.r1).length).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it('descriptor has non-negative integer elementIndex', () => {
    const { coordinator, elements } = buildAnalogCoordinator();
    const d = coordinator.getSliderProperties(elements.r1)[0]!;
    expect(Number.isInteger(d.elementIndex)).toBe(true);
    expect(d.elementIndex).toBeGreaterThanOrEqual(0);
    coordinator.dispose();
  });

  it('descriptor for resistor includes resistance property', () => {
    const { coordinator, elements } = buildAnalogCoordinator();
    const rProp = coordinator.getSliderProperties(elements.r1).find(d => d.key === 'resistance');
    expect(rProp).toBeDefined();
    coordinator.dispose();
  });

  it('descriptor currentValue matches element property value', () => {
    const { coordinator, elements } = buildAnalogCoordinator();
    const rProp = coordinator.getSliderProperties(elements.r1).find(d => d.key === 'resistance')!;
    expect(rProp.currentValue).toBe(1000);
    coordinator.dispose();
  });

  it('descriptor has non-empty label', () => {
    const { coordinator, elements } = buildAnalogCoordinator();
    expect(coordinator.getSliderProperties(elements.r1)[0]!.label.length).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it('descriptor logScale is a boolean', () => {
    const { coordinator, elements } = buildAnalogCoordinator();
    expect(typeof coordinator.getSliderProperties(elements.r1)[0]!.logScale).toBe('boolean');
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.7 setComponentProperty
// ---------------------------------------------------------------------------

describe('setComponentProperty -- digital-only coordinator', () => {
  it('does not throw for any element', () => {
    const { coordinator, circuit } = buildDigitalCoordinator();
    expect(() => coordinator.setComponentProperty(circuit.elements[0]!, 'label', 42)).not.toThrow();
    coordinator.dispose();
  });
});

describe('setComponentProperty -- analog coordinator', () => {
  it('does not throw for resistor in analog domain', () => {
    const { coordinator, elements } = buildAnalogCoordinator();
    expect(() => coordinator.setComponentProperty(elements.r1, 'resistance', 2000)).not.toThrow();
    coordinator.dispose();
  });

  it('does not throw for foreign element not in analog domain', () => {
    const { coordinator } = buildAnalogCoordinator();
    const foreign = makeAnalogEl('Resistor', 'foreign', [{ x: 999, y: 999 }],
      new Map<string, PropertyValue>([['resistance', 100]]));
    expect(() => coordinator.setComponentProperty(foreign, 'resistance', 500)).not.toThrow();
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.8 readElementCurrent
// ---------------------------------------------------------------------------

describe('readElementCurrent -- digital-only coordinator', () => {
  it('returns null', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.readElementCurrent(0)).toBeNull();
    coordinator.dispose();
  });
});

describe('readElementCurrent -- analog coordinator', () => {
  it('returns finite number for element index 0', () => {
    const { coordinator } = buildAnalogCoordinator();
    const result = coordinator.readElementCurrent(0);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!)).toBe(true);
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.8 readBranchCurrent
// ---------------------------------------------------------------------------

describe('readBranchCurrent -- digital-only coordinator', () => {
  it('returns null', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.readBranchCurrent(0)).toBeNull();
    coordinator.dispose();
  });
});

describe('readBranchCurrent -- analog coordinator', () => {
  it('returns finite number for branch index 0 (voltage source branch)', () => {
    const { coordinator } = buildAnalogCoordinator();
    const result = coordinator.readBranchCurrent(0);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!)).toBe(true);
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.9 saveSnapshot / restoreSnapshot
// ---------------------------------------------------------------------------

describe('saveSnapshot -- digital coordinator', () => {
  it('returns a number', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(typeof coordinator.saveSnapshot()).toBe('number');
    coordinator.dispose();
  });

  it('successive calls return distinct IDs', () => {
    const { coordinator } = buildDigitalCoordinator();
    const id1 = coordinator.saveSnapshot();
    const id2 = coordinator.saveSnapshot();
    expect(id1).not.toBe(id2);
    coordinator.dispose();
  });
});

describe('restoreSnapshot -- digital coordinator', () => {
  it('does not throw for a valid snapshot id', () => {
    const { coordinator } = buildDigitalCoordinator();
    const id = coordinator.saveSnapshot();
    expect(() => coordinator.restoreSnapshot(id)).not.toThrow();
    coordinator.dispose();
  });

  it('state is preserved after save+step+restore', () => {
    const { coordinator } = buildDigitalCoordinator();
    coordinator.writeByLabel('A', { type: 'digital', value: 1 });
    coordinator.writeByLabel('B', { type: 'digital', value: 1 });
    coordinator.step();
    const before = coordinator.readByLabel('Y');
    const id = coordinator.saveSnapshot();
    coordinator.writeByLabel('A', { type: 'digital', value: 0 });
    coordinator.step();
    coordinator.restoreSnapshot(id);
    expect(coordinator.readByLabel('Y')).toEqual(before);
    coordinator.dispose();
  });
});

describe('saveSnapshot -- analog-only coordinator', () => {
  it('returns 0 (no digital backend)', () => {
    const { coordinator } = buildAnalogCoordinator();
    expect(coordinator.saveSnapshot()).toBe(0);
    coordinator.dispose();
  });
});

describe('restoreSnapshot -- analog-only coordinator', () => {
  it('does not throw for a valid snapshot id', () => {
    const { coordinator } = buildAnalogCoordinator();
    const id = coordinator.saveSnapshot();
    expect(() => coordinator.restoreSnapshot(id)).not.toThrow();
    coordinator.dispose();
  });
});
