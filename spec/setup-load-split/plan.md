# Setup/Load Split — Plan & Sequencing

Master plan for the setup-load-split migration. The spec is split across:

- `00-engine.md` — engine-side contract (A0–A9): SparseSolver expandable
  port, SetupContext, setup() method, MNAEngine restructure, ckt-context
  defer-buffer-alloc, compiler strip-down.
- `01-pin-mapping.md` — `ngspiceNodeMap` registry and per-component pin
  label maps.
- `02-behavioral.md` — behavioral elements that lack ngspice anchors
  (pin-model setup() bodies, composite forward rule).
- `components/PB-*.md` — 74 per-component spec files. Each is
  self-contained; W3 implementer agents read one file each.

This work supersedes `spec/setup-load-split-task-spec.md` (revision 2)
and `spec/setup-load-split-problem-statement.md`. Those remain on disk
for historical reference but are no longer the implementation contract.

---

## Resolved decisions (rationale baked into the spec)

| Topic | Decision | Source of evidence |
|---|---|---|
| `_currentSize` field fate | Survives unchanged. Distinct from `_size`. | ngspice `MatrixFrame.CurrentSize` (assignment counter) vs `MatrixFrame.Size` (loop bound) — diverge during build, converge after. |
| `findBranch` mechanism | Lazy-allocating element-level guard. Each VSRC/VCVS/CCVS element setup() wraps `ctx.makeCur` in `if (this.branchIndex === -1) { ... }`, mirroring `vsrcset.c:40-43`'s `if (here->VSRCbranch == 0) { CKTmkCur(...); }`. `ctx.makeCur` itself is NOT idempotent — it always allocates a fresh branch index. The guard discipline is the element's responsibility. | ngspice's actual mechanism: same `if (==0)` guard appears in both `VSRCsetup` and `VSRCfindBr`, on the device. |
| `findDevice` mechanism | Reads compile-time `Map<string, AnalogElement>`. | ngspice `CKTfndDev → nghash_find(DEVnameHash)` (`cktfinddev.c:13-17`); hash populated at parse in `cktcrte.c`, NOT setup. |
| `monteCarloRun`/`parameterSweep` setup gates | Removed from spec. | These methods don't exist on `MNAEngine`. Standalone runners (`ParameterSweepRunner`, `MonteCarlo`) construct their own MNAEngines and hit `_setup()` via driver methods naturally. |
| `matrixSize` field on `CKTCircuitContext` | DELETED. Reads → `this._solver._size`. | ngspice reads `ckt->CKTmatrix->Size` directly. Single source of truth. |
| `_getInsertionOrder()` | NEW debug method on `SparseSolver`. Test-only (underscore prefix). | ngspice has no equivalent; needed for A9 invariant test. CSC order ≠ insertion order. |
| `nodesetHandles` / `icHandles` | `new Map()` at construction. | Mirrors how `nodesets` / `ics` are initialised today. |
| `getInternalNodeLabels` | Dropped from `MnaModel`. | Internal nodes don't exist until setup; compile-time labels are inconsistent. Diagnostic labels built at setup-time inside `_makeNode`. |
| `_setup()` driver gates | `dcOperatingPoint`, `step`, `acAnalysis`. | Only confirmed callers in `analog-engine.ts`. |
| `branchCount` / `getInternalNodeCount` on MnaModel | Dropped. `branchCount` replaced by inspecting `AnalogElementCore.branchIndex` post-setup (recursive walk through composites). `getInternalNodeCount` replaced by `mayCreateInternalNodes?: boolean` (declarative intent only). Earlier proposed `hasBranchRow: boolean` field was investigated and dropped — dead relic with no production use; topology validators walk actual `branchIndex` instead. | Setup-time owns matrix structure; compile-time only declares intent. |
| Memristor topology | 1× RES with state-dependent G updated each load(); `_w` integrated in `accept()`. | Matches existing `memristor.ts` direct conductance stamp. NOT VCCS (initial 01 spec was wrong). |
| Tunnel diode, triode topologies | Tunnel: 1× VCCS (2-terminal V-controlled current; control pair aliases output pair). Triode: 1× VCCS topology + 2 extra `gds` output-conductance handles (3-terminal: control = G-K, output = P-K — distinct pairs requiring VCCS structure; gds is always nonzero per Koren formula, so 2 additional `allocElement(P,P)` and `allocElement(K,P)` calls beyond the 4 VCCS entries — 6 total handles, see PB-TRIODE.md FTRIODE-D1 resolution). | |

---

## Wave plan

| Wave | Scope | Gate |
|---|---|---|
| **W0** | A0 — delete the wrong-comment block at `sparse-solver.ts:394-398`. | Compiler builds; existing tests green. Trivial. |
| **W1** | A1 — port the sparse-solver expandable-matrix mechanism (`EXPANDABLE`/`Translate`/`EnlargeMatrix`/`ExpandTranslationArrays` from `spbuild.c`/`spalloc.c`). Lands in its own PR with its own tests. | `sparse-expandable.test.ts` green; `sparse-solver.test.ts` and `sparse-reset-semantics.test.ts` still green. |
| **W2** | A2–A9 — engine restructure: new `SetupContext` interface, `setup()` method on `AnalogElementCore`, `MNAEngine._setup()` driver gate, `ckt-context.ts` defer-buffer-alloc, `compiler.ts` strip-down, factory signature change, `setup-stamp-order.test.ts` skeleton. Every component gets a stub `setup()` that throws `"PB-${name} not yet migrated"`. | Existing component tests green for components whose stub doesn't fire. `setup-stamp-order.test.ts` exists with rows for every component, all RED. |
| **W2.5** | Field rename + factory-closure-to-class conversion required by 02-behavioral.md Shape rules 2 & 3. Two coordinated changes: (a) rename `DigitalInputPinModel._capacitorChild` → `_outputCap`, `DigitalOutputPinModel._branchIdx` → `_branchIndex`, `DigitalOutputPinModel._capacitorChild` → `_outputCap` in `src/solver/analog/digital-pin-model.ts` and update every call site; (b) convert all factory-closure analog elements (`createDriverAnalogElement`, `createDriverInvAnalogElement`, `createSplitterAnalogElement`, `createSevenSegAnalogElement`, `createButtonLEDAnalogElement` in `behavioral-remaining.ts`, plus the switching factories `transgate`, `nfet`, `pfet`, `fgnfet`, `fgpfet` under `src/components/switching/`) into classes implementing `AnalogElementCore` with `_inputPins`, `_outputPins`, `_subElements`, `_childElements` instance fields. Relay / RelayDT are not in this list — their production W3 implementations live in `src/components/switching/relay.ts` and `relay-dt.ts` and are already class-based. Pin-model field references and the composite forward rule from 02-behavioral.md Shape rule 3 then apply uniformly to all elements without per-spec closure-vs-class branching. | All existing component tests green after rename + class conversion. No new behavioral changes. `setup-stamp-order.test.ts` still RED (it depends on W3 setup() bodies). |

- **W2.6 — `createSegmentDiodeElement.setup()` body** (added to resolve FBEHAV-BUTTONLED-D1 W3 race): the helper at `src/solver/analog/behavioral-remaining.ts` (search for `function createSegmentDiodeElement` or `export function createSegmentDiodeElement`) must receive its real `setup` property — not a throwing stub — during W2. The body is described in 00-engine.md §A3.2 (or wherever W2 stub specs live, with this exception called out as W2.6 not a stub but the real body). Once W2.6 lands, both PB-BEHAV-SEVENSEG and PB-BEHAV-BUTTONLED can run in parallel during W3 because neither needs to write the helper's setup() body.
- **W2.7 — `BehavioralGateElement.setup()` body** (added to resolve BATCH5-D1 W3 race across all 7 gates): the class at `src/solver/analog/behavioral-gate.ts` receives its real `setup(ctx)` body — not a throwing stub — during W2. Body specified in 00-engine.md §A3.2 W2.7 paragraph. Once W2.7 lands, the 7 gate W3 tasks (NOT/AND/NAND/OR/NOR/XOR/XNOR) all become parallel because none of them write the shared method.

| **W3** | All Part B per-component tasks land in parallel — implementer agents read `components/PB-*.md` and replace the W2 stub `setup()` with the real body. | Per-component gates: `setup-stamp-order.test.ts` row green for that component; component's own test file green. Three-surface coverage (CLAUDE.md): the setup/load split is an internal refactor and adds no new user-facing API surface. The existing E2E suite, if it remains green at W4, satisfies the three-surface rule for this work. No per-component MCP or E2E assertion is required at W3. |
| **W3.5** | Component-spec gaps not covered by the original 74 PB-*.md set: PB-LED (diode-subclass refactor), PB-BEHAV-FF-D / -JK / -RS / -T (7 flipflop classes across 4 specs), PB-BEHAV-SEQUENTIAL (3 sequential composites), PB-TLINE (Option A — keep lumped per-segment, IND/CAP/RES anchors per sub-element). Plus PB-XFMR.md and PB-TAPXFMR.md spec patches that close 5 inter-PB class-API gaps (constructor inductance arg, sub-element load() bodies, getLteTimestep, pool-backed declaration, _pinNodes ownership) followed by PB-TAPXFMR implementer re-spawn against the patched spec. See `spec/phase-3.5-component-spec-gaps.md` for the full task list. | Per-component spec-compliance gates per CLAUDE.md "Test Policy During W3 Setup-Load-Split". PB-TAPXFMR re-spawn pre-condition: PB-XFMR.md and PB-TAPXFMR.md patches landed and committed. |
| **W4** | Parity sweep. | **W4 gate**: the resistive-divider parity fixture (the first/simplest of the planned parity circuits) passes — first-iteration matrix entries match ngspice. The remaining parity fixtures are NOT a gate for this implementation; they are walked through manually by the user in a follow-up debugging pass. |

---

## Engine-wave exit criteria (W0–W2 collectively)

1. A0 deleted comment block.
2. A1 `sparse-expandable.test.ts` green; existing solver tests green.
3. A2 `setup-context.ts` exists with full interface.
4. A3 `AnalogElementCore.setup` declared; `branchIndex` mutable.
5. A4 `MNAEngine._setup()` runs unconditionally from every analysis
   driver entry. `_findBranch` / `_findDevice` work.
6. A5 `matrixSize` field on `CKTCircuitContext` deleted. Per-row and
   per-state buffers allocated post-setup.
7. A6 factory signature is 3-param. `MnaModel.mayCreateInternalNodes` /
   `findBranchFor` declared.
8. A7 Verified by the verifier agent (not an automated CI test): after W2 lands, the verifier runs `Grep "allocElement" src/components/` and confirms every match falls inside a `setup()` method body. A match inside a `load()`, `accept()`, or other body is a violation. This is a verifier-gate, not an automated CI test — but it is a hard gate, not advisory.
9. A8 `nodesetHandles` / `icHandles` populated in `_setup()`.
10. A9 `setup-stamp-order.test.ts` exists. All rows initially RED.
11. W2 stub for every component: every component file has a `setup()`
    method whose body is `throw new Error(\`PB-\${name} not yet migrated\`)`.

---

## Half-state risk

W3 components must all land before W4. Running parity tests between W2
and W3 — or with only some W3 components landed — produces noise:
load-order-sort plus lazy-Translate composes the orderings of
half-migrated and not-migrated elements into something that matches
neither ngspice nor the future fully-migrated state.

W2's "stub setup() that throws" is the temporary-but-loud intermediate.
Every component has the new method but its body is
`throw new Error(\`PB-\${name} not yet migrated\`)`. This guarantees no
component works between W2 and W3, surfacing un-migrated components
loudly. W3 lights them up one at a time.

W2.5 must land before W3 starts. W3 PB-BEHAV-* specs and PB-NFET/PFET/FGNFET/FGPFET specs assume class-based elements with `_inputPins`/`_outputPins` instance fields and pin models with `_branchIndex`/`_outputCap` field names. Running W3 against the pre-W2.5 codebase produces TypeScript compile errors immediately. W2.5 itself is mechanical — no behavior changes — but its PR is large because every call site of the renamed fields and every factory closure is touched.

W3 can land in any order — components are independent. The parity-test
gate fires only after every W3 row is green.

---

## Wave-by-wave reading guide for implementers

| Wave | Files to read |
|---|---|
| W0 | `00-engine.md` §A0. |
| W1 | `00-engine.md` §A1.1–A1.9 line-for-line. |
| W2 | `00-engine.md` §A2–A9 line-for-line. Cross-references to `01-pin-mapping.md` (new `MnaModel` field) and `02-behavioral.md` (pin-model setup interface). |
| W2.5 | `02-behavioral.md` §Shape rules 2 & 3 (the field names and class structure are the post-rename, post-conversion target). Plus a checklist of every file containing `_branchIdx`, `_capacitorChild`, or one of the named factory closures. |
| W3 | One `components/PB-*.md` file per implementer agent. Cross-references to `00-engine.md` §A2 (SetupContext interface) and `01-pin-mapping.md` (component's pin map). |
| W3.5 | `spec/phase-3.5-component-spec-gaps.md` for the task list. Per-task PB files: `components/PB-LED.md`, `components/PB-BEHAV-FF-{D,JK,RS,T}.md`, `components/PB-BEHAV-SEQUENTIAL.md`, `components/PB-TLINE.md`, plus the patched `components/PB-XFMR.md` / `components/PB-TAPXFMR.md`. PB-LED references PB-DIO.md.
| W4 | No implementation work — runs the parity test suite. |

W3 implementer agents are forbidden from reading existing digiTS
component source — they port from the spec contract and ngspice
anchors only. Post-W3 review may compare against existing digiTS
source if a divergence is suspected.

---

## Open blockers


### PB-BEHAV-SEVENSEGHEX — implementer note (NOT blocking)

`SevenSegHex` reuses `createSevenSegAnalogElement` directly with 8
segment-labelled pins, while the SevenSegHex component declares only 2
pins (`d`, `dp`). The compiler must resolve pin-label mapping between
the component's pin layout and the factory's segment-label addressing.
Implementer verifies at W3 time. If existing tests pass, current
behavior is fine.

---

## Implementation phasing

Recommended order (with parallelisation opportunities flagged):

1. **W0** (1 commit, trivial). Independent of all other work.
2. **W1** (1 PR, ~500 LOC). Independent of W0 outcome (W0 is a comment
   delete; W1 is real code). W1 depends on `MINIMUM_ALLOCATED_SIZE` /
   `EXPANSION_FACTOR` from `spconfig.h`, which is already correct.
3. **W2** (1 PR, ~2000 LOC across engine and compiler files). Depends
   on W1 — `_initStructure()` no-arg signature is in W1.
3.5. **W2.5** (1 PR, ~1500 LOC across `digital-pin-model.ts`, `behavioral-remaining.ts`, `behavioral-gate.ts`, `behavioral-combinational.ts`, switching factories, and all call sites). Depends on W2 — the stub `setup()` methods are still in place. Mechanical refactor: no behavior change.
4. **W3** (50+ parallel implementations, can be split across many
   agents). Depends on W2.5 complete — W3 specs assume post-rename, post-class-conversion architecture; running W3 against the pre-W2.5 codebase will produce TypeScript compile errors at every PB-BEHAV-* setup() body.
4.5. **W3.5** — component-spec gaps (~7 implementer tasks plus 2 spec-patch tasks plus PB-TAPXFMR re-spawn). Depends on W3 complete (PB-XFMR / PB-DIO / PB-IND / PB-CAP / PB-RES must be landed because W3.5 specs reference them as frozen contracts). Tasks: PB-LED (depends on PB-DIO), 4 PB-BEHAV-FF specs, PB-BEHAV-SEQUENTIAL, PB-TLINE , PB-XFMR.md spec patch (5 inter-PB gap closures), PB-TAPXFMR.md spec patch (mirror), PB-TAPXFMR implementer re-spawn (depends on the two patches landing first). Phase spec: `spec/phase-3.5-component-spec-gaps.md` — ephemeral, delete after execution.
5. **W4** (1 verification run). Depends on W3 and W3.5 both complete.

Suggested batching for W3: same categories as the spec-writing agents —
passives, sources+switches, semiconductors, sensors+controlled-sources,
active-composites, behavioral-gates+combinational, behavioral-remaining.
Each W3 agent landed independently turns one row green in
`setup-stamp-order.test.ts`.
