# Spec Review: setup-load-cleanup.md — Combined Report

## Overall Verdict: **needs-revision**

Standalone spec, no `plan.md`. Three review agents ran in parallel:
- **ngspice contract verification** — see `spec-setup-load-cleanup-ngspice.md`
- **F-code coverage audit** — see `spec-setup-load-cleanup-fcodes.md`
- **general wide-net review** — see `spec-setup-load-cleanup-general.md`

## Per-Lane Verdicts

| Lane | Verdict | critical | major | minor | info |
|---|---|---|---|---|---|
| ngspice | needs-revision | 0 | 4 | 4 | 2 |
| F-codes | needs-revision | 4 | 10 | 6 | 3 |
| general | needs-revision | 1 | 8 | 6 | 3 |

## Cross-Lane Cross-Checks
- No file appears with conflicting F-code instructions across lanes.
- ngspice findings (D1, D2, D4) and general findings (D2 internal-node IDs, D6 PropertyBag scope) do not overlap; both lanes touch §A.16/A.17 from different angles.
- F-code D5 (compiler.ts missing F1/F14/F15) and F-code D7 (compiler.ts missing F18) are best fixed together with general's M2 wording fix in §A.21.
- F-code D4 (bridge-adapter.ts missing F1) is independent of general D11 (bridge `_pinNodes` constructor) — kept separate.
- General M3 (C13 grep uses literal `el\.`) strengthens both ngspice and F-code lanes if applied.

## Spec is clean of CLAUDE.md banned closing verdicts
General's grep confirmed: no occurrences of "tolerance", "equivalent", "intentional divergence", "close enough", "mapping table", or "pre-existing" used as closing verdicts. Single hit on `partial` is a process-status enum value in §C.4, not a parity verdict.

---

## Mechanical Fixes (apply with user approval)

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FC-M1 | major | §B.5 row `inductor.ts` | F7 listed but file has zero `ctx.makeVolt(` sites | Strike F7. Row becomes `F1, F4, F6` |
| FC-M2 | major | §B.5 row `tapped-transformer.ts` | F7 listed but file has zero `ctx.makeVolt(` sites | Strike F7. Row becomes `F1, F2, F3, F4, F6` |
| FC-M3 | minor | §B.7 row `relay-dt.ts` | F1 listed but no `isReactive`/`isNonlinear` matches | Drop F1. Row becomes `F7 (1 makeVolt site for "coilMid")` |
| FC-M4 | minor | §B.6 rows `varactor.ts`, `schottky.ts`, `diac.ts` | F1 may not be needed per audit | Verify each per-file; drop F1 where grep returns zero hits |
| GEN-M1 | minor | §A.16 ~line 604 | `SetupContext.solver` doesn't disambiguate `beginAssembly`/`endAssembly` lifecycle | Add footnote: "Tests construct the solver and call `solver.beginAssembly(...)` / `solver.endAssembly()` outside the SetupContext lifecycle; element setup() calls only `ctx.solver.allocElement(...)`." |
| GEN-M2 | minor | §A.21 ~line 810 vs §A.15 ~line 480 | Wording about `stateSize` reads as a prohibition | Reword to "The composite's `stateSize` is provided by the `CompositeElement` base-class getter (A.15), which dynamically sums sub-element `stateSize`. The compiler does not write a `stateSize` field to the composite directly." |
| GEN-M3 | major | §C.1 row C13 ~line 1226 | Pattern `\bel\.isReactive\b` uses literal `el\.` anchor — misses `element.isReactive`, `c.isReactive`, etc. | Replace with `\b\w+\.(isReactive\|isNonlinear)\b`, OR drop C13 entirely (C1+C2 already catch all surface forms) |
| GEN-M4 | minor | §A.5 / §A.16 | `allocStates`/`makeCur` JSDoc carries storage notes that belong in prose | Move "Stored to `el._stateBase`"/"Stored to `el.branchIndex`" sentences out of A.16 JSDoc into A.5 prose |

## Decision-Required Items (compact)

### ngspice contract verification

**NG-D1 — `_findBranch` composition does not match ngspice's `CKTfndBranch` (major)**
A.6/A.16 compose `findDevice(label)` then `el.findBranchFor(name, ctx)`. ngspice's `CKTfndBranch` (cktfbran.c) iterates ALL device-type hooks (`DEVfindBranch`); each hook walks its own instances and lazy-allocates. There is no separate "find device, then call hook" step in ngspice.
- A) Align: drop `findDevice` from `SetupContext`; replace with single `findBranch(name)` driver
- B) Keep two-step composition; rewrite §A.16 JSDoc to characterize as digiTS-specific; file in `architectural-alignment.md`
- C) Add JSDoc note in A.6 describing the divergence; no architectural change

**NG-D2 — `srcFact` applied unconditionally in canonical VSRC pattern (major)**
A.13 shows `rhs[el.branchIndex] += p.voltage * ctx.srcFact;` unconditionally. ngspice (`vsrcload.c`) gates `srcFact` on `MODEDCOP|MODEDCTRANCURVE|MODETRANOP` — never applied during ordinary transient.
- A) Make canonical pattern conditional on `cktMode`; bit-exact with ngspice
- B) Document deliberate divergence; file in architectural-alignment.md
- C) Move gating into engine so `ctx.srcFact == 1.0` outside gated paths

**NG-D3 — BJT example uses `model.RC` instead of ngspice `BJTcollectorResist` (minor)**
A.13 BJT example uses `model.RC === 0` and elides base/emitter with `// ... similarly`. ngspice (`bjtsetup.c:372–428`) gates on `BJTcollectorResist`/`BJTbaseResist`/`BJTemitterResist`.
- A) Replace `model.RC` with `model.BJTcollectorResist`; show all three gates explicitly
- B) Keep `RC` shorthand; add field-name mapping comment; show all three gates
- C) Replace example body with JSDoc reference to `bjtsetup.c`

**NG-D4 — `LoadContext.iabstol` is not an ngspice field name (major)**
§A.17 lists `iabstol` alongside `reltol`. ngspice has `CKTabstol` (cktdefs.h:199), no `CKTiabstol`.
- A) Rename to `abstol`
- B) Keep `iabstol`; JSDoc characterizing as digiTS-specific; file in architectural-alignment.md
- C) Rename to a clearly digiTS name like `currentAbsTol`

**NG-D5 — `branchIndex === -1` sentinel doesn't match ngspice's `branch == 0` sentinel (minor)**
ngspice uses `0` as "not allocated". digiTS uses `-1`. Internally consistent but not ngspice-equivalent.
- A) JSDoc note in A.5/A.13 explaining sentinel value divergence
- B) Switch sentinel to `0`; reserve solver row 0; rebase real branches to start at 1
- C) File as deliberate divergence in `architectural-alignment.md`

### F-code coverage

**FC-D1 — Async-flipflop classes don't `implements ReactiveAnalogElementCore` today; A.15 mandates F18 anyway (critical)**
`d-async.ts`/`jk-async.ts`/`rs-async.ts` don't `implements ReactiveAnalogElementCore`. Forcing F18 introduces `getLteTimestep` forwarding into classes that may have intentionally lacked it.
- A) Include them as composites; uniform shape, may eliminate latent bug
- B) Exclude from A.15; A.15's "16 classes" becomes 13
- C) Audit children first

**FC-D2 — `behavioral-remaining.ts` F18 changes engine routing for 3 of 6 classes (major)**
3 classes use `get isReactive(): boolean { return this._childElements.length > 0; }` (dynamic). After F18 they become unconditionally `poolBacked: true`.
- A) Accept the change; uniform composite shape
- B) Split: F18 on the 3 dynamic classes, 3 static ones implement `PoolBackedAnalogElement` directly
- C) Add `subElementsHaveState` hook on `CompositeElement`

**FC-D3 — F18 doesn't enumerate the abstract-field declarations subclasses must add (critical)**
A.15 requires every F18 class to declare `readonly ngspiceLoadOrder` and `readonly stateSchema`. F-code F18 description doesn't say this.
- A) Strengthen F18 description in §B's edit-codes table
- B) Add a separate F19 code: "Declare ngspiceLoadOrder and stateSchema per A.15"
- C) Add per-class table in A.15 mapping each composite to its NGSPICE_LOAD_ORDER

**FC-D4 — `bridge-adapter.ts` row missing F1 despite live `isReactive`/`isNonlinear` decls (critical)**
Grep shows 4 live flag decls in the file. Row §B.1 lists `F2, F11, F18` but not F1.
- A) Add F1 explicitly: `F1, F2, F11, F18`
- B) Define F18 to imply F1 globally
- C) Leave implicit, argue A.1's universal ban makes F1 always implicit

**FC-D5 — `compiler.ts` row missing F1, F14, F15 despite live writes/reads (critical)**
Compiler reads/writes flag fields and uses `element.isReactive` predicate. Row says only "Apply A.21 in full".
- A) Annotate explicit F-codes: `F1, F14, F15 (apply A.21 in full)`
- B) Strengthen A.21 with numbered item 4 listing literal writes to strip
- C) Both

**FC-D6 — `controlled-source-base.ts` missing F6 vs A.6 mandate (major)**
A.6 lists VCVS, CCVS as branch-row owners. Per-source files DO list F6. Spec ambiguous: per-source or base hosts `findBranchFor`?
- A) Per-source hosting (A.13 canonical) — verify per-source files have F6
- B) Base-class hosting — add F6 to base, remove from `vcvs.ts`/`ccvs.ts`
- C) Document the split

**FC-D7 — `compiler.ts` row missing F18 despite A.15/R6 mandate (major)**
A.15 names `compiler.ts` as host of an anonymous CompositeElement subclass. R6 confirms. Row lacks F18.
- A) Add F18: `F1, F14, F15, F18 (apply A.21 in full)`
- B) Annotate F18's table description with "compiler.ts also"

**FC-D8 — `harness/capture.ts` row missing F9 (`stateBaseOffset` rename) (major)**
`capture.ts:203` reads `el.stateBaseOffset`. Row §B.11 doesn't list F9.
- A) Add F9
- B) Document snapshot key as preserved
- C) Out-of-band per A.20

**FC-D10 — `behavioral-flipflop.ts` row missing class-count parenthetical (minor)**
Spec other multi-class rows include counts; this row doesn't.
- A) Add "(1 class)"
- B) Strip class counts from single-class rows

### General review

**GEN-D1 — Wave closure criteria are too loose for ~150-file blast radius (critical)**
§D.3 accepts no tsc-clean / no test-clean during wave; convergence pass has no exit condition.
- A) Hard gate: zero tsc errors and no NEW test failures vs `spec/test-baseline.md`
- B) Numerical-parity gate only: C.1 clean + tsc errors within allow-list + no NEW numerical regressions
- C) Two-stage convergence: (1) C.1 + tsc clean, (2) test triage

**GEN-D2 — `_pinNodes.size + p` internal-node ID derivation is fragile (major)**
Risk for composites where `super.setup(ctx)` forwards to children calling `makeVolt`, then parent calls `makeVolt` after.
- A) Add `getInternalNodeIds?(): readonly number[]`; harness zips with labels
- B) Composites don't allocate internal nodes; only leaf children do
- C) Document contract + Section C grep for parent-side `ctx.makeVolt` in composites

**GEN-D3 — `ReadonlyMap` vs `Map` parameter typing inconsistency (major)**
Factory takes `ReadonlyMap`; element field is mutable `Map`. No clause says `_pinNodes` is conceptually frozen.
- A) Tighten to `ReadonlyMap` on element field
- B) Keep `Map`; add prose to A.4 stating immutability
- C) Use `Object.freeze(map)` runtime safety

**GEN-D4 — `getInternalNodeLabels` placement on AnalogElement vs PoolBackedAnalogElement (major)**
On base interface as optional; ~70% of elements never implement.
- A) Keep on base AnalogElement (current)
- B) Move to PoolBackedAnalogElement only
- C) Keep on base + Section C grep enforcing presence where `ctx.makeVolt` is called

**GEN-D5 — F4 on test files is ambiguous (major)**
F4 = "Factory signature → 3-arg" — production-side change. On a test file, ambiguous: rewrite factory definition vs update call sites?
- A) Add an F4-test gloss to the F-codes table
- B) Split into F4-prod and F4-test
- C) Drop F4 from test rows; expand F16's scope to cover test invocations

**GEN-D6 — `variable-rail.ts` `?? ""` workaround vs A.18 PropertyBag scope (major)**
A.18 says PropertyBag renames are out-of-scope; B.4's variable-rail row instructs `?? ""` at the call site.
- A) Add exemption to A.18: defensive call-site fallbacks are in-scope
- B) Remove `?? ""` from B.4; record as out-of-band
- C) Move `getString` to in-scope wave-wide

**GEN-D7 — `makeTestSetupContext.startBranch=-1` default is over-strict (minor)**
Tests that incidentally trigger lazy `findBranchFor` throw even if test never called setup on that peer.
- A) Document as intentional
- B) Default startBranch to 0; drop throw guard
- C) Lazy-default based on `findBranchFor` presence

**GEN-D8 — `dac.ts` F4 without F18 (minor)**
A.15 prose mentions ADC/DAC as composites; explicit table doesn't list them.
- A) Add F18 to dac.ts (and audit adc.ts)
- B) Clarify A.15's intro to remove "ADC/DAC" since explicit table doesn't list
- C) Add explicit non-composite note for adc.ts/dac.ts

**GEN-D9 — Three-Surface Testing Rule: spec doesn't address E2E/MCP impact (minor)**
Spec covers headless and harness, not `scripts/circuit-mcp-server.ts`, `e2e/parity/`, `src/io/postmessage-adapter.ts`.
- A) Add B.15 row for MCP/E2E surfaces
- B) Add one-line out-of-scope clause to A.20
- C) Do nothing; rely on convergence pass

**GEN-D10 — `ckt-context.ts` filter deletions: A.12 "verified zero callers" not demonstrated (minor)**
- A) Add C.1 row C19 grepping for `elementsWithLte`/`elementsWithAcceptStep` outside `ckt-context.ts`
- B) Move deletion to convergence pass
- C) Trust the assertion

**GEN-D11 — Bridge adapter's `_pinNodes` initialization is under-specified (info)**
A.22 says "initialize _pinNodes from wrapped digital pin model's label and node id" — but pin model is a single pin.
- A) Single-entry Map: `new Map([[pinModel.label, pinModel.nodeId]])`
- B) Add a canonical bridge-adapter snippet to A.22
- C) Defer to follow-up agent

**GEN-D12 — `transmission-line.ts` segment sub-classes excluded from F18 but F4 applied (info)**
Ambiguous: top-level only or include segment sub-class constructors?
- A) Clarify in B.5: "F4 (top-level factory only)"
- B) Strengthen F4 globally with the same gloss
- C) Do nothing

**GEN-D13 — Class implementing pattern `private` vs `#` field (info)**
A.14 uses `private _hPP`. Both `private` and `#` qualify in casual reading.
- A) Lock to TypeScript `private`
- B) Lock to JavaScript `#`
- C) Accept either; do not mix within a single file

**GEN-D14 — Out-of-band lane risk: realistic agent discipline (info)**
A.20 says don't touch out-of-band; B.4's variable-rail row already overrides for one site (D6).
- A) Hard boundary: agents MUST NOT touch out-of-band even to resolve a tsc error
- B) Triage: agent stops, documents 'blocked', moves on
- C) Accept the porousness

**GEN-D15 — F-code coverage of forbidden names: F16 vs F17 in test files (minor)**
- A) Audit B.13/B.14 and explicitly add F17 wherever applicable
- B) Define F16 to subsume F17
- C) Use C15 grep as backstop

---

## Summary

- **8 mechanical fixes** (FC-M1..M4, GEN-M1..M4) — 4 file-level F-code corrections, 4 spec-text clarifications. All low-risk.
- **23 decision-required items** — 5 ngspice (NG-D1..D5), 9 F-code (FC-D1..D8, FC-D10), 14 general (GEN-D1..D15, with D11–D14 info-tier).
- **5 critical decisions** that block shipping: FC-D1, FC-D3, FC-D4, FC-D5, GEN-D1.
- Spec is otherwise well-structured; passes the CLAUDE.md banned-vocabulary grep.

The 23 decision-required items exceed `AskUserQuestion`'s 4-question cap. Recommended path: user reads this combined report, then either replies in text with bulk decisions, or directs the coordinator to gate critical-tier items first via batched questions.
