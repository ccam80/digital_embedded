import { describe, it } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';

const registry = createDefaultRegistry();

function fmt(n: number) { return n.toExponential(6); }

describe('DIAGNOSTIC RC step response R=1k C=1uF tau=1ms V=5V', () => {
  it('prints per-step Vc vs analytical', async () => {
    const R = 1000, C = 1e-6, tau = R * C, V = 5;
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: 'vs',  type: 'DcVoltageSource', props: { voltage: 0, label: 'Vs' } },
        { id: 'r1',  type: 'Resistor',        props: { resistance: R } },
        { id: 'c1',  type: 'Capacitor',       props: { capacitance: C, label: 'Vc' } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos', 'r1:A'],
        ['r1:B',   'c1:pos'],
        ['c1:neg', 'gnd:out'],
        ['vs:neg', 'gnd:out'],
      ],
    });
    const engine = facade.compile(circuit);
    facade.setConvergenceLogEnabled(true);
    facade.setSignal(engine, 'Vs', V);
    console.log('');
    console.log('=== RC DIAGNOSTIC ===');
    console.log('R=1k  C=1uF  tau=1ms  Vsrc=5V');
    console.log('step | simTime(s)       | dt(s)           | Vc_actual(V)    | Vc_expected(V)  | error%');
    console.log('-----|-----------------|-----------------|-----------------|-----------------|--------');
    const numSamples = 20, tEnd = 5 * tau, dtStep = tEnd / numSamples;
    let prevVc = 0, prevTime = 0, anyChange = false;
    for (let i = 1; i <= numSamples; i++) {
      const targetTime = dtStep * i;
      await facade.stepToTime(engine, targetTime);
      const vc = facade.readSignal(engine, 'Vc:pos');
      const t = engine.simTime ?? targetTime;
      const expected = V * (1 - Math.exp(-t / tau));
      const errPct = expected !== 0 ? ((vc - expected) / expected) * 100 : 0;
      if (vc !== prevVc) anyChange = true;
      console.log('  ' + String(i).padStart(2) + ' | ' + fmt(t) + '  | ' + fmt(t - prevTime) + '  | ' + fmt(vc) + '  | ' + fmt(expected) + '  | ' + errPct.toFixed(3) + '%');
      prevVc = vc; prevTime = t;
    }
    console.log('');
    console.log('Capacitor voltage changed: ' + anyChange);
    console.log('Final Vc: ' + fmt(prevVc) + ' V  expected ~' + fmt(V * (1 - Math.exp(-5))) + ' V');
    const log = facade.getConvergenceLog();
    if (log && log.length > 0) {
      console.log('');
      console.log('--- Convergence log (' + log.length + ' steps) ---');
      console.log('step | simTime         | entryDt         | acceptedDt      | method    | NRiters | lteRatio    | lteRejected');
      console.log('-----|-----------------|-----------------|-----------------|-----------|---------|-------------|------------');
      for (const rec of log) {
        const att = rec.attempts[0];
        const iters = att ? att.iterations : '?';
        const method = att ? att.method : rec.entryMethod;
        console.log('  ' + String(rec.stepNumber).padStart(2) + ' | ' + fmt(rec.simTime) + '  | ' + fmt(rec.entryDt) + '  | ' + fmt(rec.acceptedDt) + '  | ' + String(method).padEnd(9) + ' | ' + String(iters).padStart(7) + ' | ' + fmt(rec.lteWorstRatio) + ' | ' + rec.lteRejected);
      }
    } else { console.log('Convergence log: empty or disabled'); }
  });
});

describe('DIAGNOSTIC RL step response R=1k L=1H tau=1ms V=5V', () => {
  it('prints per-step V_R vs analytical', async () => {
    const R = 1000, L = 1, tau = L / R, V = 5;
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: 'vs',  type: 'DcVoltageSource', props: { voltage: 0, label: 'Vs' } },
        { id: 'r1',  type: 'Resistor',        props: { resistance: R, label: 'VR' } },
        { id: 'l1',  type: 'Inductor',        props: { inductance: L } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos', 'r1:A'],
        ['r1:B',   'l1:A'],
        ['l1:B',   'gnd:out'],
        ['vs:neg', 'gnd:out'],
      ],
    });
    const engine = facade.compile(circuit);
    facade.setConvergenceLogEnabled(true);
    facade.setSignal(engine, 'Vs', V);
    console.log('');
    console.log('=== RL DIAGNOSTIC ===');
    console.log('R=1k  L=1H  tau=1ms  Vsrc=5V');
    console.log('V_R(t) = V*exp(-t/tau)  (decays from V to 0 as L charges)');
    console.log('step | simTime(s)       | dt(s)           | VR_actual(V)    | VR_expected(V)  | error%');
    console.log('-----|-----------------|-----------------|-----------------|-----------------|--------');
    const numSamples = 20, tEnd = 5 * tau, dtStep = tEnd / numSamples;
    let prevVR = 0, prevTime = 0, anyChange = false;
    for (let i = 1; i <= numSamples; i++) {
      const targetTime = dtStep * i;
      await facade.stepToTime(engine, targetTime);
      const vA = facade.readSignal(engine, 'VR:A');
      const vB = facade.readSignal(engine, 'VR:B');
      const vR = vA - vB;
      const t = engine.simTime ?? targetTime;
      const expected = V * Math.exp(-t / tau);
      const errPct = expected !== 0 ? ((vR - expected) / expected) * 100 : 0;
      if (vR !== prevVR) anyChange = true;
      console.log('  ' + String(i).padStart(2) + ' | ' + fmt(t) + '  | ' + fmt(t - prevTime) + '  | ' + fmt(vR) + '  | ' + fmt(expected) + '  | ' + errPct.toFixed(3) + '%');
      prevVR = vR; prevTime = t;
    }
    console.log('');
    console.log('Resistor voltage changed: ' + anyChange);
    console.log('Final V_R: ' + fmt(prevVR) + ' V  expected ~' + fmt(V * Math.exp(-5)) + ' V');
    const log = facade.getConvergenceLog();
    if (log && log.length > 0) {
      console.log('');
      console.log('--- Convergence log (' + log.length + ' steps) ---');
      console.log('step | simTime         | entryDt         | acceptedDt      | method    | NRiters | lteRatio    | lteRejected');
      console.log('-----|-----------------|-----------------|-----------------|-----------|---------|-------------|------------');
      for (const rec of log) {
        const att = rec.attempts[0];
        const iters = att ? att.iterations : '?';
        const method = att ? att.method : rec.entryMethod;
        console.log('  ' + String(rec.stepNumber).padStart(2) + ' | ' + fmt(rec.simTime) + '  | ' + fmt(rec.entryDt) + '  | ' + fmt(rec.acceptedDt) + '  | ' + String(method).padEnd(9) + ' | ' + String(iters).padStart(7) + ' | ' + fmt(rec.lteWorstRatio) + ' | ' + rec.lteRejected);
      }
    } else { console.log('Convergence log: empty or disabled'); }
  });
});
