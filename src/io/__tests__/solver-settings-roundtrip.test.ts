/**
 * Per-circuit solver settings- .dts serialization round-trip (Surface 1).
 *
 * solverSettings is givenness-faithful: presence in the map = given. A given
 * value equal to the engine default must still be persisted (givenness is NOT
 * delta-vs-default), and a circuit with no overrides must emit no solverSettings.
 */
import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../../headless/default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { serializeCircuit } from '../dts-serializer.js';
import { deserializeDts } from '../dts-deserializer.js';
import { DEFAULT_SIMULATION_PARAMS } from '../../core/analog-engine-interface.js';
import type { Circuit } from '../../core/circuit.js';

const registry = createDefaultRegistry();

function minimalCircuit(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: 'r1', type: 'Resistor', props: { resistance: 1000 } },
      { id: 'gnd', type: 'Ground' },
    ],
    connections: [['r1:neg', 'gnd:out']],
  });
}

describe('solver settings .dts round-trip', () => {
  it('preserves given fields, including a given value equal to the default', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const c = minimalCircuit(facade);
    const given = {
      reltol: 1e-6,
      gmin: 1e-9,
      // Equals DEFAULT_SIMULATION_PARAMS.maxTimeStep- givenness is presence, not
      // a delta, so this must survive rather than being dropped as "==default".
      maxTimeStep: DEFAULT_SIMULATION_PARAMS.maxTimeStep,
      integrationMethod: 'gear' as const,
      optran: false,
      indVerbosity: 0,
    };
    c.metadata.solverSettings = { ...given };

    const json = serializeCircuit(c);
    const c2 = deserializeDts(json, registry);

    expect(c2.metadata.solverSettings).toEqual(given);
  });

  it('emits no solverSettings when none are given', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const c = minimalCircuit(facade);

    const json = serializeCircuit(c);
    expect((JSON.parse(json) as { circuit: { solverSettings?: unknown } }).circuit.solverSettings).toBeUndefined();

    const c2 = deserializeDts(json, registry);
    expect(c2.metadata.solverSettings).toBeUndefined();
  });

  it('rejects a malformed solverSettings on load', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const c = minimalCircuit(facade);
    c.metadata.solverSettings = { reltol: 1e-6 };
    const doc = JSON.parse(serializeCircuit(c)) as { circuit: { solverSettings: Record<string, unknown> } };
    doc.circuit.solverSettings.integrationMethod = 'bogus';

    expect(() => deserializeDts(JSON.stringify(doc), registry)).toThrow(/integrationMethod/);
  });
});
