/**
 * Tarjan's algorithm for finding Strongly Connected Components (SCCs).
 *
 * Returns SCCs in reverse topological order — each SCC appears before any SCC
 * it depends on. This is the standard Tarjan output ordering.
 *
 * Used by the circuit compiler to detect combinational feedback loops.
 * Each multi-node SCC is a feedback group that requires iterative evaluation.
 *
 * Java reference: no direct equivalent — the flat-array architecture
 * introduces SCC-based evaluation as an optimization over Digital's Node graph.
 */

// ---------------------------------------------------------------------------
// findSCCs — Tarjan's strongly connected components algorithm
// ---------------------------------------------------------------------------

/**
 * Find all strongly connected components in a directed graph.
 *
 * @param adjacency  Adjacency list: adjacency[i] = array of nodes that i has
 *                   edges to (i.e. i depends on those nodes / i → j).
 * @returns          Array of SCCs in reverse topological order. Each SCC is
 *                   an array of node indices. Singleton SCCs (no self-loop) are
 *                   nodes with no combinational feedback.
 */
export function findSCCs(adjacency: number[][]): number[][] {
  const n = adjacency.length;
  const index: Int32Array = new Int32Array(n).fill(-1);
  const lowlink: Int32Array = new Int32Array(n);
  const onStack: Uint8Array = new Uint8Array(n);
  const stack: number[] = [];
  const sccs: number[][] = [];
  let nextIndex = 0;

  function strongConnect(v: number): void {
    index[v] = nextIndex;
    lowlink[v] = nextIndex;
    nextIndex++;
    stack.push(v);
    onStack[v] = 1;

    const neighbors = adjacency[v] ?? [];
    for (const w of neighbors) {
      if (index[w] === -1) {
        strongConnect(w);
        lowlink[v] = Math.min(lowlink[v]!, lowlink[w]!);
      } else if (onStack[w]) {
        lowlink[v] = Math.min(lowlink[v]!, index[w]!);
      }
    }

    if (lowlink[v] === index[v]) {
      const scc: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = 0;
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (let v = 0; v < n; v++) {
    if (index[v] === -1) {
      strongConnect(v);
    }
  }

  return sccs;
}

// ---------------------------------------------------------------------------
// hasSelfLoop — check whether a node has a self-referencing edge
// ---------------------------------------------------------------------------

/**
 * Returns true if the node at the given index has a self-loop in the adjacency
 * list. A singleton SCC with a self-loop is still a feedback group.
 */
export function hasSelfLoop(adjacency: number[][], nodeIndex: number): boolean {
  return (adjacency[nodeIndex] ?? []).includes(nodeIndex);
}
