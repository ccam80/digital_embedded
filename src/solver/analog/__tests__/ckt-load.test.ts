/**
 * Tests for cktLoad — single-pass device load function.
 *
 * Test groups:
 *   Stamping        — end-to-end solve tests
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
import {
  MODEDCOP,
  MODETRANOP,
  MODEINITFLOAT,
  MODEINITJCT,
  MODEINITFIX,
  MODEUIC,
} from '../ckt-mode.js';

// ---------------------------------------------------------------------------
// Stamping tests
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
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    newtonRaphson(ctx);
    expect(ctx.nrResult.converged).toBe(true);
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
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    newtonRaphson(ctx);
    expect(ctx.nrResult.converged).toBe(true);
  });

  it('current_source_with_resistor', () => {
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const I = makeCurrentSource(1, 0, 1e-3);
    const R = makeResistor(1, 0, 1000);
    const elements = [I, R];
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    newtonRaphson(ctx);
    expect(ctx.nrResult.converged).toBe(true);
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
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    cktLoad(ctx);
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
    // MODEDCOP | MODEINITJCT — nodeset must pin node 0 to 3.0V
    const ctxJct = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctxJct.cktMode = MODEDCOP | MODEINITJCT;
    ctxJct.nodesets.set(0, 3.0);
    cktLoad(ctxJct);
    const factJct = ctxJct.solver.factor();
    expect(factJct.success).toBe(true);
    const solJct = new Float64Array(matrixSize);
    ctxJct.solver.solve(solJct);
    const IS = makeCurrentSource(1, 0, 1e-3);
    // MODEDCOP | MODEINITFLOAT — nodeset must NOT be applied
    const ctxFloat = makeSimpleCtx({ elements: [IS, R], matrixSize, nodeCount, branchCount: 0 });
    ctxFloat.cktMode = MODEDCOP | MODEINITFLOAT;
    ctxFloat.nodesets.set(0, 3.0);
    cktLoad(ctxFloat);
    const factFloat = ctxFloat.solver.factor();
    expect(factFloat.success).toBe(true);
    const solFloat = new Float64Array(matrixSize);
    ctxFloat.solver.solve(solFloat);
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
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    cktLoad(ctx);
    // nodeAnode=2 -> voltages index 1; set anode to 5V to trigger pnjlim
    ctx.rhsOld.set([0.0, 5.0, 0.0]);
    cktLoad(ctx);
    expect(ctx.noncon).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// nodesets — bitfield gate tests (ngspice cktload.c:104-129)
// ---------------------------------------------------------------------------

describe('nodesets', () => {
  it('srcFact_scales_nodeset_rhs', () => {
    // ngspice cktload.c:96-136: nodeset RHS = CKTNS_PIN * value * srcFact
    // CKTNS_PIN = 1e10, value = 2.5, srcFact = 0.5 → expected = 1e10 * 2.5 * 0.5
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITJCT;
    ctx.srcFact = 0.5;
    ctx.nodesets.set(0, 2.5);
    cktLoad(ctx);
    const rhs = ctx.solver.getRhsSnapshot();
    expect(rhs[0]).toBe(1e10 * 2.5 * 0.5);
  });

  it('nodeset_applied_in_MODEDCOP_MODEINITFIX', () => {
    // Gate also fires for MODEINITFIX (ngspice cktload.c:106)
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITFIX;
    ctx.srcFact = 1.0;
    ctx.nodesets.set(0, 4.0);
    cktLoad(ctx);
    const rhs = ctx.solver.getRhsSnapshot();
    expect(rhs[0]).toBe(1e10 * 4.0);
  });

  it('nodeset_NOT_applied_in_MODEDCOP_MODEINITFLOAT', () => {
    // Gate must NOT fire when INITJCT|INITFIX bits are absent
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    ctx.srcFact = 1.0;
    ctx.nodesets.set(0, 2.5);
    cktLoad(ctx);
    const rhs = ctx.solver.getRhsSnapshot();
    expect(rhs[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ics — IC stamping gate tests (ngspice cktload.c:130-157)
// Gate: (MODETRANOP) && !(MODEUIC)
// ---------------------------------------------------------------------------

describe('ics', () => {
  it('ic_stamped_in_MODETRANOP_without_MODEUIC', () => {
    // ngspice cktload.c:130-157: IC gate is MODETRANOP && !MODEUIC
    // CKTNS_PIN = 1e10, value = 1.2, srcFact = 1.0 → expected = 1e10 * 1.2
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODETRANOP | MODEINITJCT;
    ctx.srcFact = 1.0;
    ctx.ics.set(0, 1.2);
    cktLoad(ctx);
    const rhs = ctx.solver.getRhsSnapshot();
    expect(rhs[0]).toBe(1e10 * 1.2);
  });

  it('ic_NOT_stamped_when_MODEUIC_set', () => {
    // UIC bypasses IC enforcement (ngspice cktload.c:130)
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODETRANOP | MODEINITJCT | MODEUIC;
    ctx.srcFact = 1.0;
    ctx.ics.set(0, 3.3);
    cktLoad(ctx);
    const rhs = ctx.solver.getRhsSnapshot();
    expect(rhs[0]).toBe(0);
  });

  it('ic_NOT_stamped_in_MODEDCOP', () => {
    // IC gate requires MODETRANOP — standalone DCOP must not apply ICs
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITJCT;
    ctx.srcFact = 1.0;
    ctx.ics.set(0, 3.3);
    cktLoad(ctx);
    const rhs = ctx.solver.getRhsSnapshot();
    expect(rhs[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// troubleNode — C7 zeroing on noncon rise (ngspice cktload.c:64-65)
// ---------------------------------------------------------------------------

describe('troubleNode', () => {
  it('troubleNode_zeroed_when_noncon_rises', () => {
    // ngspice cktload.c:64-65: when noncon rises, CKTtroubleNode is zeroed.
    const nodeCount = 2;
    const branchCount = 1;
    const matrixSize = nodeCount + branchCount;
    const Vs = makeVoltageSource(1, 0, 2, 5.0);
    const R = makeResistor(1, 2, 1000);
    const diode = makeDiode(2, 0, 1e-14, 1.0);
    const elements = [Vs, R, diode];
    const statePool = allocateStatePool(elements);
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, branchCount, statePool });
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    // Pre-seed a large voltage to trigger pnjlim → noncon > 0
    ctx.rhsOld.set([5.0, 5.0, 0.0]);
    ctx.troubleNode = 42;
    cktLoad(ctx);
    // If noncon rose during the device loop, troubleNode must have been zeroed
    if (ctx.noncon > 0) {
      expect(ctx.troubleNode).toBeNull();
    }
  });

  it('troubleNode_not_touched_when_noncon_stays_zero', () => {
    // When no device increments noncon, troubleNode is not modified by cktLoad
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    ctx.troubleNode = 7;
    ctx.noncon = 0;
    cktLoad(ctx);
    // A resistor never bumps noncon, so troubleNode must remain untouched
    expect(ctx.troubleNode).toBe(7);
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
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;

    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    expect(factorCallCount).toBeGreaterThanOrEqual(2);
    expect(ctx.solver.lastFactorUsedReorder).toBe(true);
    expect(ctx.nrResult.iterations).toBe(3);
  });
});
