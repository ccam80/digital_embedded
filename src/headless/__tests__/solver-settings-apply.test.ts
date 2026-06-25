/**
 * Per-circuit solver settings- applied at compile via the facade (Surface 1).
 *
 * Proves the metadata -> compile -> engine path (no manual configure() call):
 *  - a given reltol changes the solve and the step count;
 *  - a given maxTimeStep is a hard ceiling on the live step, while an absent
 *    one lets the speed/LTE-derived step grow past it (the givenness contract).
 */
import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import type { Circuit } from '../../core/circuit.js';

const registry = createDefaultRegistry();

/** Half-wave rectifier whose diode nonlinearity is reltol-sensitive. */
function buildRectifier(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: 'vs', type: 'AcVoltageSource', props: { amplitude: 5, frequency: 500, phase: 0, dcOffset: 0, waveform: 'sine', label: 'Vs' } },
      { id: 'r1', type: 'Resistor', props: { resistance: 100 } },
      { id: 'd1', type: 'Diode', props: { label: 'D1' } },
      { id: 'rload', type: 'Resistor', props: { resistance: 1000, label: 'Vc' } },
      { id: 'c1', type: 'Capacitor', props: { capacitance: 10e-6 } },
      { id: 'gnd', type: 'Ground' },
    ],
    connections: [
      ['vs:pos', 'r1:pos'], ['r1:neg', 'd1:A'], ['d1:K', 'rload:pos'],
      ['d1:K', 'c1:pos'], ['rload:neg', 'gnd:out'], ['c1:neg', 'gnd:out'], ['vs:neg', 'gnd:out'],
    ],
  });
}

/** Slow RC (tau = 1 ms) so an uncapped run quickly takes steps well above 1e-7 s. */
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

describe('solver settings applied at compile', () => {
  it('a given reltol changes the solve and step count', async () => {
    const target = 4e-3;

    const fLoose = new DefaultSimulatorFacade(registry);
    const cLoose = buildRectifier(fLoose);
    // Both fix maxTimeStep so only reltol differs; loose reltol defaults to 1e-3.
    cLoose.metadata.solverSettings = { maxTimeStep: 1e-3 };
    const eLoose = fLoose.compile(cLoose);
    fLoose.setConvergenceLogEnabled(true);
    await fLoose.stepToTime(eLoose, target);
    const vcLoose = fLoose.readSignal(eLoose, 'Vc:pos');
    const stepsLoose = fLoose.getConvergenceLog()?.length ?? 0;

    const fTight = new DefaultSimulatorFacade(registry);
    const cTight = buildRectifier(fTight);
    cTight.metadata.solverSettings = { reltol: 1e-6, maxTimeStep: 1e-3 };
    const eTight = fTight.compile(cTight);
    fTight.setConvergenceLogEnabled(true);
    await fTight.stepToTime(eTight, target);
    const vcTight = fTight.readSignal(eTight, 'Vc:pos');
    const stepsTight = fTight.getConvergenceLog()?.length ?? 0;

    expect(vcLoose).not.toBe(vcTight);
    expect(stepsTight).toBeGreaterThan(stepsLoose);
  });

  it('a given maxTimeStep caps the step; absent lets it grow past', async () => {
    // Capped run: tiny ceiling -> every accepted step <= 1e-7 s.
    const fCap = new DefaultSimulatorFacade(registry);
    const cCap = buildRC(fCap);
    cCap.metadata.solverSettings = { maxTimeStep: 1e-7 };
    const eCap = fCap.compile(cCap);
    fCap.setConvergenceLogEnabled(true);
    await fCap.stepToTime(eCap, 1e-5);
    const dtsCap = (fCap.getConvergenceLog() ?? []).map(r => r.acceptedDt);
    expect(dtsCap.length).toBeGreaterThan(0);
    expect(Math.max(...dtsCap)).toBeLessThanOrEqual(1e-7 * 1.0001);

    // Free run: no given maxTimeStep -> speed/LTE derive a much larger step.
    const fFree = new DefaultSimulatorFacade(registry);
    const cFree = buildRC(fFree);
    const eFree = fFree.compile(cFree);
    fFree.setConvergenceLogEnabled(true);
    await fFree.stepToTime(eFree, 1e-4);
    const dtsFree = (fFree.getConvergenceLog() ?? []).map(r => r.acceptedDt);
    expect(dtsFree.length).toBeGreaterThan(0);
    expect(Math.max(...dtsFree)).toBeGreaterThan(1e-7);
  });
});
