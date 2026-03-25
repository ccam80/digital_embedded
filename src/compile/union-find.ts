/**
 * UnionFind — disjoint-set data structure with path compression and union by rank.
 * O(α(n)) amortized per operation.
 */

export class UnionFind {
  private readonly _parent: Int32Array;
  private readonly _rank: Uint8Array;
  private _componentCount: number;

  constructor(size: number) {
    this._parent = new Int32Array(size);
    this._rank = new Uint8Array(size);
    this._componentCount = size;
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

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this._rank[ra]! < this._rank[rb]!) {
      this._parent[ra] = rb;
    } else if (this._rank[ra]! > this._rank[rb]!) {
      this._parent[rb] = ra;
    } else {
      this._parent[rb] = ra;
      this._rank[ra]!++;
    }
    this._componentCount--;
  }

  connected(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }

  get componentCount(): number {
    return this._componentCount;
  }

  /**
   * Returns a map from each root to the list of all member indices in that component.
   */
  groups(): Map<number, number[]> {
    const result = new Map<number, number[]>();
    const size = this._parent.length;
    for (let i = 0; i < size; i++) {
      const root = this.find(i);
      let members = result.get(root);
      if (members === undefined) {
        members = [];
        result.set(root, members);
      }
      members.push(i);
    }
    return result;
  }
}
