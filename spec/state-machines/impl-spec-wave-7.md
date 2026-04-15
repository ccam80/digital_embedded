# Wave 7 — UIC + Nodesets (HIGH)

Implementation spec for items 7.1-7.2 from ALIGNMENT-DIFFS.md.

## 7.1 UIC Single-Load Bypass

At NR entry, before the main loop in `newton-raphson.ts`:

```typescript
if (opts.isDcOp && opts.statePool?.uic) {
  // MODETRANOP && MODEUIC: single CKTload, no iteration
  [rhs, rhsOld] = [rhsOld, rhs];
  assembler.stampAll(elements, rhsOld, 0);
  solver.finalize();
  return { converged: true, iterations: 0, voltages: rhsOld };
}
```

## 7.2 Nodeset/IC 1e10 Conductance

New function called after CKTload (step C in Wave 1):

```typescript
function applyNodesetsAndICs(
  solver: SparseSolver,
  nodesets: Map<number, number>,  // nodeId -> value
  ics: Map<number, number>,       // nodeId -> value
  srcFact: number,
  initMode: string,
): void {
  const G_NODESET = 1e10;
  if (initMode === "initJct" || initMode === "initFix") {
    for (const [nodeId, value] of nodesets) {
      solver.stamp(nodeId, nodeId, G_NODESET);
      solver.stampRHS(nodeId, G_NODESET * value * srcFact);
    }
  }
  for (const [nodeId, value] of ics) {
    solver.stamp(nodeId, nodeId, G_NODESET);
    solver.stampRHS(nodeId, G_NODESET * value * srcFact);
  }
}
```

New NROptions fields:
- `nodesets?: Map<number, number>`
- `ics?: Map<number, number>`
- `srcFact?: number` (default 1.0)

Requires plumbing nodeset/IC data from compiled circuit through to NR options.

## Dependencies

- Depends on: Wave 1 (NR loop structure with step C placeholder)
