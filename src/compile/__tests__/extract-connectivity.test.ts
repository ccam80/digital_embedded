/**
 * Tests for extractConnectivityGroups() and resolveModelAssignments().
 *
 * Uses minimal in-process circuit elements — no .dig parser, no full
 * component registry. Mirrors the pattern from compiler.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  extractConnectivityGroups,
  resolveModelAssignments,
  type ModelAssignment,
} from '../extract-connectivity.js';
import { Circuit, Wire } from '../../core/circuit.js';
import type { CircuitElement } from '../../core/element.js';
import type { Pin, PinDeclaration } from '../../core/pin.js';
import { PinDirection, resolvePins, createInverterConfig, createClockConfig } from '../../core/pin.js';
import { AbstractCircuitElement } from '../../core/element.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import { PropertyBag } from '../../core/properties.js';
import { ComponentRegistry } from '../../core/registry.js';
import type { ComponentDefinition, ComponentModels } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';

// ---------------------------------------------------------------------------
// Minimal test element
// ---------------------------------------------------------------------------

class TestElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pinDecls: PinDeclaration[],
    props?: PropertyBag,
    rotation: 0 | 1 | 2 | 3 = 0,
    mirror = false,
  ) {
    super(typeId, instanceId, position, rotation, mirror, props ?? new PropertyBag());
    this._pins = resolvePins(
      pinDecls,
      position,
      0,
      createInverterConfig([]),
      createClockConfig([]),
    );
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: this.position.x, y: this.position.y, width: 2, height: 2 }; }
}

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
  };
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

const noopExecFn = (() => {}) as unknown as ComponentDefinition['models']['digital'] extends { executeFn: infer F } ? F : never;

function makeBaseDef(name: string, models: ComponentModels): Omit<ComponentDefinition, 'typeId'> {
  return {
    name,
    typeId: -1,
    factory: (props: PropertyBag) => new TestElement(name, crypto.randomUUID(), { x: 0, y: 0 }, [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    models,
  };
}

function buildDigitalRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register(makeBaseDef('In',  { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('Out', { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('And', { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('Tunnel', { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('Port', {}) as ComponentDefinition);
  r.register(makeBaseDef('Ground', { mnaModels: { behavioral: {} } }) as ComponentDefinition);
  return r;
}

function buildAnalogRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register(makeBaseDef('Ground',   { mnaModels: { behavioral: {} } }) as ComponentDefinition);
  r.register(makeBaseDef('Resistor', { mnaModels: { behavioral: {} } }) as ComponentDefinition);
  r.register(makeBaseDef('Tunnel',   { mnaModels: { behavioral: {} } }) as ComponentDefinition);
  return r;
}

function buildMixedRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register(makeBaseDef('In',       { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('Out',      { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('And',      { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('Ground',   { mnaModels: { behavioral: {} } }) as ComponentDefinition);
  r.register(makeBaseDef('Resistor', { mnaModels: { behavioral: {} } }) as ComponentDefinition);
  r.register(makeBaseDef('Bridge',   { digital: { executeFn: noopExecFn }, mnaModels: { behavioral: {} } }) as ComponentDefinition);
  return r;
}

// ---------------------------------------------------------------------------
// resolveModelAssignments tests
// ---------------------------------------------------------------------------

describe('resolveModelAssignments', () => {
  it('assigns digital modelKey for digital-only components', () => {
    const registry = buildDigitalRegistry();
    const andEl = new TestElement('And', 'a1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const assignments = resolveModelAssignments([andEl], registry);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.modelKey).toBe('digital');
    expect(assignments[0]!.model).not.toBeNull();
  });

  it('assigns mna modelKey for analog-only components', () => {
    const registry = buildAnalogRegistry();
    const res = new TestElement('Resistor', 'r1', { x: 0, y: 0 }, [
      outputPin(0, 0, 'p1'), outputPin(2, 0, 'p2'),
    ]);
    const assignments = resolveModelAssignments([res], registry);
    expect(assignments[0]!.modelKey).toBe('behavioral');
  });

  it('assigns neutral for infrastructure types', () => {
    const registry = buildDigitalRegistry();
    const tunnel = new TestElement('Tunnel', 't1', { x: 0, y: 0 }, [outputPin(0, 0, 'p')]);
    const ground = new TestElement('Ground', 'g1', { x: 0, y: 0 }, [outputPin(0, 0, 'p')]);
    const assignments = resolveModelAssignments([tunnel, ground], registry);
    expect(assignments[0]!.modelKey).toBe('neutral');
    expect(assignments[1]!.modelKey).toBe('neutral');
  });

  it('uses simulationModel property when present', () => {
    const registry = buildMixedRegistry();
    // Bridge component has both digital and mna models; default is digital
    // Override via simulationModel property to behavioral mna model
    const props = new PropertyBag(new Map([['simulationModel', 'behavioral']]));
    const bridge = new TestElement('Bridge', 'b1', { x: 0, y: 0 }, [], props);
    const assignments = resolveModelAssignments([bridge], registry);
    expect(assignments[0]!.modelKey).toBe('behavioral');
  });

  it('falls back to defaultModel when no simulationModel property', () => {
    const registry = new ComponentRegistry();
    registry.register(makeBaseDef('Bridge', {
      digital: { executeFn: noopExecFn },
      mnaModels: { behavioral: {} },
    }, ) as ComponentDefinition);
    // defaultModel not set — first key is used
    const bridge = new TestElement('Bridge', 'b1', { x: 0, y: 0 }, []);
    const assignments = resolveModelAssignments([bridge], registry);
    // First key of { digital, mnaModels } is "digital"
    expect(assignments[0]!.modelKey).toBe('digital');
  });

  it('assigns neutral for unknown component types', () => {
    const registry = new ComponentRegistry();
    const unknown = new TestElement('NoSuchType', 'u1', { x: 0, y: 0 }, []);
    const assignments = resolveModelAssignments([unknown], registry);
    expect(assignments[0]!.modelKey).toBe('neutral');
    expect(assignments[0]!.model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups — pure digital circuit
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups — pure digital', () => {
  it('returns one group per disconnected pin when there are no wires', () => {
    const registry = buildDigitalRegistry();
    const el = new TestElement('And', 'a1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const elements: CircuitElement[] = [el];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    expect(groups).toHaveLength(3); // 3 pins, 0 wires, 0 connections
  });

  it('wires merge two pins into one group', () => {
    const registry = buildDigitalRegistry();
    // Out-component output at (2,0); In-component input at (2,0) — same position via wire
    const outEl = new TestElement('Out', 'o1', { x: 0, y: 0 }, [outputPin(2, 0, 'out')]);
    const inEl  = new TestElement('In',  'i1', { x: 2, y: 0 }, [inputPin(0, 0, 'in')]);
    // outEl pin world pos: element(0,0) + pin(2,0) = (2,0)
    // inEl  pin world pos: element(2,0) + pin(0,0) = (2,0) — same position

    const elements: CircuitElement[] = [outEl, inEl];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    // Both pins are at world position (2,0) → merged into one group
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pins).toHaveLength(2);
  });

  it('all groups have domains containing only "digital"', () => {
    const registry = buildDigitalRegistry();
    const andEl = new TestElement('And', 'a1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const elements: CircuitElement[] = [andEl];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    for (const group of groups) {
      expect(group.domains.has('digital')).toBe(true);
      expect(group.domains.has('analog')).toBe(false);
    }
  });

  it('wire connects two separated components', () => {
    const registry = buildDigitalRegistry();
    // And gate output at element(0,0)+pin(2,0) = (2,0)
    const andEl = new TestElement('And', 'a1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    // Out probe input at element(4,0)+pin(0,0) = (4,0)
    const probeEl = new TestElement('Out', 'p1', { x: 4, y: 0 }, [inputPin(0, 0, 'in')]);

    const wire = new Wire({ x: 2, y: 0 }, { x: 4, y: 0 });

    const elements: CircuitElement[] = [andEl, probeEl];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [wire], registry, assignments);

    expect(diags).toHaveLength(0);

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
    registry.register(makeBaseDef('WideOut', { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
    registry.register(makeBaseDef('NarrowIn', { digital: { executeFn: noopExecFn } }) as ComponentDefinition);

    // 4-bit output at (2,0), 1-bit input at (2,0) — same position
    const wideEl   = new TestElement('WideOut',   'w1', { x: 0, y: 0 }, [outputPin(2, 0, 'out', 4)]);
    const narrowEl = new TestElement('NarrowIn',  'n1', { x: 2, y: 0 }, [inputPin(0, 0, 'in', 1)]);

    const elements: CircuitElement[] = [wideEl, narrowEl];
    const assignments = resolveModelAssignments(elements, registry);
    const [_groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    const widthDiags = diags.filter((d) => d.code === 'width-mismatch');
    expect(widthDiags).toHaveLength(1);
    expect(widthDiags[0]!.severity).toBe('error');
  });

  it('no diagnostic when all digital pins in group agree on bit width', () => {
    const registry = buildDigitalRegistry();
    const outEl = new TestElement('Out', 'o1', { x: 0, y: 0 }, [outputPin(2, 0, 'out', 4)]);
    const inEl  = new TestElement('In',  'i1', { x: 2, y: 0 }, [inputPin(0, 0, 'in', 4)]);

    const elements: CircuitElement[] = [outEl, inEl];
    const assignments = resolveModelAssignments(elements, registry);
    const [_groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags.filter((d) => d.code === 'width-mismatch')).toHaveLength(0);
  });

  it('bit width is set on group when all digital pins agree', () => {
    const registry = buildDigitalRegistry();
    const outEl = new TestElement('Out', 'o1', { x: 0, y: 0 }, [outputPin(2, 0, 'out', 8)]);
    const inEl  = new TestElement('In',  'i1', { x: 2, y: 0 }, [inputPin(0, 0, 'in', 8)]);

    const elements: CircuitElement[] = [outEl, inEl];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    const merged = groups.find((g) => g.pins.length === 2);
    expect(merged).toBeDefined();
    expect(merged!.bitWidth).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups — Tunnel merging
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups — Tunnel merging', () => {
  it('tunnels with same label are merged even without a wire', () => {
    const registry = buildDigitalRegistry();

    // Two Tunnel elements with label "clk", physically far apart
    const propsA = new PropertyBag(new Map([['label', 'clk']]));
    const propsB = new PropertyBag(new Map([['label', 'clk']]));
    const tA = new TestElement('Tunnel', 'tA', { x: 0, y: 0 }, [outputPin(0, 0, 'p')], propsA);
    const tB = new TestElement('Tunnel', 'tB', { x: 100, y: 0 }, [outputPin(0, 0, 'p')], propsB);

    const elements: CircuitElement[] = [tA, tB];
    const assignments = resolveModelAssignments(elements, registry);
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
    const tA = new TestElement('Tunnel', 'tA', { x: 0,  y: 0 }, [outputPin(0, 0, 'p')], propsA);
    const tB = new TestElement('Tunnel', 'tB', { x: 10, y: 0 }, [outputPin(0, 0, 'p')], propsB);

    const elements: CircuitElement[] = [tA, tB];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(groups).toHaveLength(2);
  });

  it('Tunnel uses NetName property (analog convention) when present', () => {
    const registry = buildAnalogRegistry();

    const propsA = new PropertyBag(new Map([['NetName', 'vcc']]));
    const propsB = new PropertyBag(new Map([['NetName', 'vcc']]));
    const tA = new TestElement('Tunnel', 'tA', { x: 0,   y: 0 }, [outputPin(0, 0, 'p')], propsA);
    const tB = new TestElement('Tunnel', 'tB', { x: 200, y: 0 }, [outputPin(0, 0, 'p')], propsB);

    const elements: CircuitElement[] = [tA, tB];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    expect(groups).toHaveLength(1);
  });

  it('Tunnel with no label is not merged with anything', () => {
    const registry = buildDigitalRegistry();

    const tA = new TestElement('Tunnel', 'tA', { x: 0, y: 0 }, [outputPin(0, 0, 'p')]);
    const tB = new TestElement('Tunnel', 'tB', { x: 5, y: 0 }, [outputPin(0, 0, 'p')]);

    const elements: CircuitElement[] = [tA, tB];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    // Both tunnels have no label — they stay separate
    expect(groups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups — Port label-merge
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups — Port label-merge', () => {
  it('Ports with same label are merged into one group', () => {
    const registry = buildDigitalRegistry();

    const propsA = new PropertyBag(new Map([['label', 'sig']]));
    const propsB = new PropertyBag(new Map([['label', 'sig']]));
    const pA = new TestElement('Port', 'pA', { x: 0, y: 0 }, [bidiPin(0, 0, 'port')], propsA);
    const pB = new TestElement('Port', 'pB', { x: 100, y: 0 }, [bidiPin(0, 0, 'port')], propsB);

    const elements: CircuitElement[] = [pA, pB];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pins).toHaveLength(2);
  });

  it('Ports with different labels stay separate', () => {
    const registry = buildDigitalRegistry();

    const propsA = new PropertyBag(new Map([['label', 'A']]));
    const propsB = new PropertyBag(new Map([['label', 'B']]));
    const pA = new TestElement('Port', 'pA', { x: 0, y: 0 }, [bidiPin(0, 0, 'port')], propsA);
    const pB = new TestElement('Port', 'pB', { x: 10, y: 0 }, [bidiPin(0, 0, 'port')], propsB);

    const elements: CircuitElement[] = [pA, pB];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(groups).toHaveLength(2);
  });

  it('Port with no label is not merged', () => {
    const registry = buildDigitalRegistry();

    const pA = new TestElement('Port', 'pA', { x: 0, y: 0 }, [bidiPin(0, 0, 'port')]);
    const pB = new TestElement('Port', 'pB', { x: 5, y: 0 }, [bidiPin(0, 0, 'port')]);

    const elements: CircuitElement[] = [pA, pB];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(groups).toHaveLength(2);
  });

  it('Port and Tunnel with same label are merged', () => {
    const registry = buildDigitalRegistry();

    const portProps = new PropertyBag(new Map([['label', 'net1']]));
    const tunProps = new PropertyBag(new Map([['label', 'net1']]));
    const port = new TestElement('Port', 'p1', { x: 0, y: 0 }, [bidiPin(0, 0, 'port')], portProps);
    const tunnel = new TestElement('Tunnel', 't1', { x: 50, y: 0 }, [outputPin(0, 0, 'p')], tunProps);

    const elements: CircuitElement[] = [port, tunnel];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pins).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups — pure analog circuit
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups — pure analog', () => {
  it('all groups have domains containing only "analog"', () => {
    const registry = buildAnalogRegistry();
    const r1 = new TestElement('Resistor', 'r1', { x: 0, y: 0 }, [
      outputPin(0, 0, 'p1'), outputPin(2, 0, 'p2'),
    ]);
    const elements: CircuitElement[] = [r1];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    for (const group of groups) {
      expect(group.domains.has('analog')).toBe(true);
      expect(group.domains.has('digital')).toBe(false);
    }
  });

  it('no width-mismatch diagnostic for analog circuits regardless of bitWidth values', () => {
    const registry = buildAnalogRegistry();
    // Two analog pins at the same position with different bitWidths —
    // width-mismatch only applies to digital pins
    const r1 = new TestElement('Resistor', 'r1', { x: 0, y: 0 }, [
      { ...outputPin(2, 0, 'p1', 4), direction: PinDirection.BIDIRECTIONAL },
    ]);
    const r2 = new TestElement('Resistor', 'r2', { x: 2, y: 0 }, [
      { ...inputPin(0, 0, 'p2', 1), direction: PinDirection.BIDIRECTIONAL },
    ]);
    const elements: CircuitElement[] = [r1, r2];
    const assignments = resolveModelAssignments(elements, registry);
    const [_groups, diags] = extractConnectivityGroups(elements, [], registry, assignments);

    expect(diags.filter((d) => d.code === 'width-mismatch')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups — mixed circuit
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups — mixed circuit', () => {
  it('boundary groups have domains.size > 1', () => {
    const registry = buildMixedRegistry();

    // Digital And gate output at (2,0); analog Resistor pin at (2,0) — boundary
    const andEl = new TestElement('And', 'a1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const resEl = new TestElement('Resistor', 'r1', { x: 2, y: 0 }, [
      outputPin(0, 0, 'p1'), outputPin(2, 0, 'p2'),
    ]);

    const elements: CircuitElement[] = [andEl, resEl];
    const assignments = resolveModelAssignments(elements, registry);
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

    const andEl = new TestElement('And', 'a1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const resEl = new TestElement('Resistor', 'r1', { x: 10, y: 0 }, [
      outputPin(0, 0, 'p1'), outputPin(2, 0, 'p2'),
    ]);

    const elements: CircuitElement[] = [andEl, resEl];
    const assignments = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    const digitalOnlyGroups = groups.filter(
      (g) => g.domains.has('digital') && !g.domains.has('analog'),
    );
    expect(digitalOnlyGroups.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// extractConnectivityGroups — empty circuit
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups — empty circuit', () => {
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
// extractConnectivityGroups — group metadata
// ---------------------------------------------------------------------------

describe('extractConnectivityGroups — group metadata', () => {
  it('groupId is a unique sequential integer starting from 0', () => {
    const registry = buildDigitalRegistry();
    const andEl = new TestElement('And', 'a1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const [groups] = extractConnectivityGroups([andEl], [], registry,
      resolveModelAssignments([andEl], registry));

    const ids = groups.map((g) => g.groupId).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(i);
    }
  });

  it('every pin appears in exactly one group', () => {
    const registry = buildDigitalRegistry();
    const andEl = new TestElement('And', 'a1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const probeEl = new TestElement('Out', 'p1', { x: 4, y: 0 }, [inputPin(0, 0, 'in')]);
    const wire = new Wire({ x: 2, y: 0 }, { x: 4, y: 0 });

    const elements: CircuitElement[] = [andEl, probeEl];
    const assignments = resolveModelAssignments(elements, registry);
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
    const groundEl = new TestElement('Ground', 'g1', { x: 0, y: 0 }, [outputPin(0, 0, 'gnd')]);
    const andEl    = new TestElement('And',    'a1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'A'), outputPin(2, 0, 'out'),
    ]);

    const elements: CircuitElement[] = [groundEl, andEl];
    const assignments = resolveModelAssignments(elements, registry);
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
