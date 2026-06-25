/**
 * Per-circuit solver settings- MCP / save-load surface (Surface 2).
 *
 * Mirrors the agent flow: circuit_configure (set metadata.solverSettings) ->
 * circuit_save (serializeCircuit) -> circuit_load (deserializeDts) ->
 * circuit_compile (facade.compile) -> run. Verifies the overrides survive the
 * full JSON string round-trip and still take effect after reload.
 */
import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { serializeCircuit } from '../../io/dts-serializer.js';
import { deserializeDts } from '../../io/dts-deserializer.js';
import type { Circuit } from '../../core/circuit.js';

const registry = createDefaultRegistry();

function buildRC(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: 'vs', type: 'AcVoltageSource', props: { amplitude: 5, frequency: 200, phase: 0, dcOffset: 0, waveform: 'sine', label: 'Vs' } },
      { id: 'r1', type: 'Resistor', props: { resistance: 1000 } },
      { id: 'c1', type: 'Capacitor', props: { capacitance: 1e-6, label: 'Vc' } },
      { id: 'gnd', type: 'Ground' },
    ],
    connections: [['vs:pos', 'r1:pos'], ['r1:neg', 'c1:pos'], ['c1:neg', 'gnd:out'], ['vs:neg', 'gnd:out']],
  });
}

describe('solver settings- MCP / save-load surface', () => {
  it('survive a full serialize->deserialize and still cap the step after reload', async () => {
    // circuit_configure: set per-circuit overrides.
    const fb = new DefaultSimulatorFacade(registry);
    const c = buildRC(fb);
    c.metadata.solverSettings = { maxTimeStep: 1e-7, reltol: 1e-5 };

    // circuit_save -> circuit_load: full JSON string round-trip.
    const json = serializeCircuit(c);
    const reloaded = deserializeDts(json, registry);
    expect(reloaded.metadata.solverSettings).toEqual({ maxTimeStep: 1e-7, reltol: 1e-5 });

    // circuit_compile + run on the reloaded circuit: the ceiling is honoured.
    const facade = new DefaultSimulatorFacade(registry);
    const engine = facade.compile(reloaded);
    facade.setConvergenceLogEnabled(true);
    await facade.stepToTime(engine, 1e-5);
    const dts = (facade.getConvergenceLog() ?? []).map(r => r.acceptedDt);
    expect(dts.length).toBeGreaterThan(0);
    expect(Math.max(...dts)).toBeLessThanOrEqual(1e-7 * 1.0001);
  });
});
