/**
 * JK flip-flop synthesis- derive JK excitation equations from a state
 * transition table.
 *
 * For each state bit, the JK excitation table maps the current-state /
 * next-state pair to required J and K inputs:
 *
 *   Q  Q_next  |  J   K
 *   0  0       |  0   X
 *   0  1       |  1   X
 *   1  0       |  X   1
 *   1  1       |  X   0
 *
 * J and K are treated as boolean functions of (current state, inputs).
 * These functions are minimized using Quine-McCluskey, exploiting the
 * don't-care entries that arise from the JK excitation table.
 *
 * Port of Digital's DetermineJKStateMachine.java.
 */

import type { BoolExpr } from './expression.js';
import { minimize } from './quine-mccluskey.js';
import { generateSOP } from './expression-gen.js';
import type { SignalSpec, StateTransitionTable } from './state-transition.js';
import { TruthTable } from './truth-table.js';
import type { TernaryValue } from './truth-table.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JKStateBit {
  readonly name: string;
  readonly jExpr: BoolExpr;
  readonly kExpr: BoolExpr;
}

export interface JKEquations {
  readonly stateBits: JKStateBit[];
  readonly outputExprs: { readonly name: string; readonly expr: BoolExpr }[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive JK flip-flop excitation equations from a state transition table.
 *
 * For each 1-bit state variable, produces J and K expressions as functions of
 * all state variables and inputs. When shouldMinimize is true, expressions are
 * minimized using Quine-McCluskey. When false, canonical SOP expressions are
 * used directly.
 *
 * Multi-bit state variables are expanded bit-by-bit (each bit gets its own
 * J/K pair).
 *
 * @param table          State transition table from analyseSequential().
 * @param shouldMinimize When true, apply Quine-McCluskey minimization.
 * @returns              JK equations for each state bit and output expressions.
 */
export function deriveJKEquations(table: StateTransitionTable, shouldMinimize: boolean): JKEquations {
  // Build the flat list of input variables (state bits + external inputs),
  // mirroring the variable ordering that TruthTable uses for row indices.
  const allInputSpecs = buildAllInputSpecs(table);

  // Expand state variable specs into individual bits
  const stateBitSpecs = expandStateBitSpecs(table.stateVars);

  // Build J/K equations for each expanded state bit
  const stateBits: JKStateBit[] = [];

  for (let bitIdx = 0; bitIdx < stateBitSpecs.length; bitIdx++) {
    const { varName, stateVarIndex, bitPos } = stateBitSpecs[bitIdx]!;

    const jTable = buildJKTruthTable(table, allInputSpecs, stateVarIndex, bitPos, 'J');
    const kTable = buildJKTruthTable(table, allInputSpecs, stateVarIndex, bitPos, 'K');

    const jExpr = shouldMinimize ? minimize(jTable, 0).selectedCover : generateSOP(jTable, 0);
    const kExpr = shouldMinimize ? minimize(kTable, 0).selectedCover : generateSOP(kTable, 0);

    stateBits.push({ name: varName, jExpr, kExpr });
  }

  // Build output expressions
  const outputExprs = deriveOutputExprs(table, allInputSpecs, shouldMinimize);

  return { stateBits, outputExprs };
}

// ---------------------------------------------------------------------------
// State bit expansion
// ---------------------------------------------------------------------------

interface StateBitSpec {
  /** Display name for this bit, e.g. "Q" for 1-bit or "Q[1]" for multi-bit. */
  varName: string;
  /** Index into table.stateVars for this state variable. */
  stateVarIndex: number;
  /** Bit position within the state variable (0 = LSB). */
  bitPos: number;
}

function expandStateBitSpecs(stateVars: readonly SignalSpec[]): StateBitSpec[] {
  const result: StateBitSpec[] = [];
  for (let i = 0; i < stateVars.length; i++) {
    const sv = stateVars[i]!;
    if (sv.bitWidth === 1) {
      result.push({ varName: sv.name, stateVarIndex: i, bitPos: 0 });
    } else {
      for (let b = sv.bitWidth - 1; b >= 0; b--) {
        result.push({ varName: `${sv.name}[${b}]`, stateVarIndex: i, bitPos: b });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Input spec building
// ---------------------------------------------------------------------------

/**
 * Build the ordered flat list of 1-bit signal specs that form the rows of
 * the J/K truth tables.
 *
 * Order: state bits (MSB-first within each state var), then external inputs
 * (MSB-first within each input). This matches TruthTable's row-index encoding.
 */
function buildAllInputSpecs(table: StateTransitionTable): SignalSpec[] {
  const specs: SignalSpec[] = [];

  // State variables (expanded to 1-bit each)
  for (const sv of table.stateVars) {
    if (sv.bitWidth === 1) {
      specs.push({ name: sv.name, bitWidth: 1 });
    } else {
      for (let b = sv.bitWidth - 1; b >= 0; b--) {
        specs.push({ name: `${sv.name}[${b}]`, bitWidth: 1 });
      }
    }
  }

  // External inputs (expanded to 1-bit each)
  for (const inp of table.inputs) {
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

// ---------------------------------------------------------------------------
// J/K truth table construction
// ---------------------------------------------------------------------------

/**
 * Build a 1-output TruthTable for the J or K input of one state bit.
 *
 * The truth table has rows indexed by (currentState || externalInputs).
 * Each row's output is the required J or K value:
 *
 *   Q=0, Q_next=0 → J=0, K=X
 *   Q=0, Q_next=1 → J=1, K=X
 *   Q=1, Q_next=0 → J=X, K=1
 *   Q=1, Q_next=1 → J=X, K=0
 */
function buildJKTruthTable(
  table: StateTransitionTable,
  allInputSpecs: SignalSpec[],
  stateVarIndex: number,
  bitPos: number,
  which: 'J' | 'K',
): TruthTable {
  const totalBits = allInputSpecs.reduce((s, sp) => s + sp.bitWidth, 0);
  const rowCount = 1 << totalBits;

  const outputSpec: SignalSpec = { name: which, bitWidth: 1 };
  const outputData: TernaryValue[] = new Array<TernaryValue>(rowCount).fill(-1n);

  // For each transition in the state transition table, compute the row index
  // and write the J or K value.
  for (const t of table.transitions) {
    const rowIndex = computeRowIndex(t.currentState, t.input, table.stateVars, table.inputs, totalBits);

    // Extract the current Q bit value
    const stateVal = t.currentState[stateVarIndex]!;
    const currentQ = (stateVal >> BigInt(bitPos)) & 1n;

    // Extract the next Q bit value
    const nextStateVal = t.nextState[stateVarIndex]!;
    const nextQ = (nextStateVal >> BigInt(bitPos)) & 1n;

    const jkValue = jkExcitation(currentQ, nextQ, which);
    outputData[rowIndex] = jkValue;
  }

  return new TruthTable(allInputSpecs, [outputSpec], outputData);
}

/**
 * Compute the truth-table row index from current state values and input values.
 *
 * Row index encodes all bits MSB-first: state bits (all state vars, MSB-first
 * within each) followed by input bits (all inputs, MSB-first within each).
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

  // State variables
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

  // External inputs
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

/**
 * JK excitation table lookup.
 *
 *   Q=0, Q_next=0 → J=0, K=X
 *   Q=0, Q_next=1 → J=1, K=X
 *   Q=1, Q_next=0 → J=X, K=1
 *   Q=1, Q_next=1 → J=X, K=0
 */
function jkExcitation(currentQ: bigint, nextQ: bigint, which: 'J' | 'K'): TernaryValue {
  if (currentQ === 0n && nextQ === 0n) return which === 'J' ? 0n : -1n;
  if (currentQ === 0n && nextQ === 1n) return which === 'J' ? 1n : -1n;
  if (currentQ === 1n && nextQ === 0n) return which === 'J' ? -1n : 1n;
  // currentQ === 1n && nextQ === 1n
  return which === 'J' ? -1n : 0n;
}

// ---------------------------------------------------------------------------
// Output expression derivation
// ---------------------------------------------------------------------------

/**
 * Derive expressions for each output signal as a function of current state
 * and external inputs. Minimizes when shouldMinimize is true; uses canonical
 * SOP otherwise.
 */
function deriveOutputExprs(
  table: StateTransitionTable,
  allInputSpecs: SignalSpec[],
  shouldMinimize: boolean,
): { name: string; expr: BoolExpr }[] {
  if (table.outputs.length === 0) return [];

  const totalBits = allInputSpecs.reduce((s, sp) => s + sp.bitWidth, 0);
  const rowCount = 1 << totalBits;

  // Expand output specs to individual bits
  const expandedOutputs: Array<{ name: string; data: TernaryValue[] }> = [];

  for (const outSpec of table.outputs) {
    if (outSpec.bitWidth === 1) {
      expandedOutputs.push({ name: outSpec.name, data: new Array<TernaryValue>(rowCount).fill(-1n) });
    } else {
      for (let b = outSpec.bitWidth - 1; b >= 0; b--) {
        expandedOutputs.push({
          name: `${outSpec.name}[${b}]`,
          data: new Array<TernaryValue>(rowCount).fill(-1n),
        });
      }
    }
  }

  // Fill output data from transitions
  for (const t of table.transitions) {
    const rowIndex = computeRowIndex(
      t.currentState,
      t.input,
      table.stateVars,
      table.inputs,
      totalBits,
    );

    let expandedIdx = 0;
    for (let oi = 0; oi < table.outputs.length; oi++) {
      const outSpec = table.outputs[oi]!;
      const val = t.output[oi]!;

      if (outSpec.bitWidth === 1) {
        expandedOutputs[expandedIdx]!.data[rowIndex] = (val & 1n) === 1n ? 1n : 0n;
        expandedIdx++;
      } else {
        for (let b = outSpec.bitWidth - 1; b >= 0; b--) {
          expandedOutputs[expandedIdx]!.data[rowIndex] = (val >> BigInt(b)) & 1n ? 1n : 0n;
          expandedIdx++;
        }
      }
    }
  }

  return expandedOutputs.map(({ name, data }) => {
    const outTable = new TruthTable(allInputSpecs, [{ name, bitWidth: 1 }], data);
    const expr = shouldMinimize ? minimize(outTable, 0).selectedCover : generateSOP(outTable, 0);
    return { name, expr };
  });
}
