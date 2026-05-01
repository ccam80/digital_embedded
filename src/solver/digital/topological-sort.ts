/**
 * Topological sort using Kahn's algorithm.
 *
 * Used by the circuit compiler to sort the condensation graph (DAG of SCCs)
 * into evaluation order. Components with no dependencies are evaluated first;
 * components that depend on others are evaluated after.
 *
 * Throws if a cycle is detected- this should not happen on the condensation
 * graph (which is always a DAG), but is checked defensively.
 */

// ---------------------------------------------------------------------------
// topologicalSort- Kahn's algorithm
// ---------------------------------------------------------------------------

/**
 * Sort nodes of a DAG in topological order (sources first).
 *
 * @param adjacency  Adjacency list: adjacency[i] = array of nodes that i has
 *                   edges to (i.e. i must be evaluated before those nodes).
 * @returns          Node indices in topological order (sources first).
 * @throws           Error if the graph contains a cycle.
 */
export function topologicalSort(adjacency: number[][]): number[] {
  const n = adjacency.length;
  const inDegree = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    for (const j of adjacency[i] ?? []) {
      inDegree[j]++;
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) {
      queue.push(i);
    }
  }

  const result: number[] = [];
  while (queue.length > 0) {
    const v = queue.shift()!;
    result.push(v);

    for (const w of adjacency[v] ?? []) {
      inDegree[w]--;
      if (inDegree[w] === 0) {
        queue.push(w);
      }
    }
  }

  if (result.length !== n) {
    throw new Error(
      `topologicalSort: cycle detected in graph with ${n} nodes (processed ${result.length})`,
    );
  }

  return result;
}
