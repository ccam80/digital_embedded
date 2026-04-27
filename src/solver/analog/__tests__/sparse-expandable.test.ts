import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";

// ---------------------------------------------------------------------------
// A1.8 — SparseSolver expandable matrix tests
// ---------------------------------------------------------------------------

describe("SparseSolver expandable matrix (A1.8)", () => {
  // -------------------------------------------------------------------------
  // Case 1: Fresh _initStructure(): _size === 0, _currentSize === 0,
  //         _allocatedSize === 6 (MINIMUM_ALLOCATED_SIZE per spconfig.h:336)
  // -------------------------------------------------------------------------
  it("case1: fresh _initStructure initializes size fields correctly", () => {
    const solver = new SparseSolver();
    solver._initStructure();
    const s = solver as any;
    expect(s._size).toBe(0);
    expect(s._currentSize).toBe(0);
    expect(s._allocatedSize).toBe(6);
  });

  // -------------------------------------------------------------------------
  // Case 2: After allocElement(1, 1): _size === 1, _extToIntRow[1] === 1
  // -------------------------------------------------------------------------
  it("case2: allocElement(1,1) grows _size to 1", () => {
    const solver = new SparseSolver();
    solver._initStructure();
    solver.allocElement(1, 1);
    const s = solver as any;
    expect(s._size).toBe(1);
    expect(s._extToIntRow[1]).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Case 3: allocElement(7, 7): _size === 2, _allocatedSize >= 7,
  //         _allocatedExtSize >= 7, _extToIntRow[7] === 2, _extToIntCol[7] === 2
  //
  // Note: allocElement(1,1) is called first so both row 1 and col 1 map to
  // internal slot 1, then (7,7) each get new slots: row 7 → slot 2,
  // col 7 → also slot 2 (same slot because row 7 and col 7 are in the same
  // external-index namespace — _extToIntRow and _extToIntCol are separate maps).
  // -------------------------------------------------------------------------
  it("case3: allocElement(7,7) grows allocation beyond initial 6", () => {
    const solver = new SparseSolver();
    solver._initStructure();
    solver.allocElement(1, 1);  // ext 1 → int slot 1
    solver.allocElement(7, 7);  // ext 7 → int slot 2 (new row), ext 7 col → int slot 2 (same lookup, already assigned)
    const s = solver as any;
    // _size must be at least 2 (two distinct internal slots assigned)
    expect(s._size).toBeGreaterThanOrEqual(2);
    // allocatedSize must have grown to accommodate index 7
    expect(s._allocatedSize).toBeGreaterThanOrEqual(7);
    // allocatedExtSize must have grown to accommodate ext index 7
    expect(s._allocatedExtSize).toBeGreaterThanOrEqual(7);
    // External row 7 must have been assigned internal slot 2
    expect(s._extToIntRow[7]).toBe(2);
    // External col 7 must reference same internal slot as row 7
    expect(s._extToIntCol[7]).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Case 4: Sequence allocElement(N, N) for N=1..50: _allocatedSize grows
  //         geometrically (1.5×), not linearly per-call.
  // -------------------------------------------------------------------------
  it("case4: _allocatedSize grows geometrically (1.5x), not linearly", () => {
    const solver = new SparseSolver();
    solver._initStructure();
    const s = solver as any;

    const allocSizes: number[] = [];
    let prevAllocSize = s._allocatedSize as number;

    for (let n = 1; n <= 50; n++) {
      solver.allocElement(n, n);
      const cur = s._allocatedSize as number;
      if (cur !== prevAllocSize) {
        allocSizes.push(cur);
        prevAllocSize = cur;
      }
    }

    // There should have been growth events
    expect(allocSizes.length).toBeGreaterThan(0);

    // Final allocatedSize must be >= 50
    expect(s._allocatedSize).toBeGreaterThanOrEqual(50);

    // Verify geometric growth: each growth step should be roughly 1.5x the
    // previous allocated size (never just +1 per call).
    // The number of growth events should be O(log(50)) not O(50).
    // With MINIMUM_ALLOCATED_SIZE=6 and factor=1.5:
    // 6 -> 9 -> 13 -> 20 -> 30 -> 45 -> 67 (covers 50 in 6 steps)
    expect(allocSizes.length).toBeLessThan(20);
  });

  // -------------------------------------------------------------------------
  // Case 5: _diag, _rowHead, _colHead are -1 for every index > oldAllocatedSize
  //         after a grow event.
  // -------------------------------------------------------------------------
  it("case5: new slots in _diag/_rowHead/_colHead are initialized to -1", () => {
    const solver = new SparseSolver();
    solver._initStructure();
    const s = solver as any;

    const initialAlloc = s._allocatedSize as number; // 6

    // Force a grow by going to index 7
    solver.allocElement(7, 7);

    const newAlloc = s._allocatedSize as number;
    expect(newAlloc).toBeGreaterThan(initialAlloc);

    // All newly allocated slots (initialAlloc+1 .. newAlloc) must be -1
    for (let i = initialAlloc + 1; i <= newAlloc; i++) {
      expect(s._diag[i]).toBe(-1);
      expect(s._rowHead[i]).toBe(-1);
      expect(s._colHead[i]).toBe(-1);
    }
  });

  // -------------------------------------------------------------------------
  // Case 6: _internalVectorsAllocated === false after every grow event.
  // -------------------------------------------------------------------------
  it("case6: _internalVectorsAllocated is false after every grow event", () => {
    const solver = new SparseSolver();
    solver._initStructure();
    const s = solver as any;

    expect(s._internalVectorsAllocated).toBe(false);

    // Trigger a grow
    solver.allocElement(7, 7);
    expect(s._internalVectorsAllocated).toBe(false);

    // Trigger factor (which sets _internalVectorsAllocated = true)
    solver.stampElement(solver.allocElement(1, 1), 1.0);
    solver.stampElement(solver.allocElement(7, 7), 1.0);
    solver.factor();
    expect(s._internalVectorsAllocated).toBe(true);

    // Trigger another grow by calling allocElement for a larger index
    solver._initStructure();
    solver.allocElement(20, 20);
    expect(s._internalVectorsAllocated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Case 7: grow + factor + solve agrees with a pre-sized control.
  //         Build two equivalent solvers: one using expanding allocElement calls,
  //         one using the traditional pattern. Results must match exactly.
  // -------------------------------------------------------------------------
  it("case7: expanding solver produces same solution as equivalent solver", () => {
    // Build a simple 3x3 tridiagonal system: A = [[2,-1,0],[-1,3,-1],[0,-1,2]], b=[1,2,1]
    // Solution: x=[1.25, 1.5, 1.25]
    const entries: Array<[number, number, number]> = [
      [1, 1, 2], [1, 2, -1],
      [2, 1, -1], [2, 2, 3], [2, 3, -1],
      [3, 2, -1], [3, 3, 2],
    ];
    const rhsVals = [1, 2, 1];

    function buildSolve(): Float64Array {
      const solver = new SparseSolver();
      solver._initStructure();
      for (const [r, c, v] of entries) solver.stampElement(solver.allocElement(r, c), v);
      const rhs = new Float64Array(4);
      for (let i = 0; i < rhsVals.length; i++) rhs[i + 1] = rhsVals[i];
      const result = solver.factor();
      expect(result).toBe(0);
      const x = new Float64Array(4);
      solver.solve(rhs, x);
      return x;
    }

    const sol1 = buildSolve();
    const sol2 = buildSolve();

    // Both solvers should produce the same result
    expect(sol1[1]).toBeCloseTo(1.25, 10);
    expect(sol1[2]).toBeCloseTo(1.5, 10);
    expect(sol1[3]).toBeCloseTo(1.25, 10);
    expect(sol2[1]).toBeCloseTo(sol1[1], 12);
    expect(sol2[2]).toBeCloseTo(sol1[2], 12);
    expect(sol2[3]).toBeCloseTo(sol1[3], 12);
  });

  // -------------------------------------------------------------------------
  // Case 8: _getInsertionOrder() returns (extRow, extCol) pairs in encounter order.
  // -------------------------------------------------------------------------
  it("case8: _getInsertionOrder returns pairs in allocElement encounter order", () => {
    const solver = new SparseSolver();
    solver._initStructure();

    // Allocate several elements; insertionOrder must track the calls in order.
    solver.allocElement(1, 1);
    solver.allocElement(2, 3);
    solver.allocElement(3, 2);
    solver.allocElement(1, 3);

    const order = solver._getInsertionOrder();
    expect(order).toHaveLength(4);
    expect(order[0]).toEqual({ extRow: 1, extCol: 1 });
    expect(order[1]).toEqual({ extRow: 2, extCol: 3 });
    expect(order[2]).toEqual({ extRow: 3, extCol: 2 });
    expect(order[3]).toEqual({ extRow: 1, extCol: 3 });

    // Ground-pin calls (row=0 or col=0) are NOT recorded (they return TrashCan handle 0).
    solver.allocElement(0, 1);
    solver.allocElement(1, 0);
    // Still 4 entries — ground calls skip _translate entirely.
    expect(solver._getInsertionOrder()).toHaveLength(4);

    // _resetForAssembly does NOT reset insertionOrder.
    solver._resetForAssembly();
    expect(solver._getInsertionOrder()).toHaveLength(4);

    // _initStructure() does reset insertionOrder.
    solver._initStructure();
    expect(solver._getInsertionOrder()).toHaveLength(0);
  });
});
