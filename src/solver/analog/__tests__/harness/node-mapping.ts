/**
 * Structural node mapping between our engine and ngspice.
 *
 * ngspice node names follow patterns like:
 *   "q1_c", "q1_b", "q1_e"      — BJT collector/base/emitter
 *   "r1_1", "r1_2"               — resistor terminals
 *   "v1#branch"                   — voltage source branch current
 *   "d1_a", "d1_k"               — diode anode/cathode
 *   "m1_d", "m1_g", "m1_s"       — MOSFET drain/gate/source
 *   "0"                           — ground
 *   "net_3", "3"                  — internal net numbers
 *
 * Our node labels follow patterns like:
 *   "Q1:C", "Q1:B", "Q1:E"
 *   "R1:A", "R1:B"
 *   "V1:branch"
 *   "D1:A", "D1:K"
 *   "M1:D", "M1:G", "M1:S"
 *
 * The mapping pass:
 *   1. Canonicalizes both sides to a normalized form
 *   2. Matches by canonical form
 *   3. Falls back to net-number matching for unnamed internal nodes
 */

import type {
  NodeMapping,
  TopologySnapshot,
  NgspiceTopology,
  CaptureSession,
  IterationSnapshot,
  StepSnapshot,
} from "./types.js";

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/** Pin name aliases: ngspice suffix → our pin label. */
const PIN_ALIASES: Record<string, Record<string, string>> = {
  // BJT
  bjt: { c: "C", b: "B", e: "E", s: "S" },
  // Diode
  diode: { a: "A", k: "K", "1": "A", "2": "K" },
  // MOSFET
  mosfet: { d: "D", g: "G", s: "S", b: "B" },
  mos1: { d: "D", g: "G", s: "S", b: "B" },
  // JFET
  jfet: { d: "D", g: "G", s: "S" },
  // Resistor
  resistor: { "1": "A", "2": "B" },
  // Capacitor
  capacitor: { "1": "A", "2": "B" },
  // Inductor
  inductor: { "1": "A", "2": "B" },
  // Voltage source
  vsource: { "1": "pos", "2": "neg" },
  // Current source
  isource: { "1": "pos", "2": "neg" },
};

/**
 * Canonical form: "LABEL:PIN" (uppercase label, uppercase pin).
 * Returns null if the name can't be parsed.
 */
function canonicalizeNgspiceName(
  name: string,
  deviceTypeHint?: string,
): string | null {
  if (!name || name === "0") return null; // ground

  // Branch current: "v1#branch" → "V1:branch"
  const branchMatch = name.match(/^(.+)#branch$/i);
  if (branchMatch) {
    return `${branchMatch[1].toUpperCase()}:branch`;
  }

  // Device pin: "q1_c", "r1_1", "d1_a"
  // Try splitting on underscore (most common ngspice format)
  const underscoreMatch = name.match(/^([a-zA-Z]\w*)_(\w+)$/);
  if (underscoreMatch) {
    const [, devName, pinSuffix] = underscoreMatch;
    const label = devName.toUpperCase();
    const pinLower = pinSuffix.toLowerCase();

    // Try to resolve pin suffix via device type aliases
    if (deviceTypeHint) {
      const aliases = PIN_ALIASES[deviceTypeHint.toLowerCase()];
      if (aliases && aliases[pinLower]) {
        return `${label}:${aliases[pinLower]}`;
      }
    }

    // Try all alias tables
    for (const aliases of Object.values(PIN_ALIASES)) {
      if (aliases[pinLower]) {
        return `${label}:${aliases[pinLower]}`;
      }
    }

    // Fall back to uppercase pin suffix
    return `${label}:${pinSuffix.toUpperCase()}`;
  }

  // Bare net name or number — can't canonicalize to component:pin
  return null;
}

/**
 * Canonicalize our label format. Already in "LABEL:PIN" form,
 * just normalize case.
 */
function canonicalizeOurLabel(label: string): string {
  // Already "Q1:C" format — just uppercase
  return label.toUpperCase();
}

// ---------------------------------------------------------------------------
// Mapping builder
// ---------------------------------------------------------------------------

/**
 * Build node mappings between our engine and ngspice.
 *
 * Strategy:
 *   1. For each ngspice node, try to canonicalize its name
 *   2. For each of our nodes, canonicalize our label
 *   3. Match by canonical form (exact match)
 *   4. For unmatched nodes, attempt net-number fallback
 *
 * @param ourTopology  - Our engine's topology snapshot
 * @param ngTopology   - ngspice's topology (from topology callback)
 * @param deviceTypes  - Optional map of ngspice device name → device type
 *                       (helps disambiguate pin suffixes)
 */
export function buildNodeMapping(
  ourTopology: TopologySnapshot,
  ngTopology: NgspiceTopology,
): NodeMapping[] {
  const mappings: NodeMapping[] = [];

  // Build canonical → ourIndex map
  const ourCanonical = new Map<string, { index: number; label: string }>();
  ourTopology.nodeLabels.forEach((label, nodeId) => {
    // nodeLabels may have multiple labels joined by "/", try each
    for (const part of label.split("/")) {
      const canon = canonicalizeOurLabel(part.trim());
      if (canon && !ourCanonical.has(canon)) {
        ourCanonical.set(canon, { index: nodeId, label: part.trim() });
      }
    }
  });

  // Build device type hints from ngspice topology
  const deviceTypeByPrefix = new Map<string, string>();
  for (const dev of ngTopology.devices) {
    deviceTypeByPrefix.set(dev.name.toLowerCase(), dev.typeName.toLowerCase());
  }

  // For each ngspice node, try to match
  ngTopology.nodeNames.forEach((nodeNum, ngName) => {
    if (ngName === "0" || nodeNum === 0) return; // skip ground

    // Determine device type hint from the node name prefix
    const prefixMatch = ngName.match(/^([a-zA-Z]\w*?)_/);
    const deviceType = prefixMatch
      ? deviceTypeByPrefix.get(prefixMatch[1].toLowerCase())
      : undefined;

    const canon = canonicalizeNgspiceName(ngName, deviceType);
    if (!canon) return;

    const ourMatch = ourCanonical.get(canon);
    if (ourMatch) {
      mappings.push({
        ourIndex: ourMatch.index,
        ngspiceIndex: nodeNum,
        label: ourMatch.label,
        ngspiceName: ngName,
      });
    }
  });

  return mappings;
}

// ---------------------------------------------------------------------------
// Session reindexing
// ---------------------------------------------------------------------------

/**
 * Reindex an ngspice CaptureSession's voltage/RHS arrays to match
 * our engine's node ordering using the provided node mappings.
 *
 * Creates a new session with reindexed data (does not mutate the original).
 * Nodes without a mapping get NaN values.
 *
 * @param ngSession  - ngspice capture session (original ordering)
 * @param mappings   - Node mappings from buildNodeMapping()
 * @param ourSize    - Our matrix size (target array length)
 */
export function reindexNgspiceSession(
  ngSession: CaptureSession,
  mappings: NodeMapping[],
  ourSize: number,
): CaptureSession {
  // Build ngspice index → our index lookup
  const ngToOur = new Map<number, number>();
  for (const m of mappings) {
    ngToOur.set(m.ngspiceIndex, m.ourIndex);
  }

  function reindexArray(ngArr: Float64Array): Float64Array {
    const out = new Float64Array(ourSize);
    out.fill(NaN);
    ngToOur.forEach((ourIdx, ngIdx) => {
      if (ngIdx < ngArr.length && ourIdx - 1 < ourSize && ourIdx > 0) {
        // Our voltages are 0-based (solver indices), nodeIds are 1-based
        out[ourIdx - 1] = ngArr[ngIdx];
      }
    });
    return out;
  }

  function reindexIteration(iter: IterationSnapshot): IterationSnapshot {
    return {
      ...iter,
      voltages: reindexArray(iter.voltages),
      prevVoltages: reindexArray(iter.prevVoltages),
      rhs: iter.rhs.length > 0 ? reindexArray(iter.rhs) : iter.rhs,
      preSolveRhs: iter.preSolveRhs ? reindexArray(iter.preSolveRhs) : undefined,
      // elementStates and matrix are not reindexed — they use labels
    };
  }

  function reindexStep(step: StepSnapshot): StepSnapshot {
    return {
      ...step,
      iterations: step.iterations.map(reindexIteration),
      attempts: step.attempts?.map(a => ({
        ...a,
        iterations: a.iterations.map(reindexIteration),
      })),
    };
  }

  return {
    ...ngSession,
    steps: ngSession.steps.map(reindexStep),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { canonicalizeNgspiceName, canonicalizeOurLabel };
