/**
 * Boolean expression generation from truth tables.
 *
 * Generates canonical sum-of-products (SOP) and product-of-sums (POS)
 * expressions from a TruthTable data model.
 *
 * SOP (canonical minterm form):
 *   OR of AND terms, one term per row where the output is 1.
 *   Don't-care rows (-1n) are excluded from the minterm set.
 *
 * POS (canonical maxterm form):
 *   AND of OR terms, one term per row where the output is 0.
 *   Don't-care rows (-1n) are excluded from the maxterm set.
 */

import { type BoolExpr, and, constant, negatedVariable, or, variable } from './expression.js';
import type { TruthTable } from './truth-table.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the canonical sum-of-products (SOP) expression for a single
 * output column of a truth table.
 *
 * Each row where the output is 1 contributes one minterm (an AND of literals).
 * Rows where the output is 0 or don't-care are skipped.
 *
 * Returns a constant FALSE if no minterms exist (output is always 0 or X).
 * Returns a constant TRUE if a minterm covers all variables as trivially true.
 *
 * @param table       The truth table.
 * @param outputIndex The zero-based index of the output column.
 * @returns           A BoolExpr in sum-of-products canonical form.
 */
export function generateSOP(table: TruthTable, outputIndex: number): BoolExpr {
  validateOutputIndex(table, outputIndex);

  const inputNames = table.inputs.map((s) => s.name);
  const minterms: BoolExpr[] = [];

  for (let row = 0; row < table.rowCount; row++) {
    const outputValue = table.getOutput(row, outputIndex);
    if (outputValue !== 1n) continue;

    const inputValues = table.getInputValues(row);
    const term = buildMinterm(inputNames, table.inputs.map((s) => s.bitWidth), inputValues);
    minterms.push(term);
  }

  if (minterms.length === 0) {
    return constant(false);
  }

  return or(minterms);
}

/**
 * Generate the canonical product-of-sums (POS) expression for a single
 * output column of a truth table.
 *
 * Each row where the output is 0 contributes one maxterm (an OR of literals).
 * Rows where the output is 1 or don't-care are skipped.
 *
 * Returns a constant TRUE if no maxterms exist (output is always 1 or X).
 * Returns a constant FALSE if a maxterm covers all variables as trivially false.
 *
 * @param table       The truth table.
 * @param outputIndex The zero-based index of the output column.
 * @returns           A BoolExpr in product-of-sums canonical form.
 */
export function generatePOS(table: TruthTable, outputIndex: number): BoolExpr {
  validateOutputIndex(table, outputIndex);

  const inputNames = table.inputs.map((s) => s.name);
  const maxterms: BoolExpr[] = [];

  for (let row = 0; row < table.rowCount; row++) {
    const outputValue = table.getOutput(row, outputIndex);
    if (outputValue !== 0n) continue;

    const inputValues = table.getInputValues(row);
    const term = buildMaxterm(inputNames, table.inputs.map((s) => s.bitWidth), inputValues);
    maxterms.push(term);
  }

  if (maxterms.length === 0) {
    return constant(true);
  }

  return and(maxterms);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function validateOutputIndex(table: TruthTable, outputIndex: number): void {
  if (outputIndex < 0 || outputIndex >= table.outputs.length) {
    throw new RangeError(
      `outputIndex ${outputIndex} is out of range for truth table with ${table.outputs.length} output(s)`,
    );
  }
}

/**
 * Build one minterm for SOP form: an AND of literals where each literal
 * matches the input bit pattern for this row.
 *
 * For a positive literal: the input bit is 1  → variable(name)
 * For a negative literal: the input bit is 0  → negatedVariable(name)
 *
 * Multi-bit inputs are expanded bit-by-bit, MSB first. The variable name
 * for each bit of an N-bit input named "A" is:
 *   - 1-bit input: "A"
 *   - N-bit input: "A[N-1]", "A[N-2]", ..., "A[0]"
 */
function buildMinterm(
  inputNames: string[],
  inputWidths: number[],
  inputValues: bigint[],
): BoolExpr {
  const literals: BoolExpr[] = [];

  for (let i = 0; i < inputNames.length; i++) {
    const name = inputNames[i]!;
    const width = inputWidths[i]!;
    const value = inputValues[i]!;

    if (width === 1) {
      const bit = Number(value & 1n);
      literals.push(bit === 1 ? variable(name) : negatedVariable(name));
    } else {
      for (let b = width - 1; b >= 0; b--) {
        const bit = Number((value >> BigInt(b)) & 1n);
        const bitName = `${name}[${b}]`;
        literals.push(bit === 1 ? variable(bitName) : negatedVariable(bitName));
      }
    }
  }

  return and(literals);
}

/**
 * Build one maxterm for POS form: an OR of literals where each literal
 * is the complement of the input bit pattern for this row.
 *
 * In POS, each factor represents a row where the output is 0.
 * The maxterm for row r is the OR of literals that are FALSE for that row's
 * input combination:
 *   - If input bit is 0 → positive literal (A is 0, so A makes the OR false if we want output 0)
 *   - If input bit is 1 → negative literal (!A is 0)
 *
 * This follows the standard POS canonical form.
 */
function buildMaxterm(
  inputNames: string[],
  inputWidths: number[],
  inputValues: bigint[],
): BoolExpr {
  const literals: BoolExpr[] = [];

  for (let i = 0; i < inputNames.length; i++) {
    const name = inputNames[i]!;
    const width = inputWidths[i]!;
    const value = inputValues[i]!;

    if (width === 1) {
      const bit = Number(value & 1n);
      literals.push(bit === 0 ? variable(name) : negatedVariable(name));
    } else {
      for (let b = width - 1; b >= 0; b--) {
        const bit = Number((value >> BigInt(b)) & 1n);
        const bitName = `${name}[${b}]`;
        literals.push(bit === 0 ? variable(bitName) : negatedVariable(bitName));
      }
    }
  }

  return or(literals);
}
