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
| `findBranch` mechanism | Lazy-allocating. Mirrors `VSRCfindBr` (`vsrc/vsrcfbr.c:26-39`). | ngspice's actual mechanism: same `if (VSRCbranch == 0) CKTmkCur(...)` guard in both `VSRCsetup` and `VSRCfindBr`. Order-independent. |
| `findDevice` mechanism | Reads compile-time `Map<string, AnalogElement>`. | ngspice `CKTfndDev → nghash_find(DEVnameHash)` (`cktfinddev.c:13-17`); hash populated at parse in `cktcrte.c`, NOT setup. |
| `monteCarloRun`/`parameterSweep` setup gates | Removed from spec. | These methods don't exist on `MNAEngine`. Standalone runners (`ParameterSweepRunner`, `MonteCarlo`) construct their own MNAEngines and hit `_setup()` via driver methods naturally. |
| `matrixSize` field on `CKTCircuitContext` | DELETED. Reads → `this._solver._size`. | ngspice reads `ckt->CKTmatrix->Size` directly. Single source of truth. |
| `_getInsertionOrder()` | NEW debug method on `SparseSolver`. Test-only (underscore prefix). | ngspice has no equivalent; needed for A9 invariant test. CSC order ≠ insertion order. |
| `nodesetHandles` / `icHandles` | `new Map()` at construction. | Mirrors how `nodesets` / `ics` are initialised today. |
| `getInternalNodeLabels` | Dropped from `MnaModel`. | Internal nodes don't exist until setup; compile-time labels are inconsistent. Diagnostic labels built at setup-time inside `_makeNode`. |
| `_setup()` driver gates | `dcOperatingPoint`, `step`, `acAnalysis`. | Only confirmed callers in `analog-engine.ts`. |
| `branchCount` / `getInternalNodeCount` on MnaModel | Dropped. Replaced by `hasBranchRow: boolean` and `mayCreateInternalNodes?: boolean`. | Setup-time owns matrix structure; compile-time only declares intent. |
| Memristor topology | 1× RES with state-dependent G updated each load(); `_w` integrated in `accept()`. | Matches existing `memristor.ts` direct conductance stamp. NOT VCCS (initial 01 spec was wrong). |
| Tunnel diode, triode topologies | 1× VCCS each. | Tunnel: 2-terminal V-controlled current (control pair aliases output pair). Triode: 3-terminal (control = G-K, output = P-K — distinct pairs, requires VCCS). |

---

## Wave plan

| Wave | Scope | Gate |
|---|---|---|
| **W0** | A0 — delete the wrong-comment block at `sparse-solver.ts:394-398`. | Compiler builds; existing tests green. Trivial. |
| **W1** | A1 — port the sparse-solver expandable-matrix mechanism (`EXPANDABLE`/`Translate`/`EnlargeMatrix`/`ExpandTranslationArrays` from `spbuild.c`/`spalloc.c`). Lands in its own PR with its own tests. | `sparse-expandable.test.ts` green; `sparse-solver.test.ts` and `sparse-reset-semantics.test.ts` still green. |
| **W2** | A2–A9 — engine restructure: new `SetupContext` interface, `setup()` method on `AnalogElementCore`, `MNAEngine._setup()` driver gate, `ckt-context.ts` defer-buffer-alloc, `compiler.ts` strip-down, factory signature change, `setup-stamp-order.test.ts` skeleton. Every component gets a stub `setup()` that throws `"PB-${name} not yet migrated"`. | Existing component tests green for components whose stub doesn't fire. `setup-stamp-order.test.ts` exists with rows for every component, all RED. |
| **W3** | All Part B per-component tasks land in parallel — implementer agents read `components/PB-*.md` and replace the W2 stub `setup()` with the real body. | Per-component gates: `setup-stamp-order.test.ts` row green for that component; component's own test file green. |
| **W4** | Parity sweep. The eight currently-red `ngspice-parity/` fixtures (mosfet-inverter, diode-bridge, rlc-oscillator, bjt-common-emitter, rc-transient, diode-resistor, _diag-rc-transient, _diag-diode-resistor-tran) turn green simultaneously. | All parity fixtures green; first-iteration matrix-entry assertion at `comparison-session.ts:2688` passes for every fixture. |

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
7. A6 factory signature is 3-param. `MnaModel.hasBranchRow` /
   `mayCreateInternalNodes` / `findBranchFor` declared.
8. A7 grep `allocElement` in `src/components/` returns only setup() sites.
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

W3 can land in any order — components are independent. The parity-test
gate fires only after every W3 row is green.

---

## Wave-by-wave reading guide for implementers

| Wave | Files to read |
|---|---|
| W0 | `00-engine.md` §A0. |
| W1 | `00-engine.md` §A1.1–A1.9 line-for-line. |
| W2 | `00-engine.md` §A2–A9 line-for-line. Cross-references to `01-pin-mapping.md` (new `MnaModel` field) and `02-behavioral.md` (pin-model setup interface). |
| W3 | One `components/PB-*.md` file per implementer agent. Cross-references to `00-engine.md` §A2 (SetupContext interface) and `01-pin-mapping.md` (component's pin map). |
| W4 | No implementation work — runs the parity test suite. |

W3 implementer agents are forbidden from reading existing digiTS
component source — they port from the spec contract and ngspice
anchors only. Post-W3 review may compare against existing digiTS
source if a divergence is suspected.

---

## Open blockers

### PB-TLINE — architectural divergence (gates only the W3 row for transmission line)

digiTS `TransmissionLineElement` is a lumped RLCG model with N cascaded
segments (default N=10). ngspice `tra/trasetup.c` is an ideal lossless
transmission line with a fixed 22-stamp structure. These topologies
cannot produce bit-exact matrix entries by definition.

Three resolution options:

| Option | Action | Trade-off |
|---|---|---|
| A | Add an entry to `spec/architectural-alignment.md` documenting the divergence. PB-TLINE proceeds with per-sub-element ordering (each segment uses IND/CAP/RES anchors). | Preserves digiTS lossy-line capability. Setup-stamp-order test asserts per-segment ordering instead of fixed 22-stamp sequence. |
| B | Replace digiTS lumped model with an ideal-TRA port. Refactor `transmission-line.ts` from scratch. | Bit-exact parity. Loses lossy-line modeling. Larger blast radius across any test using `transmission-line`. |
| C | Add BOTH models — keep lumped as `transmission-line-lumped.ts`, add `transmission-line.ts` ideal port. User picks per circuit. | Most flexible; most work. |

Per CLAUDE.md hard rule, agents do not add `architectural-alignment.md`
entries. User decision required before PB-TLINE W3 row can land. Does
NOT block W0/W1/W2 or any other W3 component.

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
4. **W3** (50+ parallel implementations, can be split across many
   agents). Depends on W2 — all components have stub setup() methods
   from W2. PB-TLINE blocked on architectural-alignment decision.
5. **W4** (1 verification run). Depends on W3 complete.

Suggested batching for W3: same categories as the spec-writing agents —
passives, sources+switches, semiconductors, sensors+controlled-sources,
active-composites, behavioral-gates+combinational, behavioral-remaining.
Each W3 agent landed independently turns one row green in
`setup-stamp-order.test.ts`.
