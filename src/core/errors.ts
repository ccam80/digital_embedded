/**
 * Error type taxonomy for the digital circuit simulator.
 *
 * All simulation and structural errors extend SimulationError, which carries
 * optional context fields for user-facing diagnostics: which component failed,
 * which net was involved, and what the expected vs actual state was.
 */

// ---------------------------------------------------------------------------
// SimulationError — base class for all simulator errors
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
// BurnException — shorted outputs / conflicting drivers on a net
// ---------------------------------------------------------------------------

/**
 * Thrown when two or more output pins drive a net to conflicting values
 * simultaneously (a "burn" condition — analogous to a shorted circuit).
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
// BacktrackException — switching network initialization failure
// ---------------------------------------------------------------------------

/**
 * Thrown when the switching network (bidirectional switches, transmission
 * gates) cannot reach a stable initial state during circuit initialization.
 * The resolver backtracks but exhausts its attempts.
 *
 */
export class BacktrackException extends SimulationError {
  /** Number of backtrack attempts made before giving up. */
  readonly attempts: number;

  constructor(
    message: string,
    options?: {
      componentId?: string;
      netId?: number;
      attempts?: number;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "BacktrackException";
    this.attempts = options?.attempts ?? 0;
  }
}

// ---------------------------------------------------------------------------
// BitsException — bit-width mismatch between connected pins
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
// NodeException — component evaluation error
// ---------------------------------------------------------------------------

/**
 * Thrown when a component's evaluation (flat execute function) encounters an
 * internal error — for example, an invalid configuration that was not caught
 * at compile time.
 *
 */
export class NodeException extends SimulationError {
  constructor(
    message: string,
    options?: {
      componentId?: string;
      netId?: number;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "NodeException";
  }
}

// ---------------------------------------------------------------------------
// OscillationError — circuit did not stabilize within iteration limit
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

  constructor(
    message: string,
    options?: {
      componentId?: string;
      netId?: number;
      iterations?: number;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "OscillationError";
    this.iterations = options?.iterations ?? 0;
  }
}

// ---------------------------------------------------------------------------
// PinException — unconnected or misconfigured pin
// ---------------------------------------------------------------------------

/**
 * Thrown when a pin is in an invalid state: unconnected when it must be
 * connected, multiply-driven when it may only have one driver, or configured
 * with an invalid bit width.
 *
 */
export class PinException extends SimulationError {
  /** Label of the pin that caused the error. */
  readonly pinLabel: string | undefined;

  constructor(
    message: string,
    options?: {
      componentId?: string;
      netId?: number;
      pinLabel?: string;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "PinException";
    this.pinLabel = options?.pinLabel;
  }
}
