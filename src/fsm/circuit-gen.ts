/**
 * FSM to circuit synthesis.
 *
 * Full pipeline: FSM -> state transition table -> truth tables for next-state
 * and output functions -> minimize expressions (Quine-McCluskey) -> synthesize
 * circuit (flip-flops + combinational logic).
 *
 * Supports D and JK flip-flop types. D is direct (next-state = D input).
 * JK uses the JK excitation table derivation from jk-synthesis.ts.
 */

import type { FSM } from './model.js';
import { fsmToTransitionTable } from './table-creator.js';
import type { BoolExpr } from '../analysis/expression.js';
import { minimize } from '../analysis/quine-mccluskey.js';
import { TruthTable } from '../analysis/truth-table.js';
import type { TernaryValue } from '../analysis/truth-table.js';
import type { SignalSpec } from '../analysis/state-transition.js';
import { deriveJKEquations } from '../analysis/jk-synthesis.js';
import { synthesizeCircuit } from '../analysis/synthesis.js';
import type { Circuit } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FSMSynthesisOptions {
  flipflopType?: 'D' | 'JK';
  minimize?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synthesize a Circuit from an FSM.
 *
 * @param fsm      The FSM to synthesize.
 * @param registry Component registry for creating circuit elements.
 * @param options  Synthesis options (flip-flop type, minimization).
 * @returns        A Circuit ready for loading in the editor.
 */
export function fsmToCircuit(
  fsm: FSM,
  registry: ComponentRegistry,
  options?: FSMSynthesisOptions,
): Circuit {
  const flipflopType = options?.flipflopType ?? 'D';
  const shouldMinimize = options?.minimize ?? true;

  const table = fsmToTransitionTable(fsm);

  if (flipflopType === 'JK') {
    return synthesizeJK(table, registry, shouldMinimize);
  }

  return synthesizeD(table, registry, shouldMinimize);
}

// ---------------------------------------------------------------------------
// D flip-flop synthesis
// ---------------------------------------------------------------------------

/**
 * For D flip-flops, each next-state bit is a direct boolean function of the
 * current state bits and inputs. We build a truth table for each next-state
 * bit and each output signal, minimize, and synthesize.
 */
function synthesizeD(
  table: ReturnType<typeof fsmToTransitionTable>,
  registry: ComponentRegistry,
  shouldMinimize: boolean,
): Circuit {
  const allInputSpecs = buildFlatInputSpecs(table.stateVars, table.inputs);
  const totalBits = allInputSpecs.reduce((s, sp) => s + sp.bitWidth, 0);
  const rowCount = 1 << totalBits;

  const expressions = new Map<string, BoolExpr>();
  const inputNames = allInputSpecs.map((s) => s.name);

  // Build next-state expressions (one per state bit)
  for (let si = 0; si < table.stateVars.length; si++) {
    const sv = table.stateVars[si]!;
    const outputName = `${sv.name}_next`;

    const data = new Array<TernaryValue>(rowCount).fill(-1n);
    for (const t of table.transitions) {
      const rowIdx = computeRowIndex(t.currentState, t.input, table.stateVars, table.inputs, totalBits);
      data[rowIdx] = (t.nextState[si]! & 1n) === 1n ? 1n : 0n;
    }

    const tt = new TruthTable(allInputSpecs, [{ name: outputName, bitWidth: 1 }], data);

    if (shouldMinimize) {
      const result = minimize(tt, 0);
      expressions.set(outputName, result.selectedCover);
    } else {
      const result = minimize(tt, 0);
      expressions.set(outputName, result.selectedCover);
    }
  }

  // Build output expressions
  for (let oi = 0; oi < table.outputs.length; oi++) {
    const outSpec = table.outputs[oi]!;

    const data = new Array<TernaryValue>(rowCount).fill(-1n);
    for (const t of table.transitions) {
      const rowIdx = computeRowIndex(t.currentState, t.input, table.stateVars, table.inputs, totalBits);
      data[rowIdx] = (t.output[oi]! & 1n) === 1n ? 1n : 0n;
    }

    const tt = new TruthTable(allInputSpecs, [{ name: outSpec.name, bitWidth: 1 }], data);
    const result = minimize(tt, 0);
    expressions.set(outSpec.name, result.selectedCover);
  }

  return synthesizeCircuit(expressions, inputNames, registry);
}

// ---------------------------------------------------------------------------
// JK flip-flop synthesis
// ---------------------------------------------------------------------------

/**
 * For JK flip-flops, derive J and K excitation equations for each state bit,
 * plus output expressions. Then synthesize the circuit.
 */
function synthesizeJK(
  table: ReturnType<typeof fsmToTransitionTable>,
  registry: ComponentRegistry,
  _shouldMinimize: boolean,
): Circuit {
  const jkEqs = deriveJKEquations(table);

  const expressions = new Map<string, BoolExpr>();
  const allInputSpecs = buildFlatInputSpecs(table.stateVars, table.inputs);
  const inputNames = allInputSpecs.map((s) => s.name);

  for (const bit of jkEqs.stateBits) {
    expressions.set(`${bit.name}_J`, bit.jExpr);
    expressions.set(`${bit.name}_K`, bit.kExpr);
  }

  for (const out of jkEqs.outputExprs) {
    expressions.set(out.name, out.expr);
  }

  return synthesizeCircuit(expressions, inputNames, registry);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a flat list of 1-bit signal specs from state vars and inputs.
 */
function buildFlatInputSpecs(
  stateVars: readonly SignalSpec[],
  inputs: readonly SignalSpec[],
): SignalSpec[] {
  const specs: SignalSpec[] = [];

  for (const sv of stateVars) {
    if (sv.bitWidth === 1) {
      specs.push({ name: sv.name, bitWidth: 1 });
    } else {
      for (let b = sv.bitWidth - 1; b >= 0; b--) {
        specs.push({ name: `${sv.name}[${b}]`, bitWidth: 1 });
      }
    }
  }

  for (const inp of inputs) {
    if (inp.bitWidth === 1) {
      specs.push({ name: inp.name, bitWidth: 1 });
    } else {
      for (let b = inp.bitWidth - 1; b >= 0; b--) {
        specs.push({ name: `${inp.name}[${b}]`, bitWidth: 1 });
      }
    }
  }

  return specs;
}

/**
 * Compute the truth table row index from current state values and input values.
 */
function computeRowIndex(
  currentState: readonly bigint[],
  input: readonly bigint[],
  stateVars: readonly SignalSpec[],
  inputs: readonly SignalSpec[],
  totalBits: number,
): number {
  let row = 0;
  let bitOffset = totalBits - 1;

  for (let i = 0; i < stateVars.length; i++) {
    const sv = stateVars[i]!;
    const val = currentState[i]!;
    for (let b = sv.bitWidth - 1; b >= 0; b--) {
      if ((val >> BigInt(b)) & 1n) {
        row |= 1 << bitOffset;
      }
      bitOffset--;
    }
  }

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i]!;
    const val = input[i]!;
    for (let b = inp.bitWidth - 1; b >= 0; b--) {
      if ((val >> BigInt(b)) & 1n) {
        row |= 1 << bitOffset;
      }
      bitOffset--;
    }
  }

  return row;
}
