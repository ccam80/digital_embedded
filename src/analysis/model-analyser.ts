/**
 * Model Analyser — generate a complete truth table for a combinational circuit.
 *
 * Process:
 *   1. Identify input signals (all "In" components) and output signals (all "Out" components).
 *   2. Validate: total input bit count ≤ 20 (2^20 = ~1M rows).
 *   3. Detect combinational feedback loops. Abort if any found.
 *   4. Enumerate all 2^N input combinations, simulate each, record outputs.
 *   5. Return structured TruthTable.
 *
 * Multi-bit signals: an N-bit input contributes N bits to the combination space.
 * Total combinations = 2^(sum of all input bit widths).
 *
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { SimulatorFacade } from '../headless/facade.js';
import { detectCycles } from './cycle-detector.js';
import { MAX_INPUT_BITS } from '../core/constants.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Signal specification: name and bit width.
 */
export interface SignalSpec {
  /** Label of the In or Out component. */
  name: string;
  /** Bit width of the signal. */
  bitWidth: number;
}

/**
 * One row in a truth table.
 */
export interface TruthTableRow {
  /** Input values in the same order as TruthTable.inputs. */
  inputValues: bigint[];
  /** Output values in the same order as TruthTable.outputs. */
  outputValues: bigint[];
}

/**
 * A complete truth table for a combinational circuit.
 */
export interface TruthTable {
  inputs: SignalSpec[];
  outputs: SignalSpec[];
  rows: TruthTableRow[];
}

// ---------------------------------------------------------------------------
// analyseCircuit — public API
// ---------------------------------------------------------------------------

/**
 * Analyse a combinational circuit and return its complete truth table.
 *
 * @param facade   The simulator facade (provides compile/setInput/readOutput/runToStable).
 * @param circuit  The circuit to analyse.
 * @returns        Complete truth table with all 2^N input combinations.
 * @throws Error   If input count exceeds 20 bits, or combinational cycles are detected.
 */
export function analyseCircuit(facade: SimulatorFacade, circuit: Circuit): TruthTable {
  // Step 1: identify inputs and outputs
  const inputs = collectInputSpecs(circuit);
  const outputs = collectOutputSpecs(circuit);

  // Step 2: validate input limit
  const totalInputBits = inputs.reduce((sum, s) => sum + s.bitWidth, 0);
  if (totalInputBits > MAX_INPUT_BITS) {
    throw new Error(
      `Circuit has ${totalInputBits} input bits (from ${inputs.length} inputs). ` +
      `Maximum is ${MAX_INPUT_BITS} bits (2^${MAX_INPUT_BITS} = ${(1 << MAX_INPUT_BITS).toLocaleString()} rows). ` +
      `For circuits with more than ${MAX_INPUT_BITS} inputs, use test vectors instead of exhaustive analysis.`,
    );
  }

  // Step 3: detect combinational feedback loops
  const cycles = detectCycles(circuit);
  if (cycles.length > 0) {
    const descriptions = cycles.map((c) => c.description).join('; ');
    throw new Error(
      `Circuit contains combinational feedback loops and cannot be analysed exhaustively. ` +
      `Cycles detected: ${descriptions}`,
    );
  }

  // Step 4: enumerate all 2^N combinations
  const totalCombinations = 1 << totalInputBits;
  const engine = facade.compile(circuit);
  const rows: TruthTableRow[] = [];

  for (let combo = 0; combo < totalCombinations; combo++) {
    // Distribute combo bits across inputs, MSB of combo → first input
    const inputValues = distributeInputBits(combo, inputs, totalInputBits);

    // Set each input
    for (let i = 0; i < inputs.length; i++) {
      facade.setInput(engine, inputs[i].name, Number(inputValues[i]));
    }

    // Propagate
    facade.runToStable(engine);

    // Read outputs
    const outputValues = outputs.map((out) =>
      BigInt(facade.readOutput(engine, out.name)),
    );

    rows.push({ inputValues, outputValues });
  }

  return { inputs, outputs, rows };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Collect all In component specs from the circuit, in element order.
 */
function collectInputSpecs(circuit: Circuit): SignalSpec[] {
  const specs: SignalSpec[] = [];
  for (const el of circuit.elements) {
    if (el.typeId === 'In') {
      const label = getLabel(el);
      const bitWidth = getBitWidth(el);
      specs.push({ name: label, bitWidth });
    }
  }
  return specs;
}

/**
 * Collect all Out component specs from the circuit, in element order.
 */
function collectOutputSpecs(circuit: Circuit): SignalSpec[] {
  const specs: SignalSpec[] = [];
  for (const el of circuit.elements) {
    if (el.typeId === 'Out') {
      const label = getLabel(el);
      const bitWidth = getBitWidth(el);
      specs.push({ name: label, bitWidth });
    }
  }
  return specs;
}

function getLabel(el: CircuitElement): string {
  const props = el.getProperties();
  if (props.has('label')) {
    const val = props.get('label');
    if (typeof val === 'string') return val;
  }
  return el.instanceId;
}

function getBitWidth(el: CircuitElement): number {
  const props = el.getProperties();
  if (props.has('bitWidth')) {
    const val = props.get('bitWidth');
    if (typeof val === 'number') return val;
  }
  return 1;
}

/**
 * Distribute an integer combo value across a set of input signals.
 *
 * The combo integer encodes all input bits in MSB-first order:
 * the most significant bits of combo go to the first input.
 *
 * For example with inputs [A(2-bit), B(1-bit)] and totalInputBits=3:
 *   combo=5 (binary 101): A=0b10=2, B=0b1=1
 *
 * @param combo          Integer encoding all input bits.
 * @param inputs         Input signal specs (ordered).
 * @param totalInputBits Total bit count across all inputs.
 * @returns              Array of BigInt values, one per input.
 */
function distributeInputBits(
  combo: number,
  inputs: SignalSpec[],
  totalInputBits: number,
): bigint[] {
  const result: bigint[] = [];
  let bitsRemaining = totalInputBits;

  for (const input of inputs) {
    bitsRemaining -= input.bitWidth;
    // Extract input.bitWidth bits starting at position bitsRemaining
    const mask = (1 << input.bitWidth) - 1;
    const value = (combo >>> bitsRemaining) & mask;
    result.push(BigInt(value));
  }

  return result;
}
