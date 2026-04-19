/**
 * Scratch reproducer for RC step response test in rlc-lte-path.test.ts.
 * DO NOT COMMIT.  Run with: npx tsx scripts/repro-rlc-lte-trace.mts
 */
import { DefaultSimulatorFacade } from '../src/headless/default-facade.js';
import { createDefaultRegistry } from '../src/components/register-all.js';
import { DefaultSimulationCoordinator } from '../src/solver/coordinator.js';
import { MNAEngine } from '../src/solver/analog/analog-engine.js';

const registry = createDefaultRegistry();
const facade = new DefaultSimulatorFacade(registry);

const R = 1000;
const C = 1e-6;
const tau = R * C; // 1ms

const circuit = facade.build({
  components: [
    { id: 'vs',  type: 'DcVoltageSource', props: { voltage: 0, label: 'Vs' } },
    { id: 'r1',  type: 'Resistor',        props: { resistance: R } },
    { id: 'c1',  type: 'Capacitor',       props: { capacitance: C, label: 'Vc' } },
    { id: 'gnd', type: 'Ground' },
  ],
  connections: [
    ['vs:pos',  'r1:A'],
    ['r1:B',    'c1:pos'],
    ['c1:neg',  'gnd:out'],
    ['vs:neg',  'gnd:out'],
  ],
});

const coord = facade.compile(circuit) as DefaultSimulationCoordinator;
const analog = coord.getAnalogEngine() as MNAEngine;

function readVc() { return facade.readSignal(coord, 'Vc:pos'); }
function state() {
  return {
    simTime: analog.simTime,
    currentDt: (analog as any).currentDt,
    order: (analog as any).integrationOrder,
    firsttime: (analog as any)._firsttime,
    Vc: readVc(),
  };
}

console.log('=== After compile+initialize (DCOP with Vs=0) ===');
console.log(state());

console.log('=== Calling setSignal("Vs", 5) ===');
facade.setSignal(coord, 'Vs', 5);
console.log(state());

console.log('=== Single-step trace ===');
console.log('step |       simTime |           dt | order | firsttime |        Vc');
let prevVc = 0;
let crossed3V = false, crossed4V = false;
for (let i = 0; i < 80; i++) {
  try {
    (coord as any).step();
  } catch (e: any) {
    console.log('THROW at step', i, ':', e.message);
    break;
  }
  const s = state();
  console.log(
    `${String(i).padStart(4)} | ${s.simTime.toExponential(4)} | ${s.currentDt.toExponential(3)} | ${String(s.order).padStart(5)} | ${String(s.firsttime).padStart(9)} | ${s.Vc.toFixed(5)}`
  );
  if (!crossed3V && s.Vc >= 3.0) { console.log(`   => crossed 3V at step ${i}, simTime=${s.simTime.toExponential(3)}`); crossed3V = true; }
  if (!crossed4V && s.Vc >= 4.0) { console.log(`   => crossed 4V at step ${i}, simTime=${s.simTime.toExponential(3)}`); crossed4V = true; }
  prevVc = s.Vc;
  if (s.simTime >= tau * 5.2) break;
  if (s.Vc >= 4.99) break;
}

console.log('\n=== Expected at t=tau: ~3.1606V ===');
console.log('Actual Vc at latest simTime:', prevVc.toFixed(5));
