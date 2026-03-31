/**
 * Tests for SimulationCoordinator.getCurrentResolverContext() (section 1.10).
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulationCoordinator } from '../coordinator.js';
import { compileUnified } from '../../compile/compile.js';
import { Circuit } from '../../core/circuit.js';
import { ComponentRegistry } from '../../core/registry.js';

function buildAnalogRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
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
