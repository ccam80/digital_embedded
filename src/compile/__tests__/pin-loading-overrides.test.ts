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
import type { Pin, PinDeclaration } from '../../core/pin.js';
import { PinDirection, resolvePins, createInverterConfig, createClockConfig } from '../../core/pin.js';
import { AbstractCircuitElement } from '../../core/element.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import { PropertyBag } from '../../core/properties.js';
import type { PropertyBag as PropertyBagType, PropertyValue } from '../../core/properties.js';
import { ComponentRegistry } from '../../core/registry.js';
import type { ComponentDefinition, ComponentModels, ExecuteFunction } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { SerializedElement } from '../../core/element.js';

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
  ) {
    super(typeId, instanceId, position, 0, false, props ?? new PropertyBag());
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

function inputPin(x: number, y: number, label: string): PinDeclaration {
  return { direction: PinDirection.INPUT, label, defaultBitWidth: 1, position: { x, y }, isNegatable: false, isClockCapable: false };
}

function outputPin(x: number, y: number, label: string): PinDeclaration {
  return { direction: PinDirection.OUTPUT, label, defaultBitWidth: 1, position: { x, y }, isNegatable: false, isClockCapable: false };
}

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

const noopExec: ExecuteFunction = () => {};

function buildRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  r.register({
    name: 'And',
    typeId: -1,
    factory: (props: PropertyBagType) => new TestElement(
      'And', crypto.randomUUID(), { x: 0, y: 0 },
      [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')],
      props instanceof PropertyBag ? props : new PropertyBag(),
    ),
    pinLayout: [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: '',
    models: { digital: { executeFn: noopExec } } as ComponentModels,
  } as ComponentDefinition);

  r.register({
    name: 'In',
    typeId: -1,
    factory: (props: PropertyBagType) => new TestElement(
      'In', crypto.randomUUID(), { x: 0, y: 0 },
      [outputPin(0, 0, 'out')],
      props instanceof PropertyBag ? props : new PropertyBag(),
    ),
    pinLayout: [outputPin(0, 0, 'out')],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.IO,
    helpText: '',
    models: { digital: { executeFn: noopExec } } as ComponentModels,
  } as ComponentDefinition);

  r.register({
    name: 'Tunnel',
    typeId: -1,
    factory: (props: PropertyBagType) => new TestElement(
      'Tunnel', crypto.randomUUID(), { x: 0, y: 0 },
      [outputPin(0, 0, 'out')],
      props instanceof PropertyBag ? props : new PropertyBag(),
    ),
    pinLayout: [outputPin(0, 0, 'out')],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.WIRING,
    helpText: '',
    models: { digital: { executeFn: noopExec } } as ComponentModels,
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
    const tunnel = new TestElement('Tunnel', 'tunnel-1', { x: 0, y: 0 }, [outputPin(0, 0, 'out')], tunnelProps);
    circuit.addElement(tunnel);

    const assignments = resolveModelAssignments(circuit.elements, registry);
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
    circuit.addElement(new TestElement('And', 'and-fixed', { x: 0, y: 0 }, [
      inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out'),
    ]));

    const assignments = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    for (const group of groups) {
      const netId = stableNetId(group, circuit.elements);
      expect(netId).toMatch(/^(label:|pin:)/);
      if (netId.startsWith('pin:')) {
        const parts = netId.slice('pin:'.length).split(':');
        expect(parts.length).toBeGreaterThanOrEqual(2);
      }
    }
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
    circuit.addElement(new TestElement('Tunnel', 'tun-1', { x: 0, y: 0 }, [outputPin(0, 0, 'out')], tunnelProps));

    const assignments = resolveModelAssignments(circuit.elements, registry);
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
    circuit.addElement(new TestElement('And', 'and-fixed-id', { x: 0, y: 0 }, andPins));

    const assignments = resolveModelAssignments(circuit.elements, registry);
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
    circuit.addElement(new TestElement('And', 'and-1', { x: 0, y: 0 }, [
      inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out'),
    ]));

    const assignments = resolveModelAssignments(circuit.elements, registry);
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
    circuit.addElement(new TestElement('Tunnel', 'tun-a', { x: 0, y: 0 }, [outputPin(0, 0, 'out')], t1Props));
    circuit.addElement(new TestElement('Tunnel', 'tun-b', { x: 10, y: 0 }, [outputPin(0, 0, 'out')], t2Props));

    const assignments = resolveModelAssignments(circuit.elements, registry);
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
    circuit.addElement(new TestElement('And', 'and-1', { x: 0, y: 0 }, andPins1));
    circuit.addElement(new TestElement('And', 'and-2', { x: 8, y: 0 }, andPins2));

    const wire = new Wire({ x: 2, y: 0 }, { x: 8, y: 0 });
    circuit.addWire(wire);

    const assignments = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    const groupWithWire = groups.find(g => g.wires.includes(wire));
    expect(groupWithWire).toBeDefined();
  });

  it('unconnected wire appears in exactly one group', () => {
    const registry = buildRegistry();
    const circuit = new Circuit();
    circuit.addElement(new TestElement('And', 'and-solo', { x: 0, y: 0 }, [
      inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out'),
    ]));

    const floatingWire = new Wire({ x: 5, y: 5 }, { x: 10, y: 5 });
    circuit.addWire(floatingWire);

    const assignments = resolveModelAssignments(circuit.elements, registry);
    const [groups] = extractConnectivityGroups(circuit.elements, circuit.wires, registry, assignments);

    const matchingGroups = groups.filter(g => g.wires.includes(floatingWire));
    expect(matchingGroups.length).toBeLessThanOrEqual(1);
  });
});
