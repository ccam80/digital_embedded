import type { Circuit } from "../core/circuit.js";
import type { SubcircuitHost } from "./flatten.js";

/**
 * Describes a single pin crossing the boundary between two engine types.
 *
 * Each interface pin on the subcircuit that connects the outer circuit to the
 * inner circuit produces one BoundaryPinMapping entry.
 */
export interface BoundaryPinMapping {
  /**
   * Label of the interface pin as declared on the subcircuit element in the
   * outer circuit (matches the In/Out element label inside the subcircuit).
   */
  pinLabel: string;

  /**
   * Signal direction from the subcircuit's perspective.
   *
   * 'in'  — data flows into the subcircuit (outer drives inner)
   *         Corresponds to an In element inside the subcircuit.
   * 'out' — data flows out of the subcircuit (inner drives outer)
   *         Corresponds to an Out element inside the subcircuit.
   */
  direction: "in" | "out";

  /**
   * Net ID in the outer circuit for the wire connecting to this pin.
   * Filled in by the compiler after node assignment. Undefined until then.
   */
  outerNodeId?: number;

  /**
   * Label of the corresponding In or Out element inside the subcircuit.
   * Typically identical to pinLabel, but stored explicitly for unambiguous
   * lookup inside the internal circuit.
   */
  innerLabel: string;

  /**
   * Bus width of this pin. A multi-bit signal (bitWidth > 1) creates
   * bitWidth independent bridge adapter pairs — one per bit.
   * The compiler iterates bits 0..bitWidth-1.
   */
  bitWidth: number;
}

/**
 * A subcircuit instance whose internal engine type differs from the outer
 * circuit's engine type. The flattener records one CrossEngineBoundary per
 * such instance instead of inlining the subcircuit's contents.
 *
 * The analog compiler consumes this structure to insert BridgeOutputAdapter /
 * BridgeInputAdapter elements at the boundary and to compile the inner circuit
 * with the appropriate engine.
 */
export interface CrossEngineBoundary {
  /** The original subcircuit element in the outer circuit (not flattened). */
  subcircuitElement: SubcircuitHost;

  /** The subcircuit's internal circuit definition. */
  internalCircuit: Circuit;

  /** Derived domain of the internal circuit ("digital" | "analog" | "auto"). */
  internalEngineType: string;

  /** Derived domain of the outer circuit ("digital" | "analog" | "auto"). */
  outerEngineType: string;

  /** One entry per interface pin on the subcircuit. */
  pinMappings: BoundaryPinMapping[];

  /**
   * Scoped name for this boundary instance — used in diagnostics and as a
   * key when the coordinator manages multiple bridges.
   * Format mirrors the scope prefix used by the flattener:
   * e.g. "DigitalCounter_2" or "TopLevel.DigitalCounter_2".
   */
  instanceName: string;
}
