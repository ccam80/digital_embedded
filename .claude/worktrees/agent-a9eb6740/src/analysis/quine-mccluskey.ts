/**
 * Quine-McCluskey boolean expression minimization.
 *
 * Port of Digital's MinimizerQuineMcCluskey / QuineMcCluskey.java.
 *
 * Algorithm:
 *  1. Load minterms (output=1) and don't-cares (output=X) from the truth table.
 *  2. Iteratively combine implicant rows that differ in exactly one bit.
 *     Rows that cannot be combined become prime implicants.
 *  3. Select a minimal cover: the smallest set of prime implicants that
 *     covers all non-don't-care minterms.
 *  4. Report all minimal covers of the same minimum size (Petrick's method
 *     via exhaustive search — bounded to ≤31 available primes).
 *  5. Build BoolExpr trees from the selected cover.
 */

import { type BoolExpr, and, constant, negatedVariable, or, variable } from './expression.js';
import type { TruthTable } from './truth-table.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One prime implicant: a bit pattern with some variables eliminated. */
export interface Implicant {
  /** Variables covered: true = positive literal, false = negative, undefined = eliminated. */
  literals: ReadonlyMap<string, boolean>;
  /** The original minterm indices (1-based row numbers) covered by this implicant. */
  minterms: ReadonlySet<number>;
}

export interface MinimizationResult {
  primeImplicants: Implicant[];
  minimalCovers: BoolExpr[];
  selectedCover: BoolExpr;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Minimize the boolean function for a single output column of a truth table.
 *
 * @param table       The truth table data model.
 * @param outputIndex Zero-based index of the output column to minimize.
 * @returns           Minimization result with prime implicants and minimal covers.
 */
export function minimize(table: TruthTable, outputIndex: number): MinimizationResult {
  if (outputIndex < 0 || outputIndex >= table.outputs.length) {
    throw new RangeError(
      `outputIndex ${outputIndex} out of range for truth table with ${table.outputs.length} output(s)`,
    );
  }

  const varNames = buildVarNames(table);
  const numVars = varNames.length;

  // Collect minterms and don't-cares
  const minterms: Row[] = [];
  for (let row = 0; row < table.rowCount; row++) {
    const v = table.getOutput(row, outputIndex);
    if (v === 0n) continue;
    const isDontCare = v === -1n;
    minterms.push(makeRow(numVars, row, !isDontCare));
  }

  // Run QMC reduction to find prime implicants
  const primes = findPrimeImplicants(minterms);

  // Convert raw primes to public Implicant type
  const publicPrimes = primes.map((p) => rowToImplicant(p, varNames));

  // If no minterms → output is always 0 or all X
  if (primes.length === 0 || primes.every((p) => p.source.size === 0)) {
    const expr = constant(false);
    return {
      primeImplicants: publicPrimes,
      minimalCovers: [expr],
      selectedCover: expr,
    };
  }

  // Collect all non-don't-care minterm indices that must be covered
  const requiredColumns = new Set<number>();
  for (const p of primes) {
    for (const s of p.source) {
      requiredColumns.add(s);
    }
  }

  // Find all minimal covers
  const allSolutions = findAllMinimalCovers(primes, requiredColumns);

  const minimalCovers = allSolutions.map((solution) => buildExprFromRows(solution, varNames));
  const selectedCover = minimalCovers[0] ?? constant(false);

  return {
    primeImplicants: publicPrimes,
    minimalCovers,
    selectedCover,
  };
}

// ---------------------------------------------------------------------------
// Internal row representation
// ---------------------------------------------------------------------------

/** Internal representation of one row in the QMC table. */
interface Row {
  /** Number of variables. */
  numVars: number;
  /**
   * Bit pattern: bit i=1 means variable i has value 1.
   * Stored MSB-first (bit 0 = variable 0, i.e. bit position 0 in the integer).
   */
  state: number;
  /**
   * Eliminated/optimized flags: bit i=1 means variable i has been eliminated.
   */
  eliminated: number;
  /** Original non-don't-care minterm indices (1-based). */
  source: Set<number>;
  /** Whether this row has been combined with another (and is not a prime). */
  used: boolean;
}

function makeRow(numVars: number, bitValue: number, nonDontCare: boolean): Row {
  return {
    numVars,
    state: bitValue,
    eliminated: 0,
    source: nonDontCare ? new Set([bitValue + 1]) : new Set(),
    used: false,
  };
}

function copyRow(r: Row): Row {
  return {
    numVars: r.numVars,
    state: r.state,
    eliminated: r.eliminated,
    source: new Set(r.source),
    used: false,
  };
}

function rowsEqual(a: Row, b: Row): boolean {
  return a.state === b.state && a.eliminated === b.eliminated;
}

/**
 * Check if two rows can be combined (differ in exactly one non-eliminated bit).
 * Returns the bit index of the differing bit, or -1 if not combinable.
 */
function checkCompatible(r1: Row, r2: Row): number {
  if (r1.eliminated !== r2.eliminated) return -1;
  const diff = r1.state ^ r2.state;
  if (popcount(diff) !== 1) return -1;
  return numberOfTrailingZeros(diff);
}

function popcount(n: number): number {
  let count = 0;
  let v = n >>> 0;
  while (v) {
    count += v & 1;
    v >>>= 1;
  }
  return count;
}

function numberOfTrailingZeros(n: number): number {
  if (n === 0) return 32;
  let count = 0;
  let v = n >>> 0;
  while ((v & 1) === 0) {
    count++;
    v >>>= 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Prime implicant finding
// ---------------------------------------------------------------------------

function findPrimeImplicants(initialRows: Row[]): Row[] {
  let currentRows = initialRows;
  const primes: Row[] = [];

  while (currentRows.length > 0) {
    const nextRows: Row[] = [];

    for (let i = 0; i < currentRows.length; i++) {
      for (let j = i + 1; j < currentRows.length; j++) {
        const r1 = currentRows[i]!;
        const r2 = currentRows[j]!;
        const bitIndex = checkCompatible(r1, r2);
        if (bitIndex < 0) continue;

        const newRow = copyRow(r1);
        newRow.eliminated |= 1 << bitIndex;
        newRow.state &= ~(1 << bitIndex);

        if (!nextRows.some((existing) => rowsEqual(existing, newRow))) {
          for (const s of r2.source) newRow.source.add(s);
          nextRows.push(newRow);
        }
        r1.used = true;
        r2.used = true;
      }
    }

    for (const row of currentRows) {
      if (!row.used && row.source.size > 0) {
        primes.push(row);
      }
    }

    currentRows = nextRows;
  }

  return primes;
}

// ---------------------------------------------------------------------------
// Minimal cover selection (brute-force, finds all solutions)
// ---------------------------------------------------------------------------

function findAllMinimalCovers(primes: Row[], requiredColumns: Set<number>): Row[][] {
  if (primes.length === 0) return [[]];
  if (requiredColumns.size === 0) return [[]];

  const n = primes.length;
  if (n > 31) {
    // Fall back to greedy (largest-first) for very large prime sets
    return [greedyCover(primes, requiredColumns)];
  }

  const totalCombinations = 1 << n;
  // Sort by number of bits set (fewest primes first)
  const indices: number[] = [];
  for (let i = 1; i < totalCombinations; i++) indices.push(i);
  indices.sort((a, b) => popcount(a) - popcount(b));

  let bestPrimeCount = n + 1;
  const foundSolutions: Row[][] = [];

  for (const mask of indices) {
    const primesUsed = popcount(mask);
    if (primesUsed > bestPrimeCount) break;

    // Check if this combination covers all required columns
    const covered = new Set<number>();
    for (let bit = 0; bit < n; bit++) {
      if ((mask >> bit) & 1) {
        for (const s of primes[bit]!.source) covered.add(s);
      }
    }

    if (isSuperset(covered, requiredColumns)) {
      bestPrimeCount = primesUsed;
      const solution: Row[] = [];
      for (let bit = 0; bit < n; bit++) {
        if ((mask >> bit) & 1) solution.push(primes[bit]!);
      }
      foundSolutions.push(solution);
    }
  }

  return foundSolutions.length > 0 ? foundSolutions : [greedyCover(primes, requiredColumns)];
}

function isSuperset<T>(set: Set<T>, subset: Set<T>): boolean {
  for (const item of subset) {
    if (!set.has(item)) return false;
  }
  return true;
}

function greedyCover(primes: Row[], requiredColumns: Set<number>): Row[] {
  const uncovered = new Set(requiredColumns);
  const selected: Row[] = [];
  const remaining = [...primes];

  while (uncovered.size > 0 && remaining.length > 0) {
    let bestIdx = 0;
    let bestCount = 0;
    for (let i = 0; i < remaining.length; i++) {
      let count = 0;
      for (const s of remaining[i]!.source) {
        if (uncovered.has(s)) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestIdx = i;
      }
    }
    const best = remaining.splice(bestIdx, 1)[0]!;
    selected.push(best);
    for (const s of best.source) uncovered.delete(s);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Expression building from rows
// ---------------------------------------------------------------------------

function buildExprFromRows(rows: Row[], varNames: string[]): BoolExpr {
  if (rows.length === 0) return constant(false);

  const terms = rows.map((row) => rowToExpr(row, varNames));
  return or(terms);
}

function rowToExpr(row: Row, varNames: string[]): BoolExpr {
  const literals: BoolExpr[] = [];
  for (let i = 0; i < row.numVars; i++) {
    // Variable i (MSB-first) maps to bit position (numVars - 1 - i) in state
    const bitPos = row.numVars - 1 - i;
    if ((row.eliminated >> bitPos) & 1) continue;
    const name = varNames[i]!;
    const isOne = (row.state >> bitPos) & 1;
    literals.push(isOne ? variable(name) : negatedVariable(name));
  }
  return and(literals);
}

function rowToImplicant(row: Row, varNames: string[]): Implicant {
  const literals = new Map<string, boolean>();
  for (let i = 0; i < row.numVars; i++) {
    // Variable i (MSB-first) maps to bit position (numVars - 1 - i) in state
    const bitPos = row.numVars - 1 - i;
    if ((row.eliminated >> bitPos) & 1) continue;
    const name = varNames[i]!;
    const isOne = Boolean((row.state >> bitPos) & 1);
    literals.set(name, isOne);
  }
  return { literals, minterms: new Set(row.source) };
}

// ---------------------------------------------------------------------------
// Variable naming
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of variable names for a truth table.
 * For 1-bit inputs, uses the input name directly.
 * For multi-bit inputs, expands to name[bit] notation (MSB first).
 *
 * The variable order matches the bit ordering used in TruthTable row indices:
 * variables are ordered MSB-first, with the first input's MSB at the
 * highest position.
 */
function buildVarNames(table: TruthTable): string[] {
  const names: string[] = [];
  for (const input of table.inputs) {
    if (input.bitWidth === 1) {
      names.push(input.name);
    } else {
      for (let b = input.bitWidth - 1; b >= 0; b--) {
        names.push(`${input.name}[${b}]`);
      }
    }
  }
  return names;
}
