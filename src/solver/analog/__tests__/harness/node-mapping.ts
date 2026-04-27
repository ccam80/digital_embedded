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
import type { AnalogElement } from "../../element.js";

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
// Direct mapping (auto-generated netlist)
// ---------------------------------------------------------------------------

/**
 * Build node mapping by exploiting the identity relationship between our
 * node IDs and ngspice node names.
 *
 * Since generateSpiceNetlist writes our pinNodeIds directly as ngspice node
 * numbers, ngspice creates nodes named "1", "2", ... matching our IDs.
 * We just look up each of our node IDs in ngspice's nodeNames map to get
 * the ngspice internal index.
 *
 * For branch currents (voltage sources), ngspice creates entries like
 * "v<label>#branch" which we match against our branch matrix rows.
 *
 * Both `ourIndex` and `ngspiceIndex` are 1-based slot indices: slot 0 is the
 * ground sentinel (always 0 on both sides), nodes occupy 1..nodeCount, and
 * branch currents occupy nodeCount+1..nodeCount+branchCount. This matches the
 * indexing used by `ctx.rhs`/`ctx.rhsOld` (length matrixSize+1, ckt-context.ts:543-548)
 * and by consumers that read `voltages[el.branchIndex]` directly
 * (inductor.ts, transmission-line.ts, etc.).
 */
export function buildDirectNodeMapping(
  ourTopology: TopologySnapshot,
  ngTopology: NgspiceTopology,
  elements: readonly AnalogElement[],
  elementLabels: Map<number, string>,
): NodeMapping[] {
  const mappings: NodeMapping[] = [];

  // 0. Ground sentinel: both engines reserve slot 0 for ground (always 0V).
  // Without this, reindexNgspiceSession would leave our slot 0 as NaN.
  mappings.push({
    ourIndex: 0,
    ngspiceIndex: 0,
    label: "GND",
    ngspiceName: "0",
  });

  // 1. Voltage nodes: our node ID N → ngspice node named "N", at slot N.
  for (let nodeId = 1; nodeId <= ourTopology.nodeCount; nodeId++) {
    const ngspiceIndex = ngTopology.nodeNames.get(String(nodeId));
    if (ngspiceIndex === undefined) continue;

    const label = ourTopology.nodeLabels.get(nodeId) ?? `node_${nodeId}`;
    mappings.push({
      ourIndex: nodeId,
      ngspiceIndex,
      label,
      ngspiceName: String(nodeId),
    });
  }

  // 2. Branch currents: voltage/current source elements with branchIndex >= 0.
  // el.branchIndex is the 1-based absolute slot index `totalNodeCount + 1 + meta.branchIdx`
  // (compiler.ts:1192-1193); consumers like inductor.ts read voltages[branchIndex]
  // directly, so this must remain 1-based.
  for (let ei = 0; ei < elements.length; ei++) {
    const el = elements[ei];
    if (el.branchIndex < 0) continue;

    const elLabel = elementLabels.get(ei);
    if (!elLabel) continue;

    const ngBranchName = `${elLabel.toLowerCase()}#branch`;
    const ngspiceIndex = ngTopology.nodeNames.get(ngBranchName);
    if (ngspiceIndex === undefined) continue;

    const ourIndex = el.branchIndex;
    const label = ourTopology.nodeLabels.get(-(el.branchIndex + 1))
      ?? `${elLabel}:branch`;
    mappings.push({
      ourIndex,
      ngspiceIndex,
      label,
      ngspiceName: ngBranchName,
    });
  }

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
      if (ngIdx < ngArr.length && ourIdx >= 0 && ourIdx < ourSize) {
        // ourIdx is already 0-based (nodeId - 1 from buildDirectNodeMapping)
        out[ourIdx] = ngArr[ngIdx];
      }
    });
    return out;
  }

  function reindexIteration(iter: IterationSnapshot): IterationSnapshot {
    return {
      ...iter,
      voltages: reindexArray(iter.voltages),
      prevVoltages: reindexArray(iter.prevVoltages),
      preSolveRhs: iter.preSolveRhs.length > 0 ? reindexArray(iter.preSolveRhs) : iter.preSolveRhs,
      // elementStates and matrix are not reindexed — they use labels
    };
  }

  function reindexStep(step: StepSnapshot): StepSnapshot {
    const reindexedAttempts = step.attempts?.map(a => ({
      ...a,
      iterations: a.iterations.map(reindexIteration),
    }));
    return {
      ...step,
      iterations: step.iterations.map(reindexIteration),
      ...(reindexedAttempts !== undefined ? { attempts: reindexedAttempts } : {}),
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
