/**
 * Tests for slice.ts
 */

import { describe, it, expect } from "vitest";
import {
  resolveNodeToMatrixIndex,
  resolveComponentToMatrixIndices,
  resolveSlice,
  applySliceToIteration,
} from "./slice.js";
import type { TopologySnapshot, IterationSideData } from "./types.js";

function makeTopology(): TopologySnapshot {
  const nodeLabels = new Map<number, string>([
    [1, "VCC"],
    [2, "BASE"],
    [3, "COLL"],
    [4, "EMIT"],
    [5, "Q1:B'"],
    [6, "Q1:C'"],
  ]);
  const matrixRowLabels = new Map<number, string>([
    [0, "VCC"],
    [1, "BASE"],
    [2, "COLL"],
    [3, "EMIT"],
    [4, "Q1:B'"],
    [5, "Q1:C'"],
    [6, "V1"],
  ]);
  const matrixColLabels = new Map<number, string>(matrixRowLabels);
  const elements = [
    { index: 0, label: "Q1", type: "NPN", isNonlinear: true, isReactive: false, pinNodeIds: [3, 2, 4] as readonly number[] },
    { index: 1, label: "R1", type: "resistor", isNonlinear: false, isReactive: false, pinNodeIds: [1, 2] as readonly number[] },
    { index: 2, label: "V1", type: "voltageSource", isNonlinear: false, isReactive: false, pinNodeIds: [1, 0] as readonly number[] },
  ];
  return { matrixSize: 7, nodeCount: 6, branchCount: 1, elementCount: 3, elements, nodeLabels, matrixRowLabels, matrixColLabels };
}

function makeSide(n: number): IterationSideData {
  const N = n;
  const matrix = Array.from({ length: N * N }, (_, i) => i + 1);
  const rhs = Array.from({ length: N }, (_, i) => (i + 1) * 10);
  const residual = Array.from({ length: N }, (_, i) => (i + 1) * 0.1);
  const residualInfinityNorm = Math.max(...residual.map(Math.abs));
  return { rawIteration: 1, globalConverged: false, noncon: 2, nodeVoltages: {}, nodeVoltagesBefore: {}, branchValues: {}, elementStates: {}, limitingEvents: [], rhs, residual, residualInfinityNorm, matrix, ag: [0, 0, 0, 0, 0, 0, 0], method: "trapezoidal" as const, order: 1 };
}

describe("resolveNodeToMatrixIndex", () => {
  const topo = makeTopology();
  it("resolves exact string match case-insensitive", () => {
    expect(resolveNodeToMatrixIndex("VCC", topo)).toBe(0);
    expect(resolveNodeToMatrixIndex("vcc", topo)).toBe(0);
    expect(resolveNodeToMatrixIndex("Base", topo)).toBe(1);
  });
  it("resolves prime node by exact label", () => {
    expect(resolveNodeToMatrixIndex("Q1:B'", topo)).toBe(4);
    expect(resolveNodeToMatrixIndex("q1:b'", topo)).toBe(4);
  });
  it("resolves 1-based numeric id", () => {
    expect(resolveNodeToMatrixIndex(1, topo)).toBe(0);
    expect(resolveNodeToMatrixIndex(4, topo)).toBe(3);
  });
  it("returns null for unknown string", () => { expect(resolveNodeToMatrixIndex("UNKNOWN", topo)).toBeNull(); });
  it("returns null for numeric id 0", () => { expect(resolveNodeToMatrixIndex(0, topo)).toBeNull(); });
  it("returns null for negative numeric id", () => { expect(resolveNodeToMatrixIndex(-1, topo)).toBeNull(); });
  it("returns null for numeric id beyond nodeLabels", () => { expect(resolveNodeToMatrixIndex(99, topo)).toBeNull(); });
  it("segment match resolves when unambiguous", () => {
    const topoSeg: TopologySnapshot = { ...topo, nodeLabels: new Map([[1, "A/B"]]), matrixRowLabels: new Map([[0, "A/B"]]), matrixColLabels: new Map([[0, "A/B"]]), elements: [], nodeCount: 1, branchCount: 0, elementCount: 0, matrixSize: 1 };
    expect(resolveNodeToMatrixIndex("B", topoSeg)).toBe(0);
  });
  it("throws on ambiguous segment match", () => {
    const topoAmb: TopologySnapshot = { ...topo, nodeLabels: new Map([[1, "X/B"], [2, "Y/B"]]), matrixRowLabels: new Map([[0, "X/B"], [1, "Y/B"]]), matrixColLabels: new Map([[0, "X/B"], [1, "Y/B"]]), elements: [], nodeCount: 2, branchCount: 0, elementCount: 0, matrixSize: 2 };
    expect(() => resolveNodeToMatrixIndex("B", topoAmb)).toThrow("ambiguous");
  });
});

describe("resolveComponentToMatrixIndices", () => {
  const topo = makeTopology();
  it("BJT Q1 pins plus prime nodes", () => { expect(resolveComponentToMatrixIndices("Q1", topo)).toEqual([1, 2, 3, 4, 5]); });
  it("resistor R1 pin nodes only", () => { expect(resolveComponentToMatrixIndices("R1", topo)).toEqual([0, 1]); });
  it("voltage source V1 pin plus branch row", () => { expect(resolveComponentToMatrixIndices("V1", topo)).toEqual([0, 6]); });
  it("unknown component throws", () => { expect(() => resolveComponentToMatrixIndices("UNKNOWN", topo)).toThrow("unknown component"); });
  it("case-insensitive component match", () => { expect(resolveComponentToMatrixIndices("r1", topo)).toEqual([0, 1]); });
});

describe("resolveSlice", () => {
  const topo = makeTopology();
  it("union of nodes plus component deduped sorted", () => {
    const result = resolveSlice({ nodes: ["VCC"], component: "R1" }, topo);
    expect(result.matrixIndices).toEqual([0, 1]);
  });
  it("nodes only", () => {
    const result = resolveSlice({ nodes: ["BASE", "COLL"] }, topo);
    expect(result.matrixIndices).toEqual([1, 2]);
    expect(result.labels).toEqual(["BASE", "COLL"]);
  });
  it("component only", () => { expect(resolveSlice({ component: "R1" }, topo).matrixIndices).toEqual([0, 1]); });
  it("unknown node throws", () => { expect(() => resolveSlice({ nodes: ["DOESNOTEXIST"] }, topo)).toThrow("unknown node"); });
  it("labels come from matrixRowLabels", () => { expect(resolveSlice({ nodes: [1] }, topo).labels).toEqual(["VCC"]); });
});

describe("applySliceToIteration", () => {
  const topo = makeTopology();
  const N = 7;
  it("single-node 1x1 slice", () => {
    const side = makeSide(N);
    const slice = resolveSlice({ nodes: [1] }, topo);
    const result = applySliceToIteration(side, slice, N);
    expect(result.rhs).toHaveLength(1);
    expect(result.rhs[0]).toBe(side.rhs[0]);
    expect(result.residual).toHaveLength(1);
    expect(result.residual[0]).toBe(side.residual[0]);
    expect(result.matrix).toHaveLength(1);
    expect(result.matrix![0]).toBe(side.matrix![0]);
    expect(result.nodeIndices).toEqual([0]);
  });
  it("multi-node slice preserves A[i,j] = A_full[idx_i, idx_j]", () => {
    const side = makeSide(N);
    const slice = resolveSlice({ nodes: [1, 2] }, topo);
    const result = applySliceToIteration(side, slice, N);
    expect(result.matrix).toHaveLength(4);
    expect(result.matrix![0]).toBe(side.matrix![0 * N + 0]);
    expect(result.matrix![1]).toBe(side.matrix![0 * N + 1]);
    expect(result.matrix![2]).toBe(side.matrix![1 * N + 0]);
    expect(result.matrix![3]).toBe(side.matrix![1 * N + 1]);
  });
  it("component slice size matches resolved indices", () => {
    const side = makeSide(N);
    const slice = resolveSlice({ component: "Q1" }, topo);
    const K = slice.matrixIndices.length;
    const result = applySliceToIteration(side, slice, N);
    expect(result.rhs).toHaveLength(K);
    expect(result.residual).toHaveLength(K);
    expect(result.matrix).toHaveLength(K * K);
    expect(result.nodeIndices).toEqual(slice.matrixIndices);
    expect(result.nodeLabels).toEqual(slice.labels);
  });
  it("combined nodes+component dedups", () => {
    const side = makeSide(N);
    const slice = resolveSlice({ nodes: ["VCC"], component: "R1" }, topo);
    expect(slice.matrixIndices.length).toBe(2);
    expect(applySliceToIteration(side, slice, N).matrix).toHaveLength(4);
  });
  it("residual infinity norm recomputed over slice", () => {
    const side = makeSide(N);
    const slice = resolveSlice({ nodes: [3] }, topo);
    applySliceToIteration(side, slice, N);
  });
  it("null matrix stays null rhs and residual still sliced", () => {
    const side: IterationSideData = { ...makeSide(N), matrix: null };
    const slice = resolveSlice({ nodes: [1, 2] }, topo);
    const result = applySliceToIteration(side, slice, N);
    expect(result.matrix).toBeNull();
    expect(result.rhs).toHaveLength(2);
    expect(result.residual).toHaveLength(2);
  });
  it("does not mutate input side", () => {
    const side = makeSide(N);
    const origRhs = side.rhs.slice();
    applySliceToIteration(side, resolveSlice({ nodes: [1] }, topo), N);
    expect(side.rhs).toEqual(origRhs);
  });
});
