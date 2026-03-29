/**
 * W9.3 tests: round-trip compile and orphaned override diagnostic.
 *
 * Verifies that:
 * 1. A circuit with digitalPinLoading set survives a save/load cycle and still
 *    compiles correctly with the metadata intact.
 * 2. A per-net override referencing a deleted component causes the compiler to
 *    emit an "orphaned-pin-loading-override" warning after loading.
 */

import { describe, it, expect } from 'vitest';
import { serializeCircuit as serializeJson } from '../save.js';
import { deserializeCircuit as deserializeJson } from '../load.js';
import { serializeCircuit as serializeDts } from '../dts-serializer.js';
import { deserializeDts } from '../dts-deserializer.js';
import { compileUnified } from '../../compile/compile.js';
import { Circuit, Wire } from '../../core/circuit.js';
import type { Pin, PinDeclaration } from '../../core/pin.js';
import { PinDirection, resolvePins, createInverterConfig, createClockConfig } from '../../core/pin.js';
import { AbstractCircuitElement } from '../../core/element.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import { PropertyBag } from '../../core/properties.js';
import { ComponentRegistry, ComponentCategory } from '../../core/registry.js';
import type { ComponentDefinition, ComponentModels, ExecuteFunction } from '../../core/registry.js';

// ---------------------------------------------------------------------------
// Minimal concrete CircuitElement for tests
// ---------------------------------------------------------------------------

function pinDecl(
  dir: PinDirection,
  label: string,
  x: number,
  y: number,
): PinDeclaration {
  return {
    direction: dir,
    label,
    defaultBitWidth: 1,
    position: { x, y },
    isNegatable: false,
    isClockCapable: false,
  };
}

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

  getPins(): readonly Pin[] {
    return this._pins;
  }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 2, height: 2 };
  }
}

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

const noopExec: ExecuteFunction = () => {};

const AND_PINS = [
  pinDecl(PinDirection.INPUT, 'a', 0, 0),
  pinDecl(PinDirection.INPUT, 'b', 0, 1),
  pinDecl(PinDirection.OUTPUT, 'out', 2, 0),
];

const IN_PINS = [pinDecl(PinDirection.OUTPUT, 'out', 1, 0)];

function buildRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    name: 'In',
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement('In', crypto.randomUUID(), { x: 0, y: 0 }, IN_PINS, props),
    pinLayout: IN_PINS,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: '',
    models: { digital: { executeFn: noopExec } } as ComponentModels,
  } as ComponentDefinition);

  registry.register({
    name: 'Out',
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement('Out', crypto.randomUUID(), { x: 0, y: 0 }, IN_PINS, props),
    pinLayout: IN_PINS,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: '',
    models: { digital: { executeFn: noopExec } } as ComponentModels,
  } as ComponentDefinition);

  registry.register({
    name: 'And',
    typeId: -1,
    factory: (props: PropertyBag) =>
      new TestElement('And', crypto.randomUUID(), { x: 0, y: 0 }, AND_PINS, props),
    pinLayout: AND_PINS,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: '',
    models: { digital: { executeFn: noopExec } } as ComponentModels,
  } as ComponentDefinition);

  return registry;
}

// ---------------------------------------------------------------------------
// Helper: build a minimal digital circuit
//   In(instanceId) → And → Out
// ---------------------------------------------------------------------------

function buildSimpleCircuit(inId = 'in-uuid-1'): Circuit {
  const circuit = new Circuit({ name: 'CompileTest' });

  const inEl = new TestElement('In', inId, { x: 0, y: 0 }, IN_PINS);
  const andEl = new TestElement('And', 'and-uuid-1', { x: 4, y: 0 }, AND_PINS);
  const outEl = new TestElement('Out', 'out-uuid-1', { x: 8, y: 0 }, IN_PINS);

  circuit.addElement(inEl);
  circuit.addElement(andEl);
  circuit.addElement(outEl);

  // In.out(1,0) → And.a(4,0)
  circuit.addWire(new Wire({ x: 1, y: 0 }, { x: 4, y: 0 }));
  // And.out(6,0) → Out.out(8,0)
  circuit.addWire(new Wire({ x: 6, y: 0 }, { x: 8, y: 0 }));

  return circuit;
}

// ---------------------------------------------------------------------------
// Round-trip compile tests (JSON format)
// ---------------------------------------------------------------------------

describe('W9.3 round-trip compile: JSON format', () => {
  it('circuit with digitalPinLoading=cross-domain compiles after round-trip', () => {
    const circuit = buildSimpleCircuit();
    circuit.metadata.digitalPinLoading = 'cross-domain';

    const registry = buildRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoading).toBe('cross-domain');

    const compiled = compileUnified(loaded, registry);
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('circuit with digitalPinLoading=none compiles after round-trip', () => {
    const circuit = buildSimpleCircuit();
    circuit.metadata.digitalPinLoading = 'none';

    const registry = buildRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoading).toBe('none');

    const compiled = compileUnified(loaded, registry);
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('circuit with digitalPinLoading=all compiles after round-trip', () => {
    const circuit = buildSimpleCircuit();
    circuit.metadata.digitalPinLoading = 'all';

    const registry = buildRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    expect(loaded.metadata.digitalPinLoading).toBe('all');

    const compiled = compileUnified(loaded, registry);
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Round-trip compile tests (DTS format)
// ---------------------------------------------------------------------------

describe('W9.3 round-trip compile: DTS format', () => {
  it('circuit with digitalPinLoading=cross-domain compiles after DTS round-trip', () => {
    const circuit = buildSimpleCircuit();
    circuit.metadata.digitalPinLoading = 'cross-domain';

    const registry = buildRegistry();
    const dts = serializeDts(circuit);
    const { circuit: loaded } = deserializeDts(dts, registry);

    expect(loaded.metadata.digitalPinLoading).toBe('cross-domain');

    const compiled = compileUnified(loaded, registry);
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('circuit with digitalPinLoading=none compiles after DTS round-trip', () => {
    const circuit = buildSimpleCircuit();
    circuit.metadata.digitalPinLoading = 'none';

    const registry = buildRegistry();
    const dts = serializeDts(circuit);
    const { circuit: loaded } = deserializeDts(dts, registry);

    expect(loaded.metadata.digitalPinLoading).toBe('none');

    const compiled = compileUnified(loaded, registry);
    const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Orphaned override diagnostic tests
// ---------------------------------------------------------------------------

describe('W9.3 orphaned override diagnostic', () => {
  it('JSON: orphaned label anchor emits warning after component deleted and reloaded', () => {
    const IN_INSTANCE_ID = 'in-uuid-orphan-label';
    const circuit = buildSimpleCircuit(IN_INSTANCE_ID);

    // Set an override referencing a label that matches a Tunnel/label net.
    // Since there is no labelled net "CLK" in this circuit, it is immediately
    // orphaned when the circuit compiles — but the point is to verify the
    // save/load round-trip preserves the override and the compiler emits the
    // warning.
    circuit.metadata.digitalPinLoadingOverrides = [
      { anchor: { type: 'label', label: 'CLK' }, loading: 'loaded' },
    ];

    const registry = buildRegistry();
    const json = serializeJson(circuit);
    const loaded = deserializeJson(json, registry);

    // Override must survive the round-trip
    expect(loaded.metadata.digitalPinLoadingOverrides).toHaveLength(1);
    expect(loaded.metadata.digitalPinLoadingOverrides![0]).toEqual({
      anchor: { type: 'label', label: 'CLK' },
      loading: 'loaded',
    });

    // Compile — the override references a non-existent label net, so the
    // compiler must emit an orphaned-pin-loading-override warning.
    const compiled = compileUnified(loaded, registry);
    const orphanedWarnings = compiled.diagnostics.filter(
      (d) => d.code === 'orphaned-pin-loading-override',
    );
    expect(orphanedWarnings).toHaveLength(1);
    expect(orphanedWarnings[0]!.severity).toBe('warning');
    expect(orphanedWarnings[0]!.message).toContain('CLK');
  });

  it('JSON: orphaned pin anchor emits warning after component deleted and reloaded', () => {
    // Build circuit with a known instanceId for the In element
    const IN_INSTANCE_ID = 'in-uuid-orphan-pin';
    const circuit = buildSimpleCircuit(IN_INSTANCE_ID);

    // Add an override referencing the In element's pin by its known instanceId.
    // After the element is removed, this anchor becomes orphaned.
    circuit.metadata.digitalPinLoadingOverrides = [
      {
        anchor: { type: 'pin', instanceId: IN_INSTANCE_ID, pinLabel: 'out' },
        loading: 'ideal',
      },
    ];

    const registry = buildRegistry();

    // Build a circuit that has the override but no matching element, then
    // serialize and reload it — simulating that the user deleted the element.
    const circuitNoEl = new Circuit({ name: 'OrphanPinTest' });
    // Copy the And and Out elements but NOT the In element
    const andEl = new TestElement('And', 'and-uuid-1', { x: 4, y: 0 }, AND_PINS);
    const outEl = new TestElement('Out', 'out-uuid-1', { x: 8, y: 0 }, IN_PINS);
    circuitNoEl.addElement(andEl);
    circuitNoEl.addElement(outEl);
    circuitNoEl.addWire(new Wire({ x: 6, y: 0 }, { x: 8, y: 0 }));
    // Keep the override referencing the deleted In element
    circuitNoEl.metadata.digitalPinLoadingOverrides = [
      {
        anchor: { type: 'pin', instanceId: IN_INSTANCE_ID, pinLabel: 'out' },
        loading: 'ideal',
      },
    ];

    const json = serializeJson(circuitNoEl);
    const loaded = deserializeJson(json, registry);

    // Override must survive the round-trip
    expect(loaded.metadata.digitalPinLoadingOverrides).toHaveLength(1);
    expect(loaded.metadata.digitalPinLoadingOverrides![0]!.anchor).toEqual({
      type: 'pin',
      instanceId: IN_INSTANCE_ID,
      pinLabel: 'out',
    });

    // Compile — the referenced element does not exist, so the compiler must
    // emit an orphaned-pin-loading-override warning
    const compiled = compileUnified(loaded, registry);
    const orphanedWarnings = compiled.diagnostics.filter(
      (d) => d.code === 'orphaned-pin-loading-override',
    );
    expect(orphanedWarnings).toHaveLength(1);
    expect(orphanedWarnings[0]!.severity).toBe('warning');
    expect(orphanedWarnings[0]!.message).toContain(IN_INSTANCE_ID);
  });

  it('DTS: orphaned label anchor emits warning after round-trip', () => {
    const circuit = buildSimpleCircuit();
    circuit.metadata.digitalPinLoadingOverrides = [
      { anchor: { type: 'label', label: 'MISSING_NET' }, loading: 'ideal' },
    ];

    const registry = buildRegistry();
    const dts = serializeDts(circuit);
    const { circuit: loaded } = deserializeDts(dts, registry);

    expect(loaded.metadata.digitalPinLoadingOverrides).toHaveLength(1);

    const compiled = compileUnified(loaded, registry);
    const orphanedWarnings = compiled.diagnostics.filter(
      (d) => d.code === 'orphaned-pin-loading-override',
    );
    expect(orphanedWarnings).toHaveLength(1);
    expect(orphanedWarnings[0]!.severity).toBe('warning');
    expect(orphanedWarnings[0]!.message).toContain('MISSING_NET');
  });

  it('DTS: orphaned pin anchor emits warning after component deleted and reloaded', () => {
    const IN_INSTANCE_ID = 'in-uuid-dts-orphan';
    const circuit = buildSimpleCircuit(IN_INSTANCE_ID);
    circuit.metadata.digitalPinLoadingOverrides = [
      {
        anchor: { type: 'pin', instanceId: IN_INSTANCE_ID, pinLabel: 'out' },
        loading: 'loaded',
      },
    ];

    const registry = buildRegistry();

    // First round-trip to get the circuit with instance IDs locked in
    const dtsWithOverride = serializeDts(circuit);
    const { circuit: circuitWithEl } = deserializeDts(dtsWithOverride, registry);

    // Remove the In element
    const inEl = circuitWithEl.elements.find(
      (e) => e.instanceId === IN_INSTANCE_ID,
    );
    expect(inEl).toBeDefined();
    circuitWithEl.removeElement(inEl!);

    // Re-serialize and reload
    const dtsAfterDelete = serializeDts(circuitWithEl);
    const { circuit: loaded } = deserializeDts(dtsAfterDelete, registry);

    expect(loaded.metadata.digitalPinLoadingOverrides).toHaveLength(1);

    const compiled = compileUnified(loaded, registry);
    const orphanedWarnings = compiled.diagnostics.filter(
      (d) => d.code === 'orphaned-pin-loading-override',
    );
    expect(orphanedWarnings).toHaveLength(1);
    expect(orphanedWarnings[0]!.severity).toBe('warning');
    expect(orphanedWarnings[0]!.message).toContain(IN_INSTANCE_ID);
  });
});
