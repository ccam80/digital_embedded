/**
 * Tests for extractConnectivityGroups() and resolveModelAssignments().
 *
 * Uses minimal in-process circuit elements- no .dig parser, no full
 * component registry. Mirrors the pattern from compiler.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  extractConnectivityGroups,
  resolveModelAssignments,
} from '../extract-connectivity.js';
import { Wire } from '../../core/circuit.js';
import type { CircuitElement } from '../../core/element.js';
import type { PinDeclaration } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import { PropertyBag } from '../../core/properties.js';
import { ComponentRegistry } from '../../core/registry.js';
import type { StandaloneComponentDefinition, ComponentModels } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import { createTestElementFromDecls } from '../../test-fixtures/test-element.js';
import { noopExecFn } from '../../test-fixtures/execute-stubs.js';

// ---------------------------------------------------------------------------
// Minimal test element
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// Pin declaration helpers
// ---------------------------------------------------------------------------

function inputPin(x: number, y: number, label: string, bitWidth = 1): PinDeclaration {
  return {
    direction: PinDirection.INPUT,
    label,
    defaultBitWidth: bitWidth,
    position: { x, y },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };
}

function outputPin(x: number, y: number, label: string, bitWidth = 1): PinDeclaration {
  return {
    direction: PinDirection.OUTPUT,
    label,
    defaultBitWidth: bitWidth,
    position: { x, y },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };
}

function bidiPin(x: number, y: number, label: string, bitWidth = 1): PinDeclaration {
  return {
    direction: PinDirection.BIDIRECTIONAL,
    label,
    defaultBitWidth: bitWidth,
    position: { x, y },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function makeBaseDef(name: string, models: object, defaultModel?: string): StandaloneComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (props: PropertyBag) => createTestElementFromDecls(name, crypto.randomUUID(), [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    models: models as ComponentModels,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  };
}

function buildDigitalRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register(makeBaseDef('In',  { digital: { executeFn: noopExecFn } }));
  r.register(makeBaseDef('Out', { digital: { executeFn: noopExecFn } }));
  r.register(makeBaseDef('And', { digital: { executeFn: noopExecFn } }));
  r.register(makeBaseDef('Tunnel', { digital: { executeFn: noopExecFn } }));
  r.register(makeBaseDef('Port', {}));
  r.register(makeBaseDef('Ground', {}));
  return r;
}

function buildAnalogRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register(makeBaseDef('Ground',   {}, 'behavioral'));
  r.register(makeBaseDef('Resistor', {}, 'behavioral'));
  r.register(makeBaseDef('Tunnel',   {}, 'behavioral'));
  return r;
}

function buildMixedRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register(makeBaseDef('In',       { digital: { executeFn: noopExecFn } }));
  r.register(makeBaseDef('Out',      { digital: { executeFn: noopExecFn } }));
  r.register(makeBaseDef('And',      { digital: { executeFn: noopExecFn } }));
  r.register(makeBaseDef('Ground',   {}, 'behavioral'));
  r.register(makeBaseDef('Resistor', {}, 'behavioral'));
  r.register(makeBaseDef('Bridge',   { digital: { executeFn: noopExecFn } }, 'behavioral'));
  return r;
}

// ---------------------------------------------------------------------------
// resolveModelAssignments tests
// ---------------------------------------------------------------------------

describe('resolveModelAssignments', () => {
  it('assigns digital modelKey for digital-only components', () => {
    const registry = buildDigitalRegistry();
    const andEl = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const [assignments] = resolveModelAssignments([andEl], registry);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.modelKey).toBe('digital');
    expect(assignments[0]!.model).not.toBeNull();
  });

  it('assigns mna modelKey for analog-only components', () => {
    const registry = buildAnalogRegistry();
    const res = createTestElementFromDecls('Resistor', 'r1', [
      outputPin(0, 0, 'p1'), outputPin(2, 0, 'p2'),
    ]);
    const [assignments] = resolveModelAssignments([res], registry);
    expect(assignments[0]!.modelKey).toBe('behavioral');
  });

  it('assigns neutral for infrastructure types', () => {
    const registry = buildDigitalRegistry();
    const tunnel = createTestElementFromDecls('Tunnel', 't1', [outputPin(0, 0, 'p')]);
    const ground = createTestElementFromDecls('Ground', 'g1', [outputPin(0, 0, 'p')]);
    const [assignments] = resolveModelAssignments([tunnel, ground], registry);
    expect(assignments[0]!.modelKey).toBe('neutral');
    expect(assignments[1]!.modelKey).toBe('neutral');
  });

  it('uses model property when present', () => {
    const registry = buildMixedRegistry();
    const props = new PropertyBag(new Map([['model', 'behavioral']]));
    const bridge = createTestElementFromDecls('Bridge', 'b1', [], props);
    const [assignments] = resolveModelAssignments([bridge], registry);
    expect(assignments[0]!.modelKey).toBe('behavioral');
  });

  it('falls back to defaultModel when no model property', () => {
    const registry = new ComponentRegistry();
    registry.register(makeBaseDef('Bridge', {
      digital: { executeFn: noopExecFn },
    }, 'digital'));
    const bridge = createTestElementFromDecls('Bridge', 'b1', []);
    const [assignments] = resolveModelAssignments([bridge], registry);
    expect(assignments[0]!.modelKey).toBe('digital');
  });

  it('assigns neutral for unknown component types', () => {
    const registry = new ComponentRegistry();
    const unknown = createTestElementFromDecls('NoSuchType', 'u1', []);
    const [assignments] = resolveModelAssignments([unknown], registry);
    expect(assignments[0]!.modelKey).toBe('neutral');
    expect(assignments[0]!.model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups- pure digital circuit
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups- pure digital', () => {
  it('returns one group per disconnected pin when there are no wires', () => {
    const registry = buildDigitalRegistry();
    const el = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const elements: CircuitElement[] = [el];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    // Unconnected-input warnings are emitted for the 2 disconnected input pins (A, B)
    expect(diags.filter((d) => d.code !== 'unconnected-input')).toHaveLength(0);
    expect(groups).toHaveLength(3); // 3 pins, 0 wires, 0 connections
  });

  it('wires merge two pins into one group', () => {
    const registry = buildDigitalRegistry();
    // Out-component output at (2,0); In-component input at (2,0)- same position via wire
    const outEl = createTestElementFromDecls('Out', 'o1', [outputPin(2, 0, 'out')]);
    const inEl  = createTestElementFromDecls('In', 'i1', [inputPin(0, 0, 'in')], undefined, { x: 2, y: 0 });
    // outEl pin world pos: element(0,0) + pin(2,0) = (2,0)
    // inEl  pin world pos: element(2,0) + pin(0,0) = (2,0)- same position

    const elements: CircuitElement[] = [outEl, inEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    // Both pins are at world position (2,0) → merged into one group
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pins).toHaveLength(2);
  });

  it('all groups have domains containing only "digital"', () => {
    const registry = buildDigitalRegistry();
    const andEl = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const elements: CircuitElement[] = [andEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    for (const group of groups) {
      expect(group.domains.has('digital')).toBe(true);
      expect(group.domains.has('analog')).toBe(false);
    }
  });

  it('wire connects two separated components', () => {
    const registry = buildDigitalRegistry();
    // And gate output at element(0,0)+pin(2,0) = (2,0)
    const andEl = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    // Out probe input at element(4,0)+pin(0,0) = (4,0)
    const probeEl = createTestElementFromDecls('Out', 'p1', [inputPin(0, 0, 'in')], undefined, { x: 4, y: 0 });

    const wire = new Wire({ x: 2, y: 0 }, { x: 4, y: 0 });

    const elements: CircuitElement[] = [andEl, probeEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [wire], registry, assignments);

    // Unconnected-input warnings for And gate inputs A and B (disconnected)
    expect(diags.filter((d) => d.code !== 'unconnected-input')).toHaveLength(0);

    // And gate: A(0,0), B(0,1) = 2 groups; out(2,0)+probeIn(4,0)+wire = 1 group
    // Total: 3 groups
    expect(groups).toHaveLength(3);

    // Find the group containing the And gate output
    const outGroup = groups.find((g) =>
      g.pins.some((p) => p.pinLabel === 'out') &&
      g.pins.some((p) => p.pinLabel === 'in'),
    );
    expect(outGroup).toBeDefined();
    expect(outGroup!.wires).toHaveLength(1);
    expect(outGroup!.wires[0]).toBe(wire);
  });

  it('width mismatch diagnostic emitted when digital pins disagree', () => {
    const registry = new ComponentRegistry();
    registry.register(makeBaseDef('WideOut', { digital: { executeFn: noopExecFn } }));
    registry.register(makeBaseDef('NarrowIn', { digital: { executeFn: noopExecFn } }));

    // 4-bit output at (2,0), 1-bit input at (2,0)- same position
    const wideEl   = createTestElementFromDecls('WideOut', 'w1', [outputPin(2, 0, 'out', 4)]);
    const narrowEl = createTestElementFromDecls('NarrowIn', 'n1', [inputPin(0, 0, 'in', 1)], undefined, { x: 2, y: 0 });

    const elements: CircuitElement[] = [wideEl, narrowEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [_groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    const widthDiags = diags.filter((d) => d.code === 'width-mismatch');
    expect(widthDiags).toHaveLength(1);
    expect(widthDiags[0]!.severity).toBe('error');
  });

  it('no diagnostic when all digital pins in group agree on bit width', () => {
    const registry = buildDigitalRegistry();
    const outEl = createTestElementFromDecls('Out', 'o1', [outputPin(2, 0, 'out', 4)]);
    const inEl  = createTestElementFromDecls('In', 'i1', [inputPin(0, 0, 'in', 4)], undefined, { x: 2, y: 0 });

    const elements: CircuitElement[] = [outEl, inEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [_groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags.filter((d) => d.code === 'width-mismatch')).toHaveLength(0);
  });

  it('bit width is set on group when all digital pins agree', () => {
    const registry = buildDigitalRegistry();
    const outEl = createTestElementFromDecls('Out', 'o1', [outputPin(2, 0, 'out', 8)]);
    const inEl  = createTestElementFromDecls('In', 'i1', [inputPin(0, 0, 'in', 8)], undefined, { x: 2, y: 0 });

    const elements: CircuitElement[] = [outEl, inEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    const merged = groups.find((g) => g.pins.length === 2);
    expect(merged).toBeDefined();
    expect(merged!.bitWidth).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups- Tunnel merging
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups- Tunnel merging', () => {
  it('tunnels with same label are merged even without a wire', () => {
    const registry = buildDigitalRegistry();

    // Two Tunnel elements with label "clk", physically far apart
    const propsA = new PropertyBag(new Map([['label', 'clk']]));
    const propsB = new PropertyBag(new Map([['label', 'clk']]));
    const tA = createTestElementFromDecls('Tunnel', 'tA', [outputPin(0, 0, 'p')], propsA);
    const tB = createTestElementFromDecls('Tunnel', 'tB', [outputPin(0, 0, 'p')], propsB, { x: 100, y: 0 });

    const elements: CircuitElement[] = [tA, tB];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    // Both Tunnel pins are at different world positions but share label → merged
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pins).toHaveLength(2);
  });

  it('tunnels with different labels stay separate', () => {
    const registry = buildDigitalRegistry();

    const propsA = new PropertyBag(new Map([['label', 'clk']]));
    const propsB = new PropertyBag(new Map([['label', 'data']]));
    const tA = createTestElementFromDecls('Tunnel', 'tA', [outputPin(0, 0, 'p')], propsA);
    const tB = createTestElementFromDecls('Tunnel', 'tB', [outputPin(0, 0, 'p')], propsB, { x: 10, y: 0 });

    const elements: CircuitElement[] = [tA, tB];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(groups).toHaveLength(2);
  });

  it('Tunnel uses NetName property (analog convention) when present', () => {
    const registry = buildAnalogRegistry();

    const propsA = new PropertyBag(new Map([['NetName', 'vcc']]));
    const propsB = new PropertyBag(new Map([['NetName', 'vcc']]));
    const tA = createTestElementFromDecls('Tunnel', 'tA', [outputPin(0, 0, 'p')], propsA);
    const tB = createTestElementFromDecls('Tunnel', 'tB', [outputPin(0, 0, 'p')], propsB, { x: 200, y: 0 });

    const elements: CircuitElement[] = [tA, tB];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    expect(groups).toHaveLength(1);
  });

  it('Tunnel with no label is not merged with anything', () => {
    const registry = buildDigitalRegistry();

    const tA = createTestElementFromDecls('Tunnel', 'tA', [outputPin(0, 0, 'p')]);
    const tB = createTestElementFromDecls('Tunnel', 'tB', [outputPin(0, 0, 'p')], undefined, { x: 5, y: 0 });

    const elements: CircuitElement[] = [tA, tB];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    // Both tunnels have no label- they stay separate
    expect(groups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups- Port label-merge
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups- Port label-merge', () => {
  it('Ports with same label are merged into one group', () => {
    const registry = buildDigitalRegistry();

    const propsA = new PropertyBag(new Map([['label', 'sig']]));
    const propsB = new PropertyBag(new Map([['label', 'sig']]));
    const pA = createTestElementFromDecls('Port', 'pA', [bidiPin(0, 0, 'port')], propsA);
    const pB = createTestElementFromDecls('Port', 'pB', [bidiPin(0, 0, 'port')], propsB, { x: 100, y: 0 });

    const elements: CircuitElement[] = [pA, pB];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pins).toHaveLength(2);
  });

  it('Ports with different labels stay separate', () => {
    const registry = buildDigitalRegistry();

    const propsA = new PropertyBag(new Map([['label', 'A']]));
    const propsB = new PropertyBag(new Map([['label', 'B']]));
    const pA = createTestElementFromDecls('Port', 'pA', [bidiPin(0, 0, 'port')], propsA);
    const pB = createTestElementFromDecls('Port', 'pB', [bidiPin(0, 0, 'port')], propsB, { x: 10, y: 0 });

    const elements: CircuitElement[] = [pA, pB];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(groups).toHaveLength(2);
  });

  it('Port with no label is not merged', () => {
    const registry = buildDigitalRegistry();

    const pA = createTestElementFromDecls('Port', 'pA', [bidiPin(0, 0, 'port')]);
    const pB = createTestElementFromDecls('Port', 'pB', [bidiPin(0, 0, 'port')], undefined, { x: 5, y: 0 });

    const elements: CircuitElement[] = [pA, pB];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(groups).toHaveLength(2);
  });

  it('Port and Tunnel with same label are merged', () => {
    const registry = buildDigitalRegistry();

    const portProps = new PropertyBag(new Map([['label', 'net1']]));
    const tunProps = new PropertyBag(new Map([['label', 'net1']]));
    const port = createTestElementFromDecls('Port', 'p1', [bidiPin(0, 0, 'port')], portProps);
    const tunnel = createTestElementFromDecls('Tunnel', 't1', [outputPin(0, 0, 'p')], tunProps, { x: 50, y: 0 });

    const elements: CircuitElement[] = [port, tunnel];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pins).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups- pure analog circuit
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups- pure analog', () => {
  it('all groups have domains containing only "analog"', () => {
    const registry = buildAnalogRegistry();
    const r1 = createTestElementFromDecls('Resistor', 'r1', [
      outputPin(0, 0, 'p1'), outputPin(2, 0, 'p2'),
    ]);
    const elements: CircuitElement[] = [r1];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    for (const group of groups) {
      expect(group.domains.has('analog')).toBe(true);
      expect(group.domains.has('digital')).toBe(false);
    }
  });

  it('no width-mismatch diagnostic for analog circuits regardless of bitWidth values', () => {
    const registry = buildAnalogRegistry();
    // Two analog pins at the same position with different bitWidths-
    // width-mismatch only applies to digital pins
    const r1 = createTestElementFromDecls('Resistor', 'r1', [
      { ...outputPin(2, 0, 'p1', 4), direction: PinDirection.BIDIRECTIONAL },
    ]);
    const r2 = createTestElementFromDecls('Resistor', 'r2', [
      { ...inputPin(0, 0, 'p2', 1), direction: PinDirection.BIDIRECTIONAL },
    ], undefined, { x: 2, y: 0 });
    const elements: CircuitElement[] = [r1, r2];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [_groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags.filter((d) => d.code === 'width-mismatch')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups- mixed circuit
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups- mixed circuit', () => {
  it('boundary groups have domains.size > 1', () => {
    const registry = buildMixedRegistry();

    // Digital And gate output at (2,0); analog Resistor pin at (2,0)- boundary
    const andEl = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const resEl = createTestElementFromDecls('Resistor', 'r1', [
      outputPin(0, 0, 'p1'), outputPin(2, 0, 'p2'),
    ], undefined, { x: 2, y: 0 });

    const elements: CircuitElement[] = [andEl, resEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    // The group at (2,0) should have both digital and analog domains
    const boundaryGroups = groups.filter((g) => g.domains.size > 1);
    expect(boundaryGroups.length).toBeGreaterThanOrEqual(1);
    const boundary = boundaryGroups[0]!;
    expect(boundary.domains.has('digital')).toBe(true);
    expect(boundary.domains.has('analog')).toBe(true);
  });

  it('pure digital groups have only digital domain', () => {
    const registry = buildMixedRegistry();

    const andEl = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const resEl = createTestElementFromDecls('Resistor', 'r1', [
      outputPin(0, 0, 'p1'), outputPin(2, 0, 'p2'),
    ], undefined, { x: 10, y: 0 });

    const elements: CircuitElement[] = [andEl, resEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    const digitalOnlyGroups = groups.filter(
      (g) => g.domains.has('digital') && !g.domains.has('analog'),
    );
    expect(digitalOnlyGroups.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups- empty circuit
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups- empty circuit', () => {
  it('returns empty groups and no diagnostics for empty circuit', () => {
    const registry = buildDigitalRegistry();
    const [groups, diags] = extractConnectivityGroups([], [], registry, []);
    expect(groups).toHaveLength(0);
    expect(diags).toHaveLength(0);
  });

  it('returns empty groups for circuit with only wires (no elements)', () => {
    const registry = buildDigitalRegistry();
    const wire = new Wire({ x: 0, y: 0 }, { x: 1, y: 0 });
    const [groups, diags] = extractConnectivityGroups([], [wire], registry, []);
    expect(groups).toHaveLength(0);
    expect(diags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups- group metadata
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups- group metadata', () => {
  it('groupId is a unique sequential integer starting from 0', () => {
    const registry = buildDigitalRegistry();
    const andEl = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const [groups] = extractConnectivityGroups([andEl], [], registry,
      resolveModelAssignments([andEl], registry)[0]);

    const ids = groups.map((g) => g.groupId).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(i);
    }
  });

  it('every pin appears in exactly one group', () => {
    const registry = buildDigitalRegistry();
    const andEl = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const probeEl = createTestElementFromDecls('Out', 'p1', [inputPin(0, 0, 'in')], undefined, { x: 4, y: 0 });
    const wire = new Wire({ x: 2, y: 0 }, { x: 4, y: 0 });

    const elements: CircuitElement[] = [andEl, probeEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [wire], registry, assignments);

    // Total pins across all elements
    const totalPins = elements.reduce((sum, el) => sum + el.getPins().length, 0);

    // Sum of pins in all groups should equal totalPins
    const groupPinTotal = groups.reduce((sum, g) => sum + g.pins.length, 0);
    expect(groupPinTotal).toBe(totalPins);
  });

  it('neutral-domain pins (infrastructure) do not contribute to domains set', () => {
    const registry = buildDigitalRegistry();
    // Ground is neutral; And gate is digital
    // Ground pin at (0,0), And gate input at (0,0) → they share a position
    const groundEl = createTestElementFromDecls('Ground', 'g1', [outputPin(0, 0, 'gnd')]);
    const andEl    = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), outputPin(2, 0, 'out'),
    ]);

    const elements: CircuitElement[] = [groundEl, andEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    // The group containing Ground pin (neutral) and And input (digital)
    const sharedGroup = groups.find((g) => g.pins.length === 2);
    expect(sharedGroup).toBeDefined();
    // Neutral domain should NOT appear in domains set
    expect(sharedGroup!.domains.has('neutral')).toBe(false);
    // Digital domain should appear (from the And gate input)
    expect(sharedGroup!.domains.has('digital')).toBe(true);
  });
});
