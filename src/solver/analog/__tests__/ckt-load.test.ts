/**
 * Tests for cktLoad — single-pass device load function.
 *
 * Test groups:
 *   Stamping        — migrated end-to-end solve tests from mna-assembler.test.ts
 *   CKTload         — cktLoad-specific behaviour (single pass, nodesets, noncon)
 *   E_SINGULAR      — Phase 0 E_SINGULAR recovery via cktLoad re-run
 */

import { describe, it, expect } from 'vitest';
import { cktLoad } from '../ckt-load.js';
import {
  makeResistor,
  makeVoltageSource,
  makeCurrentSource,
  makeDiode,
  makeSimpleCtx,
  allocateStatePool,
} from './test-helpers.js';
import { newtonRaphson } from '../newton-raphson.js';
import { SparseSolver } from '../sparse-solver.js';

// ---------------------------------------------------------------------------
// Stamping tests — migrated from mna-assembler.test.ts
// ---------------------------------------------------------------------------

describe('Stamping', () => {
  it('resistor_divider_dc', () => {
    const nodeCount = 2;
    const branchCount = 1;
    const matrixSize = nodeCount + branchCount;
    const R1 = makeResistor(1, 2, 1000);
    const R2 = makeResistor(2, 0, 1000);
    const Vs = makeVoltageSource(1, 0, nodeCount, 5);
    const elements = [R1, R2, Vs];
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, branchCount });
    ctx.isDcOp = true;
    ctx.isTransient = false;
    ctx.initMode = 'initFloat';
    newtonRaphson(ctx);
    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.voltages[0]).toBeCloseTo(5.0, 8);
    expect(ctx.nrResult.voltages[1]).toBeCloseTo(2.5, 8);
  });

  it('two_voltage_sources_series', () => {
    const nodeCount = 2;
    const branchCount = 2;
    const matrixSize = nodeCount + branchCount;
    const R = makeResistor(2, 0, 1000);
    const V1 = makeVoltageSource(1, 0, nodeCount, 3);
    const V2src = makeVoltageSource(2, 1, nodeCount + 1, 2);
    const elements = [R, V1, V2src];
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, branchCount });
    ctx.isDcOp = true;
    ctx.isTransient = false;
    ctx.initMode = 'initFloat';
    newtonRaphson(ctx);
    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.voltages[0]).toBeCloseTo(3.0, 8);
    expect(ctx.nrResult.voltages[1]).toBeCloseTo(5.0, 8);
    expect(ctx.nrResult.voltages[1] / 1000).toBeCloseTo(5e-3, 8);
  });

  it('current_source_with_resistor', () => {
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const I = makeCurrentSource(1, 0, 1e-3);
    const R = makeResistor(1, 0, 1000);
    const elements = [I, R];
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, branchCount: 0 });
    ctx.isDcOp = true;
    ctx.isTransient = false;
    ctx.initMode = 'initFloat';
    newtonRaphson(ctx);
    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.nrResult.voltages[0]).toBeCloseTo(1.0, 8);
  });
});

// ---------------------------------------------------------------------------
// CKTload tests — Task 2.2.1 / 2.2.3 required tests
// ---------------------------------------------------------------------------

describe('CKTload', () => {
  it('single_pass_stamps_all_contributions', () => {
    const nodeCount = 2;
    const branchCount = 1;
    const matrixSize = nodeCount + branchCount;
    const Vs = makeVoltageSource(1, 0, 2, 5.0);
    const R = makeResistor(1, 2, 1000);
    const diode = makeDiode(2, 0, 1e-14, 1.0);
    const elements = [Vs, R, diode];
    const statePool = allocateStatePool(elements);
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, branchCount, statePool });
    ctx.isDcOp = true;
    ctx.isTransient = false;
    ctx.initMode = 'initFloat';
    cktLoad(ctx, 0);
    const factorResult = ctx.solver.factor();
    expect(factorResult.success).toBe(true);
    const solution = new Float64Array(matrixSize);
    ctx.solver.solve(solution);
    expect(Number.isFinite(solution[0])).toBe(true);
    expect(Number.isFinite(solution[1])).toBe(true);
  });

  it('nodesets_applied_after_device_loads', () => {
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctxJct = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctxJct.isDcOp = true;
    ctxJct.isTransient = false;
    ctxJct.initMode = 'initJct';
    ctxJct.nodesets.set(0, 3.0);
    cktLoad(ctxJct, 0);
    const factJct = ctxJct.solver.factor();
    expect(factJct.success).toBe(true);
    const solJct = new Float64Array(matrixSize);
    ctxJct.solver.solve(solJct);
    expect(solJct[0]).toBeCloseTo(3.0, 3);
    const IS = makeCurrentSource(1, 0, 1e-3);
    const ctxFloat = makeSimpleCtx({ elements: [IS, R], matrixSize, nodeCount, branchCount: 0 });
    ctxFloat.isDcOp = true;
    ctxFloat.isTransient = false;
    ctxFloat.initMode = 'initFloat';
    ctxFloat.nodesets.set(0, 3.0);
    cktLoad(ctxFloat, 0);
    const factFloat = ctxFloat.solver.factor();
    expect(factFloat.success).toBe(true);
    const solFloat = new Float64Array(matrixSize);
    ctxFloat.solver.solve(solFloat);
    expect(solFloat[0]).toBeCloseTo(1.0, 6);
  });

  it('noncon_incremented_by_device_limiting', () => {
    const nodeCount = 2;
    const branchCount = 1;
    const matrixSize = nodeCount + branchCount;
    const Vs = makeVoltageSource(1, 0, 2, 5.0);
    const R = makeResistor(1, 2, 1000);
    const diode = makeDiode(2, 0, 1e-14, 1.0);
    const elements = [Vs, R, diode];
    const statePool = allocateStatePool(elements);
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, branchCount, statePool });
    ctx.isDcOp = true;
    ctx.isTransient = false;
    ctx.initMode = 'initFloat';
    cktLoad(ctx, 0);
    // nodeAnode=2 -> voltages index 1; set anode to 5V to trigger pnjlim
    ctx.rhsOld.set([0.0, 5.0, 0.0]);
    cktLoad(ctx, 1);
    expect(ctx.noncon).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// nodesets — C7.1 srcFact scaling
// ---------------------------------------------------------------------------

describe('nodesets', () => {
  it('srcFact_scales_nodeset_rhs', () => {
    // ngspice cktload.c:96-136: nodeset RHS = CKTNS_PIN * value * srcFact
    // CKTNS_PIN = 1e10, value = 2.5, srcFact = 0.5 → expected = 1e10 * 2.5 * 0.5
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.isDcOp = true;
    ctx.isTransient = false;
    ctx.initMode = 'initJct';
    ctx.srcFact = 0.5;
    ctx.nodesets.set(0, 2.5);
    cktLoad(ctx, 0);
    const rhs = ctx.solver.getRhsSnapshot();
    expect(rhs[0]).toBe(1e10 * 2.5 * 0.5);
  });
});

// ---------------------------------------------------------------------------
// ics — C7.1 IC stamping in initJct / outside init modes
// ---------------------------------------------------------------------------

describe('ics', () => {
  it('ic_stamped_in_initJct', () => {
    // ngspice cktload.c:96-136: IC RHS = CKTNS_PIN * value * srcFact
    // CKTNS_PIN = 1e10, value = 1.2, srcFact = 1.0 → expected = 1e10 * 1.2
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.isDcOp = true;
    ctx.isTransient = false;
    ctx.initMode = 'initJct';
    ctx.srcFact = 1.0;
    ctx.ics.set(0, 1.2);
    cktLoad(ctx, 0);
    const rhs = ctx.solver.getRhsSnapshot();
    expect(rhs[0]).toBe(1e10 * 1.2);
  });

  it('ic_not_stamped_outside_init_modes', () => {
    // With initMode = "floating" (not initJct or initFix), IC must NOT stamp RHS
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.isDcOp = true;
    ctx.isTransient = false;
    ctx.initMode = 'floating' as never;
    ctx.srcFact = 1.0;
    ctx.ics.set(0, 3.3);
    cktLoad(ctx, 0);
    const rhs = ctx.solver.getRhsSnapshot();
    // RHS[0] should only reflect the resistor stamp (which is 0 for a linear resistor
    // with no current source — resistor stamps G into the matrix, 0 into RHS)
    expect(rhs[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E_SINGULAR recovery test — Task 2.2.3
// ---------------------------------------------------------------------------

describe('E_SINGULAR', () => {
  it('e_singular_recovery_via_cktLoad', () => {
    const nodeCount = 2;
    const branchCount = 1;
    const matrixSize = nodeCount + branchCount;
    const Vs = makeVoltageSource(1, 0, 2, 5.0);
    const R = makeResistor(1, 2, 1000);
    const elements = [Vs, R];

    let factorCallCount = 0;

    const realSolver = new SparseSolver();

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === 'factor') {
          return () => {
            factorCallCount++;
            if (factorCallCount === 1) {
              return { success: false };
            }
            return (target as SparseSolver).factor();
          };
        }
        if (prop === 'lastFactorUsedReorder') {
          return factorCallCount >= 2 ? true : false;
        }
        if (prop === 'forceReorder') {
          return () => {
            return (target as SparseSolver).forceReorder();
          };
        }
        const val = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === 'function') return val.bind(target);
        return val;
      },
    }) as SparseSolver;

    const ctx = makeSimpleCtx({ solver: proxySolver, elements, matrixSize, nodeCount, branchCount });
    ctx.isDcOp = true;

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(factorCallCount).toBeGreaterThanOrEqual(2);
    expect(ctx.solver.lastFactorUsedReorder).toBe(true);
    expect(ctx.nrResult.iterations).toBe(3);
  });
});
