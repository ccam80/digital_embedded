/**
 * Tests for stableNetId() helper and resolveLoadingOverrides().
 *
 * Uses minimal in-process circuit elements — no .dig parser, no full
 * component registry. Mirrors the pattern from extract-connectivity.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  stableNetId,
  resolveLoadingOverrides,
  extractConnectivityGroups,
  resolveModelAssignments,
  type PinLoadingOverride,
} from '../extract-connectivity.js';
import { Wire } from '../../core/circuit.js';
import type { CircuitElement } from '../../core/element.js';
import type { Pin, PinDeclaration } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import { PropertyBag } from '../../core/properties.js';
import { ComponentRegistry } from '../../core/registry.js';
import type { ComponentDefinition, ComponentModels } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { ConnectivityGroup } from '../types.js';
import { createTestElementFromDecls } from '../../test-fixtures/test-element.js';
import { noopExecFn } from '../../test-fixtures/execute-stubs.js';

// ---------------------------------------------------------------------------
// Minimal test element
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// Pin declaration helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

const noopExecFn = (() => {}) as unknown as ComponentDefinition['models']['digital'] extends { executeFn: infer F } ? F : never;

function makeBaseDef(name: string, models: ComponentModels): Omit<ComponentDefinition, 'typeId'> {
  return {
    name,
    typeId: -1,
    factory: (props: PropertyBag) => createTestElementFromDecls(name, crypto.randomUUID(), [], props),
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    models,
  };
}

function buildMixedRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register(makeBaseDef('In',       { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('Out',      { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('And',      { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('Resistor', { mnaModels: { behavioral: {} } }) as ComponentDefinition);
  r.register(makeBaseDef('Tunnel',   { digital: { executeFn: noopExecFn } }) as ComponentDefinition);
  r.register(makeBaseDef('Port',     {} ) as ComponentDefinition);
  return r;
}

// ---------------------------------------------------------------------------
// Helper: build a ConnectivityGroup with a single pin from a given element
// ---------------------------------------------------------------------------

function singlePinGroup(
  groupId: number,
  elementIndex: number,
  pinIndex: number,
  pinLabel: string,
  domain: string,
): ConnectivityGroup {
  return {
    groupId,
    pins: [{ elementIndex, pinIndex, pinLabel, direction: PinDirection.OUTPUT, bitWidth: 1, worldPosition: { x: 0, y: 0 }, wireVertex: null, domain, kind: "signal" }],
    wires: [],
    domains: new Set([domain]),
    bitWidth: 1,
  };
}

// ---------------------------------------------------------------------------
// stableNetId tests
// ---------------------------------------------------------------------------

describe('stableNetId', () => {
  it('returns label:X for a group containing a Tunnel with a label', () => {
    const tunnelProps = new PropertyBag(new Map([['label', 'CLK']]));
    const tunnel = createTestElementFromDecls('Tunnel', 'tunnel-1', [outputPin(0, 0, 'p')], tunnelProps);
    const andEl  = createTestElementFromDecls('And', 'and-1', [inputPin(0, 0, 'A')], undefined, { x: 2, y: 0 });

    const elements: CircuitElement[] = [tunnel, andEl];
    const group: ConnectivityGroup = {
      groupId: 0,
      pins: [
        { elementIndex: 0, pinIndex: 0, pinLabel: 'p', direction: PinDirection.OUTPUT, bitWidth: 1, worldPosition: { x: 0, y: 0 }, wireVertex: null, domain: 'neutral', kind: "signal" },
        { elementIndex: 1, pinIndex: 0, pinLabel: 'A', direction: PinDirection.INPUT,  bitWidth: 1, worldPosition: { x: 2, y: 0 }, wireVertex: null, domain: 'digital', kind: "signal" },
      ],
      wires: [],
      domains: new Set(['digital']),
      bitWidth: 1,
    };

    expect(stableNetId(group, elements)).toBe('label:CLK');
  });

  it('returns label:X for a group containing a Port with a label', () => {
    const portProps = new PropertyBag(new Map([['label', 'DATA']]));
    const port   = createTestElementFromDecls('Port', 'port-1', [outputPin(0, 0, 'p')], portProps);
    const elements: CircuitElement[] = [port];
    const group: ConnectivityGroup = {
      groupId: 0,
      pins: [
        { elementIndex: 0, pinIndex: 0, pinLabel: 'p', direction: PinDirection.OUTPUT, bitWidth: 1, worldPosition: { x: 0, y: 0 }, wireVertex: null, domain: 'neutral', kind: "signal" },
      ],
      wires: [],
      domains: new Set(),
      bitWidth: undefined,
    };

    expect(stableNetId(group, elements)).toBe('label:DATA');
  });

  it('returns pin:instanceId:pinLabel for an unnamed net (no Tunnel or Port)', () => {
    const resistor = createTestElementFromDecls('Resistor', 'res-abc', [outputPin(0, 0, 'p1'), outputPin(2, 0, 'p2')]);
    const elements: CircuitElement[] = [resistor];
    const group: ConnectivityGroup = {
      groupId: 0,
      pins: [
        { elementIndex: 0, pinIndex: 0, pinLabel: 'p1', direction: PinDirection.OUTPUT, bitWidth: 1, worldPosition: { x: 0, y: 0 }, wireVertex: null, domain: 'analog', kind: "signal" },
      ],
      wires: [],
      domains: new Set(['analog']),
      bitWidth: undefined,
    };

    expect(stableNetId(group, elements)).toBe('pin:res-abc:p1');
  });

  it('uses first canonical pin (sorted by instanceId) for unnamed nets with multiple pins', () => {
    // Element with instanceId "aaa" sorts before "zzz"
    const elA = createTestElementFromDecls('And', 'zzz-instance', [outputPin(2, 0, 'out')]);
    const elB = createTestElementFromDecls('And', 'aaa-instance', [inputPin(0, 0, 'in')], undefined, { x: 4, y: 0 });
    const elements: CircuitElement[] = [elA, elB];

    const group: ConnectivityGroup = {
      groupId: 0,
      pins: [
        { elementIndex: 0, pinIndex: 0, pinLabel: 'out', direction: PinDirection.OUTPUT, bitWidth: 1, worldPosition: { x: 2, y: 0 }, wireVertex: null, domain: 'digital', kind: "signal" },
        { elementIndex: 1, pinIndex: 0, pinLabel: 'in',  direction: PinDirection.INPUT,  bitWidth: 1, worldPosition: { x: 4, y: 0 }, wireVertex: null, domain: 'digital', kind: "signal" },
      ],
      wires: [],
      domains: new Set(['digital']),
      bitWidth: 1,
    };

    // "aaa-instance" sorts before "zzz-instance", so canonical pin is elB's "in"
    expect(stableNetId(group, elements)).toBe('pin:aaa-instance:in');
  });

  it('ignores Tunnel/Port elements that have an empty label', () => {
    const emptyLabelProps = new PropertyBag(new Map([['label', '']]));
    const tunnel   = createTestElementFromDecls('Tunnel', 'tunnel-empty', [outputPin(0, 0, 'p')], emptyLabelProps);
    const resistor = createTestElementFromDecls('Resistor', 'res-xyz', [outputPin(0, 0, 'p1')], undefined, { x: 2, y: 0 });
    const elements: CircuitElement[] = [tunnel, resistor];

    const group: ConnectivityGroup = {
      groupId: 0,
      pins: [
        { elementIndex: 0, pinIndex: 0, pinLabel: 'p',  direction: PinDirection.OUTPUT, bitWidth: 1, worldPosition: { x: 0, y: 0 }, wireVertex: null, domain: 'neutral', kind: "signal" },
        { elementIndex: 1, pinIndex: 0, pinLabel: 'p1', direction: PinDirection.OUTPUT, bitWidth: 1, worldPosition: { x: 2, y: 0 }, wireVertex: null, domain: 'analog', kind: "signal" },
      ],
      wires: [],
      domains: new Set(['analog']),
      bitWidth: undefined,
    };

    // Empty label → skip tunnel → fall back to canonical pin
    expect(stableNetId(group, elements)).toBe('pin:res-xyz:p1');
  });
});

// ---------------------------------------------------------------------------
// resolveLoadingOverrides tests
// ---------------------------------------------------------------------------

describe('resolveLoadingOverrides', () => {
  it('returns empty map and no diagnostics when overrides list is empty', () => {
    const registry = buildMixedRegistry();
    const andEl = createTestElementFromDecls('And', 'a1', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const elements: CircuitElement[] = [andEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    const { resolved, diagnostics } = resolveLoadingOverrides([], groups, elements);
    expect(resolved.size).toBe(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('resolves label override to the correct connectivity group', () => {
    // Build a circuit with a Tunnel labelled "CLK" connected to an And gate input
    const registry = buildMixedRegistry();
    const tunnelProps = new PropertyBag(new Map([['label', 'CLK']]));
    const tunnel = createTestElementFromDecls('Tunnel', 'tunnel-clk', [outputPin(0, 0, 'p')], tunnelProps);
    const andEl  = createTestElementFromDecls('And', 'and-1', [
      inputPin(0, 0, 'A'),
    ]);

    const elements: CircuitElement[] = [tunnel, andEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    const override: PinLoadingOverride = {
      anchor: { type: 'label', label: 'CLK' },
      loading: 'loaded',
    };

    const { resolved, diagnostics } = resolveLoadingOverrides([override], groups, elements);
    expect(diagnostics).toHaveLength(0);
    // Find the group that has the tunnel pin
    const tunnelGroup = groups.find(g =>
      g.pins.some(p => elements[p.elementIndex]?.typeId === 'Tunnel'),
    );
    expect(tunnelGroup).toBeDefined();
    expect(resolved.get(tunnelGroup!.groupId)).toBe('loaded');
  });

  it('resolves pin anchor override to the correct connectivity group', () => {
    const registry = buildMixedRegistry();
    const andEl = createTestElementFromDecls('And', 'fixed-id-123', [
      inputPin(0, 0, 'A'), inputPin(0, 1, 'B'), outputPin(2, 0, 'out'),
    ]);
    const elements: CircuitElement[] = [andEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    // Find the group for pin "out" of element "fixed-id-123"
    const outGroup = groups.find(g =>
      g.pins.some(p => p.pinLabel === 'out' && elements[p.elementIndex]?.instanceId === 'fixed-id-123'),
    );
    expect(outGroup).toBeDefined();

    const override: PinLoadingOverride = {
      anchor: { type: 'pin', instanceId: 'fixed-id-123', pinLabel: 'out' },
      loading: 'ideal',
    };

    const { resolved, diagnostics } = resolveLoadingOverrides([override], groups, elements);
    expect(diagnostics).toHaveLength(0);
    expect(resolved.get(outGroup!.groupId)).toBe('ideal');
  });

  it('emits orphaned-pin-loading-override warning for a label anchor that does not exist', () => {
    const registry = buildMixedRegistry();
    const andEl = createTestElementFromDecls('And', 'a1', [
      outputPin(2, 0, 'out'),
    ]);
    const elements: CircuitElement[] = [andEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    const override: PinLoadingOverride = {
      anchor: { type: 'label', label: 'NONEXISTENT' },
      loading: 'loaded',
    };

    const { resolved, diagnostics } = resolveLoadingOverrides([override], groups, elements);
    expect(resolved.size).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe('warning');
    expect(diagnostics[0]!.code).toBe('orphaned-pin-loading-override');
    expect(diagnostics[0]!.message).toContain('NONEXISTENT');
  });

  it('emits orphaned-pin-loading-override warning for a pin anchor that does not exist', () => {
    const registry = buildMixedRegistry();
    const andEl = createTestElementFromDecls('And', 'a1', [
      outputPin(2, 0, 'out'),
    ]);
    const elements: CircuitElement[] = [andEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    const override: PinLoadingOverride = {
      anchor: { type: 'pin', instanceId: 'deleted-element-id', pinLabel: 'out' },
      loading: 'ideal',
    };

    const { resolved, diagnostics } = resolveLoadingOverrides([override], groups, elements);
    expect(resolved.size).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe('warning');
    expect(diagnostics[0]!.code).toBe('orphaned-pin-loading-override');
    expect(diagnostics[0]!.message).toContain('deleted-element-id');
  });

  it('resolves multiple overrides independently and emits one warning per orphan', () => {
    const registry = buildMixedRegistry();
    const tunnelProps = new PropertyBag(new Map([['label', 'CLK']]));
    const tunnel = createTestElementFromDecls('Tunnel', 'tunnel-clk', [outputPin(0, 0, 'p')], tunnelProps);
    const andEl  = createTestElementFromDecls('And', 'and-fixed', [outputPin(2, 0, 'out')]);
    const elements: CircuitElement[] = [tunnel, andEl];
    const [assignments] = resolveModelAssignments(elements, registry);
    const [groups] = extractConnectivityGroups(elements, [], registry, assignments);

    const overrides: PinLoadingOverride[] = [
      { anchor: { type: 'label', label: 'CLK' }, loading: 'loaded' },
      { anchor: { type: 'label', label: 'MISSING' }, loading: 'ideal' },
      { anchor: { type: 'pin', instanceId: 'and-fixed', pinLabel: 'out' }, loading: 'ideal' },
    ];

    const { resolved, diagnostics } = resolveLoadingOverrides(overrides, groups, elements);
    expect(resolved.size).toBe(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('orphaned-pin-loading-override');
    expect(diagnostics[0]!.message).toContain('MISSING');
  });
});
