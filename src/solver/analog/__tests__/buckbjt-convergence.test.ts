/**
 * Bit-exact DC-OP convergence parity tests for the buckbjt fixture against
 * ngspice: compares every NR iteration's rhsOld[], noncon, diagGmin, and
 * srcFact. Requires the instrumented ngspice DLL; gated on its presence.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { accessSync } from 'fs';
import { ComparisonSession } from './harness/comparison-session.js';
import type { NRPhase } from './harness/types.js';

// The ComparisonSession requires the instrumented ngspice DLL; gate the
// test on its presence so the suite does not produce a false red when
// run on a machine without the DLL.
const DLL_PATH = resolve(
  process.cwd(),
  'ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll',
);
try { accessSync(DLL_PATH); } catch { throw new Error('ngspice DLL required for buckbjt convergence test'); }
const describeIfDll = describe;

// Phases whose phaseParameter carries diagGmin (ngspice CKTdiagGmin).
const GMIN_PHASES: ReadonlySet<NRPhase> = new Set([
  'dcopGminDynamic',
  'dcopGminSpice3',
]);

// Phase whose phaseParameter carries srcFact (ngspice CKTsrcFact).
const SRCFACT_PHASE: NRPhase = 'dcopSrcSweep';

describeIfDll('buckbjt DC-OP per-NR-iteration parity (C4.3)', () => {
  it('buckbjt_load_dcop_parity: rhsOld + noncon + diagGmin + srcFact bit-exact vs ngspice', async () => {
    const session = new ComparisonSession({
      dtsPath: 'fixtures/buckbjt.dts',
      dllPath: DLL_PATH,
    });
    await session.init();
    await session.runDcOp();

    // Session is valid: ngspice bridge ran without error, and our side
    // produced at least one boot step (DC-OP always produces step 0).
    expect(session.errors).toEqual([]);

    const map = session.sessionMap();
    expect(map.analysis).toBe('dcop');
    expect(map.ours.stepCount).toBeGreaterThan(0);
    expect(map.ngspice.stepCount).toBeGreaterThan(0);

    // -----------------------------------------------------------------
    // Assert 3 + 4: per-attempt diagGmin / srcFact bit-exact
    // -----------------------------------------------------------------
    //
    // ngspice surfaces `CKTdiagGmin` and `CKTsrcFact` via the `phaseGmin`
    // and `phaseSrcFact` fields on each raw iteration; the bridge maps
    // those to the attempt-level `phaseParameter` property (see
    // `ngspice-bridge.ts` which assigns phaseParameter from phaseGmin on
    // gmin-stepping phases and from phaseSrcFact on dcopSrcSweep).
    //
    // On our side the phase-begin hook passes the same scalar through
    // `dc-operating-point.ts::PhaseBeginFn(phase, phaseParameter)` into
    // the capture's `beginAttempt(..., phaseParameter)` call. A bit-exact
    // match here means both engines entered the same sub-phase with the
    // same ramp value at the same attempt index.
    for (let s = 0; s < map.ours.stepCount; s++) {
      const ourStep = map.ours.steps[s];
      const ngStep  = map.ngspice.steps[s];
      expect(ngStep, `ngspice has no step ${s} (ours does)`).toBeDefined();

      // Pair attempts by (phase, phaseAttemptIndex): walk ours, assert
      // the corresponding ngspice attempt has bit-identical
      // phaseParameter. If ngspice lacks the attempt we still emit a
      // failing expectation rather than silently continuing.
      const phaseCounts = new Map<NRPhase, number>();
      for (const ourAtt of ourStep.attempts) {
        const idx = phaseCounts.get(ourAtt.phase) ?? 0;
        phaseCounts.set(ourAtt.phase, idx + 1);

        // Only the gmin-stepping and source-sweep phases carry a
        // meaningful phaseParameter scalar to compare. Other phases
        // (e.g. dcopDirect, dcopInitJct) do not parametrise the
        // per-attempt ramp, so there is nothing to compare there.
        const isGmin = GMIN_PHASES.has(ourAtt.phase);
        const isSrcSweep = ourAtt.phase === SRCFACT_PHASE;
        if (!isGmin && !isSrcSweep) continue;

        const detail = session.getAttempt({
          stepIndex: s,
          phase: ourAtt.phase,
          phaseAttemptIndex: idx,
        });

        const ourParam = detail.ourAttempt?.phaseParameter;
        const ngParam  = detail.ngspiceAttempt?.phaseParameter;

        if (isGmin) {
          // diagGmin bit-exact.
          expect(
            ourParam,
            `step ${s} ${ourAtt.phase}[${idx}]: our diagGmin missing`,
          ).not.toBeUndefined();
          expect(
            ngParam,
            `step ${s} ${ourAtt.phase}[${idx}]: ngspice diagGmin missing`,
          ).not.toBeUndefined();
          expect(
            ourParam,
            `step ${s} ${ourAtt.phase}[${idx}]: diagGmin divergence (ours=${ourParam}, ng=${ngParam})`,
          ).toBe(ngParam);
        } else {
          // srcFact bit-exact.
          expect(
            ourParam,
            `step ${s} ${SRCFACT_PHASE}[${idx}]: our srcFact missing`,
          ).not.toBeUndefined();
          expect(
            ngParam,
            `step ${s} ${SRCFACT_PHASE}[${idx}]: ngspice srcFact missing`,
          ).not.toBeUndefined();
          expect(
            ourParam,
            `step ${s} ${SRCFACT_PHASE}[${idx}]: srcFact divergence (ours=${ourParam}, ng=${ngParam})`,
          ).toBe(ngParam);
        }
      }
    }

    // -----------------------------------------------------------------
    // Assert 1 + 2: per-iteration rhsOld[] + noncon bit-exact
    // -----------------------------------------------------------------
    //
    // For every step, for every NR iteration of the accepted attempt:
    //   - rhs[label] is the preSolveRhs entry at `label`, which is
    //     ngspice's rhsOld[] at that node/branch.
    //   - noncon is the per-iteration convergence counter.
    //
    // `IterationReport` already exposes both as `ComparedValue`
    // (see `comparison-session.ts::getIterations`). We assert
    // `absDelta === 0` (bit-exact) on every label / iteration.
    for (let s = 0; s < map.ours.stepCount; s++) {
      const iters = session.getIterations(s);
      expect(iters.length, `step ${s}: no iterations captured`).toBeGreaterThan(0);

      for (const it of iters) {
        // noncon bit-exact- absDelta is |ours - ngspice|; 0 === bit-exact.
        expect(
          it.noncon.absDelta,
          `step ${s} iter ${it.iteration}: noncon divergence ours=${it.noncon.ours} ng=${it.noncon.ngspice}`,
        ).toBe(0);

        // rhsOld[] bit-exact for every labelled RHS entry.
        for (const [label, cv] of Object.entries(it.rhs)) {
          expect(
            cv.absDelta,
            `step ${s} iter ${it.iteration}: rhsOld[${label}] divergence ours=${cv.ours} ng=${cv.ngspice} absDelta=${cv.absDelta}`,
          ).toBe(0);
        }
      }
    }
  }, 120_000);
});

