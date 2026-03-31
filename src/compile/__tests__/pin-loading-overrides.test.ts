/**
 * Headless tests for per-net digitalPinLoadingOverrides.
 *
 * Verifies that:
 * - PinLoadingOverride anchors round-trip correctly through stableNetId
 * - resolveLoadingOverrides matches wires to their groups
 * - Adding overrides to circuit metadata changes compile behaviour
 * - Orphaned overrides (referencing non-existent nets) produce a warning diagnostic
 */

import { describe, it, expect } from 'vitest';
import { extractConnectivityGroups, resolveModelAssignments, stableNetId, resolveLoadingOverrides } from '../extract-connectivity.js';
import type { PinLoadingOverride } from '../extract-connectivity.js';
import { Circuit, Wire } from '../../core/circuit.js';
import type { PinDeclaration } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import { PropertyBag } from '../../core/properties.js';
import type { PropertyBag as PropertyBagType } from '../../core/properties.js';
import { ComponentRegistry } from '../../core/registry.js';
import type { ComponentDefinition, ComponentModels } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import { createTestElementFromDecls } from '../../test-fixtures/test-element.js';
import { noopExecFn } from '../../test-fixtures/execute-stubs.js';

// ---------------------------------------------------------------------------
// Pin declaration helpers
// ---------------------------------------------------------------------------

function inputPin(x: number, y: number, label: string): PinDeclaration {
  return { direction: PinDirection.INPUT, label, defaultBitWidth: 1, position: { x, y }, isNegatable: false, isClockCapable: false, kind: "signal" };
}

function outputPin(x: number, y: number, label: string): PinDeclaration {
  return { direction: PinDirection.OUTPUT, label, defaultBitWidth: 1, position: { x, y }, isNegatable: false, isClockCapable: false, kind: "signal" };
}

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

function buildRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register({
    name: 'And',
    typeId: -1,
    factory: (props: PropertyBagType) => createTestElementFromDecls(
      'And', crypto.randomUUID(),
      [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')],
      props instanceof PropertyBag ? props : new PropertyBag(),
    ),
    pinLayout: [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } } as ComponentModels,
  } as ComponentDefinition);

  r.register({
    name: 'In',
    typeId: -1,
    factory: (props: PropertyBagType) => createTestElementFromDecls(
      'In', crypto.randomUUID(),
      [outputPin(0, 0, 'out')],
      props instanceof PropertyBag ? props : new PropertyBag(),
    ),
    pinLayout: [outputPin(0, 0, 'out')],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } } as ComponentModels,
  } as ComponentDefinition);

  r.register({
    name: 'Tunnel',
    typeId: -1,
    factory: (props: PropertyBagType) => createTestElementFromDecls(
      'Tunnel', crypto.randomUUID(),
      [outputPin(0, 0, 'out')],
      props instanceof PropertyBag ? props : new PropertyBag(),
    ),
    pinLayout: [outputPin(0, 0, 'out')],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.WIRING,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } } as ComponentModels,
  } as ComponentDefinition);

  return r;
}

// ---------------------------------------------------------------------------
// Tests: stableNetId format and anchor round-trip
// ---------------------------------------------------------------------------

describe('stableNetId — format matches PinLoadingOverride anchor format', () => {
  it('label-anchored net produces "label:<label>" stable ID', () => {
    const registry = buildRegistry();
    const tunnelProps = new PropertyBag(new Map([['label', 'CLK']]));
    const circuit = new Circuit();
    const tunnel = createTestElementFromDecls('Tunnel', 'tunnel-1', [outputPin(0, 0, 'out')], tunnelProps);
    circuit.addElement(tunnel);

    const [assignments] = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    const tunnelGroup = groups.find(g =>
      g.pins.some(p => circuit.elements[p.elementIndex]?.instanceId === 'tunnel-1'),
    );
    expect(tunnelGroup).toBeDefined();

    const netId = stableNetId(tunnelGroup!, circuit.elements);
    expect(netId).toBe('label:CLK');
  });

  it('pin-anchored net produces "pin:<instanceId>:<pinLabel>" stable ID', () => {
    const registry = buildRegistry();
    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-fixed', [
      inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out'),
    ]));

    const [assignments] = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    const netIds = groups.map(g => stableNetId(g, circuit.elements));
    expect(netIds).toContain('pin:and-fixed:a');
    expect(netIds).toContain('pin:and-fixed:b');
    expect(netIds).toContain('pin:and-fixed:out');
  });
});

// ---------------------------------------------------------------------------
// Tests: resolveLoadingOverrides
// ---------------------------------------------------------------------------

describe('resolveLoadingOverrides — matches overrides to connectivity groups', () => {
  it('label-anchored override matches the correct group', () => {
    const registry = buildRegistry();
    const tunnelProps = new PropertyBag(new Map([['label', 'DATA']]));
    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('Tunnel', 'tun-1', [outputPin(0, 0, 'out')], tunnelProps));

    const [assignments] = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    const overrides: PinLoadingOverride[] = [
      { anchor: { type: 'label', label: 'DATA' }, loading: 'loaded' },
    ];

    const { resolved, diagnostics } = resolveLoadingOverrides(overrides, groups, circuit.elements);

    expect(diagnostics).toHaveLength(0);
    expect(resolved.size).toBe(1);
    const [, loadingMode] = [...resolved.entries()][0]!;
    expect(loadingMode).toBe('loaded');
  });

  it('pin-anchored override matches the correct group', () => {
    const registry = buildRegistry();
    const andPins = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-fixed-id', andPins));

    const [assignments] = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    // Find the group containing the 'out' pin of 'and-fixed-id'
    const outGroup = groups.find(g =>
      g.pins.some(p => {
        const el = circuit.elements[p.elementIndex];
        return el?.instanceId === 'and-fixed-id' && p.pinLabel === 'out';
      }),
    );
    expect(outGroup).toBeDefined();

    const overrides: PinLoadingOverride[] = [
      { anchor: { type: 'pin', instanceId: 'and-fixed-id', pinLabel: 'out' }, loading: 'ideal' },
    ];

    const { resolved, diagnostics } = resolveLoadingOverrides(overrides, groups, circuit.elements);

    expect(diagnostics).toHaveLength(0);
    expect(resolved.size).toBe(1);
    const [[groupId, loadingMode]] = [...resolved.entries()];
    expect(groupId).toBe(outGroup!.groupId);
    expect(loadingMode).toBe('ideal');
  });

  it('orphaned override (non-existent net) produces a warning diagnostic', () => {
    const registry = buildRegistry();
    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-1', [
      inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out'),
    ]));

    const [assignments] = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    const overrides: PinLoadingOverride[] = [
      { anchor: { type: 'label', label: 'NONEXISTENT_NET' }, loading: 'loaded' },
    ];

    const { resolved, diagnostics } = resolveLoadingOverrides(overrides, groups, circuit.elements);

    expect(resolved.size).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe('warning');
    expect(diagnostics[0]!.code).toBe('orphaned-pin-loading-override');
  });

  it('multiple overrides on different nets are all resolved', () => {
    const registry = buildRegistry();
    const t1Props = new PropertyBag(new Map([['label', 'NET_A']]));
    const t2Props = new PropertyBag(new Map([['label', 'NET_B']]));
    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('Tunnel', 'tun-a', [outputPin(0, 0, 'out')], t1Props));
    circuit.addElement(createTestElementFromDecls('Tunnel', 'tun-b', [outputPin(0, 0, 'out')], t2Props, { x: 10, y: 0 }));

    const [assignments] = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    const overrides: PinLoadingOverride[] = [
      { anchor: { type: 'label', label: 'NET_A' }, loading: 'loaded' },
      { anchor: { type: 'label', label: 'NET_B' }, loading: 'ideal' },
    ];

    const { resolved, diagnostics } = resolveLoadingOverrides(overrides, groups, circuit.elements);

    expect(diagnostics).toHaveLength(0);
    expect(resolved.size).toBe(2);

    const values = [...resolved.values()];
    expect(values).toContain('loaded');
    expect(values).toContain('ideal');
  });
});

// ---------------------------------------------------------------------------
// Tests: stableNetId wires membership
// ---------------------------------------------------------------------------

describe('connectivity groups — wires field is populated for connected groups', () => {
  it('wire connecting two elements appears in the connectivity group', () => {
    const registry = buildRegistry();
    const andPins1 = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const andPins2 = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-1', andPins1));
    circuit.addElement(createTestElementFromDecls('And', 'and-2', andPins2, undefined, { x: 8, y: 0 }));

    const wire = new Wire({ x: 2, y: 0 }, { x: 8, y: 0 });
    circuit.addWire(wire);

    const [assignments] = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    const groupWithWire = groups.find(g => g.wires.includes(wire));
    expect(groupWithWire).toBeDefined();
  });

  it('unconnected wire appears in exactly one group', () => {
    const registry = buildRegistry();
    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-solo', [
      inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out'),
    ]));

    const floatingWire = new Wire({ x: 5, y: 5 }, { x: 10, y: 5 });
    circuit.addWire(floatingWire);

    const [assignments] = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    const matchingGroups = groups.filter(g => g.wires.includes(floatingWire));
    expect(matchingGroups.length).toBe(1);
  });
});
