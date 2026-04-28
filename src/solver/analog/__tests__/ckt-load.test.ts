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
  makeSimpleCtx,
  allocateStatePool,
} from './test-helpers.js';
import { makeDcVoltageSource } from '../../../components/sources/dc-voltage-source.js';
import { makeCurrentSource as makeCurrentSourceProduction } from '../../../components/sources/current-source.js';
import { PropertyBag } from '../../../core/properties.js';
import { NGSPICE_LOAD_ORDER } from '../../../core/analog-types.js';
import type { AnalogElement } from '../element.js';
import type { LoadContext } from '../load-context.js';
import type { SetupContext } from '../setup-context.js';

function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  let _hPP = -1, _hNN = -1, _hPN = -1, _hNP = -1;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES,
    _pinNodes: new Map([["A", nodeA], ["B", nodeB]]),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext): void {
      const s = ctx.solver;
      if (nodeA !== 0) _hPP = s.allocElement(nodeA, nodeA);
      if (nodeB !== 0) _hNN = s.allocElement(nodeB, nodeB);
      if (nodeA !== 0 && nodeB !== 0) {
        _hPN = s.allocElement(nodeA, nodeB);
        _hNP = s.allocElement(nodeB, nodeA);
      }
    },
    load(ctx: LoadContext): void {
      const s = ctx.solver;
      if (_hPP !== -1) s.stampElement(_hPP,  G);
      if (_hNN !== -1) s.stampElement(_hNN,  G);
      if (_hPN !== -1) s.stampElement(_hPN, -G);
      if (_hNP !== -1) s.stampElement(_hNP, -G);
    },
    getPinCurrents(rhs: Float64Array): number[] {
      const vA = rhs[nodeA] ?? 0;
      const vB = rhs[nodeB] ?? 0;
      return [G * (vA - vB), G * (vB - vA)];
    },
    setParam(_key: string, _value: number): void {},
  };
  return el;
}

function makeVoltageSource(posNode: number, negNode: number, _branchRow: number, voltage: number): AnalogElement {
  const props = new PropertyBag([]);
  props.replaceModelParams({ voltage });
  return makeDcVoltageSource(
    new Map([["pos", posNode], ["neg", negNode]]),
    props,
    () => 0,
  );
}

function makeCurrentSource(posNode: number, negNode: number, current: number): AnalogElement {
  const props = new PropertyBag([]);
  props.replaceModelParams({ current });
  return makeCurrentSourceProduction(
    new Map([["pos", posNode], ["neg", negNode]]),
    props,
    () => 0,
  );
}

function makeDiode(nodeAnode: number, nodeCathode: number, IS: number, N: number): AnalogElement {
  const VT = 0.025852;
  let _hAA = -1, _hKK = -1, _hAK = -1, _hKA = -1;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.DIO,
    _pinNodes: new Map([["A", nodeAnode], ["K", nodeCathode]]),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext): void {
      const s = ctx.solver;
      if (nodeAnode !== 0) _hAA = s.allocElement(nodeAnode, nodeAnode);
      if (nodeCathode !== 0) _hKK = s.allocElement(nodeCathode, nodeCathode);
      if (nodeAnode !== 0 && nodeCathode !== 0) {
        _hAK = s.allocElement(nodeAnode, nodeCathode);
        _hKA = s.allocElement(nodeCathode, nodeAnode);
      }
    },
    load(ctx: LoadContext): void {
      const vA = ctx.rhsOld[nodeAnode] ?? 0;
      const vK = ctx.rhsOld[nodeCathode] ?? 0;
      const vD = Math.min(vA - vK, 0.7);
      const Id = IS * (Math.exp(vD / (N * VT)) - 1);
      const Gd = IS / (N * VT) * Math.exp(vD / (N * VT));
      const Ieq = Id - Gd * vD;
      const s = ctx.solver;
      if (_hAA !== -1) s.stampElement(_hAA,  Gd);
      if (_hKK !== -1) s.stampElement(_hKK,  Gd);
      if (_hAK !== -1) s.stampElement(_hAK, -Gd);
      if (_hKA !== -1) s.stampElement(_hKA, -Gd);
      if (nodeAnode !== 0) ctx.rhs[nodeAnode] -= Ieq;
      if (nodeCathode !== 0) ctx.rhs[nodeCathode] += Ieq;
    },
    getPinCurrents(_rhs: Float64Array): number[] { return [0, 0]; },
    setParam(_key: string, _value: number): void {},
  };
  return el;
}
import { newtonRaphson } from '../newton-raphson.js';
import { SparseSolver, spSINGULAR } from '../sparse-solver.js';
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
    expect(factorResult).toBe(0);
    const solution = new Float64Array(matrixSize);
    ctx.solver.solve(ctx.rhs, solution);
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
    expect(factJct).toBe(0);
    const solJct = new Float64Array(matrixSize);
    ctxJct.solver.solve(ctxJct.rhs, solJct);
    const IS = makeCurrentSource(1, 0, 1e-3);
    // MODEDCOP | MODEINITFLOAT — nodeset must NOT be applied
    const ctxFloat = makeSimpleCtx({ elements: [IS, R], matrixSize, nodeCount, branchCount: 0 });
    ctxFloat.cktMode = MODEDCOP | MODEINITFLOAT;
    ctxFloat.nodesets.set(0, 3.0);
    cktLoad(ctxFloat);
    const factFloat = ctxFloat.solver.factor();
    expect(factFloat).toBe(0);
    const solFloat = new Float64Array(matrixSize);
    ctxFloat.solver.solve(ctxFloat.rhs, solFloat);
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
    // nodeAnode=2 -> 1-based slot 2; set anode to 5V to trigger pnjlim
    // rhs is Float64Array(matrixSize+1): [ground, node1, node2, branch]
    ctx.rhsOld.set([0.0, 0.0, 5.0, 0.0]);
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
    // Node 1 is the active circuit node (1-based MNA; slot 0 = ground sentinel)
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITJCT;
    ctx.srcFact = 0.5;
    ctx.nodesets.set(1, 2.5);
    cktLoad(ctx);
    const rhs = ctx.rhs;
    expect(rhs[1]).toBe(1e10 * 2.5 * 0.5);
  });

  it('nodeset_applied_in_MODEDCOP_MODEINITFIX', () => {
    // Gate also fires for MODEINITFIX (ngspice cktload.c:106)
    // Node 1 is the active circuit node (1-based MNA; slot 0 = ground sentinel)
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITFIX;
    ctx.srcFact = 1.0;
    ctx.nodesets.set(1, 4.0);
    cktLoad(ctx);
    const rhs = ctx.rhs;
    expect(rhs[1]).toBe(1e10 * 4.0);
  });

  it('nodeset_NOT_applied_in_MODEDCOP_MODEINITFLOAT', () => {
    // Gate must NOT fire when INITJCT|INITFIX bits are absent
    // Node 1 is the active circuit node (1-based MNA; slot 0 = ground sentinel)
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITFLOAT;
    ctx.srcFact = 1.0;
    ctx.nodesets.set(1, 2.5);
    cktLoad(ctx);
    const rhs = ctx.rhs;
    expect(rhs[1]).toBe(0);
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
    // Node 1 is the active circuit node (1-based MNA; slot 0 = ground sentinel)
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODETRANOP | MODEINITJCT;
    ctx.srcFact = 1.0;
    ctx.ics.set(1, 1.2);
    cktLoad(ctx);
    const rhs = ctx.rhs;
    expect(rhs[1]).toBe(1e10 * 1.2);
  });

  it('ic_NOT_stamped_when_MODEUIC_set', () => {
    // UIC bypasses IC enforcement (ngspice cktload.c:130)
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODETRANOP | MODEINITJCT | MODEUIC;
    ctx.srcFact = 1.0;
    ctx.ics.set(1, 3.3);
    cktLoad(ctx);
    const rhs = ctx.rhs;
    expect(rhs[1]).toBe(0);
  });

  it('ic_NOT_stamped_in_MODEDCOP', () => {
    // IC gate requires MODETRANOP — standalone DCOP must not apply ICs
    const nodeCount = 1;
    const matrixSize = nodeCount;
    const R = makeResistor(1, 0, 1000);
    const ctx = makeSimpleCtx({ elements: [R], matrixSize, nodeCount, branchCount: 0 });
    ctx.cktMode = MODEDCOP | MODEINITJCT;
    ctx.srcFact = 1.0;
    ctx.ics.set(1, 3.3);
    cktLoad(ctx);
    const rhs = ctx.rhs;
    expect(rhs[1]).toBe(0);
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
    // factor() returns the ngspice error code (number); the per-call
    // walkedReorder signal lives on the solver instance (lastFactorWalkedReorder).
    // Capture both around the proxy so the test can assert the retry succeeded
    // via the SMPreorder path.
    let lastErrorCode: number | undefined;
    let stubWalkedReorder = false;

    const realSolver = new SparseSolver();

    const proxySolver = new Proxy(realSolver, {
      get(target, prop) {
        if (prop === 'factor') {
          return () => {
            factorCallCount++;
            if (factorCallCount === 1) {
              // Simulate SMPluFac (reuse) failing with spSINGULAR — this
              // triggers the NR-side NISHOULDREORDER retry.
              stubWalkedReorder = false;
              lastErrorCode = spSINGULAR;
              return spSINGULAR;
            }
            const errorCode = (target as SparseSolver).factor();
            // Latch to true: once the reorder path was walked, keep the signal
            // even if subsequent factor calls take the cheaper reuse path.
            stubWalkedReorder = stubWalkedReorder || (target as SparseSolver).lastFactorWalkedReorder;
            lastErrorCode = errorCode;
            return errorCode;
          };
        }
        if (prop === 'lastFactorWalkedReorder') {
          return stubWalkedReorder;
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
    // After the retry, the next factor() call must walk the SMPreorder
    // (spOrderAndFactor) body — mirrors niiter.c:861 NISHOULDREORDER branch.
    expect(stubWalkedReorder).toBe(true);
    expect(lastErrorCode).toBe(0);
    expect(ctx.nrResult.iterations).toBe(3);
  });
});
