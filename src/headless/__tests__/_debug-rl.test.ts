/* eslint-disable */
// @ts-nocheck
import { describe, it } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';

const registry = createDefaultRegistry();

describe('debug RL step', () => {
  it('probe', async () => {
    globalThis.__INDUCTOR_DEBUG = true;
    globalThis.__INDUCTOR_DEBUG_COUNT = 0;

    const R = 10;
    const L = 1e-3;
    const tau = L / R;

    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: 'vs',  type: 'DcVoltageSource', props: { voltage: 0, label: 'Vs' } },
        { id: 'r1',  type: 'Resistor',        props: { resistance: R, label: 'VR' } },
        { id: 'l1',  type: 'Inductor',        props: { inductance: L } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos',  'r1:A'],
        ['r1:B',    'l1:A'],
        ['l1:B',    'gnd:out'],
        ['vs:neg',  'gnd:out'],
      ],
    });

    // Verify resistance prop was applied
    for (const el of (circuit as any).elements) {
      const props = el.getProperties?.();
      if (props) {
        try {
          const r = props.getModelParam?.('resistance');
          const l = props.getModelParam?.('inductance');
          if (r !== undefined || l !== undefined) {
            console.log(`[props] ${el.elementTypeName ?? el.type ?? '?'} resistance=${r} inductance=${l}`);
          }
        } catch {}
      }
    }
    console.log('=== COMPILE ===');
    const engine = facade.compile(circuit);
    console.log('=== SET SIGNAL 1V ===');
    facade.setSignal(engine, 'Vs', 1);
    console.log('=== STEP TO TAU ===');
    await facade.stepToTime(engine, tau);
    const vr = facade.readSignal(engine, 'VR');
    console.log(`VR(tau) = ${vr}`);
    globalThis.__INDUCTOR_DEBUG = false;
  });
});
