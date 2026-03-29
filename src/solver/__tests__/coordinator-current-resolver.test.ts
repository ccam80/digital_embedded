/**
 * Tests for SimulationCoordinator.getCurrentResolverContext() (section 1.10).
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulationCoordinator } from '../coordinator.js';
import { compileUnified } from '../../compile/compile.js';
import { Circuit } from '../../core/circuit.js';
import { AbstractCircuitElement } from '../../core/element.js';
import { PropertyBag } from '../../core/properties.js';
import { PinDirection } from '../../core/pin.js';
import { ComponentRegistry } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { Pin, Rotation } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { ComponentDefinition, AnalogFactory } from '../../core/registry.js';
import type { AnalogElement } from '../analog/element.js';
import type { SparseSolver } from '../analog/sparse-solver.js';

class MockElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];
  constructor(typeId: string, instanceId: string, position: { x: number; y: number }, pins: Pin[]) {
    super(typeId, instanceId, position, 0 as Rotation, false, new PropertyBag());
    this._pins = pins;
  }
  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: this.position.x, y: this.position.y, width: 4, height: 4 }; }
}

function makePin(label: string, direction: PinDirection, localX: number, localY: number): Pin {
  return { label, direction, position: { x: localX, y: localY }, bitWidth: 1, isNegated: false, isClock: false, kind: "signal" };
}

function makeAnalogElementObj(typeId: string, instanceId: string, pinDescs: { x: number; y: number; label: string }[]): MockElement {
  const pins = pinDescs.map(p => makePin(p.label, PinDirection.BIDIRECTIONAL, p.x, p.y));
  return new MockElement(typeId, instanceId, { x: 0, y: 0 }, pins);
}

function makeResistorAnalogEl(nodeA: number, nodeB: number, r: number): AnalogElement {
  const g = 1 / r;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(s: SparseSolver) {
      if (nodeA > 0) s.addG(nodeA, nodeA, g);
      if (nodeB > 0) s.addG(nodeB, nodeB, g);
      if (nodeA > 0 && nodeB > 0) { s.addG(nodeA, nodeB, -g); s.addG(nodeB, nodeA, -g); }
    },
    getPinCurrents(_v: Float64Array) { return [1.0, -1.0]; },
  };
}

function buildAnalogRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  const resistorFactory: AnalogFactory = (_el: unknown, pinNodes: number[], _props: unknown) =>
    makeResistorAnalogEl(pinNodes[0] ?? 0, pinNodes[1] ?? 0, 1000);
  return registry;
}

describe('SimulationCoordinator.getCurrentResolverContext', () => {
  it('returns non-null for analog circuit', () => {
    const registry = buildAnalogRegistry();
    const circuit = new Circuit();
    const unified = compileUnified(circuit, registry);
    const coordinator = new DefaultSimulationCoordinator(unified, registry);
    const ctx = coordinator.getCurrentResolverContext();
    expect(ctx).toBeDefined();
  });

  it('returns null for digital-only circuit', () => {
    const registry = new ComponentRegistry();
    const circuit = new Circuit();
    const unified = compileUnified(circuit, registry);
    const coordinator = new DefaultSimulationCoordinator(unified, registry);
    const ctx = coordinator.getCurrentResolverContext();
    expect(ctx).toBeNull();
  });
});
