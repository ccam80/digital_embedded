/**
 * Circuit Comparison- compare two circuits by running the same test vectors
 * against both and diffing the outputs.
 *
 * Two modes:
 *   - test-based:  instructor-provided test vectors drive both circuits
 *   - exhaustive:  all 2^N input combinations when total input bits ≤ 20
 *
 * Auto-selection: test data provided → test-based; no test data + inputs ≤ 20
 * bits → exhaustive; otherwise error.
 *
 * Input/output signal names for exhaustive mode are derived from the reference
 * circuit's In/Out elements (typeId "In" / "Out").
 *
 */

import type { Circuit } from '../core/circuit.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';
import type { ParsedTestData } from './parser.js';

// ---------------------------------------------------------------------------
// ComparatorFacade- minimal interface required by compareCircuits
// ---------------------------------------------------------------------------

/**
 * Minimal facade required by compareCircuits.
 *
 * Both SimulatorFacade and SimulationRunner satisfy this interface structurally.
 */
export interface ComparatorFacade {
  compile(circuit: Circuit): SimulationCoordinator;
  setSignal(coordinator: SimulationCoordinator, label: string, value: number): void;
  readSignal(coordinator: SimulationCoordinator, label: string): number;
  settle(coordinator: SimulationCoordinator, settleTime?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

/**
 * A single input combination where the two circuits produced different outputs.
 */
export interface ComparisonMismatch {
  /** Zero-based index of this vector in the test run. */
  vectorIndex: number;
  /** Input signal values applied for this vector. */
  inputs: Record<string, number>;
  /** Output values from the reference circuit. */
  referenceOutputs: Record<string, number>;
  /** Output values from the student circuit. */
  studentOutputs: Record<string, number>;
  /** Names of the output signals that disagreed. */
  differingSignals: string[];
}

/**
 * Full result of comparing two circuits.
 */
export interface ComparisonResult {
  /** Which comparison mode was used. */
  mode: 'test-based' | 'exhaustive';
  /** Total number of input combinations tested. */
  totalVectors: number;
  /** Number of combinations where both circuits agreed. */
  matchCount: number;
  /** Number of combinations where the circuits disagreed. */
  mismatchCount: number;
  /** Detailed mismatch records. */
  mismatches: ComparisonMismatch[];
}

// ---------------------------------------------------------------------------
// Signal inventory- names and bit widths derived from circuit elements
// ---------------------------------------------------------------------------

interface SignalInventory {
  inputNames: string[];
  /** Parallel bit-width array, index-aligned with inputNames. */
  inputBitWidths: number[];
  outputNames: string[];
  /** Total number of input bits (sum of bitWidths for all In elements). */
  totalInputBits: number;
}

/**
 * Walk the reference circuit's elements, collect In/Out labels and bit widths.
 * Elements with typeId "In" are inputs; typeId "Out" are outputs.
 */
function deriveSignalInventory(circuit: Circuit): SignalInventory {
  const inputNames: string[] = [];
  const inputBitWidths: number[] = [];
  const outputNames: string[] = [];
  let totalInputBits = 0;

  for (const element of circuit.elements) {
    const props = element.getProperties();
    if (element.typeId === "In" || element.typeId === "Port") {
      const label = props.getOrDefault<string>("label", "");
      const bitWidth = props.getOrDefault<number>("bitWidth", 1);
      if (label.length > 0) {
        inputNames.push(label);
        inputBitWidths.push(bitWidth);
        totalInputBits += bitWidth;
      }
    } else if (element.typeId === "Out" || element.typeId === "Port") {
      const label = props.getOrDefault<string>("label", "");
      if (label.length > 0) {
        outputNames.push(label);
      }
    }
  }

  return { inputNames, inputBitWidths, outputNames, totalInputBits };
}

// ---------------------------------------------------------------------------
// compareCircuits- main entry point
// ---------------------------------------------------------------------------

/**
 * Compare a reference circuit against a student circuit.
 *
 * Both circuits are compiled fresh. The same test vectors are applied to both.
 * When output signals disagree, a ComparisonMismatch is recorded.
 *
 * @param facade            The facade providing compile/setSignal/readSignal/settle
 * @param referenceCircuit  The known-correct reference circuit
 * @param studentCircuit    The student's circuit under evaluation
 * @param testData          Optional parsed test vectors; if absent, exhaustive mode is used
 * @returns                 ComparisonResult with match/mismatch counts and details
 * @throws                  Error if exhaustive mode is needed but total input bits > 20
 */
export async function compareCircuits(
  facade: ComparatorFacade,
  referenceCircuit: Circuit,
  studentCircuit: Circuit,
  testData?: ParsedTestData,
): Promise<ComparisonResult> {
  const refCoord = facade.compile(referenceCircuit);
  const stuCoord = facade.compile(studentCircuit);

  if (testData !== undefined) {
    return runTestBased(facade, refCoord, stuCoord, testData);
  }

  const inventory = deriveSignalInventory(referenceCircuit);

  if (inventory.totalInputBits > 20) {
    throw new Error(
      `Exhaustive comparison requires \u2264 20 total input bits, but the reference circuit has ` +
      `${inventory.totalInputBits} input bits. Provide test vectors to use test-based comparison.`
    );
  }

  return runExhaustive(facade, refCoord, stuCoord, inventory);
}

// ---------------------------------------------------------------------------
// Test-based comparison
// ---------------------------------------------------------------------------

async function runTestBased(
  facade: ComparatorFacade,
  refEngine: SimulationCoordinator,
  stuEngine: SimulationCoordinator,
  testData: ParsedTestData,
): Promise<ComparisonResult> {
  const mismatches: ComparisonMismatch[] = [];

  for (let i = 0; i < testData.vectors.length; i++) {
    const vector = testData.vectors[i];

    // Collect numeric input values (skip don't-care and clock)
    const inputValues: Record<string, number> = {};
    for (const name of testData.inputNames) {
      const tv = vector.inputs.get(name);
      if (tv === undefined || tv.kind === 'dontCare' || tv.kind === 'clock') {
        inputValues[name] = 0;
        continue;
      }
      if (tv.kind === 'highZ') {
        inputValues[name] = 0xFFFFFFFF;
        continue;
      }
      inputValues[name] = Number(tv.value);
    }

    const mismatch = await runOneBoth(
      facade, refEngine, stuEngine,
      testData.inputNames, testData.outputNames,
      inputValues, i,
    );

    if (mismatch !== null) {
      mismatches.push(mismatch);
    }
  }

  const totalVectors = testData.vectors.length;
  return {
    mode: 'test-based',
    totalVectors,
    matchCount: totalVectors - mismatches.length,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

// ---------------------------------------------------------------------------
// Exhaustive comparison
// ---------------------------------------------------------------------------

async function runExhaustive(
  facade: ComparatorFacade,
  refEngine: SimulationCoordinator,
  stuEngine: SimulationCoordinator,
  inventory: SignalInventory,
): Promise<ComparisonResult> {
  const { inputNames, inputBitWidths, outputNames, totalInputBits } = inventory;
  const totalVectors = 1 << totalInputBits;
  const mismatches: ComparisonMismatch[] = [];

  for (let combo = 0; combo < totalVectors; combo++) {
    // Split the combined bit index into per-signal values
    const inputValues: Record<string, number> = {};
    let remaining = combo;
    for (let k = 0; k < inputNames.length; k++) {
      const width = inputBitWidths[k];
      const mask = (1 << width) - 1;
      inputValues[inputNames[k]] = remaining & mask;
      remaining >>= width;
    }

    const mismatch = await runOneBoth(
      facade, refEngine, stuEngine,
      inputNames, outputNames,
      inputValues, combo,
    );

    if (mismatch !== null) {
      mismatches.push(mismatch);
    }
  }

  return {
    mode: 'exhaustive',
    totalVectors,
    matchCount: totalVectors - mismatches.length,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

// ---------------------------------------------------------------------------
// Shared: apply one input combination to both circuits and diff outputs
// ---------------------------------------------------------------------------

async function runOneBoth(
  facade: ComparatorFacade,
  refEngine: SimulationCoordinator,
  stuEngine: SimulationCoordinator,
  inputNames: string[],
  outputNames: string[],
  inputValues: Record<string, number>,
  vectorIndex: number,
): Promise<ComparisonMismatch | null> {
  // Apply inputs to reference
  for (const name of inputNames) {
    facade.setSignal(refEngine, name, inputValues[name] ?? 0);
  }
  await facade.settle(refEngine);

  // Apply same inputs to student
  for (const name of inputNames) {
    facade.setSignal(stuEngine, name, inputValues[name] ?? 0);
  }
  await facade.settle(stuEngine);

  // Read and diff outputs
  const referenceOutputs: Record<string, number> = {};
  const studentOutputs: Record<string, number> = {};
  const differingSignals: string[] = [];

  for (const name of outputNames) {
    const refVal = facade.readSignal(refEngine, name);
    const stuVal = facade.readSignal(stuEngine, name);
    referenceOutputs[name] = refVal;
    studentOutputs[name] = stuVal;
    if (refVal !== stuVal) {
      differingSignals.push(name);
    }
  }

  if (differingSignals.length === 0) {
    return null;
  }

  return {
    vectorIndex,
    inputs: inputValues,
    referenceOutputs,
    studentOutputs,
    differingSignals,
  };
}
