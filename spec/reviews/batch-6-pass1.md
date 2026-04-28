# Wave Verification: Batch 6 (Pass 1)

## Verdict
```json
{"6.POT":"PASS","6.MEMR":"PASS","6.VSRC-VAR":"FAIL","6.VSRC-DC":"PASS","6.DIAC":"PASS","6.CRYSTAL":"PASS","6.VSRC-AC":"PASS","6.SCR":"FAIL","6.POLCAP":"PASS","6.TRIAC":"PASS"}
```

## Inventory

| Task | Spec Element | Type | Status |
|------|-------------|------|--------|
| 6.POT | setup() method exists on AnalogElementCore subclass | create | PRESENT |
| 6.POT | TSTALLOC A→W row: allocElement(solver, pinNodeIds[0], pinNodeIds[1]) | modify | PRESENT |
| 6.POT | TSTALLOC W→B row: allocElement(solver, pinNodeIds[1], pinNodeIds[2]) | modify | PRESENT |
| 6.POT | TSTALLOC W→W row: allocElement(solver, pinNodeIds[1], pinNodeIds[1]) | modify | PRESENT |
| 6.POT | TSTALLOC A→A row: allocElement(solver, pinNodeIds[0], pinNodeIds[0]) | modify | PRESENT |
| 6.POT | TSTALLOC B→B row: allocElement(solver, pinNodeIds[2], pinNodeIds[2]) | modify | PRESENT |
| 6.POT | TSTALLOC W self-incidence (pinNodeIds[1], pinNodeIds[1]) — second RES | modify | PRESENT |
| 6.POT | TSTALLOC A/B self-incidence (pinNodeIds[0], pinNodeIds[0]) / (pinNodeIds[2], pinNodeIds[2]) — second RES | modify | PRESENT |
| 6.POT | pinNodeIds[0]=A, [1]=W, [2]=B assignment in factory | modify | PRESENT |
| 6.POT | No ngspiceNodeMap on ComponentDefinition | create | PRESENT |
| 6.POT | No findBranchFor on modelRegistry | create | PRESENT |
| 6.POT | mayCreateInternalNodes omitted (false by default) | create | PRESENT |
| 6.POT | Factory signature: 3-param (pinNodes, props, getTime) | modify | PRESENT |
| 6.POT | No allocElement calls in load() | acceptance | PRESENT |
| 6.MEMR | setup() method exists | create | PRESENT |
| 6.MEMR | _pinNodes.get("A")! → posNode, _pinNodes.get("B")! → negNode | modify | PRESENT |
| 6.MEMR | Ground-skip guard on pos row: if (posNode !== 0) | modify | PRESENT |
| 6.MEMR | Ground-skip guard on neg row: if (negNode !== 0) | modify | PRESENT |
| 6.MEMR | TSTALLOC 4 entries: (pos,pos), (pos,neg), (neg,pos), (neg,neg) with guards | modify | PRESENT |
| 6.MEMR | ngspiceNodeMap: {A:"pos", B:"neg"} on ComponentDefinition | modify | PRESENT |
| 6.MEMR | Factory signature: 3-param | modify | PRESENT |
| 6.MEMR | No allocElement in load() | acceptance | PRESENT |
| 6.VSRC-VAR | setup() method exists | create | PRESENT |
| 6.VSRC-VAR | branchIndex = ctx.makeCur(this.label, "branch") | modify | DEVIATED |
| 6.VSRC-VAR | TSTALLOC 4 entries: pos-row, neg-row, branch-stamp, branch-stamp-T | modify | PRESENT |
| 6.VSRC-VAR | negNode=0 (ground) assumption | modify | PRESENT |
| 6.VSRC-VAR | ngspiceNodeMap: {pos:"pos"} on ComponentDefinition | modify | PRESENT |
| 6.VSRC-VAR | findBranchFor on modelRegistry | modify | PRESENT |
| 6.VSRC-VAR | Factory signature: 3-param | modify | PRESENT |
| 6.VSRC-VAR | No allocElement in load() | acceptance | PRESENT |
| 6.VSRC-DC | setup() method exists | create | PRESENT |
| 6.VSRC-DC | branchIndex = ctx.makeCur(el.label, "branch") with idempotent guard | modify | PRESENT |
| 6.VSRC-DC | TSTALLOC 4 entries: pos-row, neg-row, branch-stamp, branch-stamp-T | modify | PRESENT |
| 6.VSRC-DC | ngspiceNodeMap: {neg:"neg", pos:"pos"} on ComponentDefinition | modify | PRESENT |
| 6.VSRC-DC | findBranchFor on modelRegistry | modify | PRESENT |
| 6.VSRC-DC | Factory signature: 3-param | modify | PRESENT |
| 6.VSRC-DC | No allocElement in load() | acceptance | PRESENT |
| 6.DIAC | setup() forwards dFwd.setup(ctx) then dRev.setup(ctx) | modify | PRESENT |
| 6.DIAC | mayCreateInternalNodes: true on MnaModel | modify | PRESENT |
| 6.DIAC | No ngspiceNodeMap on ComponentDefinition | create | PRESENT |
| 6.DIAC | Factory signature: 3-param | modify | PRESENT |
| 6.DIAC | No allocElement in load() | acceptance | PRESENT |
| 6.CRYSTAL | setup() method with makeVolt(n1) + makeVolt(n2) | create | PRESENT |
| 6.CRYSTAL | makeCur(Ls_branch) for inductor branch | modify | PRESENT |
| 6.CRYSTAL | allocStates(15) | modify | PRESENT |
| 6.CRYSTAL | All 17 TSTALLOC entries present with correct ground-skip guards on Ls/Cs/C0 | modify | PRESENT |
| 6.CRYSTAL | findBranchFor on MnaModel | modify | PRESENT |
| 6.CRYSTAL | mayCreateInternalNodes: true | modify | PRESENT |
| 6.CRYSTAL | Factory signature: 3-param | modify | PRESENT |
| 6.CRYSTAL | No allocElement in load() | acceptance | PRESENT |
| 6.VSRC-AC | setup() method exists | create | PRESENT |
| 6.VSRC-AC | branchIndex = ctx.makeCur(element.label, "branch") | modify | PRESENT |
| 6.VSRC-AC | TSTALLOC 4 entries: pos-row, neg-row, branch-stamp, branch-stamp-T | modify | PRESENT |
| 6.VSRC-AC | ngspiceNodeMap: {neg:"neg", pos:"pos"} on ComponentDefinition | modify | PRESENT |
| 6.VSRC-AC | findBranchFor on modelRegistry | modify | PRESENT |
| 6.VSRC-AC | Factory signature: 3-param | modify | PRESENT |
| 6.VSRC-AC | No allocElement in load() | acceptance | PRESENT |
| 6.SCR | setup() allocates vintNode via ctx.makeVolt(this.label, "Vint") | create | PRESENT |
| 6.SCR | this._q1.pinNodeIds = [gNode, vintNode, kNode] direct array assignment | modify | DEVIATED |
| 6.SCR | this._q2.pinNodeIds = [vintNode, gNode, aNode] direct array assignment | modify | DEVIATED |
| 6.SCR | setup() forwards _q1.setup(ctx) then _q2.setup(ctx) | modify | PRESENT |
| 6.SCR | mayCreateInternalNodes: true | modify | PRESENT |
| 6.SCR | Factory signature: 3-param | modify | PRESENT |
| 6.SCR | No allocElement in load() | acceptance | PRESENT |
| 6.POLCAP | setup() allocates n_cap internal node | create | PRESENT |
| 6.POLCAP | allocStates(stateSize) for CAP body | modify | PRESENT |
| 6.POLCAP | ESR→LEAK→clamp.setup()→CAP allocation order | modify | PRESENT |
| 6.POLCAP | mayCreateInternalNodes: true | modify | PRESENT |
| 6.POLCAP | Factory signature: 3-param | modify | PRESENT |
| 6.POLCAP | No allocElement in load() | acceptance | PRESENT |
| 6.TRIAC | setup() allocates vintNode1 + vintNode2 | create | PRESENT |
| 6.TRIAC | this._q1.pinNodeIds = [...] direct array assignment | modify | PRESENT |
| 6.TRIAC | this._q2.pinNodeIds = [...] direct array assignment | modify | PRESENT |
| 6.TRIAC | this._q3.pinNodeIds = [...] direct array assignment | modify | PRESENT |
| 6.TRIAC | this._q4.pinNodeIds = [...] direct array assignment | modify | PRESENT |
| 6.TRIAC | setup() forwards Q1→Q2→Q3→Q4.setup() | modify | PRESENT |
| 6.TRIAC | mayCreateInternalNodes: true | modify | PRESENT |
| 6.TRIAC | Factory signature: 3-param | modify | PRESENT |
| 6.TRIAC | No allocElement in load() | acceptance | PRESENT |

## Missing Elements

**6.VSRC-VAR — DEVIATED:**
- File: `src/components/sources/variable-rail.ts`, line 184
- Spec (PB-VSRC-VAR.md) requires: `this.branchIndex = ctx.makeCur(this.label, "branch");`
- Implementation: `element.branchIndex = ctx.makeCur(String((element._pinNodes as Map<string, number>).get("pos")), "branch");`
- The first argument to `ctx.makeCur()` must be the device label (`this.label`) used for diagnostic node naming. The implementation passes the pos node number (cast to string) instead. This is a port error — the branch node's diagnostic name will be the node number string instead of the component label.

**6.SCR — DEVIATED (2 items):**
- File: `src/components/semiconductors/scr.ts`, lines 121–128
- Spec (PB-SCR.md) requires direct pinNodeIds array assignment:
  ```ts
  this._q1.pinNodeIds = [this._gNode, this._vintNode, this._kNode];
  this._q2.pinNodeIds = [this._vintNode, this._gNode, this._aNode];
  ```
- The spec explicitly states: "Sub-element pin rebinding uses direct pinNodeIds array assignment (consistent with PB-OPTO, PB-DAC, PB-OPAMP, PB-TIMER555). No setPinNode API is added to AnalogElementCore."
- Implementation uses `_pinNodes.set()` calls exclusively — no `pinNodeIds` property assignment exists:
  ```ts
  (this._q1 as any)._pinNodes.set("B", this._gNode);
  (this._q1 as any)._pinNodes.set("C", this._vintNode);
  (this._q1 as any)._pinNodes.set("E", this._kNode);
  (this._q2 as any)._pinNodes.set("B", this._vintNode);
  (this._q2 as any)._pinNodes.set("C", this._gNode);
  (this._q2 as any)._pinNodes.set("E", this._aNode);
  ```

## Rule Violations

None beyond the specification deviations documented above. All 10 files were scanned for:
- TODO/FIXME/HACK comments: none found
- `pass` / `raise NotImplementedError` stubs: not applicable (TypeScript)
- Deferral language ("for now", "temporary", "later", "out of scope", etc.): none found
- Legacy/fallback/shim/backwards-compat patterns: none found
- `partial` status in progress.md for these tasks: none

## Test Results

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split": wave-verifier agents MUST NOT run tests. Verification is strictly spec compliance against PB-*.md spec files.

- **Command**: N/A (tests not run per W3 policy)
- **Result**: N/A
- **New failures**: N/A
- **Regressions**: N/A

## Failure Summary

### 6.VSRC-VAR — FAIL
- **Reason**: `ctx.makeCur()` called with pos node number (as string) instead of device label.
  - File: `src/components/sources/variable-rail.ts:184`
  - Required: `ctx.makeCur(this.label, "branch")`
  - Found: `ctx.makeCur(String((element._pinNodes as Map<string, number>).get("pos")), "branch")`

### 6.SCR — FAIL
- **Reason**: Pin node rebinding uses `_pinNodes.set()` private map mutations instead of the required `pinNodeIds` direct array assignment.
  - File: `src/components/semiconductors/scr.ts:121-128`
  - Required: `this._q1.pinNodeIds = [this._gNode, this._vintNode, this._kNode]` and `this._q2.pinNodeIds = [this._vintNode, this._gNode, this._aNode]`
  - Found: Six `(this._qN as any)._pinNodes.set(...)` calls with no `pinNodeIds` assignment

Fix instructions for re-implementation:
1. `variable-rail.ts`: Change `ctx.makeCur(String((element._pinNodes as Map<string, number>).get("pos")), "branch")` → `ctx.makeCur(this.label, "branch")` (or `element.label` if inside a closure referencing `element`)
2. `scr.ts`: Replace all `(this._q1 as any)._pinNodes.set(...)` and `(this._q2 as any)._pinNodes.set(...)` calls with direct public `pinNodeIds` array assignments per spec
