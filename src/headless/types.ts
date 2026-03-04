/**
 * Shared types for the headless SimulatorFacade API.
 *
 * All types are browser-free and Node.js-compatible.
 * Used by LLMs, AI agents, the postMessage bridge, and programmatic clients.
 */

// ---------------------------------------------------------------------------
// CircuitBuildOptions — options for createCircuit()
// ---------------------------------------------------------------------------

/**
 * Options for creating a new circuit via the facade.
 */
export interface CircuitBuildOptions {
  /** Human-readable name for the circuit. Defaults to "Untitled". */
  name?: string;
  /** Optional description. */
  description?: string;
}

// ---------------------------------------------------------------------------
// TestVector — result of a single test vector row
// ---------------------------------------------------------------------------

/**
 * The outcome of running one test vector row.
 */
export interface TestVector {
  /** Whether this row passed. */
  passed: boolean;
  /** The input values applied for this row (signal label → raw value). */
  inputs: Record<string, number>;
  /** The expected output values for this row (signal label → raw value). */
  expectedOutputs: Record<string, number>;
  /** The actual output values observed (signal label → raw value). */
  actualOutputs: Record<string, number>;
}

// ---------------------------------------------------------------------------
// TestResults — aggregate results from runTests()
// ---------------------------------------------------------------------------

/**
 * Aggregate result of running a circuit's test suite via runTests().
 */
export interface TestResults {
  /** Number of test vectors that passed. */
  passed: number;
  /** Number of test vectors that failed. */
  failed: number;
  /** Total number of test vectors evaluated. */
  total: number;
  /** Per-vector results, in row order. */
  vectors: TestVector[];
}

// ---------------------------------------------------------------------------
// FacadeError — structured error for all facade-level failures
// ---------------------------------------------------------------------------

/**
 * Error class for all facade-level failures.
 *
 * Messages are plain English — not raw stack traces. Context fields carry
 * structured information for programmatic inspection. LLM clients should read
 * .message for a human-readable description and the context fields for
 * structured data.
 *
 * Examples:
 *   "Unknown component type 'Andd'. Did you mean 'And'?"
 *   "Pin 'X' not found on component 'And'. Valid pins: A, B, Y."
 *   "Cannot connect output pin 'Y' (1 bit) to input pin 'A' (8 bits)."
 */
export class FacadeError extends Error {
  /** Name of the component type involved, e.g. "And". */
  readonly componentName: string | undefined;
  /** Label of the pin involved, e.g. "A". */
  readonly pinLabel: string | undefined;
  /** Name of the circuit involved. */
  readonly circuitName: string | undefined;
  /** Additional structured context for programmatic inspection. */
  readonly context: Record<string, unknown> | undefined;

  constructor(
    message: string,
    componentName?: string,
    pinLabel?: string,
    circuitName?: string,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FacadeError";
    this.componentName = componentName;
    this.pinLabel = pinLabel;
    this.circuitName = circuitName;
    this.context = context;
    Object.setPrototypeOf(this, FacadeError.prototype);
  }
}
