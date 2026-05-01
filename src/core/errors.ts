/**
 * Error type taxonomy for the digital circuit simulator.
 *
 * All simulation and structural errors extend SimulationError, which carries
 * optional context fields for user-facing diagnostics: which component failed,
 * which net was involved, and what the expected vs actual state was.
 */

// ---------------------------------------------------------------------------
// SimulationError- base class for all simulator errors
// ---------------------------------------------------------------------------

/**
 * Base class for all errors originating in the simulation engine, compiler,
 * or structural validation layer.
 *
 * Context fields are optional because not every error has component/net
 * attribution (e.g. a structural parse error may have neither).
 */
export class SimulationError extends Error {
  /** ID of the component that caused or is associated with this error. */
  readonly componentId: string | undefined;

  /** Net ID involved in this error (set by the compiler/engine layer). */
  readonly netId: number | undefined;

  constructor(
    message: string,
    options?: {
      componentId?: string;
      netId?: number;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SimulationError";
    this.componentId = options?.componentId;
    this.netId = options?.netId;
  }
}

// ---------------------------------------------------------------------------
// BurnException- shorted outputs / conflicting drivers on a net
// ---------------------------------------------------------------------------

/**
 * Thrown when two or more output pins drive a net to conflicting values
 * simultaneously (a "burn" condition- analogous to a shorted circuit).
 *
 */
export class BurnException extends SimulationError {
  /** The conflicting signal values that were observed on the net. */
  readonly conflictingValues: readonly number[];

  constructor(
    message: string,
    options?: {
      componentId?: string;
      netId?: number;
      conflictingValues?: number[];
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "BurnException";
    this.conflictingValues = options?.conflictingValues ?? [];
  }
}

// ---------------------------------------------------------------------------
// BitsException- bit-width mismatch between connected pins
// ---------------------------------------------------------------------------

/**
 * Thrown when two pins connected by a wire have incompatible bit widths,
 * making it impossible to compile a valid net assignment.
 *
 */
export class BitsException extends SimulationError {
  /** Bit width declared by the source (driving) pin. */
  readonly expectedBits: number;

  /** Bit width declared by the sink (receiving) pin. */
  readonly actualBits: number;

  constructor(
    message: string,
    options?: {
      componentId?: string;
      netId?: number;
      expectedBits?: number;
      actualBits?: number;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "BitsException";
    this.expectedBits = options?.expectedBits ?? 0;
    this.actualBits = options?.actualBits ?? 0;
  }
}

// ---------------------------------------------------------------------------
// OscillationError- circuit did not stabilize within iteration limit
// ---------------------------------------------------------------------------

/**
 * Thrown when a circuit fails to reach a stable state within the allowed
 * number of iterations. Indicates a combinational feedback loop that never
 * converges (e.g. a ring oscillator or improperly initialized SR latch).
 *
 */
export class OscillationError extends SimulationError {
  /** Number of iterations attempted before giving up. */
  readonly iterations: number;

  /** Indices of the components confirmed to be oscillating. */
  readonly componentIndices: number[];

  constructor(
    message: string,
    options?: {
      componentId?: string;
      netId?: number;
      iterations?: number;
      componentIndices?: number[];
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "OscillationError";
    this.iterations = options?.iterations ?? 0;
    this.componentIndices = options?.componentIndices ?? [];
  }
}

