/**
 * Type definitions for the native JSON save format.
 *
 * The JSON format directly serializes PropertyBag values — no attribute
 * mapping is needed (that is only for .dig import). bigint values are
 * serialized as strings with a "_bigint:" prefix to survive JSON round-trip
 * (JSON has no native bigint type).
 */

// ---------------------------------------------------------------------------
// Saved sub-structures
// ---------------------------------------------------------------------------

/** Circuit-level metadata stored at the top of every saved file. */
export interface SavedMetadata {
  /** Display name for this circuit. */
  name: string;
  /** Optional description. */
  description: string;
  /** Ordering of measurement probes for the data table. */
  measurementOrdering: string[];
  /** Whether this is a generic (parameterised) circuit. */
  isGeneric: boolean;
  /**
   * Controls where analog/digital bridge adapters are placed.
   * Absent = "cross-domain" default.
   */
  digitalPinLoading?: "cross-domain" | "all" | "none";
  /**
   * Per-net overrides for digital pin loading mode.
   * Each entry identifies a net by anchor and overrides the circuit-level setting.
   */
  digitalPinLoadingOverrides?: Array<{
    anchor:
      | { type: "label"; label: string }
      | { type: "pin"; instanceId: string; pinLabel: string };
    loading: "loaded" | "ideal";
  }>;
}

/**
 * A single placed component as stored in the JSON format.
 * Properties are stored as a plain Record — bigints encoded as "_bigint:<n>".
 */
export interface SavedElement {
  /** Component type name matching the registry. E.g. "And", "FlipflopD". */
  typeName: string;
  /** Stable instance identifier for cross-circuit references and undo. */
  instanceId: string;
  /** Grid position of the component origin. */
  position: { x: number; y: number };
  /**
   * Rotation in quarter-turns clockwise.
   * 0 = default, 1 = 90° CW, 2 = 180°, 3 = 270° CW.
   */
  rotation: number;
  /** Whether the component is mirrored horizontally before rotation. */
  mirror: boolean;
  /** Serialized property values. bigint encoded as "_bigint:<n>". */
  properties: Record<string, unknown>;
}

/** A single wire segment as stored in the JSON format. */
export interface SavedWire {
  p1: { x: number; y: number };
  p2: { x: number; y: number };
}

// ---------------------------------------------------------------------------
// Root document type
// ---------------------------------------------------------------------------

/**
 * The complete JSON document produced by serializeCircuit().
 * version identifies the save format for future migration.
 */
export interface SavedCircuit {
  /** Save format version. Currently 1. */
  version: number;
  /** Circuit-level metadata. */
  metadata: SavedMetadata;
  /** All placed elements in stable order. */
  elements: SavedElement[];
  /** All wire segments. */
  wires: SavedWire[];
}
