/**
 * Tests for JK flip-flop synthesis (task 8.2.6).
 *
 * Tests verify:
 *   - toggleFlipflop: single state bit toggling on every clock → J=1, K=1
 *   - dTypeFromJK: D flip-flop equivalent → J=D, K=!D
 *   - twoStateBits: 2-state-bit FSM → correct J/K equations for each bit
 *   - dontCaresExploited: JK derivation produces simpler expressions than
 *     a naive approach would, because don't-cares are exploited
 */

import { describe, expect, it } from 'vitest';
import { evaluate, exprToString } from '../expression.js';
import { deriveJKEquations } from '../jk-synthesis.js';
import type { StateTransitionTable } from '../state-transition.js';

// ---------------------------------------------------------------------------
// Helper: evaluate a BoolExpr with a simple string→boolean map
// ---------------------------------------------------------------------------

function evalExpr(exprStr: string, vars: Record<string, boolean>): boolean {
  // We use the real evaluate function from expression.ts.
  // To avoid building BoolExpr objects manually we import deriveJKEquations
  // and use the returned BoolExpr directly via evaluate().
  // This helper is for readability only.
  void exprStr;
  void vars;
  throw new Error('use evalExprDirect instead');
}
void evalExpr; // suppress lint

function evalExprDirect(
  expr: import('../expression.js').BoolExpr,
  vars: Record<string, boolean>,
): boolean {
  return evaluate(expr, new Map(Object.entries(vars)));
}

// ---------------------------------------------------------------------------
// Test 1: toggleFlipflop
//
// A circuit with a single state bit Q that always toggles (T flip-flop).
// State transition table:
//   Q=0 → Q_next=1   (J=1, K=X)
//   Q=1 → Q_next=0   (J=X, K=1)
//
// No external inputs. After minimisation: J = 1, K = 1.
// ---------------------------------------------------------------------------

describe('jk-synthesis', () => {
  it('toggleFlipflop — single state bit always toggling → J=1, K=1', () => {
    const table: StateTransitionTable = {
      stateVars: [{ name: 'Q', bitWidth: 1 }],
      inputs: [],
      outputs: [],
      transitions: [
        // Q=0 → Q_next=1
        { currentState: [0n], input: [], nextState: [1n], output: [] },
        // Q=1 → Q_next=0
        { currentState: [1n], input: [], nextState: [0n], output: [] },
      ],
    };

    const result = deriveJKEquations(table);

    expect(result.stateBits).toHaveLength(1);
    const { jExpr, kExpr } = result.stateBits[0]!;

    // J and K should evaluate to true regardless of Q
    // (J=1 means output is constant true, K=1 same)
    expect(evalExprDirect(jExpr, { Q: false })).toBe(true);
    expect(evalExprDirect(jExpr, { Q: true })).toBe(true);
    expect(evalExprDirect(kExpr, { Q: false })).toBe(true);
    expect(evalExprDirect(kExpr, { Q: true })).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: dTypeFromJK
  //
  // A D flip-flop implemented with JK: Q_next = D
  // State transition table (variables: Q, D):
  //   Q=0, D=0 → Q_next=0   J=0, K=X
  //   Q=0, D=1 → Q_next=1   J=1, K=X
  //   Q=1, D=0 → Q_next=0   J=X, K=1
  //   Q=1, D=1 → Q_next=1   J=X, K=0
  //
  // After minimisation: J=D, K=!D
  // -------------------------------------------------------------------------

  it('dTypeFromJK — D flip-flop equivalent → J=D, K=!D', () => {
    const table: StateTransitionTable = {
      stateVars: [{ name: 'Q', bitWidth: 1 }],
      inputs: [{ name: 'D', bitWidth: 1 }],
      outputs: [],
      transitions: [
        { currentState: [0n], input: [0n], nextState: [0n], output: [] },
        { currentState: [0n], input: [1n], nextState: [1n], output: [] },
        { currentState: [1n], input: [0n], nextState: [0n], output: [] },
        { currentState: [1n], input: [1n], nextState: [1n], output: [] },
      ],
    };

    const result = deriveJKEquations(table);

    expect(result.stateBits).toHaveLength(1);
    const { jExpr, kExpr } = result.stateBits[0]!;

    // J should equal D
    expect(evalExprDirect(jExpr, { Q: false, D: false })).toBe(false);
    expect(evalExprDirect(jExpr, { Q: false, D: true })).toBe(true);
    expect(evalExprDirect(jExpr, { Q: true, D: false })).toBe(false);
    expect(evalExprDirect(jExpr, { Q: true, D: true })).toBe(true);

    // K should equal !D
    expect(evalExprDirect(kExpr, { Q: false, D: false })).toBe(true);
    expect(evalExprDirect(kExpr, { Q: false, D: true })).toBe(false);
    expect(evalExprDirect(kExpr, { Q: true, D: false })).toBe(true);
    expect(evalExprDirect(kExpr, { Q: true, D: true })).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3: twoStateBits
  //
  // A 2-bit counter: Q1Q0 → 00→01→10→11→00 (mod-4 counter)
  // No external inputs.
  //
  // State bits: Q1 (bit 1), Q0 (bit 0)
  //
  // Transitions:
  //   Q1=0, Q0=0 → Q1_next=0, Q0_next=1
  //   Q1=0, Q0=1 → Q1_next=1, Q0_next=0
  //   Q1=1, Q0=0 → Q1_next=1, Q0_next=1
  //   Q1=1, Q0=1 → Q1_next=0, Q0_next=0
  //
  // JK derivation for Q0 (always toggles): J0=1, K0=1
  // JK derivation for Q1:
  //   Q1=0,Q0=0: Q1_next=0 → J1=0, K1=X
  //   Q1=0,Q0=1: Q1_next=1 → J1=1, K1=X
  //   Q1=1,Q0=0: Q1_next=1 → J1=X, K1=0
  //   Q1=1,Q0=1: Q1_next=0 → J1=X, K1=1
  // → J1=Q0, K1=Q0
  // -------------------------------------------------------------------------

  it('twoStateBits — 2-state-bit mod-4 counter → correct J/K per bit', () => {
    // Encode both state bits in a single 2-bit state variable "Q" where
    // bit 1 = Q1, bit 0 = Q0.
    const table: StateTransitionTable = {
      stateVars: [
        { name: 'Q1', bitWidth: 1 },
        { name: 'Q0', bitWidth: 1 },
      ],
      inputs: [],
      outputs: [],
      transitions: [
        // Q1=0,Q0=0 → Q1_next=0,Q0_next=1
        { currentState: [0n, 0n], input: [], nextState: [0n, 1n], output: [] },
        // Q1=0,Q0=1 → Q1_next=1,Q0_next=0
        { currentState: [0n, 1n], input: [], nextState: [1n, 0n], output: [] },
        // Q1=1,Q0=0 → Q1_next=1,Q0_next=1
        { currentState: [1n, 0n], input: [], nextState: [1n, 1n], output: [] },
        // Q1=1,Q0=1 → Q1_next=0,Q0_next=0
        { currentState: [1n, 1n], input: [], nextState: [0n, 0n], output: [] },
      ],
    };

    const result = deriveJKEquations(table);

    expect(result.stateBits).toHaveLength(2);

    const q1 = result.stateBits[0]!; // Q1
    const q0 = result.stateBits[1]!; // Q0

    // Q0 always toggles → J0=1, K0=1
    expect(evalExprDirect(q0.jExpr, { Q1: false, Q0: false })).toBe(true);
    expect(evalExprDirect(q0.jExpr, { Q1: true, Q0: false })).toBe(true);
    expect(evalExprDirect(q0.kExpr, { Q1: false, Q0: true })).toBe(true);
    expect(evalExprDirect(q0.kExpr, { Q1: true, Q0: true })).toBe(true);

    // Q1: J1 = Q0, K1 = Q0
    expect(evalExprDirect(q1.jExpr, { Q1: false, Q0: false })).toBe(false);
    expect(evalExprDirect(q1.jExpr, { Q1: false, Q0: true })).toBe(true);
    expect(evalExprDirect(q1.kExpr, { Q1: true, Q0: false })).toBe(false);
    expect(evalExprDirect(q1.kExpr, { Q1: true, Q0: true })).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: dontCaresExploited
  //
  // Verifies that the JK synthesis exploits don't-cares from the JK
  // excitation table to produce simpler expressions.
  //
  // For the D flip-flop case:
  //   J is defined only for Q=0 rows (K=X when Q=0),
  //   K is defined only for Q=1 rows (J=X when Q=1).
  //
  // Without don't-cares, J would be a function of both Q and D.
  // With don't-cares exploited, J simplifies to just D (independent of Q).
  //
  // We verify this by checking that the J expression for the D flip-flop
  // does not contain "Q" in its string representation — it was eliminated.
  // -------------------------------------------------------------------------

  it('dontCaresExploited — JK excitation don\'t-cares simplify expressions', () => {
    const table: StateTransitionTable = {
      stateVars: [{ name: 'Q', bitWidth: 1 }],
      inputs: [{ name: 'D', bitWidth: 1 }],
      outputs: [],
      transitions: [
        { currentState: [0n], input: [0n], nextState: [0n], output: [] },
        { currentState: [0n], input: [1n], nextState: [1n], output: [] },
        { currentState: [1n], input: [0n], nextState: [0n], output: [] },
        { currentState: [1n], input: [1n], nextState: [1n], output: [] },
      ],
    };

    const result = deriveJKEquations(table);

    const { jExpr, kExpr } = result.stateBits[0]!;

    // J should simplify to just D (Q eliminated via don't-cares)
    const jStr = exprToString(jExpr);
    expect(jStr).not.toContain('Q');
    expect(jStr).toContain('D');

    // K should simplify to just !D (Q eliminated via don't-cares)
    const kStr = exprToString(kExpr);
    expect(kStr).not.toContain('Q');
    expect(kStr).toContain('D');
  });
});
