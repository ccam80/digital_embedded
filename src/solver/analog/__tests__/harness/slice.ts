/**
 * Slice filters for harness_get_attempt — resolve node/component queries to
 * matrix indices and apply them to IterationSideData objects.
 */

import type { TopologySnapshot, IterationSideData } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SliceFilter {
  nodes?: ReadonlyArray<string | number>;
  component?: string;
}

export interface ResolvedSlice {
  matrixIndices: number[];
  labels: string[];
}

// ---------------------------------------------------------------------------
// resolveNodeToMatrixIndex
// ---------------------------------------------------------------------------

/**
 * Resolve a single node query (name string or 1-based numeric id) to a
 * 0-based matrix index.
 *
 * - Numeric: must be integer >= 1 and exist in topology.nodeLabels; returns query - 1.
 * - String: trim + uppercase-compare against every topology.nodeLabels value.
 *   Exact match takes priority over segment match (split by '/').
 *   Exactly one segment match -> use it.
 *   Multiple segment matches -> throw ambiguous error.
 *   Zero matches -> return null.
 */
export function resolveNodeToMatrixIndex(
  query: string | number,
  topology: TopologySnapshot,
): number | null {
  if (typeof query === "number") {
    if (!Number.isInteger(query) || query < 1) return null;
    if (!topology.nodeLabels.has(query)) return null;
    return query - 1;
  }

  const q = query.trim().toUpperCase();

  // Exact match first
  for (const [nodeId, label] of topology.nodeLabels) {
    if (label.toUpperCase() === q) return nodeId - 1;
  }

  // Segment match: split label by '/' and check each segment
  const segmentMatches: Array<{ nodeId: number; label: string }> = [];
  for (const [nodeId, label] of topology.nodeLabels) {
    const segments = label.toUpperCase().split("/");
    if (segments.includes(q)) {
      segmentMatches.push({ nodeId, label });
    }
  }

  if (segmentMatches.length === 1) return segmentMatches[0].nodeId - 1;
  if (segmentMatches.length > 1) {
    const matchList = segmentMatches.map(m => `'${m.label}'`).join(", ");
    throw new Error(`slice: ambiguous node label '${query}' matches ${matchList}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// resolveComponentToMatrixIndices
// ---------------------------------------------------------------------------

/**
 * Resolve a component label to the set of 0-based matrix indices it covers:
 * - non-ground pinNodeIds (nodeId - 1)
 * - prime nodes: labels starting with '<component>:'
 * - branch rows: matrixRowLabels at index >= nodeCount where label is exactly
 *   the component name, starts with '<component>#', or starts with '<component>:'
 *
 * Returns indices sorted ascending. Throws if component is unknown.
 */
export function resolveComponentToMatrixIndices(
  componentLabel: string,
  topology: TopologySnapshot,
): number[] {
  const lowerLabel = componentLabel.toLowerCase();
  const el = topology.elements.find(e => e.label.toLowerCase() === lowerLabel);
  if (!el) {
    const known = topology.elements.map(e => e.label).join(", ");
    throw new Error(`slice: unknown component '${componentLabel}'. Known: ${known}`);
  }

  const indices = new Set<number>();
  const compUpper = el.label.toUpperCase();

  // Non-ground pin node ids
  for (const nodeId of el.pinNodeIds) {
    if (nodeId !== 0) indices.add(nodeId - 1);
  }

  // Prime nodes: topology.nodeLabels entries whose label starts with '<component>:'
  const primePrefix = compUpper + ":";
  for (const [nodeId, label] of topology.nodeLabels) {
    if (label.toUpperCase().startsWith(primePrefix)) {
      indices.add(nodeId - 1);
    }
  }

  // Branch rows: matrixRowLabels at index >= nodeCount
  const branchPrefix1 = compUpper + "#";
  const branchPrefix2 = compUpper + ":";
  for (const [rowIdx, label] of topology.matrixRowLabels) {
    if (rowIdx < topology.nodeCount) continue;
    const labelUpper = label.toUpperCase();
    if (
      labelUpper === compUpper ||
      labelUpper.startsWith(branchPrefix1) ||
      labelUpper.startsWith(branchPrefix2)
    ) {
      indices.add(rowIdx);
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// resolveSlice
// ---------------------------------------------------------------------------

/**
 * Union nodes + component into a sorted, deduplicated set of matrix indices
 * with corresponding labels.
 *
 * Throws for unknown nodes. Throws for unknown component (via
 * resolveComponentToMatrixIndices).
 */
export function resolveSlice(
  filter: SliceFilter,
  topology: TopologySnapshot,
): ResolvedSlice {
  const indexSet = new Set<number>();

  if (filter.nodes) {
    for (const node of filter.nodes) {
      const idx = resolveNodeToMatrixIndex(node, topology);
      if (idx === null) {
        throw new Error(`slice: unknown node '${node}'`);
      }
      indexSet.add(idx);
    }
  }

  if (filter.component) {
    for (const idx of resolveComponentToMatrixIndices(filter.component, topology)) {
      indexSet.add(idx);
    }
  }

  const matrixIndices = Array.from(indexSet).sort((a, b) => a - b);

  const labels = matrixIndices.map(idx => {
    // matrixRowLabels is keyed by 0-based row index
    const fromMatrix = topology.matrixRowLabels.get(idx);
    if (fromMatrix !== undefined) return fromMatrix;
    // fallback: nodeLabels is keyed by 1-based nodeId
    const fromNode = topology.nodeLabels.get(idx + 1);
    if (fromNode !== undefined) return fromNode;
    return `row${idx}`;
  });

  return { matrixIndices, labels };
}

// ---------------------------------------------------------------------------
// applySliceToIteration
// ---------------------------------------------------------------------------

/**
 * Apply a resolved slice to one IterationSideData, returning a new object
 * (input is not mutated). K = slice.matrixIndices.length.
 *
 * - rhs and residual are sliced positionally to K entries.
 * - matrix is sliced into a KxK row-major flat array (null matrix stays null).
 * - residualInfinityNorm is recomputed over the sliced residual.
 * - nodeLabels and nodeIndices are set to the slice arrays.
 */
export function applySliceToIteration(
  side: IterationSideData,
  slice: ResolvedSlice,
  fullMatrixSize: number,
): IterationSideData {
  const K = slice.matrixIndices.length;
  const indices = slice.matrixIndices;

  // Slice rhs
  const rhs = indices.map(i => side.rhs[i] ?? 0);

  // Slice residual
  const residual = indices.map(i => side.residual[i] ?? 0);

  // Recompute infinity norm over sliced residual
  let residualInfinityNorm = 0;
  for (const v of residual) {
    const abs = Math.abs(v);
    if (abs > residualInfinityNorm) residualInfinityNorm = abs;
  }

  // Slice matrix: KxK row-major from NxN row-major
  let matrix: number[] | null = null;
  if (side.matrix !== null) {
    const N = fullMatrixSize;
    matrix = new Array<number>(K * K).fill(0);
    for (let ki = 0; ki < K; ki++) {
      const ri = indices[ki];
      for (let kj = 0; kj < K; kj++) {
        const ci = indices[kj];
        matrix[ki * K + kj] = side.matrix[ri * N + ci] ?? 0;
      }
    }
  }

  return {
    ...side,
    rhs,
    residual,
    residualInfinityNorm,
    matrix,
    nodeLabels: slice.labels.slice(),
    nodeIndices: indices.slice(),
  };
}
