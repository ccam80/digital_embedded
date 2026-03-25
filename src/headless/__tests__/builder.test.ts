import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBuilder } from '../builder.js';
import { ComponentRegistry } from '../../core/registry.js';
import type { CircuitElement } from '../../core/element.js';
import { PropertyBag } from '../../core/properties.js';
import type { PropertyValue } from '../../core/properties.js';
import type { Pin } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import { FacadeError } from '../types.js';

// Simple mock CircuitElement for testing
class MockCircuitElement implements CircuitElement {
  readonly typeId: string;
  readonly instanceId: string;
  position: { x: number; y: number };
  rotation: 0 | 1 | 2 | 3 = 0;
  mirror = false;
  private mockPins: Pin[];

  constructor(
    typeId: string,
    position: { x: number; y: number },
    pins: Pin[]
  ) {
    this.typeId = typeId;
    this.instanceId = `${typeId}-${Math.random().toString(36).substr(2, 9)}`;
    this.position = position;
    this.mockPins = pins;
  }

  getPins(): readonly Pin[] {
    return this.mockPins;
  }

  getProperties(): PropertyBag {
    return new PropertyBag();
  }

  draw(): void {}
  getBoundingBox() {
    return { x: this.position.x - 2, y: this.position.y - 2, width: 4, height: 4 };
  }
  serialize() {
    return {
      typeId: this.typeId,
      instanceId: this.instanceId,
      position: this.position,
      rotation: this.rotation,
      mirror: this.mirror,
      properties: {},
    };
  }
  getHelpText() {
    return '';
  }
  getAttribute(_name: string): PropertyValue | undefined {
    return this.getProperties().has(_name) ? this.getProperties().get(_name) : undefined;
  }
}

describe('CircuitBuilder', () => {
  let builder: CircuitBuilder;
  let registry: ComponentRegistry;

  beforeEach(() => {
    registry = new ComponentRegistry();

    // Register a simple mock component
    registry.register({
      name: 'Mock',
      typeId: -1,
      factory: (props: PropertyBag) => {
        const pos = props.has('position') ? (props.get('position') as number[]) : [0, 0];
        const position = { x: pos[0] ?? 0, y: pos[1] ?? 0 };
        const pins: Pin[] = [
          {
            label: 'in',
            direction: PinDirection.INPUT,
            position: { x: -2, y: 0 },
            bitWidth: 1,
            isNegated: false,
            isClock: false,
          },
          {
            label: 'out',
            direction: PinDirection.OUTPUT,
            position: { x: 2, y: 0 },
            bitWidth: 1,
            isNegated: false,
            isClock: false,
          },
        ];
        return new MockCircuitElement('Mock', position, pins);
      },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: 'LOGIC' as any,
      helpText: 'Mock',
      models: {
        digital: { executeFn: () => {} },
      },
    });

    // Register And gate mock
    registry.register({
      name: 'And',
      typeId: -1,
      factory: (props: PropertyBag) => {
        const pos = props.has('position') ? (props.get('position') as number[]) : [0, 0];
        const position = { x: pos[0] ?? 0, y: pos[1] ?? 0 };
        const pins: Pin[] = [
          {
            label: 'A',
            direction: PinDirection.INPUT,
            position: { x: -2, y: -1 },
            bitWidth: 1,
            isNegated: false,
            isClock: false,
          },
          {
            label: 'B',
            direction: PinDirection.INPUT,
            position: { x: -2, y: 1 },
            bitWidth: 1,
            isNegated: false,
            isClock: false,
          },
          {
            label: 'Y',
            direction: PinDirection.OUTPUT,
            position: { x: 2, y: 0 },
            bitWidth: 1,
            isNegated: false,
            isClock: false,
          },
        ];
        return new MockCircuitElement('And', position, pins);
      },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: 'LOGIC' as any,
      helpText: 'And',
      models: {
        digital: { executeFn: () => {} },
      },
    });

    builder = new CircuitBuilder(registry);
  });

  describe('createsEmptyCircuit', () => {
    it('createCircuit returns a Circuit with zero elements and zero wires', () => {
      const circuit = builder.createCircuit();
      expect(circuit.elements).toHaveLength(0);
      expect(circuit.wires).toHaveLength(0);
    });
  });

  describe('addsComponentByTypeName', () => {
    it('addComponent registers a mock component and adds it to circuit', () => {
      const circuit = builder.createCircuit();
      const element = builder.addComponent(circuit, 'Mock');

      expect(circuit.elements).toHaveLength(1);
      expect(element.typeId).toBe('Mock');
      expect(circuit.elements[0]).toBe(element);
    });
  });

  describe('autoPositionsSequentially', () => {
    it('add 3 components with auto-position, positions are (0,0), (0,4), (0,8)', () => {
      const circuit = builder.createCircuit();
      const el1 = builder.addComponent(circuit, 'Mock');
      const el2 = builder.addComponent(circuit, 'Mock');
      const el3 = builder.addComponent(circuit, 'Mock');

      expect(el1.position).toEqual({ x: 0, y: 0 });
      expect(el2.position).toEqual({ x: 0, y: 8 });
      expect(el3.position).toEqual({ x: 0, y: 16 });
    });
  });

  describe('connectsOutputToInput', () => {
    it('connect two components with output to input pins', () => {
      const circuit = builder.createCircuit();
      const el1 = builder.addComponent(circuit, 'Mock');
      const el2 = builder.addComponent(circuit, 'Mock');

      const wire = builder.connect(circuit, el1, 'out', el2, 'in');

      expect(circuit.wires).toHaveLength(1);
      expect(wire).toBeDefined();
      expect(wire.start).toEqual({ x: 2, y: 0 });
      expect(wire.end).toEqual({ x: -2, y: 8 });
    });
  });

  describe('rejectsUnknownType', () => {
    it('addComponent with unknown type throws FacadeError with suggestion', () => {
      const circuit = builder.createCircuit();

      expect(() => builder.addComponent(circuit, 'Andd')).toThrow(FacadeError);
      try {
        builder.addComponent(circuit, 'Andd');
      } catch (e) {
        const error = e as FacadeError;
        expect(error.message).toContain('Unknown component type');
        expect(error.message).toContain('And');
        expect(error.componentName).toBe('Andd');
      }
    });
  });

  describe('rejectsUnknownPin', () => {
    it('connect with bad pin label throws FacadeError listing valid pins', () => {
      const circuit = builder.createCircuit();
      const el1 = builder.addComponent(circuit, 'Mock');
      const el2 = builder.addComponent(circuit, 'Mock');

      expect(() => builder.connect(circuit, el1, 'badPin', el2, 'in')).toThrow(
        FacadeError
      );
      try {
        builder.connect(circuit, el1, 'badPin', el2, 'in');
      } catch (e) {
        const error = e as FacadeError;
        expect(error.message).toContain('badPin');
        expect(error.message).toContain('in');
        expect(error.message).toContain('out');
      }
    });
  });

  describe('rejectsBitWidthMismatch', () => {
    it('connect pins with different bit widths throws error', () => {
      registry.register({
        name: 'Wide',
        typeId: -1,
        factory: (props: PropertyBag) => {
          const pos = props.has('position') ? (props.get('position') as number[]) : [0, 0];
          const position = { x: pos[0] ?? 0, y: pos[1] ?? 0 };
          const pins: Pin[] = [
            {
              label: 'in',
              direction: PinDirection.INPUT,
              position: { x: -2, y: 0 },
              bitWidth: 8,
              isNegated: false,
              isClock: false,
            },
          ];
          return new MockCircuitElement('Wide', position, pins);
        },
        pinLayout: [],
        propertyDefs: [],
        attributeMap: [],
        category: 'LOGIC' as any,
        helpText: 'Wide',
        models: {
          digital: { executeFn: () => {} },
        },
      });

      const circuit = builder.createCircuit();
      const narrow = builder.addComponent(circuit, 'Mock'); // 1-bit output
      const wide = builder.addComponent(circuit, 'Wide'); // 8-bit input

      expect(() => builder.connect(circuit, narrow, 'out', wide, 'in')).toThrow(
        FacadeError
      );
    });
  });

  describe('rejectsInputToInput', () => {
    it('connect two input pins throws FacadeError', () => {
      const circuit = builder.createCircuit();
      const el1 = builder.addComponent(circuit, 'Mock');
      const el2 = builder.addComponent(circuit, 'Mock');

      expect(() => builder.connect(circuit, el1, 'in', el2, 'in')).toThrow(
        FacadeError
      );
    });
  });
});
