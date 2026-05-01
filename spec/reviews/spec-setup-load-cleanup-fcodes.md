# Spec Review: Setup-Load Cleanup- F-Code Coverage Audit

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 4 | 4 |
| major    | 4 | 6 | 10 |
| minor    | 4 | 2 | 6 |
| info     | 2 | 1 | 3 |

## Plan Coverage
No `spec/plan.md` exists for this standalone spec; coverage is per-file by F-code only. The audit below focuses on whether the per-file F-code annotations match what the actual files require.

## Method
- Sampled ~3 files per B-section, prioritising "high" estimates and unusual F-code combinations.
- Validated F1 by grepping `\bisReactive\b|\bisNonlinear\b`.
- Validated F3 by grepping `pinNodeIds\s*[!?:]` (field form).
- Validated F7 by counting `ctx\.makeVolt\(` per file and comparing to spec's parenthetical assertion.
- Validated F6 by grepping `findBranchFor` and checking against the A.6 list.
- Validated F10 by grepping `ReactiveAnalogElement(Core)?` for import/cast survival.
- Validated F18 by reading A.15's subclass mandate and comparing each B.3/B.1 row.

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | major | spec ssB.5 row `inductor.ts` | Spec lists `F7` but the file `src/components/passives/inductor.ts` contains zero `ctx.makeVolt(` call sites (verified via grep). Inductors own only a branch row, never an internal node. F7 is wasted work and may cause an implementer to invent a phantom internal node. | Strike `F7` from the row. The remaining edits become `F1, F4, F6`. |
| M2 | major | spec ssB.5 row `tapped-transformer.ts` | Spec lists `F7` but the file contains zero `ctx.makeVolt(` call sites (verified via grep). Tapped-transformer windings own branch rows (F6 covers them); they never allocate an internal node. F7 is wasted work. | Strike `F7` from the row. The remaining edits become `F1, F2, F3, F4, F6`. |
| M3 | minor | spec ssB.7 row `relay-dt.ts` | Spec text reads `F1, F7 (1 makeVolt site)`- but `relay-dt.ts` does not declare an `_isReactive`/`_isNonlinear` field; the F1 motivation (strip dead-flag fields) does not apply unless we are scrubbing a value transitively. Grep returned zero `isReactive`/`isNonlinear` matches in this file. F1 is unused work. | Drop `F1` from the row. The remaining edit becomes `F7 (1 makeVolt site for "coilMid")`. |
| M4 | minor | spec ssB.6 row `tunnel-diode.ts`, `varactor.ts`, `schottky.ts`, `diac.ts` | Spec assigns `F1, F4` (or `F1, F4, F5`) but these files contain neither `isReactive` nor `isNonlinear` (verified via grep- they were not in the matching set). F1 wastes agent effort on these specific files. | Verify per-file: if grep returns zero F1 matches, drop F1. Alternatively, retain F1 only for `tunnel-diode.ts` (which the F1 sweep will simply pass on). |

### Decision-Required Items

#### D1- Composite refactor list omits `behavioral-flipflop/d-async.ts`, `jk-async.ts`, `rs-async.ts` from A.15's subclass-required class enumeration (critical)

- **Location**: spec ssA.15 "Subclasses required to refactor (16 classes total)" plus rows in ssB.3 (`d-async.ts`, `jk-async.ts`, `rs-async.ts`)
- **Problem**: ssA.15's table lists `behavioral-flipflop/d-async.ts | 1 class`, `jk-async.ts | 1 class`, `rs-async.ts | 1 class`. ssB.3 assigns `F18` to those three files. But grepping the actual class declarations:
  - `BehavioralDAsyncFlipflopElement`- declared with **no** `implements ReactiveAnalogElementCore` clause (just `export class BehavioralDAsyncFlipflopElement {`)
  - `BehavioralJKAsyncFlipflopElement`- same
  - `BehavioralRSAsyncLatchElement`- same

  So today these classes do **not** implement the reactive interface. The A.15 mandate ("every composite class refactors to extend `CompositeElement`") would force them under the new abstract base- but the fact that the current code declines to declare reactivity may be intentional (these may be shallow "store the latest input" composites with no reactive children).
- **Why decision-required**: the file inspector cannot tell from the spec text whether the omission of `implements ReactiveAnalogElementCore` is a current-state defect (should be folded in) or by-design (these classes should not be reactive composites and should not gain `getLteTimestep` forwarding). Either interpretation is consistent with A.15 vocabulary.
- **Options**:
  - **Option A- Include them as composites**: Keep `F18` on all three; the new `extends CompositeElement` will pick up `getLteTimestep` forwarding through the base class. Additionally add a note: "verify `getSubElements()` returns whatever pin-model array these classes already track."
    - Pros: enforces uniform composite shape; eliminates the latent risk that async flipflop logic owns a reactive child no one is forwarding LTE through.
    - Cons: changes element semantics (these classes will start participating in LTE proposal even if currently they shouldn't).
  - **Option B- Exclude them from A.15**: Remove the three `*-async.ts` rows from A.15's subclass mandate table; drop `F18` from ssB.3 for these files (keep `F1`).
    - Pros: preserves current shape; avoids mass-introducing reactivity to async latches.
    - Cons: leaves the spec's "16 composite classes" claim incorrect; A.15 mandate becomes a 13-class mandate.
  - **Option C- Audit the children first**: Add a pre-step to A.15: "For each `*-async.ts` file, verify whether the class owns any `_childElements: AnalogCapacitorElement[]` or similar reactive-child array. Only refactor classes that do." Then rewrite the rows accordingly.
    - Pros: lets the actual code shape decide; surfaces a possible latent bug.
    - Cons: defers the decision into wave-time, against the spec's "no investigation" agent-discipline rule.

#### D2- `behavioral-remaining.ts` row missing `F10` despite ngspice-bridge-style cast survival (major)

- **Location**: spec ssB.3 row `behavioral-remaining.ts`
- **Problem**: Spec lists `F1, F2 (field only- preserve the function-local const allNodeIds), F4, F18 (6 classes)`. But the file (verified via grep) contains no `ReactiveAnalogElement` import/cast, while `behavioral-sequential.ts` and `behavioral-flipflop.ts` (which DO import `ReactiveAnalogElementCore`) explicitly receive `F10`. By contrast `behavioral-remaining.ts` declares `readonly isNonlinear = true` and a `get isReactive(): boolean` getter on three classes (`BehavioralMuxElement`, `BehavioralDemuxElement`, `BehavioralDecoderElement`). When F1 deletes those, the type inference of the class will collapse to `AnalogElement`-only- and currently the file does NOT cast through `ReactiveAnalogElement`. So F10 is correctly absent.

  However, the broader concern: after the F18 refactor extends `CompositeElement` (which is `PoolBackedAnalogElement`), 3 of the 6 classes lose the "reactive" getter that today is the only way the engine treats them as poolBacked. The spec is silent on whether these get `readonly poolBacked = true` (inherited via base class) but their `_childElements` are `AnalogCapacitorElement[]` and CompositeElement's `stateSize` getter sums child stateSize. So the practical effect is: today `isReactive` is dynamic (`children.length > 0`); after the refactor, all 6 classes become poolBacked unconditionally. That changes engine routing.
- **Why decision-required**: this is a behaviour change masquerading as a cleanup. Whether to allow it is a design call.
- **Options**:
  - **Option A- Accept the behaviour change**: Keep `F18` on all 6 classes; rely on `CompositeElement.stateSize` returning 0 when `_childElements.length === 0` so the engine treats them as poolBacked-but-empty.
    - Pros: uniform shape; fewer special cases.
    - Cons: classes that today return `{ poolBacked: false }` will register as poolBacked-with-zero-state- the engine's `_poolBackedElements` filter will admit them, which is a topology shift.
  - **Option B- Split the 6 classes**: Keep `F18` only on the 3 dynamic-reactive classes (mux/demux/decoder); leave `BehavioralFunctionElement`/`BehavioralSeven*`/`BehavioralButtonLED` as PoolBacked-static implementations under `PoolBackedAnalogElement` directly.
    - Pros: preserves engine routing.
    - Cons: A.15's "16 classes" mandate becomes 14; the spec needs amending; 4 distinct subclass shapes survive instead of 1.
  - **Option C- Add an `isPoolBacked` predicate gate to CompositeElement**: New abstract field `protected readonly subElementsHaveState: boolean` that drives the `poolBacked` flag dynamically.
    - Pros: preserves dynamism without splitting the class hierarchy.
    - Cons: adds complexity to the abstract base; not what A.15 currently specifies.

#### D3- `behavioral-flipflop/d-async.ts`, `jk-async.ts`, `rs-async.ts` rows under-list F-codes (critical)

- **Location**: spec ssB.3 rows for the three async-flipflop files
- **Problem**: Spec assigns only `F1, F18` to `d-async.ts`, `jk-async.ts`, `rs-async.ts`. But grep showed these classes already lack `implements ReactiveAnalogElementCore` (no F10 needed- correct). However, these three classes are missing what would be required for any class adopting CompositeElement: per A.15 the subclass must declare `readonly ngspiceLoadOrder` and `readonly stateSchema`. The B.3 row provides no F-code that pins down "must declare ngspiceLoadOrder"; F18 alone is the trigger but its parenthetical text doesn't enumerate the schema and load-order requirement for these specific files. Without it, an agent reading just one row may extend `CompositeElement` and forget to declare those abstract fields, producing a TS error.

  Also: unlike their non-async siblings (`jk.ts`, `rs.ts`, `t.ts` all get `F10`), the async variants don't get F10 because they don't currently import `ReactiveAnalogElementCore`. But after F18 they may need to import `CompositeElement` and `StateSchema`- neither F-code calls this out.
- **Why decision-required**: ambiguity over whether F18 implies the abstract-field declarations or whether a separate F-code is needed.
- **Options**:
  - **Option A- Strengthen F18's definition**: Edit the F18 row in the Edit-codes table at line 890 to read: "Refactor composite class to `extends CompositeElement` (A.15)- including declaring `readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.<DEVICE>` and `readonly stateSchema` per A.15."
    - Pros: ripples through every F18 file; one-line fix.
    - Cons: doesn't address the missing import requirements (StateSchema source).
  - **Option B- Add a new F-code F19**: "Declare `ngspiceLoadOrder` and `stateSchema` per A.15." Apply to all 16 composite classes.
    - Pros: makes the requirement explicit; greppable in the per-file checklist.
    - Cons: adds an F-code; the spec is intentionally tight on F-code count.
  - **Option C- Document per-class load-order assignments**: Inside A.15, add a table showing which `NGSPICE_LOAD_ORDER` enum each composite uses (most are VCVS or VSRC; behavioural-counter likely VSRC).
    - Pros: removes the design decision from the implementing agent.
    - Cons: longer A.15 section.

#### D4- `bridge-adapter.ts` F-codes don't list F1 despite live `isReactive` getter (critical)

- **Location**: spec ssB.1 row `bridge-adapter.ts`- currently `F2, F11, F18`
- **Problem**: grep confirmed `bridge-adapter.ts` contains live `isReactive` and `isNonlinear` declarations:
  ```
  58:  readonly isNonlinear: false = false;
  88:  get isReactive(): boolean { ... }
  180:  readonly isNonlinear: false = false;
  205:  get isReactive(): boolean { ... }
  ```
  Plus 4 instances of `internalNodeLabels` (lines 55, 80, 177, 197). The row lists `F2` (allNodeIds) and `F11` (internalNodeLabels) and `F18` (composite refactor) but **NOT F1 (strip dead flags)**. Without F1 the agent will leave the four flag declarations untouched, in direct contradiction of A.1 (forbidden names) and A.15 (composite subclass mandate, which inherits its `poolBacked` discriminator from the base class- there is no place in `CompositeElement` for a per-instance `isReactive` getter).
- **Why decision-required**: the omission could be intentional (perhaps F18's rewrite to extend `CompositeElement` is supposed to absorb the flag deletion implicitly), or it could be an oversight.
- **Options**:
  - **Option A- Add F1 explicitly**: Update the row to `F1, F2, F11, F18`.
    - Pros: aligns with A.1's universal "forbidden names" mandate; matches the pattern used in B.3 (every composite row lists F1).
    - Cons: adds an F-code but the agent would do this work anyway under F18.
  - **Option B- Define F18 to imply F1**: Add to the F18 description: "Refactor composite class to `extends CompositeElement` (A.15); strip any per-class `isReactive`/`isNonlinear` fields (subsumed by base-class `poolBacked` discriminator)."
    - Pros: one-row fix to the table; ripples globally.
    - Cons: still leaves rows like `B.7 trans-gate.ts` (F1 only, no F18) needing F1 explicitly.
  - **Option C- Leave it implicit**: argue that A.1's forbidden-name table makes deletion mandatory regardless of F-code annotation, and instruct agents to "always strip A.1 names whether or not F1 is listed."
    - Pros: zero spec edits.
    - Cons: relies on agents reading two sections to know what to do; the per-file F-code is supposed to be sufficient.

#### D5- `compiler.ts` F-codes don't list F1 despite live `isReactive`/`isNonlinear` reads and writes (critical)

- **Location**: spec ssB.1 row `compiler.ts`- currently described as "Apply A.21 in full"
- **Problem**: grep confirms `compiler.ts` contains live reads and writes of these flags at lines 313–327 (writing `isNonlinear`/`isReactive` onto a composite returned from `compileSubcircuitToMnaModel`) and line 1250 (`element.isReactive` predicate). A.21 covers (1) parallel-array writes, (2) the type discriminator rewrite, (3) the composite shape- but nowhere in A.21 is the **deletion of the `isNonlinear`/`isReactive` writes at lines 313/326** mentioned. The agent reading only B.1 + A.21 will rewrite the discriminator (item 2 of A.21) but may leave the literal writes of `isNonlinear: anyNonlinear, isReactive: anyReactive` on the synthesized composite literal- directly violating A.1.
- **Why decision-required**: A.21 step 3 says "rewrite to anonymous class extending `CompositeElement`" which transitively forbids those writes (a CompositeElement subclass can't have `isReactive`). But the F-code cell lacks an F1 annotation that would make it greppable in the per-file checklist (C.1).
- **Options**:
  - **Option A- Annotate the row with explicit F-codes**: Replace the row's edit text with `F1, F14, F15 (apply A.21 in full)` so the C.1 grep is exercised.
    - Pros: aligns with the C.4 per-file output format (which expects F-codes to enumerate).
    - Cons: makes the row text longer.
  - **Option B- Strengthen A.21 wording**: Add a numbered item 4 to A.21: "Strip every `isReactive`/`isNonlinear` literal write on the composite builder, including lines that today read `subElements.some(e => e.isNonlinear)`."
    - Pros: keeps the F-code list short.
    - Cons: hides the work in prose, against the row-grep model.
  - **Option C- Both**: list F1, F14, F15 AND amend A.21 prose.
    - Pros: belt-and-braces.
    - Cons: more edits.

#### D6- `controlled-source-base.ts` row missing F6 despite owning branch rows (major)

- **Location**: spec ssB.1 row `controlled-source-base.ts`
- **Problem**: A.6 says "Sources / passives that own branch rows … VCVS, CCVS …" These are implemented via `controlled-source-base.ts`. The B.1 row lists `F1, F2, F12` but not `F6`. Yet `vcvs.ts` (B.8) and `ccvs.ts` (B.8) DO list F6, and `vcvs.ts` already has `findBranchFor(name: string, ctx: SetupContext): number {` (line 362) inline in its factory return literal. So either F6 belongs on `controlled-source-base.ts` (if the base class hosts the method) or only on the per-source files (if each source owns its own copy).

  Grep shows that `controlled-source-base.ts` does NOT currently contain `findBranchFor`, but `cccs.ts` already references `// ctx.findBranch dispatches to the controlling source's findBranchFor` at line 148. The pattern is split across files.
- **Why decision-required**: the architectural choice- host `findBranchFor` on the per-source factory (as the canonical pattern A.13 shows) or on the controlled-source base class- is a design call the spec doesn't make explicit.
- **Options**:
  - **Option A- Per-source hosting (matches A.6/A.13)**: Leave `controlled-source-base.ts` without F6. Verify each per-source file (`vcvs.ts`, `ccvs.ts`) lists F6. Verify `cccs.ts`, `vccs.ts` do NOT list F6 (they don't own branch rows; they read them).
    - Pros: matches A.13's canonical inline-factory pattern.
    - Cons: leaves the base class unable to provide a default; each source duplicates the idempotent makeCur block.
  - **Option B- Base-class hosting**: Add F6 to `controlled-source-base.ts`; remove F6 from `vcvs.ts`/`ccvs.ts`.
    - Pros: DRY; one implementation.
    - Cons: contradicts A.6 ("on the element factory's returned literal").
  - **Option C- Split by source type**: Document in A.6 that VCVS/CCVS host on the base class while VSRC/IND/CRYSTAL host on the factory.
    - Pros: matches the file-level architecture.
    - Cons: extra rules.

#### D7- `compiler.ts` is in ssB.1 but A.15's mandate also names it- F18 not listed (major)

- **Location**: spec ssB.1 row `compiler.ts`; ssA.15 "Subclasses required to refactor (16 classes total)" includes `compiler.ts` ("the inline composite literal in `compileSubcircuitToMnaModel` becomes an anonymous class extending `CompositeElement`")
- **Problem**: A.15 explicitly states `compiler.ts`'s inline composite becomes a `CompositeElement` subclass. C.2's R6 confirms: "`extends CompositeElement` on every composite class listed in A.15's subclass mandate. The 16 composite-class files in B.3 plus `bridge-adapter.ts` plus `compiler.ts` (anonymous class)." But the ssB.1 row for `compiler.ts` does not list `F18`. F18 is the only F-code that ties to A.15. A C.2 R6 grep on `compiler.ts` will fail because the agent didn't apply F18.

  Note: A.21 step 3 implicitly covers this ("anonymous class extending `CompositeElement`"). But the per-file F-code listing should make this greppable.
- **Why decision-required**: same shape as D5- the work is described in A.21 prose but not F-code-tagged.
- **Options**:
  - **Option A- Add F18 to the compiler row**: Replace the row's edit text with `F1, F14, F15, F18 (apply A.21 in full)`.
    - Pros: aligns with C.2 R6.
    - Cons: longer row.
  - **Option B- Annotate F18 with a "compiler.ts also" note**: Add to F18's description in the table at line 890: "F18 also applies to the inline composite in `compiler.ts::compileSubcircuitToMnaModel` per A.21."
    - Pros: minimal row edits.
    - Cons: hidden side channel.

#### D8- `harness/capture.ts` row doesn't enumerate the seven concrete grep-targets visible in current code (major)

- **Location**: spec ssB.11 row `capture.ts`
- **Problem**: grep on `capture.ts` shows seven concrete sites that need attention:
  - Line 101: `el.pinNodeIds.length` (iteration)
  - Line 102: `el.pinNodeIds[p]` (subscript)
  - Line 115: `el.pinNodeIds.length` (count)
  - Line 118: `el.allNodeIds[pinCount + p]` (internal-node access- A.23 step 2)
  - Line 116: `el.internalNodeLabels ?? []` (F11 target)
  - Line 172–174: `isNonlinear: el.isNonlinear, isReactive: el.isReactive, pinNodeIds: el.pinNodeIds` in snapshot
  - Line 203: `el.stateBaseOffset` (rename to `_stateBase`)

  The spec lists `F11, F1, F3` plus "the internal-node ID derivation rewrite". F1, F3, F11 cover all but the line 203 `stateBaseOffset` rename- which is **F9**. F9 is missing from the row.
- **Why decision-required**: F9 is mechanically clear, but it raises a downstream question: does the harness blob's snapshot record the `stateBaseOffset` field name, which external consumers (test fixtures, recorded ngspice-bridge expected outputs) may depend on? Renaming may break external test data. (Possibly out-of-scope; possibly a finding.)
- **Options**:
  - **Option A- Add F9 to the row**: Update to `F11, F1, F3, F9` plus the prose.
    - Pros: complete F-code listing.
    - Cons: if the snapshot's downstream serialised form must keep `stateBaseOffset`, this would break harness consumers.
  - **Option B- Keep field name, rename only internal usage**: Add a note that the snapshot's serialised key remains `stateBaseOffset` even though the runtime field is `_stateBase`.
    - Pros: preserves wire format.
    - Cons: violates "scorched earth" rule from `rules.md`.
  - **Option C- Document this as out-of-band**: Treat `stateBaseOffset` survival in `capture.ts` as an A.20 out-of-scope item (harness wire format) and explicitly exempt it.
    - Pros: defers to a separate spec.
    - Cons: contradicts A.1's universal ban and needs ssA.20 amended.

#### D9- `transmission-line.ts` F-code count for F15 is "3 in-file `el.isReactive` predicates" but file actually has 9 isReactive references (major)

- **Location**: spec ssB.5 row `transmission-line.ts`- `F15 (3 in-file el.isReactive predicates)`
- **Problem**: grep on `transmission-line.ts` for `\bisReactive\b` returned 9 matches. Decomposing:
  - Line 240: `readonly isReactive = false;` (segment-resistor child)- F1 target
  - Line 300: `readonly isReactive = false;`- F1 target
  - Line 360: `readonly isReactive = true as const;`- F1 target
  - Line 501: `readonly isReactive = true as const;`- F1 target
  - Line 619: `readonly isReactive = true as const;`- F1 target
  - Line 764: `readonly isReactive = true;`- F1 target
  - Line 883: `if (el.isReactive) {`- F15 target
  - Line 914: `if (el.isReactive) {`- F15 target
  - Line 938: `if (!el.isReactive) continue;`- F15 target

  So F15 is correctly "3 sites"- that part matches. But F1 must also handle 6 field declarations on the segment sub-classes. The row already lists F1 so this is correctly covered.

  However the parenthetical "(3 in-file `el.isReactive` predicates)" is correct. No mismatch on F15. The real concern: the row says `F1, F2, F3, F4, F7 (2 makeVolt sites in a loop), F10, F15 (3 in-file el.isReactive predicates)`- the F7 parenthetical "2 makeVolt sites in a loop" matches grep (lines 831, 834 inside a loop). All counts check out.

  Verified F-code coverage aligns. Moving from "issue" to "info"- see D9.alt below.
- **Why decision-required**: the spec is correct here. False alarm- but worth recording the count-verification process.
- **Options**: N/A- the row checks out; this finding is downgraded to info I3 below.

#### D10- `behavioral-flipflop.ts` row missing F18 listing for the second class? (minor)

- **Location**: spec ssB.3 row `behavioral-flipflop.ts`
- **Problem**: ssA.15 lists `behavioral-flipflop.ts | BehavioralDFlipflopElement`- one class. Grep confirms there is exactly one class (`BehavioralDFlipflopElement`) in this file. The B.3 row says "F1, F2, F4, F5, F10, F18"- no parenthetical (1 class). All other multi-class rows in B.3 carry the parenthetical (e.g. "(3 classes)", "(6 classes)"). Without the count, an agent reading just this row may think there are multiple classes.
- **Why decision-required**: the inconsistency is a documentation nit; the actual edits are unambiguous.
- **Options**:
  - **Option A- Add "(1 class)" to the row**: Update to `F1, F2, F4, F5, F10, F18 (1 class)`.
    - Pros: stylistic consistency with sibling rows.
    - Cons: trivial.
  - **Option B- Strip class counts from all single-class rows**: Inverse- make the convention "only annotate when count > 1".
    - Pros: conciseness.
    - Cons: rewrites 14 rows.

---

### Info-level Observations

| ID | Severity | Location | Observation |
|----|----------|----------|-------------|
| I1 | info | spec ssB.6 row `triode.ts` | Spec lists `F1, F4, F5, F12 (class)`. The "(class)" parenthetical is on F12 (correct), but F12's table definition already says "Class adopts unified shape"- the parenthetical is redundant. Stylistic only. |
| I2 | info | spec ssB.4 row `dc-voltage-source.ts` "this is the canonical reference for the inline-factory pattern (A.13)" | Verified: dc-voltage-source.ts already uses `_pinNodes: new Map<string, number>(pinNodes)` and inline `findBranchFor`. The file appears to already be partially compliant. Worth confirming whether F1, F4, F5, F6, F8 still apply (they do- `isReactive`/`isNonlinear` matches showed up in the file via grep). The wording "this is the canonical reference" should clarify whether "canonical" means "what the file looks like AFTER the wave" (target) or "what other agents should mimic" (template). |
| I3 | info | F-code count parentheticals (e.g. F7 (3 makeVolt sites)) | Spec uses parenthetical counts for F7 across many rows; confirmed accurate via grep on `bjt.ts` (3 sites), `mosfet.ts` (2 sites- drain/source primes per spec; note line 767 is a comment, not a call), `timer-555.ts` (4 sites: nLower, nComp1Out, nComp2Out, nDisBase- exactly matches spec), `optocoupler.ts` (2 in-class calls at 326/327- spec says 2, matches; lines 18–19 are comment), `crystal.ts` (2- n1, n2; matches), `inductor.ts` (0- does NOT match F7 spec, see M1), `tapped-transformer.ts` (0- does NOT match F7 spec, see M2). Most counts are accurate; only the two flagged in M1/M2 are wrong. |

---

## Spot-check evidence summary

| File | Spec F-codes | Verified evidence | Match? |
|---|---|---|---|
| `compiler.ts` (B.1, high) | "A.21 in full"- implies F1, F14, F15, F18 (anon class) | grep: 4 isReactive, 1 isNonlinear, 2 anyNonlinear/anyReactive writes, predicate at line 1250, parallel-array writes at 1215/1216/1247, `pinNodeIds` field-form survival on plain data records (line 1097, 1101, 1102, 1134, 1137, 1239- local var) | partial- F1 not listed, F18 not listed (D5, D7) |
| `bridge-adapter.ts` (B.1, high) | F2, F11, F18 | grep: 4 isReactive/isNonlinear declarations + 4 internalNodeLabels declarations | partial- F1 missing (D4) |
| `behavioral-remaining.ts` (B.3, high, 6 classes) | F1, F2 (field only), F4, F18 (6 classes) | grep: 6 classes confirmed; 3 use `get isReactive`, 3 use `readonly isReactive = false`; no `ReactiveAnalogElement` cast | F10 absent- correct; behaviour change concern in D2 |
| `transmission-line.ts` (B.5, high) | F1, F2, F3, F4, F7 (2 makeVolt), F10, F15 (3) | grep: 9 isReactive matches (6 field, 3 predicate), 2 makeVolt sites at 831/834 in loop, ReactiveAnalogElementCore imported and used 3× as cast | matches |
| `crystal.ts` (B.5, high) | F1, F2, F3, F4, F5, F6, F7 (2 makeVolt), F10, F12 | grep: 2 makeVolt sites (n1, n2), `findBranchFor` line 250 + 494, `ReactiveAnalogElement` cast confirmed | matches |
| `bjt.ts` (B.6, high) | F1, F4, F5, F7 (3 makeVolt) | grep: 3 makeVolt sites (col, base, emit primes) | matches |
| `mosfet.ts` (B.6, high) | F1, F4, F5, F7 (2 makeVolt) | grep: 2 makeVolt sites (drain, source primes- RD/RS gated) | matches |
| `timer-555.ts` (B.8, high) | F1 (2 classes), F4, F7 (4 makeVolt) | grep: 4 makeVolt sites (nLower, nComp1Out, nComp2Out, nDisBase) | matches |
| `ota.ts` (B.8, high) | F1, F4, F8 | grep: 0 makeVolt sites, 4 `_h*` handles on returned object literal at lines 182–185, isReactive: false at 176, isNonlinear: true at 175 | F4- verify factory signature; F8 confirmed needed; matches |
| `harness/capture.ts` (B.11, high) | F11, F1, F3 + A.23 prose | grep: 7 distinct sites incl. `el.stateBaseOffset` at line 203 (F9 target) | F9 missing (D8) |
| `led.ts` (B.9, audit only) | "Verified clean of dead flags" | grep: 0 isReactive/isNonlinear/pinNodeIds/allNodeIds/withNodeIds | matches- verified clean |
| `dc-voltage-source.ts` (B.4, canonical) | F1, F4, F5, F6, F8 | grep: file already uses `_pinNodes: new Map<string, number>(pinNodes)`, has inline `findBranchFor` at line 257- already mostly compliant | matches; canonical-status confirmed |
| `inductor.ts` (B.5) | F1, F4, F6, F7 | grep: 0 makeVolt sites- F7 inappropriate (M1) | mismatch- F7 wrong |
| `tapped-transformer.ts` (B.5) | F1, F2, F3, F4, F6, F7 | grep: 0 makeVolt sites- F7 inappropriate (M2) | mismatch- F7 wrong |
| `relay-dt.ts` (B.7) | F1, F7 (1 makeVolt) | grep: 1 makeVolt site (line 120, coilMid); 0 isReactive/isNonlinear matches | F1 inappropriate (M3) |

---

Full report written to: spec/reviews/spec-setup-load-cleanup-fcodes.md
