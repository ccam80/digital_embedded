/**
 * Unit coverage for the first-divergence causal tie-break
 * (`pickEarliestDivergence` / `FIRST_DIVERGENCE_CAUSAL_RANK`).
 *
 * This is the bug-prone heart of the multi-signal router: when two classes
 * first diverge at the SAME (stepIndex, iterationIndex), the more upstream
 * class must be reported as `earliest` so an agent drills the cause, not the
 * symptom. A divergent RHS over an identical Jacobian produces a divergent
 * post-solve voltage at the same iteration, so `rhs` must beat `voltage`.
 *
 * Pure-function tests- no engine, no ngspice DLL.
 */

import { describe, it, expect } from "vitest";
import {
  pickEarliestDivergence,
  FIRST_DIVERGENCE_CAUSAL_RANK,
} from "./comparison-session.js";
import type { FirstDivergenceSignal, DivergenceSignalClass } from "./types.js";

function sig(
  signalClass: DivergenceSignalClass,
  stepIndex: number,
  iterationIndex: number,
): FirstDivergenceSignal {
  return { signalClass, stepIndex, iterationIndex, attribute: "x", ours: 0, ngspice: 1, absDelta: 1 };
}

describe("pickEarliestDivergence", () => {
  it("returns null for an empty signal set", () => {
    expect(pickEarliestDivergence([])).toBeNull();
  });

  it("rhs beats voltage at the same (step, iter)- the cause, not the symptom", () => {
    const r = pickEarliestDivergence([sig("voltage", 2, 3), sig("rhs", 2, 3)]);
    expect(r?.signalClass).toBe("rhs");
  });

  it("tie-break is order-independent (voltage listed first still loses to rhs)", () => {
    const a = pickEarliestDivergence([sig("rhs", 2, 3), sig("voltage", 2, 3)]);
    const b = pickEarliestDivergence([sig("voltage", 2, 3), sig("rhs", 2, 3)]);
    expect(a?.signalClass).toBe("rhs");
    expect(b?.signalClass).toBe("rhs");
  });

  it("an earlier step wins regardless of causal rank", () => {
    // voltage (downstream) at an earlier step beats rhs (upstream) at a later step.
    const r = pickEarliestDivergence([sig("rhs", 5, 0), sig("voltage", 2, 9)]);
    expect(r?.signalClass).toBe("voltage");
    expect(r?.stepIndex).toBe(2);
  });

  it("an earlier iteration within the same step wins regardless of rank", () => {
    const r = pickEarliestDivergence([sig("rhs", 4, 7), sig("voltage", 4, 2)]);
    expect(r?.signalClass).toBe("voltage");
    expect(r?.iterationIndex).toBe(2);
  });

  it("shape (most upstream) wins a full (step, iter) tie over every other class", () => {
    const r = pickEarliestDivergence([
      sig("convergence", 1, 1),
      sig("voltage", 1, 1),
      sig("matrix", 1, 1),
      sig("rhs", 1, 1),
      sig("limiting", 1, 1),
      sig("state", 1, 1),
      sig("integration", 1, 1),
      sig("shape", 1, 1),
    ]);
    expect(r?.signalClass).toBe("shape");
  });

  it("ranks the full pipeline upstream-to-downstream without gaps or dups", () => {
    const order: DivergenceSignalClass[] = [
      "shape", "integration", "state", "limiting", "rhs", "matrix", "voltage", "convergence",
    ];
    const ranks = order.map(c => FIRST_DIVERGENCE_CAUSAL_RANK[c]);
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // strictly increasing in declared causal order
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
  });
});
