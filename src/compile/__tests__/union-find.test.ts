import { describe, it, expect } from "vitest";
import { UnionFind } from "../union-find";

describe("UnionFind", () => {
  describe("constructor", () => {
    it("initialises with each element in its own component", () => {
      const uf = new UnionFind(5);
      expect(uf.componentCount).toBe(5);
    });

    it("size-0 construction is valid", () => {
      const uf = new UnionFind(0);
      expect(uf.componentCount).toBe(0);
    });
  });

  describe("find", () => {
    it("returns self for an isolated element", () => {
      const uf = new UnionFind(4);
      expect(uf.find(0)).toBe(0);
      expect(uf.find(3)).toBe(3);
    });

    it("returns the same root for two unioned elements", () => {
      const uf = new UnionFind(4);
      uf.union(1, 2);
      expect(uf.find(1)).toBe(uf.find(2));
    });

    it("path compression: repeated find is stable", () => {
      const uf = new UnionFind(6);
      uf.union(0, 1);
      uf.union(1, 2);
      uf.union(2, 3);
      const root = uf.find(3);
      // After path compression all intermediate nodes point to root
      expect(uf.find(0)).toBe(root);
      expect(uf.find(1)).toBe(root);
      expect(uf.find(2)).toBe(root);
      expect(uf.find(3)).toBe(root);
    });
  });

  describe("union", () => {
    it("reduces componentCount by 1 when merging two distinct components", () => {
      const uf = new UnionFind(4);
      uf.union(0, 1);
      expect(uf.componentCount).toBe(3);
    });

    it("does not change componentCount when unioning elements already connected", () => {
      const uf = new UnionFind(4);
      uf.union(0, 1);
      uf.union(0, 1);
      expect(uf.componentCount).toBe(3);
    });

    it("merging all elements leaves componentCount = 1", () => {
      const uf = new UnionFind(4);
      uf.union(0, 1);
      uf.union(2, 3);
      uf.union(0, 2);
      expect(uf.componentCount).toBe(1);
    });

    it("union is commutative: union(a,b) same result as union(b,a)", () => {
      const uf1 = new UnionFind(4);
      uf1.union(1, 3);
      const uf2 = new UnionFind(4);
      uf2.union(3, 1);
      expect(uf1.find(1)).toBe(uf1.find(3));
      expect(uf2.find(1)).toBe(uf2.find(3));
      // Both should report the same connectivity
      expect(uf1.connected(1, 3)).toBe(true);
      expect(uf2.connected(1, 3)).toBe(true);
    });

    it("union is transitive", () => {
      const uf = new UnionFind(5);
      uf.union(0, 1);
      uf.union(1, 2);
      uf.union(2, 3);
      expect(uf.connected(0, 3)).toBe(true);
    });
  });

  describe("connected", () => {
    it("returns false for unrelated elements", () => {
      const uf = new UnionFind(4);
      expect(uf.connected(0, 3)).toBe(false);
    });

    it("returns true after unioning", () => {
      const uf = new UnionFind(4);
      uf.union(0, 3);
      expect(uf.connected(0, 3)).toBe(true);
    });

    it("element is connected to itself", () => {
      const uf = new UnionFind(4);
      expect(uf.connected(2, 2)).toBe(true);
    });
  });

  describe("groups", () => {
    it("with no unions, each element is its own group", () => {
      const uf = new UnionFind(3);
      const g = uf.groups();
      expect(g.size).toBe(3);
      // Every value is a singleton
      for (const members of g.values()) {
        expect(members).toHaveLength(1);
      }
    });

    it("after unions, groups reflect components correctly", () => {
      const uf = new UnionFind(6);
      uf.union(0, 1);
      uf.union(1, 2);
      uf.union(4, 5);
      const g = uf.groups();
      expect(g.size).toBe(3); // {0,1,2}, {3}, {4,5}

      // Every element appears in exactly one group
      const seen = new Set<number>();
      for (const members of g.values()) {
        for (const m of members) {
          expect(seen.has(m)).toBe(false);
          seen.add(m);
        }
      }
      expect(seen.size).toBe(6);
    });

    it("groups key is the find() root of the group members", () => {
      const uf = new UnionFind(4);
      uf.union(0, 1);
      uf.union(2, 3);
      const g = uf.groups();
      for (const [root, members] of g) {
        for (const m of members) {
          expect(uf.find(m)).toBe(root);
        }
      }
    });

    it("returns empty map for size-0 UnionFind", () => {
      const uf = new UnionFind(0);
      expect(uf.groups().size).toBe(0);
    });

    it("groups() size equals componentCount", () => {
      const uf = new UnionFind(8);
      uf.union(0, 1);
      uf.union(2, 3);
      uf.union(4, 5);
      expect(uf.groups().size).toBe(uf.componentCount);
    });
  });

  describe("componentCount", () => {
    it("starts at size", () => {
      expect(new UnionFind(10).componentCount).toBe(10);
    });

    it("decrements only on new merges", () => {
      const uf = new UnionFind(5);
      uf.union(0, 1); // 4
      uf.union(1, 0); // still 4- no-op
      uf.union(2, 3); // 3
      uf.union(0, 3); // 2
      expect(uf.componentCount).toBe(2);
    });
  });
});
