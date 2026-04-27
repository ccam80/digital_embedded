/**
 * Phase 3 Task 3.3.3 -- Relay composite-child existence + integration tests.
 *
 * Verifies that both relay factories expose a child AnalogInductorElement via
 * getChildElements(), and that the relay composite delegates load() through to
 * the child so flux integration runs end-to-end.
 *
 * "Delegates integration" in this codebase means the parent's load(ctx) calls
 * coilInductor.load(ctx), which runs niIntegrate over the flux history. The
 * relay's stateSchema mirrors the child inductor's schema so PHI/CCAP slots
 * are name-resolvable through the parent.
 */

import { describe, it, expect } from "vitest";
import {
  createRelayAnalogElement,
  createRelayDTAnalogElement,
} from "../behavioral-remaining.js";
import { AnalogInductorElement } from "../../../components/passives/inductor.js";
import { PropertyBag } from "../../../core/properties.js";
import { StatePool } from "../state-pool.js";
import { SparseSolver } from "../sparse-solver.js";
import { MODETRAN, MODEINITTRAN, MODEINITFLOAT } from "../ckt-mode.js";
import type { LoadContext } from "../load-context.js";
import { makeLoadCtx } from "./test-helpers.js";

describe("Phase 3 Task 3.3.3 -- Relay composite-child", () => {
  it("SPDT relay exposes coil inductor as composite child", () => {
    const props = new PropertyBag();
    const relay = createRelayAnalogElement(
      new Map([["in1", 1], ["in2", 2], ["A1", 3], ["B1", 4]]),
      [],
      10,
      props,
    );

    const children = (relay as any).getChildElements();
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(AnalogInductorElement);
    expect(children[0].isReactive).toBe(true);
  });

  it("DPDT relay exposes coil inductor as composite child", () => {
    const props = new PropertyBag();
    const relay = createRelayDTAnalogElement(
      new Map([["in1", 1], ["in2", 2], ["A1", 3], ["B1", 4], ["C1", 5]]),
      [],
      10,
      props,
    );

    const children = (relay as any).getChildElements();
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(AnalogInductorElement);
    expect(children[0].isReactive).toBe(true);
  });

  it("SPDT relay child inductor integrates the coil current", () => {
    // MNA layout under the 1-indexed-nodes contract (slot 0 is the ngspice
    // ground sentinel; branch rows live AFTER the node block):
    //   rhs[0] = ground (always 0)
    //   rhs[1] = node 1 (coil+)
    //   rhs[2] = node 2 (coil-)
    //   rhs[3] = branch row (coil current i_L)
    //
    // Drive a non-zero coil current via rhsOld[branchIdx] so the child
    // inductor's flux-from-current update (indload.c:48-50,
    // PHI = L * CKTrhsOld[INDbrEq]) produces an observable side effect.
    //
    // Step 1 (MODETRAN | MODEINITTRAN): flux update + s1[CCAP] = s0[CCAP] seed.
    // Step 2 (MODETRAN | MODEINITFLOAT): flux update + NIintegrate writes
    //   s0[CCAP] and stamps -req on (b,b) and +veq into rhs[b].
    //
    // Observable assertions (no reading of nonexistent slots):
    //   1. s0[base + SLOT_PHI] == L * I  (flux mirrors current)
    //   2. rhs[branchIdx] != 0           (companion veq landed in RHS)

    const props = new PropertyBag();
    const branchIdx = 3;
    const relay = createRelayAnalogElement(
      new Map([["in1", 1], ["in2", 2], ["A1", 4], ["B1", 5]]),
      [],
      branchIdx,
      props,
    );

    // Pool sized to the relay's stateSize, which the relay claims from its
    // child inductor (stateSize = coilInductor.stateSize = 2).
    const pool = new StatePool(Math.max((relay as any).stateSize, 1));
    (relay as any).stateBaseOffset = 0;
    (relay as any).initState(pool);

    const inductor = (relay as any).getChildElements()[0] as AnalogInductorElement;
    const base = inductor.stateBaseOffset;

    // Resolve PHI by name through the relay's stateSchema. The schema fix in
    // behavioral-remaining.ts sets relay.stateSchema = coilInductor.stateSchema,
    // so PHI/CCAP are name-resolvable through the parent (no raw constants).
    const slots = (relay as any).stateSchema.slots as ReadonlyArray<{ name: string }>;
    const SLOT_PHI = slots.findIndex((s) => s.name === "PHI");
    expect(SLOT_PHI).toBeGreaterThanOrEqual(0);

    // Solver: 4 rows/cols (ground=0, node1=1, node2=2, branch=3).
    const matrixSize = 4;
    const dt = 1e-6;
    const ag = new Float64Array(7);
    ag[0] = 1 / dt;       // order-1 trapezoidal
    ag[1] = -1 / dt;

    const I_TEST = 0.01;  // 10 mA coil current
    const L = 0.1;        // RELAY_L_DEFAULT in behavioral-remaining.ts

    function makeCtx(cktMode: number): LoadContext {
      const solver = new SparseSolver();
      solver._initStructure();
      const rhs = new Float64Array(matrixSize);
      const rhsOld = new Float64Array(matrixSize);
      rhsOld[branchIdx] = I_TEST;  // branch row carries current, not voltage
      return makeLoadCtx({
        solver,
        rhs,
        rhsOld,
        cktMode,
        dt,
        deltaOld: [dt, dt, 0, 0, 0, 0, 0],
        ag,
      });
    }

    // Step 1: MODEINITTRAN seeds state.
    relay.load(makeCtx(MODETRAN | MODEINITTRAN));

    // Step 2: MODEINITFLOAT runs NIintegrate end-to-end through the composite.
    const ctx2 = makeCtx(MODETRAN | MODEINITFLOAT);
    relay.load(ctx2);

    // 1. Flux mirrors current: proves the child inductor's load() ran and the
    //    relay's stateBaseOffset propagated correctly into the child's pool slot.
    const phi = pool.states[0][base + SLOT_PHI];
    expect(phi).toBeCloseTo(L * I_TEST, 12);

    // 2. RHS picked up the companion-current term via the inductor's stampRHS.
    //    Proves the delegation reaches all the way through to MNA stamping.
    expect(ctx2.rhs[branchIdx]).not.toBe(0);
  });
});
