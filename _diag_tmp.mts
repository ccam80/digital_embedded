import { readFileSync } from 'fs';
import { createDefaultRegistry } from './src/components/register-all.js';
import { DefaultSimulatorFacade } from './src/headless/default-facade.js';
import type { AnalogEngine } from './src/core/analog-engine-interface.js';

const W = (s: string) => process.stdout.write(s + '\n');

try {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const json = readFileSync('fixtures/buckbjt.dts', 'utf-8');
  const circuit = facade.deserialize(json);
  const coordinator = facade.compile(circuit);
  const analog = coordinator.getAnalogEngine()! as any;
  
  // Access compiled circuit internals
  const compiled = analog._compiled;
  const elements = compiled.elements;
  const statePool = compiled.statePool;
  
  W('=== Elements ===');
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    W('  [' + i + '] reactive=' + el.isReactive + ' nonlinear=' + el.isNonlinear +
      ' hasLteTimestep=' + (typeof el.getLteTimestep === 'function') +
      ' schema=' + (el.stateSchema?.owner || 'none'));
  }
  
  W('\n=== State pool after DCOP ===');
  W('s0 length: ' + statePool.state0.length);
  W('tranStep: ' + statePool.tranStep);
  
  // Check Q values in state pool after DCOP for each reactive element
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el.isReactive || !el.stateSchema) continue;
    const base = el.stateBaseOffset;
    const slots = el.stateSchema.slots;
    W('\n  Element[' + i + '] ' + el.stateSchema.owner + ' base=' + base);
    for (let s = 0; s < slots.length; s++) {
      const val = statePool.state0[base + s];
      if (val !== 0) {
        W('    s0[' + slots[s].name + '] = ' + val);
      }
    }
    // Check s1 vs s0 for Q slots
    for (let s = 0; s < slots.length; s++) {
      const v0 = statePool.state0[base + s];
      const v1 = statePool.state1[base + s];
      if (v0 !== v1) {
        W('    DIFF s0 vs s1: ' + slots[s].name + ' s0=' + v0 + ' s1=' + v1);
      }
    }
  }
  
} catch (e: any) {
  W('ERROR: ' + e.message?.substring(0, 500));
}
