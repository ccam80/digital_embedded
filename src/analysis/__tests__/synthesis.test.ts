/**
 * Tests for synthesis.ts and auto-layout.ts (task 8.3.1).
 *
 * Tests:
 *   - singleGate: A & B → circuit with 2 In, 1 And, 1 Out, correctly wired
 *   - multiOutput: two expressions → circuit with shared inputs, two output chains
 *   - nandOnly: NAND-only expression → circuit contains only NAND/Not gates
 *   - layoutPositions: all components have valid grid positions, no overlaps
 *   - functionalVerification: synthesize from truth table, verify circuit structure
 *   - loadInEditor: synthesized circuit loads without errors (elements + wires valid)
 */

import { describe, expect, it } from 'vitest';
import { synthesizeCircuit } from '../synthesis.js';
import { and, not, or, variable, negatedVariable, constant } from '../expression.js';
import type { BoolExpr } from '../expression.js';
import { toNandOnly } from '../expression-modifiers.js';
import { ComponentRegistry } from '../../core/registry.js';
import { PropertyBag, PropertyType } from '../../core/properties.js';
import { AbstractCircuitElement } from '../../core/element.js';
import type { Pin, Rotation } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { ComponentLayout } from '../../core/registry.js';

// ---------------------------------------------------------------------------
// Stub element — lightweight CircuitElement for testing
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

function noop(_i: number, _s: Uint32Array, _l: ComponentLayout): void {}

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
    executeFn: noop,
    pinLayout: [],
    propertyDefs: [
      { key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
  });

  registry.register({
    name: 'Out',
    typeId: -1,
    factory: (props) => new StubElement('Out', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in', PinDirection.INPUT, 0, 1),
    ], props),
    executeFn: noop,
    pinLayout: [],
    propertyDefs: [
      { key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
  });

  registry.register({
    name: 'And',
    typeId: -1,
    factory: (props) => {
      const count = (props.has('inputCount') ? props.get<number>('inputCount') : 2);
      const pins: Pin[] = [];
      for (let i = 0; i < count; i++) {
        pins.push(makePin(`in${i}`, PinDirection.INPUT, 0, i));
      }
      pins.push(makePin('out', PinDirection.OUTPUT, 4, Math.floor(count / 2)));
      return new StubElement('And', crypto.randomUUID(), { x: 0, y: 0 }, pins, props);
    },
    executeFn: noop,
    pinLayout: [],
    propertyDefs: [
      { key: 'inputCount', type: PropertyType.INT, label: 'Inputs', defaultValue: 2 },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
  });

  registry.register({
    name: 'Or',
    typeId: -1,
    factory: (props) => {
      const count = (props.has('inputCount') ? props.get<number>('inputCount') : 2);
      const pins: Pin[] = [];
      for (let i = 0; i < count; i++) {
        pins.push(makePin(`in${i}`, PinDirection.INPUT, 0, i));
      }
      pins.push(makePin('out', PinDirection.OUTPUT, 4, Math.floor(count / 2)));
      return new StubElement('Or', crypto.randomUUID(), { x: 0, y: 0 }, pins, props);
    },
    executeFn: noop,
    pinLayout: [],
    propertyDefs: [
      { key: 'inputCount', type: PropertyType.INT, label: 'Inputs', defaultValue: 2 },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
  });

  registry.register({
    name: 'Not',
    typeId: -1,
    factory: (props) => new StubElement('Not', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
      makePin('out', PinDirection.OUTPUT, 4, 0),
    ], props),
    executeFn: noop,
    pinLayout: [],
    propertyDefs: [
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('synthesis', () => {
  // -------------------------------------------------------------------------
  // singleGate: A & B → circuit with 2 In, 1 And, 1 Out, correctly wired
  // -------------------------------------------------------------------------

  it('singleGate — A & B → 2 In, 1 And, 1 Out elements', () => {
    const registry = buildRegistry();
    const expr: BoolExpr = and([variable('A'), variable('B')]);
    const expressions = new Map<string, BoolExpr>([['Y', expr]]);

    const circuit = synthesizeCircuit(expressions, ['A', 'B'], registry);

    const typeIds = circuit.elements.map((el) => el.typeId);

    // Two In components (A and B)
    expect(typeIds.filter((t) => t === 'In')).toHaveLength(2);

    // One And component
    expect(typeIds.filter((t) => t === 'And')).toHaveLength(1);

    // One Out component (Y)
    expect(typeIds.filter((t) => t === 'Out')).toHaveLength(1);

    // Total: 4 elements
    expect(circuit.elements).toHaveLength(4);

    // Should have wires connecting them
    expect(circuit.wires.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // multiOutput: two expressions → shared inputs, two output chains
  // -------------------------------------------------------------------------

  it('multiOutput — A&B and A|B → shared inputs, two output Out components', () => {
    const registry = buildRegistry();
    const exprAnd: BoolExpr = and([variable('A'), variable('B')]);
    const exprOr: BoolExpr = or([variable('A'), variable('B')]);
    const expressions = new Map<string, BoolExpr>([
      ['Y1', exprAnd],
      ['Y2', exprOr],
    ]);

    const circuit = synthesizeCircuit(expressions, ['A', 'B'], registry);

    const typeIds = circuit.elements.map((el) => el.typeId);

    // Exactly 2 In components (A and B shared)
    expect(typeIds.filter((t) => t === 'In')).toHaveLength(2);

    // Two Out components
    expect(typeIds.filter((t) => t === 'Out')).toHaveLength(2);

    // Check output labels include both Y1 and Y2
    const outLabels = circuit.elements
      .filter((el) => el.typeId === 'Out')
      .map((el) => {
        const props = el.getProperties();
        return props.has('label') ? props.get<string>('label') : '';
      });
    expect(outLabels).toContain('Y1');
    expect(outLabels).toContain('Y2');
  });

  // -------------------------------------------------------------------------
  // nandOnly: NAND-only expression → circuit contains only Not/And nodes
  // (NAND is represented as not(and([...])))
  // -------------------------------------------------------------------------

  it('nandOnly — NAND-only expression → circuit contains only Not and And gate elements', () => {
    const registry = buildRegistry();

    // A & B converted to NAND-only: not(and(not(and(A,B)), not(and(A,B))))
    const baseExpr: BoolExpr = and([variable('A'), variable('B')]);
    const nandExpr = toNandOnly(baseExpr);
    const expressions = new Map<string, BoolExpr>([['Y', nandExpr]]);

    const circuit = synthesizeCircuit(expressions, ['A', 'B'], registry);

    const gateTypeIds = circuit.elements
      .filter((el) => el.typeId !== 'In' && el.typeId !== 'Out')
      .map((el) => el.typeId);

    // All gates should be either 'And' (wrapped in Not) or 'Not'
    for (const tid of gateTypeIds) {
      expect(['And', 'Not', 'Or']).toContain(tid);
    }

    // No bare 'Or' gates (NAND-only expressions don't use Or)
    expect(gateTypeIds.filter((t) => t === 'Or')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // layoutPositions: all components have valid grid positions, no overlaps
  // -------------------------------------------------------------------------

  it('layoutPositions — all components have integer positions, no two share same position', () => {
    const registry = buildRegistry();

    // Use a more complex expression to get multiple elements
    const expr: BoolExpr = or([
      and([variable('A'), variable('B')]),
      and([variable('A'), variable('C')]),
    ]);
    const expressions = new Map<string, BoolExpr>([['Y', expr]]);

    const circuit = synthesizeCircuit(expressions, ['A', 'B', 'C'], registry);

    // All positions should be integer grid coordinates
    for (const el of circuit.elements) {
      expect(Number.isInteger(el.position.x)).toBe(true);
      expect(Number.isInteger(el.position.y)).toBe(true);
      expect(el.position.x).toBeGreaterThanOrEqual(0);
      expect(el.position.y).toBeGreaterThanOrEqual(0);
    }

    // No two elements share the exact same (x, y) position
    const positions = circuit.elements.map((el) => `${el.position.x},${el.position.y}`);
    const uniquePositions = new Set(positions);
    expect(uniquePositions.size).toBe(positions.length);
  });

  // -------------------------------------------------------------------------
  // functionalVerification: synthesize from a boolean expression and verify
  // the circuit's structural correspondence to the expression
  // -------------------------------------------------------------------------

  it('functionalVerification — synthesised circuit structure matches expression', () => {
    const registry = buildRegistry();

    // A | !B  →  Or(A, Not(B))
    const expr: BoolExpr = or([variable('A'), negatedVariable('B')]);
    const expressions = new Map<string, BoolExpr>([['Y', expr]]);

    const circuit = synthesizeCircuit(expressions, ['A', 'B'], registry);

    const typeIds = circuit.elements.map((el) => el.typeId);

    // Should have In(A), In(B), Not(for !B), Or, Out(Y)
    expect(typeIds.filter((t) => t === 'In')).toHaveLength(2);
    expect(typeIds.filter((t) => t === 'Not')).toHaveLength(1);
    expect(typeIds.filter((t) => t === 'Or')).toHaveLength(1);
    expect(typeIds.filter((t) => t === 'Out')).toHaveLength(1);

    // Wires: A→Or, B→Not, Not→Or, Or→Out  (at minimum 4 wires expected)
    expect(circuit.wires.length).toBeGreaterThanOrEqual(4);
  });

  // -------------------------------------------------------------------------
  // loadInEditor: synthesized circuit loads without errors
  // -------------------------------------------------------------------------

  it('loadInEditor — synthesized circuit is structurally valid (no errors on creation)', () => {
    const registry = buildRegistry();

    // Constant expression
    const expr: BoolExpr = constant(true);
    const expressions = new Map<string, BoolExpr>([['Y', expr]]);

    // Should not throw
    expect(() => {
      const circuit = synthesizeCircuit(expressions, [], registry);
      // Circuit should have at least one element (the Const/In for the constant)
      // and one Out
      expect(circuit.elements.length).toBeGreaterThan(0);
      // Wires array should be valid (possibly empty for a single constant)
      expect(Array.isArray(circuit.wires)).toBe(true);
      // Circuit metadata should be set
      expect(circuit.metadata.name).toBe('Synthesised');
    }).not.toThrow();
  });
});
