/**
 * UnionFind — union-find (disjoint-set) data structure with path compression
 * and union by rank.
 *
 * Shared by the circuit compiler (src/engine/compiler.ts) and the headless
 * net resolver (src/headless/netlist.ts).
 */

export class UnionFind {
  private readonly _parent: Int32Array;
  private readonly _rank: Uint8Array;

  constructor(size: number) {
    this._parent = new Int32Array(size);
    this._rank = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      this._parent[i] = i;
    }
  }

  find(x: number): number {
    let root = x;
    while (this._parent[root] !== root) {
      root = this._parent[root]!;
    }
    // Path compression
    let cur = x;
    while (cur !== root) {
      const next = this._parent[cur]!;
      this._parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (this._rank[rx]! < this._rank[ry]!) {
      this._parent[rx] = ry;
    } else if (this._rank[rx]! > this._rank[ry]!) {
      this._parent[ry] = rx;
    } else {
      this._parent[ry] = rx;
      this._rank[rx]!++;
    }
  }

  connected(x: number, y: number): boolean {
    return this.find(x) === this.find(y);
  }
}
