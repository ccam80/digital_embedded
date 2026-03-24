/**
 * BridgeInstance — compiled inner circuit + bridge adapter mappings.
 *
 * Holds everything the MixedSignalCoordinator needs to synchronize one
 * digital subcircuit running inside an analog simulation:
 *   - The compiled inner circuit (for the digital engine)
 *   - Output adapters (digital→analog) and input adapters (analog→digital)
 *   - Net ID mappings so the coordinator can read/write signals in the inner
 *     digital circuit's signal array
 */

import type { CompiledCircuitImpl } from "../engine/compiled-circuit.js";
import type { BridgeOutputAdapter, BridgeInputAdapter } from "./bridge-adapter.js";

/**
 * Compiled representation of one cross-engine boundary.
 *
 * Produced by the analog compiler for each CrossEngineBoundary in the
 * FlattenResult. Consumed by the MixedSignalCoordinator.
 */
export interface BridgeInstance {
  /**
   * The inner digital circuit compiled by the digital compiler.
   *
   * The coordinator creates a DigitalEngine, calls init(compiledInner) on it,
   * and steps it independently from the outer analog engine.
   */
  compiledInner: CompiledCircuitImpl;

  /**
   * Adapters for digital→analog signals.
   *
   * Each adapter corresponds to one digital subcircuit output pin (Out element
   * inside the inner circuit). The coordinator reads the inner engine's output
   * net and calls adapter.setLogicLevel() to drive the outer analog MNA matrix.
   */
  outputAdapters: BridgeOutputAdapter[];

  /**
   * Adapters for analog→digital signals.
   *
   * Each adapter corresponds to one digital subcircuit input pin (In element
   * inside the inner circuit). The coordinator reads the outer analog node
   * voltage, calls adapter.readLogicLevel(), and writes the bit to the inner
   * engine's input net.
   */
  inputAdapters: BridgeInputAdapter[];

  /**
   * Net IDs in the inner compiled circuit for each output adapter.
   *
   * outputPinNetIds[i] is the net ID corresponding to outputAdapters[i].
   * The coordinator calls innerEngine.getSignalRaw(outputPinNetIds[i]) to
   * read the digital output value before updating the adapter.
   */
  outputPinNetIds: number[];

  /**
   * Net IDs in the inner compiled circuit for each input adapter.
   *
   * inputPinNetIds[i] is the net ID corresponding to inputAdapters[i].
   * The coordinator calls innerEngine.setSignalValue(inputPinNetIds[i], bit)
   * to inject the threshold-detected analog voltage into the inner circuit.
   */
  inputPinNetIds: number[];

  /**
   * Scoped name for this bridge instance.
   *
   * Used in diagnostic messages and as a unique key when multiple bridge
   * instances exist in a single analog circuit. Matches the instanceName
   * from the corresponding CrossEngineBoundary.
   */
  instanceName: string;
}
