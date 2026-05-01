# Spec Review: setup-load-cleanup.md- ngspice Source Verification

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 4 | 4 |
| minor    | 0 | 4 | 4 |
| info     | 0 | 2 | 2 |

## Plan Coverage
This is a single-document, single-wave execution plan with no separate `spec/plan.md`. Plan-coverage is not applicable. The spec self-asserts (Section A.20) what is in/out of scope and (Section D) the execution model. The review here focuses on Section-A ngspice-equivalence claims as instructed.

| Focus Item | Verified? | Notes |
|-----------|----------|-------|
| A.10 NGSPICE_LOAD_ORDER constants | yes (all 17 match) | See M-table → no findings |
| A.11 `label: ""` init grounded by compiler.ts Object.assign | yes | compiler.ts:1214 confirms `Object.assign(core, { ..., label })` |
| A.12 `_findBranch` semantics | divergent | See D1 |
| A.13 VSRC TSTALLOC pairs / load stamps | mostly yes | See D2 (srcFact unconditional) |
| A.13 BJT model.RC === 0 gate | divergent (naming + scope) | See D3 |
| A.16 `SetupContext` fields | mostly yes | See D1 (findBranch/findDevice composition) |
| A.17 `LoadContext` field naming `iabstol` | divergent | See D4 |
| A.5/A.6 findBranchFor idempotency / `-1` sentinel | divergent (sentinel value) | See D5 |
| A.21 typeof getLteTimestep discriminator | digiTS-internal- info | See I1 |
| A.2 no Core split | digiTS-internal- info | See I2 |

## ngspice Source Files Consulted

| ngspice file | Function/struct used to verify |
|---|---|
| `ref/ngspice/src/spicelib/devices/dev.c` (lines 140-212) | `static_devices[]` array- bucket-order verification for A.10 |
| `ref/ngspice/src/include/ngspice/cktdefs.h` (lines 61-292) | `CKTcircuit` struct fields- A.16, A.17 verification |
| `ref/ngspice/src/include/ngspice/devdefs.h` (line 66) | `DEVfindBranch` hook signature |
| `ref/ngspice/src/spicelib/devices/vsrc/vsrcset.c` | `VSRCsetup`- A.13 TSTALLOC pairs, idempotent branch alloc |
| `ref/ngspice/src/spicelib/devices/vsrc/vsrcload.c` (lines 43-46, 410-416) | `VSRCload`- A.13 stamp signs, srcFact application |
| `ref/ngspice/src/spicelib/devices/vsrc/vsrcfbr.c` | `VSRCfindBr`- per-device findBranch hook structure |
| `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c` (lines 372-428) | `BJTsetup`- A.7/A.13 collector/base/emitter prime allocation |
| `ref/ngspice/src/spicelib/devices/ind/indsetup.c` (lines 84-88) | `INDsetup`- A.5 idempotent branch alloc |
| `ref/ngspice/src/spicelib/devices/vcvs/vcvsset.c` (lines 41-45) | `VCVSsetup`- A.5/A.6 idempotent branch alloc |
| `ref/ngspice/src/spicelib/devices/ccvs/ccvsset.c` (lines 40-50) | `CCVSsetup`- controlling-source lookup via `CKTfndBranch` |
| `ref/ngspice/src/spicelib/analysis/cktfbran.c` | `CKTfndBranch`- A.12 driver iterating ALL devices |

## Findings

### Mechanical Fixes
None found. (Every divergence between the spec and ngspice involves an architectural choice that a reasonable reviewer could resolve more than one way; none is a single unambiguous edit.)

### Decision-Required Items

#### D1- `_findBranch` / `SetupContext.findBranch` semantics do not match ngspice composition (major)

- **Location**: ssA.6 paragraph "The engine's `_findBranch` resolves `el = findDevice(label)` via the context, then dispatches via `(el as any).findBranchFor?.(name, ctx) ?? 0`." and ssA.16 `findBranch(sourceLabel)` / `findDevice(deviceLabel)` JSDoc.
- **Problem**: The spec asserts that branch lookup is composed as: (1) caller resolves `el = ctx.findDevice(label)`, then (2) calls `el.findBranchFor(name, ctx)`. ngspice does **not** compose the operations this way. In ngspice (`cktfbran.c`), `CKTfndBranch(ckt, name)` is a top-level driver that **iterates every device type's `DEVfindBranch` hook in `static_devices[]` order**, passing the requested `name`; each per-type hook (`VSRCfindBr`, etc., e.g. `vsrcfbr.c` lines 22-37) walks its own instance list looking for a name match, and lazy-allocates the branch row only when found. There is no separate "find the device, then call its hook" step- the hook IS the per-device name-match-and-allocate pathway. The spec's `findDevice(deviceLabel)` API field has no direct counterpart in ngspice's branch-lookup path, and `findBranchFor` is shaped as "operate on already-resolved `el`" rather than ngspice's "given a name, walk my own instances".
- **ngspice source**: `ref/ngspice/src/spicelib/analysis/cktfbran.c` (full file), `ref/ngspice/src/spicelib/devices/vsrc/vsrcfbr.c` (full file).
- **Why decision-required**: Two reasonable resolutions exist- either (a) align digiTS to ngspice's "iterate all devices' hooks" pattern, or (b) keep digiTS's `findDevice(label)` two-step composition and stop characterizing it as ngspice-equivalent in ssA.16's JSDoc. Both keep working code; the choice changes the semantic claim, the JSDoc, and possibly the engine's branch-lookup algorithm.
- **Options**:
  - **Option A- Align to ngspice**: Replace the `findDevice` + `el.findBranchFor` composition with a single `findBranch(name)` driver that walks all elements that own branches and asks each `el.findBranchFor(name, ctx)` to do its own name-match-and-allocate. Drop `findDevice(deviceLabel)` from `SetupContext`. Hook bodies on each element take ownership of the name comparison.
    - Pros: Bit-exact with ngspice's `CKTfndBranch`/`VSRCfindBr` pattern; no re-characterization needed in ssA.16; hook semantics are uniform.
    - Cons: Requires an architectural change that may affect callers of `findDevice` for non-branch purposes; hook body becomes longer (must do its own name match).
  - **Option B- Keep two-step composition; remove ngspice-equivalence claim**: Leave ssA.6 / ssA.16 as-is structurally, but rewrite the ssA.16 `findBranch` JSDoc to say "lazy branch-row lookup; **digiTS-specific composition of `findDevice(label)` then `el.findBranchFor(name, ctx)`**- does not mirror ngspice's `CKTfndBranch`+`DEVfindBranch` pattern." File a follow-up entry in `spec/architectural-alignment.md` (user action) recording the deliberate divergence per the CLAUDE.md "ngspice Parity Vocabulary" rule.
    - Pros: No code churn; preserves digiTS's `findDevice` API which has other callers (peer-element direct access for controlled sources).
    - Cons: The spec stops being able to claim ssA.16 is "the exact shape every `setup()` body uses" when the ssA.6 paragraph still uses `findDevice` + `findBranchFor` as the composition; readers must remember this is digiTS-specific.

#### D2- `srcFact` application in canonical VSRC pattern is unconditional in spec, conditional in ngspice (major)

- **Location**: ssA.13 canonical inline-factory pattern, the line `ctx.rhs[el.branchIndex] += p.voltage * ctx.srcFact;`
- **Problem**: The spec's canonical DC-voltage-source `load()` body shows `+= p.voltage * ctx.srcFact` applied unconditionally. ngspice's `VSRCload` (`vsrcload.c`) applies `CKTsrcFact` in **two different gated paths**: (1) inside the `(MODEDCOP | MODEDCTRANCURVE)` branch, the DC value is multiplied by `CKTsrcFact` directly (line 54: `value = here->VSRCdcValue * ckt->CKTsrcFact;`); (2) for transient-OP only, after the function-table branch, line 410-412: `if (ckt->CKTmode & MODETRANOP) value *= ckt->CKTsrcFact;`. There is **no path** in ngspice where `srcFact` is applied unconditionally to all transient timepoints- once the OP completes and the simulation enters MODETRAN proper, `srcFact` is no longer multiplied in.
- **ngspice source**: `ref/ngspice/src/spicelib/devices/vsrc/vsrcload.c` lines 47-55 (DC branch), 405-413 (post-function-table branch).
- **Why decision-required**: Either the canonical-pattern code is wrong (and every implementer following A.13 will produce a VSRC stamp that incorrectly applies `srcFact` during transient post-OP), or the spec is intentionally diverging from ngspice and the JSDoc/comment must say so. Both have implementation impact, and it's not obvious from the spec which one was intended. The CLAUDE.md "ngspice Parity Vocabulary- Banned Closing Verdicts" rule requires that this be either fixed numerically or filed as a deliberate divergence in `architectural-alignment.md`.
- **Options**:
  - **Option A- Make canonical pattern conditional**: Edit ssA.13 `load()` body to gate the `srcFact` multiplication on a `cktMode` check matching ngspice's `MODEDCOP | MODEDCTRANCURVE | MODETRANOP` paths, e.g.: `const v = (ctx.cktMode & MODE_DCOP_OR_DCTRAN) ? p.voltage * ctx.srcFact : p.voltage; ctx.rhs[el.branchIndex] += v;`- and add MODE-bit constants to whatever existing `cktMode` bitfield definition the project uses.
    - Pros: Bit-exact with ngspice; the canonical pattern is correct; downstream factories don't propagate the divergence.
    - Cons: Requires existing voltage-source loads to change behaviour during transient; may surface latent regressions if any test depended on the unconditional form.
  - **Option B- Document deliberate digiTS divergence**: Keep the unconditional form, add a ssA.13 note: "**digiTS divergence**- `srcFact` is applied unconditionally on every load() call. ngspice gates it on `MODEDCOP | MODEDCTRANCURVE | MODETRANOP`. Filed in `spec/architectural-alignment.md` as a deliberate ramp-source-during-transient choice." Coordinator files the alignment entry (user action per the CLAUDE.md rule).
    - Pros: Preserves current digiTS source-stepping ramp behaviour during transient.
    - Cons: Numerically diverges from ngspice for transient simulations; users seeking ngspice-bit-exactness will hit this.
  - **Option C- Set `ctx.srcFact = 1.0` outside the gated paths**: Move the conditional gating up to the engine's coordinator so that `ctx.srcFact` is always `1.0` outside `MODEDCOP|MODEDCTRANCURVE|MODETRANOP`, making the unconditional canonical pattern correct.
    - Pros: Canonical pattern stays simple; bit-exact during transient.
    - Cons: Couples the load-context shape to the engine's mode logic; may complicate harness comparison runs that need direct control of `srcFact`.

#### D3- BJT example uses `model.RC` instead of ngspice `BJTcollectorResist`; only collector path shown (minor)

- **Location**: ssA.13 BJT canonical pattern, the line `if (model.RC === 0) { nodeC_int = colNode; } else { nodeC_int = ctx.makeVolt(...); }`, and the comment `// ... similarly for base, emitter ...`
- **Problem**: The spec's example uses a digiTS-style abbreviated field name `model.RC`. ngspice's actual gate field (per `bjtsetup.c` lines 372, 391, 410) is `model->BJTcollectorResist` for the collector internal-node, `model->BJTbaseResist` for the base internal-node, `model->BJTemitterResist` for the emitter internal-node. Three independent gates, three independent allocations. The "...similarly for base, emitter ..." compresses this to a comment- agents who haven't read ngspice may assume one combined gate or invent their own naming. Additionally, the spec's `internalLabels.push("collector")` is fine as a digiTS diagnostic suffix, but ngspice's `CKTmkVolt(ckt, &tmp, here->BJTname, "collector")` passes "collector" as the suffix to the *node name builder*, not as a label-list entry; the analogy is close but not identical.
- **ngspice source**: `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c` lines 372-428 (three independent if/else blocks gating on three distinct model-resist fields, each calling `CKTmkVolt` with a different suffix string).
- **Why decision-required**: Two questions tangled into one: (1) should the spec's example use ngspice's actual field name (`BJTcollectorResist`) or a digiTS-internal abbreviation (`RC`)? (2) Should the example show all three gates explicitly, or is the comment "...similarly..." adequate? These are independent choices and either combination is defensible.
- **Options**:
  - **Option A- Use ngspice's actual field names; show all three gates**: Replace `model.RC` with `model.BJTcollectorResist` (or whatever the digiTS field is named, plus a JSDoc cross-reference), and expand the example to show all three internal-node allocations explicitly: `if (model.BJTcollectorResist === 0) { nodeC_int = colNode; } else { ... }; if (model.BJTbaseResist === 0) { ... }; if (model.BJTemitterResist === 0) { ... }`.
    - Pros: One-to-one with ngspice; agents have nothing to invent; the analogy to `bjtsetup.c` is line-for-line.
    - Cons: Larger code block in the spec; if digiTS uses different field names internally, the example will need a cross-reference.
  - **Option B- Keep `RC` shorthand; expand example to show all three; add a comment listing actual ngspice field names**: Leave the abbreviation but add a comment block: `// model.RC → BJTcollectorResist, model.RB → BJTbaseResist, model.RE → BJTemitterResist (per ngspice bjtsetup.c)`. Show all three gates explicitly.
    - Pros: Compact; preserves digiTS's naming; explicit ngspice cite for agents.
    - Cons: Two naming conventions in one file; agents must mentally translate.
  - **Option C- Replace example with a JSDoc reference to bjtsetup.c**: Drop the BJT example body entirely and write: "BJT mirrors `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c` lines 372-428: three independent gates on `BJTcollectorResist`, `BJTbaseResist`, `BJTemitterResist`, each lazy-allocating an internal node when the resist is non-zero. See `src/components/semiconductors/bjt.ts` for digiTS naming."
    - Pros: Forces agents to consult ngspice directly; no ambiguity.
    - Cons: Less self-contained; agents implementing without ngspice access (or in a hurry) lose the inline reference.

#### D4- `LoadContext.iabstol` is not an ngspice field name (major)

- **Location**: ssA.17 `LoadContext` interface field `readonly iabstol: number;`
- **Problem**: The spec lists `iabstol` alongside `reltol`, `voltTol`, `diagonalGmin` etc., in a context where surrounding fields (`rhs` ↔ `CKTrhs`, `srcFact` ↔ `CKTsrcFact`, `diagonalGmin` ↔ `CKTdiagGmin`) all match ngspice spelling. ngspice's actual field for absolute-tolerance is `CKTabstol` (cktdefs.h line 199: `double CKTabstol;`). There is no `CKTiabstol`. Searching the ngspice include tree for `iabstol` returns no struct field- the closest match is `CKTlteAbstol` (under `#ifdef NEWTRUNC`). The `i` prefix may have been added in digiTS to disambiguate from a different `abstol` (e.g. BSIM model `abstol`) or to convey "current" (since the BJT/diode convergence test uses an abs-tol on currents), but this is not communicated in the spec, and the field is presented in a list whose other entries are bit-for-bit ngspice names.
- **ngspice source**: `ref/ngspice/src/include/ngspice/cktdefs.h` line 199 (`double CKTabstol;`); zero matches for `CKTiabstol` in the entire ngspice tree.
- **Why decision-required**: Either `iabstol` is a typo for `abstol` (and should be renamed), or it's a digiTS-deliberate name (and the JSDoc/listing must say so per the CLAUDE.md "ngspice Parity Vocabulary" rule). The fix differs and changes downstream code referencing the field.
- **Options**:
  - **Option A- Rename to `abstol`**: Edit ssA.17 `iabstol` → `abstol`, matching `CKTabstol`. Update `LoadContext` and every consumer (load() bodies that read this field) to use the new name.
    - Pros: Bit-exact spelling; the field now matches the rest of the ngspice-mirroring list.
    - Cons: Requires touching `load-context.ts` and every consumer; if the existing code already uses `iabstol` widely, the diff is large.
  - **Option B- Keep `iabstol`; document divergence**: Add a ssA.17 JSDoc note: "**digiTS-specific name**: `iabstol` corresponds to ngspice `CKTabstol`. The `i` prefix disambiguates from <whatever-it-disambiguates>. Filed in `spec/architectural-alignment.md`."
    - Pros: No code churn.
    - Cons: One field in a list of otherwise-ngspice-named fields uses a different naming convention; JSDoc burden grows; CLAUDE.md "Parity Vocabulary" requires the alignment-list entry as a user action.
  - **Option C- Rename to a clearly-digiTS name, e.g. `currentAbsTol`**: If the field is genuinely about a current-tolerance (not a node-voltage tolerance), make that explicit: `readonly currentAbsTol: number; // ngspice CKTabstol when used for current-quantity convergence checks`.
    - Pros: Self-documenting; no confusion with ngspice naming.
    - Cons: Larger touch-list than option A; semantic interpretation of `CKTabstol` as a current-only field is debatable (ngspice uses it broadly).

#### D5- `branchIndex === -1` sentinel does not match ngspice's `branch == 0` sentinel (minor)

- **Location**: ssA.5 ("Branch-row allocation is **idempotent**: `setup()` opens with `if (el.branchIndex === -1) { el.branchIndex = ctx.makeCur(...); }`"), ssA.6 (same form in `findBranchFor`), ssA.13 canonical pattern (`branchIndex: -1` initializer, `if (el.branchIndex === -1) ...`).
- **Problem**: ngspice's idempotent branch-allocation uses `0` as the "not-yet-allocated" sentinel: `if (here->VSRCbranch == 0) { ... here->VSRCbranch = tmp->number; }` (vsrcset.c:40-44, vcvsset.c:41-45, indsetup.c:84-88, ccvsset.c:40-44, vsrcfbr.c:27-31). The spec uses `-1`. ngspice can do this because branch indices live in the same positive node-numbering space as actual nodes (0 is reserved for ground / "not allocated"); digiTS uses signed Float64Array indices where 0 is a valid row, so `-1` is the sentinel. The spec is **internally consistent** and **correct for digiTS**, but it is **not** "the same idempotency pattern as ngspice"- ngspice's pattern is `== 0`, digiTS's is `=== -1`.
- **ngspice source**: `ref/ngspice/src/spicelib/devices/vsrc/vsrcset.c:40-44`, `vcvs/vcvsset.c:41-45`, `ind/indsetup.c:84-88`, `ccvs/ccvsset.c:40-44`, `vsrc/vsrcfbr.c:27-31`.
- **Why decision-required**: The spec implicitly characterizes the pattern as ngspice-equivalent ("idempotent" with no sentinel-value caveat). A reader expecting bit-exact ngspice semantics could mis-implement a downstream check (e.g., harness code comparing digiTS `branchIndex == 0` and assuming "not allocated"- getting the wrong answer). The fix is either a JSDoc clarification or, if digiTS were to switch to `0`, a larger architectural change.
- **Options**:
  - **Option A- Add a JSDoc note documenting the sentinel difference**: In ssA.5 (or ssA.13), add: "Sentinel value: digiTS uses `-1` for 'not-yet-allocated'; ngspice uses `0` (because ngspice node-number 0 is ground/unallocated). The idempotency *pattern* matches ngspice; only the sentinel value differs."
    - Pros: No code change; clarifies the divergence for harness/comparison code authors.
    - Cons: One more JSDoc note for agents to read; doesn't change behaviour.
  - **Option B- Switch sentinel to `0` and reserve row 0 as "no branch"**: Edit every factory and class to use `branchIndex: 0` (initializer) and `if (el.branchIndex === 0)` (gate). Reserve solver row 0 as the "no branch" sentinel and rebase all real branch indices to start at 1.
    - Pros: Bit-exact with ngspice; harness comparison code can use the same compare without translation.
    - Cons: Requires solver row-numbering rebase; large blast radius (every load() body, every harness comparator); high risk of off-by-one bugs.
  - **Option C- File as a deliberate divergence in `architectural-alignment.md`**: Per CLAUDE.md "ngspice Parity Vocabulary", if this is intentional, it belongs in the alignment list. Coordinator files the entry (user action).
    - Pros: Records the intentional divergence; agents reading the alignment list see it.
    - Cons: Requires user action to file.

### Info Findings

#### I1- `typeof getLteTimestep === "function"` is digiTS-internal; spec correctly does not claim ngspice-equivalence

- **Location**: ssA.9 / ssA.21 / ssA.12- the discriminator `typeof element.getLteTimestep === "function" ? "inductor" : "voltage"`.
- **Observation**: The spec uses method-presence as the reactivity discriminator- this is a TypeScript/digiTS pattern, not an ngspice pattern (ngspice uses per-device `DEVtrunc` hook presence at the *device-type* level, not per-instance method check). The spec does not characterize this as ngspice-equivalent, so there's no parity claim to verify. **No action needed**, but flagging for completeness so a future reader doesn't assume this pattern was lifted from ngspice.
- **Why info**: The spec is internally self-consistent and correctly silent on ngspice-equivalence here. No spec change needed unless the user wants an explicit "**digiTS-internal pattern**" callout in ssA.21.

#### I2- A.2 "no Core / non-Core split, no post-compile type promotion" is digiTS-internal

- **Location**: ssA.2 paragraph "There is no `Core` / non-`Core` split, no post-compile type promotion, no `isReactive` / `isNonlinear` flag."
- **Observation**: This is a digiTS architectural cleanup statement, not an ngspice claim. The review request explicitly notes this is out of scope for ngspice verification. **No action needed**.

## Summary of ngspice-divergence categorization

Per CLAUDE.md "ngspice Parity Vocabulary- Banned Closing Verdicts": every divergence above is **architectural** (digiTS chose a different shape) rather than **numerical** (ngspice algorithm implemented incorrectly). All four major findings (D1, D2, D3, D4) and one minor (D5) require either:

1. Code changes to align bit-exact (Option A in each), or
2. An explicit entry in `spec/architectural-alignment.md` (user action- agents do not write to that file per CLAUDE.md), or
3. A JSDoc/comment note in the spec characterizing the divergence (no closing verdict using "tolerance" / "equivalent" / "mapping" / "intentional divergence").

The spec is **not** ready to ship as a contract until each Decision-Required item is resolved by user choice.

Full report written to: C:/local_working_projects/digital_in_browser/spec/reviews/spec-setup-load-cleanup-ngspice.md
