/**
 * Structural node mapping between our engine and ngspice.
 *
 * ngspice node names follow patterns like:
 *   "q1_c", "q1_b", "q1_e"     - BJT collector/base/emitter
 *   "r1_1", "r1_2"              - resistor terminals
 *   "v1#branch"                  - voltage source branch current
 *   "d1_a", "d1_k"              - diode anode/cathode
 *   "m1_d", "m1_g", "m1_s"      - MOSFET drain/gate/source
 *   "0"                          - ground
 *   "net_3", "3"                 - internal net numbers
 *
 * Our node labels follow patterns like:
 *   "Q1:C", "Q1:B", "Q1:E"
 *   "R1:pos", "R1:neg"
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
  AcCaptureSession,
  AcCapturePoint,
} from "./types.js";
import type { AnalogElement } from "../../element.js";
import { canonicalizeSpiceLabel } from "./netlist-generator.js";

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
  resistor: { "1": "pos", "2": "neg" },
  // Capacitor
  capacitor: { "1": "pos", "2": "neg" },
  // Inductor
  inductor: { "1": "pos", "2": "neg" },
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

  // Bare net name or number- can't canonicalize to component:pin
  return null;
}

/**
 * Canonicalize our label format. Already in "LABEL:PIN" form,
 * just normalize case.
 */
function canonicalizeOurLabel(label: string): string {
  // Already "Q1:C" format- just uppercase
  return label.toUpperCase();
}

/**
 * Candidate ngspice deck-name stems for a composite sub-element's branch row.
 *
 * The netlist generator joins each composite nesting level with "_"
 * (`${rawLabel}_${subName}`, netlist-generator.ts:530,1492) but passes the
 * top-level instance label through verbatim. Our intrinsic label is colon-joined
 * at every level (compiler.ts:306, `${parentLabel}:${subName}`), and a synthetic
 * boundary adapter's own instance label already carries ":" segments
 * (`bridge-adapter:<uuid>:<pin>_pin`). A blanket ":"->"_" therefore over-converts
 * the instance-label colons. The flattened label can't say which colons are
 * sub-element joins, so yield one variant per join depth: rename the trailing k
 * colons (k = colonCount..0) to "_", preserving the leading ones. k = colonCount
 * is the all-underscore form (genuine N-level nesting, outer:mid:vs ->
 * outer_mid_vs); a smaller k preserves a colon-bearing instance label
 * (bridge-adapter:uuid:pin:vilSrc -> bridge-adapter:uuid:pin_vilSrc). Exactly one
 * variant equals the real deck name; the rest never match in ngLookup.
 */
function branchLabelRenameVariants(label: string): string[] {
  const colonIdx: number[] = [];
  for (let i = 0; i < label.length; i++) if (label[i] === ":") colonIdx.push(i);
  const variants: string[] = [];
  for (let k = colonIdx.length; k >= 0; k--) {
    const chars = label.split("");
    for (let j = colonIdx.length - k; j < colonIdx.length; j++) chars[colonIdx[j]!] = "_";
    variants.push(chars.join(""));
  }
  return variants;
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
  nodeTable?: readonly { name: string; number: number; type: "voltage" | "current" }[],
): NodeMapping[] {
  const mappings: NodeMapping[] = [];

  // ngspice node names are case-insensitive identifiers. Internally-minted nodes
  // (CKTmkVolt suffixes, e.g. a BJT's "collCX") keep their source case in the
  // node table, so a case-sensitive lookup misses them while every all-lowercase
  // suffix (int1, collector, …) happened to match. Resolve every lookup against
  // a case-folded view of nodeNames to match ngspice's own semantics; this is a
  // no-op for the numeric voltage-node keys and the already-lowercased branch
  // candidates, and fixes the mixed-case internal-node keys.
  const ngLookup = new Map<string, number>();
  for (const [name, idx] of ngTopology.nodeNames) ngLookup.set(name.toLowerCase(), idx);

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
    const ngspiceIndex = ngLookup.get(String(nodeId).toLowerCase());
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
  // el.branchIndex is the 1-based MNA equation index allocated inside the
  // element's setup() via ctx.makeCur (VSRCsetup parity); consumers like
  // inductor.ts read voltages[branchIndex] directly, so this must remain 1-based.
  //
  // Name resolution against ngspice's nodeNames map has to handle three cases:
  //   (a) Top-level vsource/inductor where elementLabels gives the user-facing
  //       label (e.g. "vCC") and ngspice's deck name matches lower-cased
  //       ("vcc#branch"). Direct lookup works.
  //   (b) Composite-internal sub-element where elementLabels falls back to
  //       auto-numbered "X4" but the netlist generator emitted a deck name
  //       like "Vtx_vSense" (parent rawLabel + "_" + subElementName, plus
  //       canonicalizeSpiceLabel's V/L prefix). For these, the AnalogElement's
  //       intrinsic .label is the parent-pathed colon form ("tx:vSense");
  //       replace ":" with "_" and run canonicalizeSpiceLabel with each
  //       branch-element prefix (V, L, E, F, H) to reconstruct the ngspice
  //       deck name without re-implementing the generator's logic.
  //   (c) Top-level element whose deck label needed a prefix add (e.g. user
  //       called it "myInductor"; netlist emitted "LmyInductor"). Same prefix-
  //       loop covers it via case (b)'s path.
  const branchPrefixCandidates = ["V", "L", "E", "F", "H"];
  for (let ei = 0; ei < elements.length; ei++) {
    const el = elements[ei];
    if (el.branchIndex < 0) continue;

    const candidates: string[] = [];
    const userLabel = elementLabels.get(ei);
    if (userLabel) {
      candidates.push(`${userLabel.toLowerCase()}#branch`);
    }
    const intrinsic = el.label;
    if (intrinsic) {
      for (const variant of branchLabelRenameVariants(intrinsic)) {
        for (const prefix of branchPrefixCandidates) {
          candidates.push(`${canonicalizeSpiceLabel(variant, prefix).toLowerCase()}#branch`);
        }
      }
    }

    let ngspiceIndex: number | undefined;
    let resolvedName = "";
    for (const cand of candidates) {
      const idx = ngLookup.get(cand);
      if (idx !== undefined) { ngspiceIndex = idx; resolvedName = cand; break; }
    }
    if (ngspiceIndex === undefined) continue;

    const ourIndex = el.branchIndex;
    const labelHint = userLabel ?? intrinsic ?? `element_${ei}`;
    const label = ourTopology.nodeLabels.get(-(el.branchIndex + 1))
      ?? `${labelHint}:branch`;
    mappings.push({
      ourIndex,
      ngspiceIndex,
      label,
      ngspiceName: resolvedName,
    });
  }

  // 3. Element-internal nodes (TRA int1/int2, TRA i1/i2, opamp/MOSFET/BJT
  //    internals, etc.). Populated by `ctx.makeVolt(label, suffix)` /
  //    `ctx.makeCur(label, suffix)` during setup() — every entry has name
  //    `${label}#${suffix}` (analog-engine.ts:_makeNode), exactly matching
  //    ngspice's `CKTmkVolt`/`CKTmkCur` output (e.g. `tl1#int1`).
  //
  //    Without this pass, internal slots end up unmapped and
  //    reindexNgspiceSession fills them with NaN — the source of the
  //    "ngspice=NaN" symptom seen on the TRA matched-load parity tests
  //    (where ngspice perfectly resolved tl1#int1/int2/i1/i2 but the
  //    mapping table just couldn't find them).
  if (nodeTable) {
    const claimed = new Set<number>();
    for (const m of mappings) claimed.add(m.ourIndex);
    for (const entry of nodeTable) {
      if (claimed.has(entry.number)) continue;
      const ngName = entry.name.toLowerCase();
      const ngspiceIndex = ngLookup.get(ngName);
      if (ngspiceIndex === undefined) continue;
      const label = ourTopology.nodeLabels.get(entry.number)
        ?? entry.name.replace("#", ":");
      mappings.push({
        ourIndex: entry.number,
        ngspiceIndex,
        label,
        ngspiceName: ngName,
      });
      claimed.add(entry.number);
    }
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
      // matrix and elementStates are intentionally NOT reindexed. The line-by-
      // line port of ngspice's allocation order, cktTranslate first-sight
      // sequence, and NGSPICE_LOAD_ORDER sort guarantees both engines assign
      // the same internal sparse-matrix indices to the same external-node
      // pairs. Matrix entries are compared raw (row, col) against ours by
      // _assertFirstIterationMatrixEntriesMatch, which classifies divergences
      // as: (a) coordinate-set drift (oursOnly/ngOnly entries), (b) value
      // permutation (same coord set + same value multiset, values shuffled),
      // or (c) genuine arithmetic divergence at aligned cells (multisets
      // differ). Reindexing here would silently absorb (a) and (b)- both
      // structural porting bugs in load order or internal-node allocation-
      // and is forbidden.
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

/**
 * Reindex an ngspice AcCaptureSession's solution/RHS arrays into our
 * engine's node ordering, parallel to `reindexNgspiceSession` for DC/TRAN.
 *
 * Per-point: `solRe`, `solIm`, `rhsRe`, `rhsIm` are reindexed.
 * Per-point: `matrix` is NOT reindexed- the per-(row, col) cell comparison
 * in `acFirstDivergence` translates ngspice's external indices through
 * `_ngMatrixRowMap` / `_ngMatrixColMap` at comparison time. Reindexing the
 * matrix here would let mismatched allocations look like the same coord,
 * destroying the harness's ability to surface allocation-order divergence
 * (forbidden for the same reason as in `reindexNgspiceSession`).
 *
 * Unmapped slots get NaN- surfaces missing/extra-node divergence in the
 * subsequent walk rather than silently aligning unrelated quantities.
 */
export function reindexNgspiceAcSession(
  ngAcSession: AcCaptureSession,
  mappings: NodeMapping[],
  ourSize: number,
): AcCaptureSession {
  const ngToOur = new Map<number, number>();
  for (const m of mappings) {
    ngToOur.set(m.ngspiceIndex, m.ourIndex);
  }

  function reindexArray(ngArr: Float64Array): Float64Array {
    const out = new Float64Array(ourSize);
    out.fill(NaN);
    ngToOur.forEach((ourIdx, ngIdx) => {
      if (ngIdx < ngArr.length && ourIdx >= 0 && ourIdx < ourSize) {
        out[ourIdx] = ngArr[ngIdx];
      }
    });
    return out;
  }

  function reindexPoint(p: AcCapturePoint): AcCapturePoint {
    return {
      ...p,
      solRe: reindexArray(p.solRe),
      solIm: reindexArray(p.solIm),
      ...(p.rhsRe ? { rhsRe: reindexArray(p.rhsRe) } : {}),
      ...(p.rhsIm ? { rhsIm: reindexArray(p.rhsIm) } : {}),
    };
  }

  return {
    ...ngAcSession,
    points: ngAcSession.points.map(reindexPoint),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { canonicalizeNgspiceName, canonicalizeOurLabel };
