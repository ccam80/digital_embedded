/**
 * Diagnostic probe for the diode-bridge parity hang.
 *
 * Loads the diode-bridge.dts fixture (the same one diode-bridge.test.ts uses)
 * via DefaultSimulatorFacade, enables the convergence log, and calls
 * dcOperatingPoint() with a watchdog timer. If DCOP doesn't return within
 * the budget, dump the convergence log to stderr to identify what the
 * solver was doing at hang time.
 *
 * Usage: npx tsx scripts/diag-diode-bridge-hang.ts [budget_ms]
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DefaultSimulatorFacade } from '../src/headless/default-facade.js';
import { createDefaultRegistry } from '../src/components/register-all.js';

const FIXTURE = resolve(
  process.cwd(),
  'src/solver/analog/__tests__/ngspice-parity/fixtures/diode-bridge.dts',
);
const BUDGET_MS = Number(process.argv[2] ?? 8000);

const registry = createDefaultRegistry();
const facade = new DefaultSimulatorFacade(registry);
const dts = readFileSync(FIXTURE, 'utf-8');
const circuit = facade.deserialize(dts);
const engine = facade.compile(circuit);
facade.setConvergenceLogEnabled(true);

console.error(`[probe] DCOP starting; budget=${BUDGET_MS}ms`);

const watchdog = setTimeout(() => {
  console.error(`[probe] WATCHDOG FIRED at ${BUDGET_MS}ms — dumping convergence log`);
  const log = facade.getConvergenceLog();
  if (!log || log.length === 0) {
    console.error('[probe] convergence log empty');
  } else {
    console.error(`[probe] log has ${log.length} step records`);
    for (const rec of log.slice(-10)) {
      const att0 = rec.attempts[0];
      console.error(
        `  step=${rec.stepNumber} simTime=${rec.simTime.toExponential(3)} ` +
        `entryDt=${rec.entryDt.toExponential(3)} acceptedDt=${rec.acceptedDt.toExponential(3)} ` +
        `attempts=${rec.attempts.length} method=${att0?.method ?? rec.entryMethod} ` +
        `iters=${att0?.iterations} blame=${(att0 as any)?.blameElement ?? '?'}`,
      );
    }
    if (log.length > 0) {
      const last = log[log.length - 1]!;
      console.error(`[probe] last record full:\n${JSON.stringify(last, null, 2)}`);
    }
  }
  process.exit(2);
}, BUDGET_MS);

const tDcop = Date.now();
const coord = engine as unknown as {
  dcOperatingPoint(): { converged: boolean };
  step(): unknown;
  simTime?: number;
};
const dcopRes = coord.dcOperatingPoint();
clearTimeout(watchdog);
const dcopMs = Date.now() - tDcop;
console.error(`[probe] DCOP returned in ${dcopMs}ms; converged=${dcopRes?.converged}`);

// Transient: walk steps with per-step budget. The parity test ran 33.3ms simulated
// at 100us maxStep — easily 300+ steps. Hang likely in here, not DCOP.
const STOP_SIM_TIME = 33.3e-3;
const PER_STEP_BUDGET_MS = 200;
let stepNum = 0;
const tTran0 = Date.now();
let stepWatchdog: NodeJS.Timeout | null = null;

while ((coord.simTime ?? 0) < STOP_SIM_TIME) {
  stepNum++;
  const stepStart = Date.now();
  const stepBudget = setTimeout(() => {
    console.error(
      `[probe] STEP WATCHDOG at step=${stepNum} simTime=${coord.simTime} ` +
      `(elapsed=${Date.now() - stepStart}ms, budget=${PER_STEP_BUDGET_MS}ms)`,
    );
    const log = facade.getConvergenceLog();
    if (log) {
      const recent = log.slice(-5);
      console.error(`[probe] last ${recent.length} convergence-log records:`);
      for (const rec of recent) {
        const att0 = rec.attempts[0];
        console.error(
          `  step=${rec.stepNumber} simTime=${rec.simTime?.toExponential(3)} ` +
          `entryDt=${rec.entryDt?.toExponential(3)} acceptedDt=${rec.acceptedDt?.toExponential(3)} ` +
          `attempts=${rec.attempts.length} method=${att0?.method ?? rec.entryMethod} ` +
          `iters=${att0?.iterations} conv=${(att0 as any)?.converged}`,
        );
      }
      const lastRec = log[log.length - 1];
      if (lastRec) {
        console.error(`[probe] last record full:\n${JSON.stringify(lastRec, null, 2).slice(0, 2000)}`);
      }
    } else {
      console.error('[probe] convergence log empty');
    }
    process.exit(2);
  }, PER_STEP_BUDGET_MS);
  stepWatchdog = stepBudget;

  try {
    coord.step();
  } catch (err) {
    clearTimeout(stepBudget);
    console.error(`[probe] step ${stepNum} threw at simTime=${coord.simTime}: ${(err as Error).message}`);
    process.exit(1);
  }
  clearTimeout(stepBudget);

  if (stepNum % 50 === 0) {
    console.error(
      `[probe] step ${stepNum} simTime=${coord.simTime?.toExponential(3)} ` +
      `(${Date.now() - tTran0}ms total)`,
    );
  }
  if (stepNum > 5000) {
    console.error(`[probe] EXCEEDED 5000 steps; aborting (likely runaway)`);
    process.exit(3);
  }
}

if (stepWatchdog) clearTimeout(stepWatchdog);
console.error(
  `[probe] transient complete: ${stepNum} steps, simTime=${coord.simTime}, ` +
  `total=${Date.now() - tTran0}ms`,
);
process.exit(0);
