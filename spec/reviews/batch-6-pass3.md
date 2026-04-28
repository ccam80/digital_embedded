# Wave Verification: Batch 6 (Pass 3)

## Verdict
```json
{"6.TRIODE":"PASS"}
```

## Inventory

| Task | Spec Element | Type | Status |
|------|-------------|------|--------|
| 6.TRIODE | setup() calls this._vccs.setup(ctx) first | create | PRESENT |
| 6.TRIODE | setup() uses nP = this._nodeP, nK = this._nodeK (authorized fix-3: _vccs._posNode/_negNode do not exist) | modify | PRESENT |
| 6.TRIODE | setup() allocates _hPP_gds = solver.allocElement(nP, nP) | create | PRESENT |
| 6.TRIODE | setup() allocates _hKP_gds = solver.allocElement(nK, nP) | create | PRESENT |
| 6.TRIODE | TSTALLOC entry 1: allocElement(P, G) via VCCS _pinNodes "out+"=P, "ctrl+"=G | modify | PRESENT |
| 6.TRIODE | TSTALLOC entry 2: allocElement(P, K) via VCCS _pinNodes "out+"=P, "ctrl-"=K | modify | PRESENT |
| 6.TRIODE | TSTALLOC entry 3: allocElement(K, G) via VCCS _pinNodes "out-"=K, "ctrl+"=G | modify | PRESENT |
| 6.TRIODE | TSTALLOC entry 4: allocElement(K, K) via VCCS _pinNodes "out-"=K, "ctrl-"=K | modify | PRESENT |
| 6.TRIODE | TSTALLOC entry 5: allocElement(P, P) — gds composite handle | create | PRESENT |
| 6.TRIODE | TSTALLOC entry 6: allocElement(K, P) — gds composite handle | create | PRESENT |
| 6.TRIODE | 6 total handles (4 VCCS + 2 gds) matches FTRIODE-D1 | acceptance | PRESENT |
| 6.TRIODE | VCCSAnalogElement constructor: (vccsExpr, vccsDeriv, "V(ctrl)", "voltage") — fix-1 | modify | PRESENT |
| 6.TRIODE | VCCS _pinNodes keys: "ctrl+"=G, "ctrl-"=K, "out+"=P, "out-"=K — fix-2 | modify | PRESENT |
| 6.TRIODE | load() stamps via this._vccs.stamps.{pCtP,pCtN,nCtP,nCtN} — fix-4 | modify | PRESENT |
| 6.TRIODE | load() stamps _hPP_gds (+gds) and _hKP_gds (-gds) | modify | PRESENT |
| 6.TRIODE | load() stamps RHS: stampRHS(P, -ieq) and stampRHS(K, +ieq) | modify | PRESENT |
| 6.TRIODE | No allocElement calls inside load() | acceptance | PRESENT |
| 6.TRIODE | Factory 3-param signature: (pinNodes, props, _ngspiceNodeMap?) | modify | PRESENT |
| 6.TRIODE | No internalNodeIds/branchIdx in factory | modify | PRESENT |
| 6.TRIODE | No branchCount/getInternalNodeCount on model registry entry | modify | PRESENT |
| 6.TRIODE | ngspiceNodeMap absent from ComponentDefinition (composite rule) | acceptance | PRESENT |
| 6.TRIODE | mayCreateInternalNodes omitted from model registry (correct — no internal nodes) | acceptance | PRESENT |
| 6.TRIODE | findBranchFor omitted (correct — no branch row) | acceptance | PRESENT |
| 6.TRIODE | No banned closing verdicts in triode.ts or progress.md entry | acceptance | PRESENT |

## Missing Elements

None.

## Rule Violations

None. Full scan of `src/components/semiconductors/triode.ts`:

- No `TODO`, `FIXME`, `HACK` comments.
- No deferral language ("for now", "temporary", "later", "out of scope", "future work").
- No legacy/fallback/shim/backwards-compat patterns.
- No `allocElement` calls outside `setup()`.
- No `partial` status in progress.md for this task (status = `complete`).
- No banned closing verdicts in progress.md entry 6.TRIODE-fix2.

## The Four Authorized Fix-Implementer Corrections — Confirmation

**Fix-1 (Constructor):** `new VCCSAnalogElement(vccsExpr, vccsDeriv, "V(ctrl)", "voltage")` — confirmed present at `triode.ts:206`. Matches `ControlledSourceElement` constructor signature `(expression, derivative, controlLabel, controlType)`. Preceded by correct `parseExpression` / `differentiate` / `simplify` calls at lines 204-205.

**Fix-2 (_pinNodes keys):** `this._vccs._pinNodes = new Map([["ctrl+", G], ["ctrl-", K], ["out+", P], ["out-", K]])` — confirmed at `triode.ts:207-212`. Keys match what `VCCSAnalogElement.setup()` reads via `_pinNodes.get("out+")` / `_pinNodes.get("out-")` / `_pinNodes.get("ctrl+")` / `_pinNodes.get("ctrl-")` at `vccs.ts:141-144`.

**Fix-3 (setup() node access):** `const nP = this._nodeP; const nK = this._nodeK` — confirmed at `triode.ts:227-228`. This replaces the previously specified (but unreachable) `this._vccs._posNode`/`_negNode`. The spec listing at PB-TRIODE.md:107-108 used those non-existent fields; the fix-implementer assignment explicitly authorized substituting `this._nodeP`/`this._nodeK` as the correct equivalent. The effective (row, col) values are identical — `_nodeP` is always equal to what `_posNode` would have been, and `_nodeK` equals what `_negNode` would have been, because the constructor sets `this._nodeP = pinNodes.get("P")!` and the VCCS _pinNodes has `"out+" = P` and `"out-" = K`.

**Fix-4 (stamps accessor):** `const { pCtP, pCtN, nCtP, nCtN } = this._vccs.stamps` — confirmed at `triode.ts:268`. The `stamps` getter on `VCCSAnalogElement` (`vccs.ts:157-164`) returns `{ pCtP: this._hPCtP, pCtN: this._hPCtN, nCtP: this._hNCtP, nCtN: this._hNCtN }`. All four handles are used correctly in lines 269-272.

## TSTALLOC Sequence Verification (vccsset.c:43-46)

With Triode pin assignments P=plate, G=grid, K=cathode, the VCCS _pinNodes sets `"out+"=P`, `"out-"=K`, `"ctrl+"=G`, `"ctrl-"=K`. The resulting VCCS setup() allocations:

| # | ngspice anchor | Effective call | Handle |
|---|---|---|---|
| 1 | vccsset.c:43 VCCSposContPosptr | allocElement(P, G) | `_hPCtP` |
| 2 | vccsset.c:44 VCCSposContNegptr | allocElement(P, K) | `_hPCtN` |
| 3 | vccsset.c:45 VCCSnegContPosptr | allocElement(K, G) | `_hNCtP` |
| 4 | vccsset.c:46 VCCSnegContNegptr | allocElement(K, K) | `_hNCtN` |
| 5 | FTRIODE-D1 gds | allocElement(P, P) | `_hPP_gds` |
| 6 | FTRIODE-D1 gds | allocElement(K, P) | `_hKP_gds` |

Matches PB-TRIODE.md §"TSTALLOC sequence" table exactly.

## Test Results

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split": wave-verifier agents MUST NOT run tests. Verification is strictly spec compliance against PB-TRIODE.md.

- **Command**: N/A (tests not run per W3 policy)
- **Result**: N/A
- **New failures**: N/A
- **Regressions**: N/A

## Failure Summary

None. All 8 green-gate items PASS. All 4 authorized fix-implementer corrections confirmed present and correct.
