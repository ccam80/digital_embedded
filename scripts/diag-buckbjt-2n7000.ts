/**
 * Diagnostic: load fixtures/buckbjt.dts, swap M1's NMOS model to 2N7000,
 * enable the convergence log, step until failure or 200 steps, and dump the
 * blame element / dt-collapse pattern.
 *
 * Prints the per-step record so we can see exactly where convergence fails.
 */
import { readFileSync } from 'node:fs';
import { DefaultSimulatorFacade } from '../src/headless/default-facade.js';
import { createDefaultRegistry } from '../src/components/register-all.js';

const NMOS_2N7000_PARAMS: Record<string, number> = {
  VTO: 2.236, KP: 0.0932174, LAMBDA: 0, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1.0724e-11, CGSO: 1.79115e-7,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
};

const NMOS_BS170_PARAMS: Record<string, number> = {
  VTO: 1.824, KP: 0.1233, LAMBDA: 0, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 35e-12, CBS: 0, CGDO: 3e-12, CGSO: 28e-12,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
};

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toExponential(3);
}

function runWithModel(modelKey: string, params: Record<string, number>, label: string): void {
  console.log('');
  console.log('================================================================');
  console.log(` ${label}`);
  console.log('================================================================');

  const json = readFileSync('fixtures/buckbjt.dts', 'utf8');
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.deserialize(json);

  let nmosCount = 0;
  for (const el of circuit.elements) {
    if (el.typeId === 'NMOS') {
      const bag = el.getProperties();
      bag.set('model', modelKey);
      bag.replaceModelParams(params);
      nmosCount++;
    }
  }
  console.log(`Patched ${nmosCount} NMOS element(s) to model="${modelKey}"`);

  let coord;
  try {
    coord = facade.compile(circuit);
  } catch (e) {
    console.log(`COMPILE FAILED: ${(e as Error).message}`);
    return;
  }
  facade.setConvergenceLogEnabled(true);

  const maxSteps = 200;
  let stepFailedAt = -1;
  let lastErr: string | null = null;

  for (let i = 0; i < maxSteps; i++) {
    try {
      facade.step(coord, { clockAdvance: false });
    } catch (e) {
      stepFailedAt = i;
      lastErr = (e as Error).message;
      break;
    }
  }

  const log = facade.getConvergenceLog();
  if (log === null) {
    console.log('No convergence log (no analog domain?).');
    return;
  }

  console.log('');
  if (stepFailedAt >= 0) {
    console.log(`step() THREW at iteration ${stepFailedAt}: ${lastErr}`);
  } else {
    console.log(`step() ran ${maxSteps} times without throwing.`);
  }
  console.log(`Convergence log captured ${log.length} step records.`);
  console.log('');
  console.log('  # | simTime    | entryDt    | acceptedDt | outcome    | NRconv | iters | blameEl | blameNode | retries | lteRej | lteRatio');
  console.log('----|------------|------------|------------|------------|--------|-------|---------|-----------|---------|--------|---------');

  const tail = log.slice(Math.max(0, log.length - 40));
  for (const rec of tail) {
    const att = rec.attempts[rec.attempts.length - 1];
    const conv = att ? (att.converged ? 'Y' : 'N') : '?';
    const iters = att ? att.iterations : -1;
    const blameEl = att ? att.blameElement : -1;
    const blameNode = att ? att.blameNode : -1;
    console.log(
      `${String(rec.stepNumber).padStart(3)} | ${fmt(rec.simTime).padStart(10)} | ${fmt(rec.entryDt).padStart(10)} | ${fmt(rec.acceptedDt).padStart(10)} | ${rec.outcome.padEnd(10)} | ${conv.padStart(6)} | ${String(iters).padStart(5)} | ${String(blameEl).padStart(7)} | ${String(blameNode).padStart(9)} | ${String(rec.attempts.length).padStart(7)} | ${String(rec.lteRejected).padStart(6)} | ${fmt(rec.lteWorstRatio)}`,
    );
  }

  // If the last step has multiple attempts, dump them in detail
  const last = log[log.length - 1];
  if (last && last.attempts.length > 1) {
    console.log('');
    console.log(`Last step had ${last.attempts.length} NR attempts:`);
    for (let i = 0; i < last.attempts.length; i++) {
      const a = last.attempts[i];
      console.log(`  attempt ${i}: dt=${fmt(a.dt)} method=${a.method} iters=${a.iterations} converged=${a.converged} blameEl=${a.blameElement} blameNode=${a.blameNode} trigger=${a.trigger}`);
    }
  }

  // Dump element index → label mapping so we can decode blameElement
  console.log('');
  console.log('Element index → instanceId/typeId/label:');
  let idx = 0;
  for (const el of circuit.elements) {
    const label = el.getProperties().has('label') ? el.getProperties().get<string>('label') : '';
    console.log(`  [${idx}] typeId=${el.typeId.padEnd(20)} id=${el.instanceId.slice(0, 8)}.. label="${label}"`);
    idx++;
  }
}

runWithModel('2N7000',   NMOS_2N7000_PARAMS, 'Run 1 — 2N7000 stock (W=L=1u — BUG)');
runWithModel('2N7000',   { ...NMOS_2N7000_PARAMS, W: 100e-6, L: 100e-6 }, 'Run 2 — 2N7000 with MODPEX W=L=100u');
