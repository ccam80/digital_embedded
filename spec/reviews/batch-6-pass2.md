# Wave Verification: Batch 6 (Pass 2)

## Verdict
```json
{"6.RES":"PASS","6.IND":"PASS","6.XFMR":"FAIL","6.VSRC-VAR":"PASS","6.ISRC":"PASS","6.TRIODE":"FAIL","6.TUNNEL":"PASS"}
```

## Inventory

| Task | Spec Element | Type | Status |
|------|-------------|------|--------|
| 6.RES | setup() body exists matching PB-RES listing | create | PRESENT |
| 6.RES | TSTALLOC 1: allocElement(posNode, posNode) → _hPP | modify | PRESENT |
| 6.RES | TSTALLOC 2: allocElement(negNode, negNode) → _hNN | modify | PRESENT |
| 6.RES | TSTALLOC 3: allocElement(posNode, negNode) → _hPN | modify | PRESENT |
| 6.RES | TSTALLOC 4: allocElement(negNode, posNode) → _hNP | modify | PRESENT |
| 6.RES | posNode = _pinNodes.get("A")!, negNode = _pinNodes.get("B")! | modify | PRESENT |
| 6.RES | No allocElement in load() | acceptance | PRESENT |
| 6.RES | Factory 3-param (pinNodes, props, _getTime) | modify | PRESENT |
| 6.RES | ngspiceNodeMap: { A: "pos", B: "neg" } on ComponentDefinition | modify | PRESENT |
| 6.RES | No findBranchFor (correct — no branch row) | acceptance | PRESENT |
| 6.RES | mayCreateInternalNodes omitted (correct) | acceptance | PRESENT |
| 6.RES | No internalNodeIds/branchIdx in factory | modify | PRESENT |
| 6.IND | setup() body exists matching PB-IND listing | create | PRESENT |
| 6.IND | allocStates(2) — INDflux + INDvolt | modify | PRESENT |
| 6.IND | Idempotent branchIndex guard: if (this.branchIndex === -1) | modify | PRESENT |
| 6.IND | ctx.makeCur(this._label, "branch") | modify | PRESENT |
| 6.IND | TSTALLOC 1: allocElement(posNode, b) → _hPIbr | modify | PRESENT |
| 6.IND | TSTALLOC 2: allocElement(negNode, b) → _hNIbr | modify | PRESENT |
| 6.IND | TSTALLOC 3: allocElement(b, negNode) → _hIbrN | modify | PRESENT |
| 6.IND | TSTALLOC 4: allocElement(b, posNode) → _hIbrP | modify | PRESENT |
| 6.IND | TSTALLOC 5: allocElement(b, b) → _hIbrIbr | modify | PRESENT |
| 6.IND | posNode = _pinNodes.get("A")!, negNode = _pinNodes.get("B")! | modify | PRESENT |
| 6.IND | No allocElement in load() | acceptance | PRESENT |
| 6.IND | findBranchFor on element class | create | PRESENT |
| 6.IND | findBranchFor on MnaModel registry | modify | PRESENT |
| 6.IND | ngspiceNodeMap: { A: "pos", B: "neg" } on ComponentDefinition | modify | PRESENT |
| 6.IND | branchCount removed from MnaModel | modify | PRESENT |
| 6.IND | mayCreateInternalNodes omitted (correct) | acceptance | PRESENT |
| 6.IND | Factory 3-param (pinNodes, props, _getTime) | modify | PRESENT |
| 6.XFMR | Composite setup() calls _l1.setup(ctx), _l2.setup(ctx), _mut.setup(ctx) in order | create | PRESENT |
| 6.XFMR | _l1 before _l2 before _mut ordering invariant | modify | PRESENT |
| 6.XFMR | InductorSubElement: allocStates(2) in setup() | create | PRESENT |
| 6.XFMR | InductorSubElement: idempotent branchIndex guard | create | PRESENT |
| 6.XFMR | InductorSubElement: 5-entry TSTALLOC (indsetup.c:96-100) | create | PRESENT |
| 6.XFMR | InductorSubElement: 4-param constructor (posNode, negNode, label, inductance) | create | DEVIATED |
| 6.XFMR | InductorSubElement: poolBacked = true as const field | create | MISSING |
| 6.XFMR | InductorSubElement: stateSchema = INDUCTOR_SUB_SCHEMA | create | MISSING |
| 6.XFMR | InductorSubElement: stateSize = 2 | create | MISSING |
| 6.XFMR | InductorSubElement: stateBaseOffset: number = -1 | create | MISSING |
| 6.XFMR | InductorSubElement: s0..s7 Float64Array fields | create | MISSING |
| 6.XFMR | InductorSubElement: ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND | create | MISSING |
| 6.XFMR | InductorSubElement: isNonlinear: false | create | MISSING |
| 6.XFMR | InductorSubElement: isReactive: true | create | MISSING |
| 6.XFMR | InductorSubElement: initState(pool) method | create | MISSING |
| 6.XFMR | InductorSubElement: load(ctx) body (indload.c port) | create | MISSING |
| 6.XFMR | InductorSubElement: getLteTimestep method | create | MISSING |
| 6.XFMR | InductorSubElement: setParam("L"/"inductance", value) | create | MISSING |
| 6.XFMR | MutualInductorElement: 2-entry TSTALLOC (mutsetup.c:66-67) | create | PRESENT |
| 6.XFMR | MutualInductorElement: guard b1 === -1 || b2 === -1 throws | create | PRESENT |
| 6.XFMR | ngspiceNodeMap absent from ComponentDefinition (composite) | acceptance | PRESENT |
| 6.XFMR | findBranchFor on AnalogTransformerElement (delegates to _l1/_l2) | create | PRESENT |
| 6.XFMR | Factory 3-param (pinNodes, props, _getTime) | modify | PRESENT |
| 6.XFMR | branchCount removed from MnaModel | modify | PRESENT |
| 6.XFMR | mayCreateInternalNodes omitted (correct) | acceptance | PRESENT |
| 6.XFMR | No allocElement in load() | acceptance | PRESENT |
| 6.VSRC-VAR | setup() body exists | create | PRESENT |
| 6.VSRC-VAR | ctx.makeCur(element.label, "branch") — device label (not node number) | modify | PRESENT |
| 6.VSRC-VAR | Idempotent guard: if (element.branchIndex === -1) | modify | PRESENT |
| 6.VSRC-VAR | negNode = 0 (hardcoded ground) | modify | PRESENT |
| 6.VSRC-VAR | TSTALLOC 1: allocElement(posNode, branchNode) → _hPosBr | modify | PRESENT |
| 6.VSRC-VAR | TSTALLOC 2: allocElement(0, branchNode) → _hNegBr | modify | PRESENT |
| 6.VSRC-VAR | TSTALLOC 3: allocElement(branchNode, 0) → _hBrNeg | modify | PRESENT |
| 6.VSRC-VAR | TSTALLOC 4: allocElement(branchNode, posNode) → _hBrPos | modify | PRESENT |
| 6.VSRC-VAR | No allocElement in load() | acceptance | PRESENT |
| 6.VSRC-VAR | ngspiceNodeMap: { pos: "pos" } on model registry entry | modify | PRESENT |
| 6.VSRC-VAR | findBranchFor on model registry entry | modify | PRESENT |
| 6.VSRC-VAR | Factory 3-param compatible | modify | PRESENT |
| 6.ISRC | setup(_ctx) body is intentionally empty | create | PRESENT |
| 6.ISRC | No TSTALLOC calls (correct — no *set.c) | acceptance | PRESENT |
| 6.ISRC | No allocStates, no makeCur, no makeVolt | acceptance | PRESENT |
| 6.ISRC | ngspiceNodeMap: { neg: "neg", pos: "pos" } on model registry | modify | PRESENT |
| 6.ISRC | No findBranchFor (correct — no branch row) | acceptance | PRESENT |
| 6.ISRC | Factory 3-param (pinNodes, props) at model registry | modify | PRESENT |
| 6.ISRC | No internalNodeIds/branchIdx in factory | modify | PRESENT |
| 6.ISRC | No allocElement in load() | acceptance | PRESENT |
| 6.TRIODE | setup() calls this._vccs.setup(ctx) first | create | PRESENT |
| 6.TRIODE | setup() allocates _hPP_gds = solver.allocElement(nP, nP) | create | PRESENT |
| 6.TRIODE | setup() allocates _hKP_gds = solver.allocElement(nK, nP) | create | PRESENT |
| 6.TRIODE | VCCSAnalogElement constructed with correct (ExprNode, ExprNode, label, type) signature | create | DEVIATED |
| 6.TRIODE | VCCS _pinNodes uses "out+"/"out-"/"ctrl+"/"ctrl-" keys matching VCCSAnalogElement.setup() | create | DEVIATED |
| 6.TRIODE | nP = this._vccs._posNode, nK = this._vccs._negNode — fields exist on VCCSAnalogElement | create | DEVIATED |
| 6.TRIODE | load() stamps via this._vccs._hPosCPos/_hPosCNeg/_hNegCPos/_hNegCNeg | create | DEVIATED |
| 6.TRIODE | ngspiceNodeMap absent from ComponentDefinition (composite) | acceptance | PRESENT |
| 6.TRIODE | No findBranchFor (correct — no branch row) | acceptance | PRESENT |
| 6.TRIODE | mayCreateInternalNodes omitted | acceptance | PRESENT |
| 6.TRIODE | Factory 3-param (pinNodes, props, _ngspiceNodeMap) | modify | PRESENT |
| 6.TRIODE | No allocElement in load() | acceptance | PRESENT |
| 6.TUNNEL | setup() delegates to this._vccs.setup(ctx) | create | PRESENT |
| 6.TUNNEL | VCCSAnalogElement constructed with (vccsExpr, vccsDeriv, "V(ctrl)", "voltage") | create | PRESENT |
| 6.TUNNEL | VCCS _pinNodes set with "ctrl+"/"ctrl-"/"out+"/"out-" keys | create | PRESENT |
| 6.TUNNEL | contPosNode = contNegNode = A, posNode = negNode = K (self-controlled) | modify | PRESENT |
| 6.TUNNEL | load() uses this._vccs.stamps accessor for handles | create | PRESENT |
| 6.TUNNEL | No allocElement in load() | acceptance | PRESENT |
| 6.TUNNEL | ngspiceNodeMap absent from ComponentDefinition (composite) | acceptance | PRESENT |
| 6.TUNNEL | No findBranchFor (correct) | acceptance | PRESENT |
| 6.TUNNEL | mayCreateInternalNodes omitted | acceptance | PRESENT |
| 6.TUNNEL | Factory 3-param (pinNodes, props, _getTime) | modify | PRESENT |
| 6.TUNNEL | No internalNodeIds/branchIdx in factory | modify | PRESENT |

## Missing Elements

### 6.XFMR — DEVIATED / MISSING

The spec PB-XFMR.md §"New class InductorSubElement" specifies a **4-parameter constructor**:
```ts
constructor(
  private readonly _posNode: number,
  private readonly _negNode: number,
  private readonly _label: string,
  private _inductance: number,   // ← required 4th param
)
```
The implementation at `src/components/passives/mutual-inductor.ts:33-38` has only **3 parameters** — `_inductance` is absent.

The spec also requires `InductorSubElement` to be a full `PoolBackedAnalogElementCore` implementation with the following fields/methods — all MISSING from the implementation:
- `readonly poolBacked = true as const`
- `readonly stateSchema: StateSchema = INDUCTOR_SUB_SCHEMA`
- `readonly stateSize: number = 2`
- `stateBaseOffset: number = -1`
- `s0..s7: Float64Array<ArrayBufferLike>`
- `readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND`
- `readonly isNonlinear: false = false`
- `readonly isReactive: true = true`
- `initState(pool: StatePoolRef): void`
- `load(ctx: LoadContext): void` (indload.c port)
- `getLteTimestep(...)` 
- `setParam(key: string, value: number): void`

The implementation in `mutual-inductor.ts` implements only the `setup()` and `findBranchFor()` methods with handle getters, but none of the pool-backed state machinery, load(), getLteTimestep(), setParam(), or ngspiceLoadOrder fields required by the spec.

### 6.TRIODE — DEVIATED (4 items)

**Deviation 1 — Wrong VCCSAnalogElement constructor arguments.**
- File: `src/components/semiconductors/triode.ts`, line 213
- Spec (PB-TRIODE): `VccsAnalogElement` constructed with pin nodes for correct VCCS operation. The implementation calls `new VCCSAnalogElement(vccsPinNodes, props, vccsNgspiceNodeMap)`.
- Actual `VCCSAnalogElement` constructor signature (from `src/components/active/vccs.ts`, inherited from `ControlledSourceElement`): `constructor(expression: ExprNode, derivative: ExprNode, controlLabel: string, controlType: "voltage" | "current")`.
- A `Map<string, number>` is passed as `expression`, a `PropertyBag` as `derivative`, and a `Record` as `controlLabel`. This is a type mismatch — the VCCS element is constructed with meaningless arguments.

**Deviation 2 — Wrong _pinNodes keys for VCCSAnalogElement.**
- File: `src/components/semiconductors/triode.ts`, lines 201-206
- The `vccsPinNodes` Map uses keys `"pos"`, `"neg"`, `"contPos"`, `"contNeg"`.
- `VCCSAnalogElement.setup()` (vccs.ts:141-144) reads `_pinNodes.get("out+")`, `_pinNodes.get("out-")`, `_pinNodes.get("ctrl+")`, `_pinNodes.get("ctrl-")` — these keys don't match, so all node lookups return `undefined`.

**Deviation 3 — Access of nonexistent _posNode/_negNode fields.**
- File: `src/components/semiconductors/triode.ts`, lines 228-229
- `this._vccs._posNode` and `this._vccs._negNode` do not exist on `VCCSAnalogElement`. The class stores nodes only via `_pinNodes` map.

**Deviation 4 — Access of nonexistent private handle fields.**
- File: `src/components/semiconductors/triode.ts`, lines 269-272
- `this._vccs._hPosCPos`, `this._vccs._hPosCNeg`, `this._vccs._hNegCPos`, `this._vccs._hNegCNeg` do not exist on `VCCSAnalogElement`. The class's internal handles are named `_hPCtP`, `_hPCtN`, `_hNCtP`, `_hNCtN` (private), exposed only through the `stamps` getter. The spec (PB-TRIODE) specifies accessing stamps via `_vccs.stamps` (as tunnel diode correctly does), not by accessing private internal fields by wrong names.

## Rule Violations

None beyond the specification deviations documented above. All 7 source files and `mutual-inductor.ts` were scanned for:
- TODO/FIXME/HACK comments: none found
- Deferral language ("for now", "temporary", "later", "out of scope", etc.): none found
- Legacy/fallback/shim/backwards-compat patterns: none found
- `partial` status in progress.md for these tasks: not found
- `allocElement` calls outside `setup()` method bodies: none found in any file

## Test Results

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split": wave-verifier agents MUST NOT run tests. Verification is strictly spec compliance against PB-*.md spec files.

- **Command**: N/A (tests not run per W3 policy)
- **Result**: N/A
- **New failures**: N/A
- **Regressions**: N/A

## User-decision pending

**6.XFMR conditional:** The presence of `src/components/passives/mutual-inductor.ts` (116 lines) was flagged in the assignment as an out-of-scope file whose authorization is being adjudicated by the user offline. Per the assignment brief, the 6.XFMR verdict is not blocked on that ruling — but the verdict IS FAIL for independent reasons (missing `InductorSubElement` pool-backed interface and constructor mismatch), so the user decision on file authorization is moot for this pass.

## Failure Summary

### 6.XFMR — FAIL

1. **`InductorSubElement` constructor is 3-param, not 4-param.** Spec requires `(posNode, negNode, label, inductance)`. Implementation has `(posNode, negNode, label)` only. File: `src/components/passives/mutual-inductor.ts:33-37`.

2. **`InductorSubElement` is not a `PoolBackedAnalogElementCore`.** The spec requires it to implement the full pool-backed interface: `poolBacked`, `stateSchema`, `stateSize`, `stateBaseOffset`, `s0..s7`, `ngspiceLoadOrder`, `isNonlinear`, `isReactive`, `initState()`, `load()`, `getLteTimestep()`, `setParam()`. The implementation has none of these — only `setup()`, `findBranchFor()`, and handle getters.

Fix instructions:
- Expand `InductorSubElement` in `src/components/passives/mutual-inductor.ts` to fully implement `PoolBackedAnalogElementCore` per the complete spec in PB-XFMR.md §"New class InductorSubElement".
- Add the 4th constructor parameter `private _inductance: number`.
- Add all required pool-backed fields and methods.

### 6.TRIODE — FAIL

1. **VCCSAnalogElement constructed with wrong arguments.** Line 213 passes `(vccsPinNodes, props, vccsNgspiceNodeMap)` but constructor requires `(expression: ExprNode, derivative: ExprNode, controlLabel: string, controlType: string)`. File: `src/components/semiconductors/triode.ts:213`.

2. **Wrong `_pinNodes` keys.** `vccsPinNodes` uses `"pos"/"neg"/"contPos"/"contNeg"` but `VCCSAnalogElement.setup()` reads `"out+"/"out-"/"ctrl+"/"ctrl-"`. Lines 201-206.

3. **Nonexistent `_posNode`/`_negNode` field access.** Lines 228-229 access `this._vccs._posNode` and `this._vccs._negNode` which don't exist on `VCCSAnalogElement`.

4. **Nonexistent private handle field access.** Lines 269-272 access `this._vccs._hPosCPos/_hPosCNeg/_hNegCPos/_hNegCNeg` which don't exist. Should use `this._vccs.stamps.pCtP/pCtN/nCtP/nCtN` (as tunnel-diode.ts correctly does).

Fix instructions:
- Construct `VCCSAnalogElement` correctly using `parseExpression`/`differentiate`/`simplify` pattern (as tunnel-diode.ts does at lines 232-234).
- Set `vccsElement._pinNodes` with keys `"ctrl+"`, `"ctrl-"`, `"out+"`, `"out-"` mapping to `G`, `K`, `P`, `K` nodes respectively.
- Remove `this._vccs._posNode`/`_negNode` accesses; use `this._nodeP`/`this._nodeK` directly (already stored on TriodeElement).
- Replace `this._vccs._hPosCPos` etc. with `this._vccs.stamps.pCtP` etc. in load().
