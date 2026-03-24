/**
 * Dependency analysis — determine which outputs depend on which inputs.
 *
 * For each (output, input) pair, the dependency is determined empirically:
 * vary the input between 0 and 1 while holding all other inputs at 0.
 * If the output changes, the output depends on that input.
 *
 * This approach correctly handles multi-bit signals and complex gate
 * topologies without requiring static dataflow analysis.
 *
 * The result is a DependencyMatrix:
 *   depends[outputIdx][inputIdx] = true iff output depends on input.
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { SimulatorFacade } from '../headless/facade.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DependencyMatrix {
  /** Ordered input signal names. */
  readonly inputs: readonly string[];
  /** Ordered output signal names. */
  readonly outputs: readonly string[];
  /**
   * depends[outputIdx][inputIdx] = true iff the output depends on that input.
   *
   * Indexed as: depends[outputIdx][inputIdx]
   */
  readonly depends: readonly (readonly boolean[])[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse which outputs depend on which inputs.
 *
 * @param facade   Simulator facade (compile/setInput/readOutput/runToStable).
 * @param circuit  The circuit to analyse.
 * @returns        Dependency matrix.
 */
export function analyseDependencies(
  facade: SimulatorFacade,
  circuit: Circuit,
): DependencyMatrix {
  const inputs = collectInputNames(circuit);
  const outputs = collectOutputNames(circuit);

  if (inputs.length === 0 || outputs.length === 0) {
    return {
      inputs,
      outputs,
      depends: outputs.map(() => inputs.map(() => false)),
    };
  }

  const engine = facade.compile(circuit);

  // Build the dependency matrix
  const depends: boolean[][] = outputs.map(() => inputs.map(() => false));

  // Test with two baselines (all-0 and all-1) to catch both AND-type and
  // OR-type dependencies. An AND gate output only changes when toggling
  // an input while others are 1; an OR gate only changes when others are 0.
  for (const baseValue of [0, 1]) {
    for (let inputIdx = 0; inputIdx < inputs.length; inputIdx++) {
      const inputName = inputs[inputIdx]!;

      // Set all inputs to baseline value
      for (const name of inputs) {
        facade.setInput(engine, name, baseValue);
      }
      facade.runToStable(engine);

      // Read baseline output values
      const baseline = outputs.map((outName) => facade.readOutput(engine, outName));

      // Toggle this input
      facade.setInput(engine, inputName, baseValue === 0 ? 1 : 0);
      facade.runToStable(engine);

      // Compare outputs
      for (let outputIdx = 0; outputIdx < outputs.length; outputIdx++) {
        const newValue = facade.readOutput(engine, outputs[outputIdx]!);
        if (newValue !== baseline[outputIdx]) {
          depends[outputIdx]![inputIdx] = true;
        }
      }
    }
  }

  return { inputs, outputs, depends };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectInputNames(circuit: Circuit): string[] {
  return circuit.elements
    .filter((el) => el.typeId === 'In')
    .map((el) => getLabel(el));
}

function collectOutputNames(circuit: Circuit): string[] {
  return circuit.elements
    .filter((el) => el.typeId === 'Out')
    .map((el) => getLabel(el));
}

function getLabel(el: CircuitElement): string {
  const props = el.getProperties();
  if (props.has('label')) {
    const val = props.get('label');
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return el.instanceId;
}
