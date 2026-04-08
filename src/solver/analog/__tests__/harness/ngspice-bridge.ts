/**
 * Node FFI bridge to ngspice shared library.
 *
 * Loads ngspice.dll via node-ffi-napi / koffi, registers the
 * instrumentation callback, runs a SPICE netlist, and converts
 * ngspice per-iteration data into our CaptureSession format.
 *
 * IMPORTANT: This module is test-only and requires native addons.
 * It is not bundled into the browser application. Tests that use
 * this bridge should be in a separate test file with a guard:
 *
 *   import.meta.env?.NGSPICE_DLL_PATH || describe.skip(...)
 *
 * Environment variable:
 *   NGSPICE_DLL_PATH — absolute path to ngspice.dll with instrumentation
 */

import type {
  CaptureSession,
  TopologySnapshot,
  StepSnapshot,
  IterationSnapshot,
  ElementStateSnapshot,
} from "./types.js";

// ---------------------------------------------------------------------------
// FFI types (koffi bindings — resolved at runtime)
// ---------------------------------------------------------------------------

/**
 * Raw callback data from ngspice ni_instrument_cb.
 * Matches the C typedef in niiter.c.
 */
interface RawNgspiceIteration {
  iteration: number;
  matrixSize: number;
  rhs: Float64Array;
  rhsOld: Float64Array;
  state0: Float64Array;
  numStates: number;
  noncon: number;
  converged: boolean;
}

// ---------------------------------------------------------------------------
// NgspiceBridge
// ---------------------------------------------------------------------------

/**
 * Bridge to an instrumented ngspice shared library.
 *
 * Usage:
 *   const bridge = new NgspiceBridge(process.env.NGSPICE_DLL_PATH!);
 *   bridge.loadNetlist(spiceNetlist);
 *   bridge.runDcOp();           // or runTran(stopTime, maxStep)
 *   const session = bridge.getCaptureSession();
 *   bridge.dispose();
 */
export class NgspiceBridge {
  private _dllPath: string;
  private _lib: any;  // koffi library handle
  private _iterations: RawNgspiceIteration[] = [];
  private _stepBoundaries: number[] = [];  // iteration indices where steps start
  private _topology: TopologySnapshot | null = null;

  constructor(dllPath: string) {
    this._dllPath = dllPath;
    // Actual FFI loading deferred to init() to allow async import of koffi
  }

  /**
   * Initialize the FFI binding. Must be called before any other method.
   * Separated from constructor because koffi is an optional dependency
   * that may not be installed in all environments.
   */
  async init(): Promise<void> {
    // Dynamic import to avoid hard dependency
    const koffi = await import("koffi");

    this._lib = koffi.load(this._dllPath);

    // Define callback type
    const callbackType = koffi.proto(
      "void ni_instrument_cb(int, int, double*, double*, double*, int, int, int)",
    );

    // Register our callback
    const registerFn = this._lib.func(
      "void ni_instrument_register(ni_instrument_cb*)",
    );

    const callback = koffi.register(
      (iteration: number, matrixSize: number, rhsPtr: any, rhsOldPtr: any,
       state0Ptr: any, numStates: number, noncon: number, converged: number) => {
        // Copy data out of ngspice buffers into JS-owned arrays
        const rhs = new Float64Array(matrixSize);
        const rhsOld = new Float64Array(matrixSize);
        const state0 = new Float64Array(numStates);

        koffi.decode(rhsPtr, "double", matrixSize, rhs);
        koffi.decode(rhsOldPtr, "double", matrixSize, rhsOld);
        koffi.decode(state0Ptr, "double", numStates, state0);

        this._iterations.push({
          iteration,
          matrixSize,
          rhs,
          rhsOld,
          state0,
          numStates,
          noncon,
          converged: converged !== 0,
        });
      },
      callbackType,
    );

    registerFn(callback);
  }

  /**
   * Load a SPICE netlist into ngspice.
   * The netlist should be a complete .spice file content as a string.
   */
  loadNetlist(netlist: string): void {
    // Use ngspice shared API: ngSpice_Circ(lines)
    const circ = this._lib.func("int ngSpice_Circ(char**)");
    const lines = netlist.split("\n").map(l => l + "\0");
    lines.push("\0"); // null terminator
    circ(lines);
  }

  /**
   * Run DC operating point analysis.
   */
  runDcOp(): void {
    this._iterations = [];
    const cmd = this._lib.func("int ngSpice_Command(char*)");
    cmd("op");
  }

  /**
   * Run transient analysis.
   */
  runTran(stopTime: number, maxStep: number): void {
    this._iterations = [];
    const cmd = this._lib.func("int ngSpice_Command(char*)");
    cmd(`tran ${maxStep} ${stopTime}`);
  }

  /**
   * Convert accumulated iteration data into a CaptureSession.
   *
   * Note: This produces a simplified session without matrix snapshots
   * (ngspice's assembled matrix is not exposed through the callback).
   * Voltage and state comparisons are the primary use case.
   */
  getCaptureSession(): CaptureSession {
    // Group iterations into steps by detecting iteration counter resets
    const steps: StepSnapshot[] = [];
    let currentStepIterations: IterationSnapshot[] = [];
    let lastIteration = -1;

    for (const raw of this._iterations) {
      if (raw.iteration <= lastIteration && currentStepIterations.length > 0) {
        // New step detected (iteration counter reset)
        steps.push({
          simTime: 0, // will need to be populated from ngspice time vector
          dt: 0,
          iterations: currentStepIterations,
          converged: currentStepIterations[currentStepIterations.length - 1]?.globalConverged ?? false,
          iterationCount: currentStepIterations.length,
        });
        currentStepIterations = [];
      }

      currentStepIterations.push({
        iteration: raw.iteration,
        voltages: raw.rhs.slice(),  // ngspice: CKTrhs = new voltages after solve
        prevVoltages: raw.rhsOld.slice(),
        rhs: new Float64Array(0),   // matrix RHS not available from callback
        matrix: [],                 // matrix entries not available
        elementStates: [],          // populated via device mapping + state0
        noncon: raw.noncon,
        globalConverged: raw.converged,
        elemConverged: raw.converged, // ngspice merges both into noncon
      });

      lastIteration = raw.iteration;
    }

    // Flush last step
    if (currentStepIterations.length > 0) {
      steps.push({
        simTime: 0,
        dt: 0,
        iterations: currentStepIterations,
        converged: currentStepIterations[currentStepIterations.length - 1]?.globalConverged ?? false,
        iterationCount: currentStepIterations.length,
      });
    }

    return {
      source: "ngspice",
      topology: this._topology ?? {
        matrixSize: this._iterations[0]?.matrixSize ?? 0,
        nodeCount: 0,
        branchCount: 0,
        elementCount: 0,
        elements: [],
        nodeLabels: new Map(),
      },
      steps,
    };
  }

  /**
   * Clean up FFI resources.
   */
  dispose(): void {
    if (this._lib) {
      // Unregister callback
      const registerFn = this._lib.func(
        "void ni_instrument_register(void*)",
      );
      registerFn(null);
      this._lib = null;
    }
  }
}
