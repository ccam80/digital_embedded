# Spec Review: Combined Report — setup-load-split

## Overall Verdict: needs-revision

Every reviewed spec returned **needs-revision**. The defects cluster around ~15 cross-cutting architectural decisions that appear under different IDs in multiple per-file reports; resolving each ROOT decision auto-resolves several per-file findings.

## Per-Phase Verdicts

| Phase | Verdict | critical | major | minor | info |
|-------|---------|----------|-------|-------|------|
| plan.md (master plan) | needs-revision | 0 | 2 | 5 | 2 |
| 00-engine.md (W0–W2 contract) | needs-revision | 2 | 5 | 3 | 1 |
| 01-pin-mapping.md | needs-revision | 0 | 3 | 3 | 1 |
| 02-behavioral.md | needs-revision | 2 | 4 | 3 | 1 |
| Batch 1 — passives (14 files) | needs-revision | 0 | 9 | 12 | 3 |
| Batch 2 — sources/switches (15 files) | needs-revision | 3 | 8 | 7 | 3 |
| Batch 3 — semis A (15 files) | needs-revision | 1 | 8 | 5 | 2 |
| Batch 4 — actives (13 files) | needs-revision | 4 | 15 | 11 | 2 |
| Batch 5 — behavioral (17 files) | needs-revision | 1 | 5 | 4 | 2 |
| **Totals** | | **13** | **59** | **53** | **17** |

Per-file detail lives in the per-batch reports under `spec/reviews/setup-load-split-*.md`. This file consolidates the cross-cutting items only.

---

## ROOT Cross-Cutting Decisions

These ~15 decisions, if resolved, automatically resolve a large fraction of the per-file Decision-Required items. Resolve these first; per-file items become straightforward edits afterward.

### R1 — Pin-node access pattern inside setup() bodies (cross: every PB-*)

- **Findings affected**: BATCH1-D1, FPOLCAP-D2, FSCR-D1, FTRIAC-D1, BATCH4-M2; implicitly every PB-* spec
- **Problem**: Specs use both `pinNodes.get("label")!` and `this.pinNodeIds[N]` interchangeably. `setup(ctx: SetupContext): void` (00-engine.md §A3) has no `pinNodes` parameter; `SetupContext` (00-engine.md §A2) has no `pinNodes` field. Neither pattern is explained anywhere.
- **Options**:
  - **A** — Standardize on `this.pinNodeIds[N]` instance-array access (engine spec adds clarification that pinNodeIds is a factory-set instance field). Update 5 batch-1 files using the `.get()` form.
  - **B** — Standardize on `this.pinNodes.get("label")!` instance-Map access (each element class stores pinNodes as an instance field). Update 5 batch-1 files using `pinNodeIds[]` form.
  - **C** — Extend `SetupContext` to carry per-element `pinNodes`. Changes 00-engine.md §A2.

### R2 — `hasBranchRow` semantics for composites with VCVS/VSRC sub-elements (cross: 6+ files)

- **Findings affected**: BATCH4-D1 (PB-DAC, PB-COMPARATOR, PB-OPAMP, PB-REAL_OPAMP, PB-TIMER555), FCCCS-D1 (CCCS note)
- **Problem**: All five composites declare `hasBranchRow: false` despite VCVS sub-elements calling `ctx.makeCur()` during setup(). 00-engine.md §A3.1 says `true` for "models that allocate a branch row in setup()". Topology validators may under-count branch rows for circuits using these components.
- **Options**:
  - **A** — `hasBranchRow: true` on all five composites; engine spec §A3.1 clarifies "direct or transitive."
  - **B** — Keep `false`; topology validators walk sub-elements (code change outside spec scope).
  - **C** — Document that compiler flattens composites pre-validation (verify against `compiler.ts` first).

### R3 — `ctx.makeCur` idempotency (cross: VSRC family + plan + engine)

- **Findings affected**: FVSRC-DC-D1, FVCVS-D1, BATCH2-M3, plan resolved-decisions ("findBranch lazy-allocating mirrors VSRCfindBr")
- **Problem**: Plan implies `makeCur` is idempotent for the same `(label, suffix)` pair. Engine §A2 defines it as `_makeNode(label, suffix, "current")` which always increments `_maxEqNum`. PB-VCVS spec drops the element-level `if (branchIndex === -1)` guard claiming makeCur idempotency; PB-VSRC-DC/AC/VAR keep the guard. Inconsistent.
- **Options**:
  - **A** — Add element-level guard to PB-VCVS (matches VSRC family + ngspice); declare `makeCur` non-idempotent in §A2.
  - **B** — Make `makeCur` genuinely idempotent in engine §A2; remove element guards from VSRC family + VCVS + CCVS.

### R4 — `findBranchFor` iteration mechanism (cross: VSRC family + RELAY + CRYSTAL + engine)

- **Findings affected**: engine D3 (`_registeredMnaModels` source unspecified), BATCH2-D1 (VSRC family pseudocode references undefined `instance`), FVCVS-D1, FCCVS-D1, FRELAY-D1, FCRYSTAL-D1
- **Problem**: VSRC family `findBranchFor` callbacks reference an undefined free variable `instance`. RELAY references undefined `coilInstance`. VCVS/CCVS use `ctx.findDevice(name)` with brittle load-order narrowing. Engine spec doesn't say how `_registeredMnaModels` is built or how callbacks reach instance lists.
- **Options**:
  - **A** — All five (VSRC/AC/VAR + VCVS + CCVS) use `ctx.findDevice(name)`; resolve narrowing via `instanceof` or label-uniqueness assumption. Add `findDevice` semantics to engine §A2.
  - **B** — All use ngspice-pattern model-instance walk: each MnaModel factory closes over instance list. Requires engine §A4 to spec how factories receive instance lists.
  - **C** — Eliminate `_registeredMnaModels` entirely; put `findBranchFor?` directly on `AnalogElement`; `_findBranch` walks `this._elements`.

### R5 — Pool / temp access in load() and accept() (cross: 4+ active composites + NTC)

- **Findings affected**: FADC-D1, FOPTO-D1, FSCHMITT-D1, FTIMER-D1, BATCH4-M1, FCOMP-D2 (`_latchActive`), FNTC-D1 (`ctx.temp` is SetupContext field, not LoadContext)
- **Problem**: Multiple specs reference `pool` / `this._pool` / `ctx.temp` in `load()` or `accept()` bodies without those being declared anywhere. `LoadContext` interface is not specified to expose state-pool or temperature.
- **Options**:
  - **A** — Each element stores `this._pool` field set in an `initState(pool)` call inserted into `_setup()` after `allocateStateBuffers`. Add `initState` mechanism to engine spec.
  - **B** — Extend `LoadContext` to expose `statePool` (and `temp` for FNTC). Specify in 00-engine.md.
  - **C** — Hybrid: `LoadContext.statePool` for transient state; instance-cached `_ambientTemp` for setup-time config like temperature.

### R6 — Cross-element setter APIs `setControlVoltage` / `setCtrlVoltage` / `setOutputVoltage` / `setPinNode` (cross: ANALOG_SWITCH + NFET + TIMER555 + SCR + TRIAC)

- **Findings affected**: FANALOG_SWITCH-D1 (critical), FNFET-D1, FTIMER-D3, FSCR-D1, FTRIAC-D1, BATCH4-M2, FBEHAV-BUTTONLED-D1
- **Problem**: Multiple specs invoke methods that exist nowhere: `setCtrlVoltage` on SwitchElement (PB-ANALOG_SWITCH), `setControlVoltage` on SwitchElement (PB-NFET), `setOutputVoltage` on DigitalOutputPinModel (PB-TIMER555), `setPinNode(label, n)` (PB-SCR, PB-TRIAC). Some specs use `pinNodeIds = [...]` instead. Each invented method needs either a real definition or replacement.
- **Options** (apply uniformly across all affected specs):
  - **A** — Specify each new method on the relevant element/pin-model class; add to PB-SW / 02-behavioral. Larger blast radius across multiple spec files.
  - **B** — Replace all setters with direct field/array assignment (`pinNodeIds = [...]`, internal field writes). Faster; breaks encapsulation.
  - **C** — Hybrid per case: `pinNodeIds = [...]` for SCR/TRIAC; new methods only where genuinely needed (e.g., setLogicLevel already exists for TIMER output if VCC tracking can be parameterized differently).

### R7 — `_deviceMap` recursive sub-element registration (cross: SUBCKT critical + RELAY)

- **Findings affected**: FSUBCKT-D1 (critical), FRELAY-D1
- **Problem**: 00-engine.md §A4.1 builds `_deviceMap` from `compiled.elements` (top-level only). Subcircuit sub-elements and relay coil sub-elements are inside composite `_subElements` arrays, never inserted into `_deviceMap`. Any CCCS/CCVS/MUT inside a subcircuit referencing an internal element gets `findDevice(name) === null`.
- **Options**:
  - **A** — `_deviceMap` populated recursively during `init()` to include all sub-elements with namespaced labels. Engine spec §A4.1 amendment.
  - **B** — Add `ctx.registerDevice(label, this)` to `SetupContext`; sub-elements self-register in their own setup(). Engine spec §A2 amendment.
  - **C** — Restrict `findDevice` to top-level scope; prohibit cross-element references inside subcircuits. Likely breaks real-world subcircuit use.

### R8 — W2 stub `setup()` body specification location (cross: plan ↔ engine)

- **Findings affected**: engine D6, plan exit criterion 11
- **Problem**: Plan exit criterion 11 mandates every component file gets a stub `setup()` whose body throws `PB-${name} not yet migrated`. Plan reading guide says "W2: 00-engine.md §A2–A9 line-for-line." Engine spec contains no stub instruction. W2 implementer reading only 00-engine.md will not add stubs; W2 gate fails.
- **Options**:
  - **A** — Add §A3.2 "W2 component stubs" subsection to 00-engine.md with the stub body.
  - **B** — Cross-reference plan exit criterion 11 from §A3.

### R9 — `_translate` insertion-order semantics + `_resetForAssembly` reset (engine, blocks A9)

- **Findings affected**: engine D1 (critical), engine D2 (critical)
- **Problem**: §A1.5 `_translate` double-pushes `_insertionOrder` when both indices are new, with the col-branch push recording call-site row coords (semantically wrong). §A1.7 claims `_resetForAssembly()` resets `_insertionOrder` but never amends `_resetForAssembly()` body. The A9 setup-stamp-order test cannot be written until both are resolved.
- **Options for D1 (semantics)**:
  - **A** — One push per `allocElement` call (TSTALLOC-call semantics). Move push to top of `_translate`. A9 asserts position-for-position vs ngspice TSTALLOC sequence.
  - **B** — One push per novel index (index-assignment semantics). A9 asserts subsequence of novel-index encounters.
  - **C** — Keep current double-push; accept semantic mismatch.
- **Options for D2 (reset)**:
  - **A** — Add `_insertionOrder = []` to `_resetForAssembly()`; A9 test reads order between `_setup()` and first NR.
  - **B** — Restrict `_insertionOrder` lifetime to setup-only; remove `_resetForAssembly` reset claim.

### R10 — `spec/architectural-alignment.md` does not exist (cross: TLINE + OPTO + RELAY)

- **Findings affected**: FTLINE-D1, FOPTO-D2, BATCH2-D2 (Relay coil-R positions 6–9)
- **Problem**: Multiple specs cite "add architectural-alignment.md entry" as their resolution. The file doesn't exist on disk. Per CLAUDE.md, only the user creates entries there. Three specs are blocked on this file.
- **Options** (user action required per CLAUDE.md hard rule):
  - **A** — User creates `spec/architectural-alignment.md` with entries for: TLINE topology choice, Optocoupler CCCS coupling, Relay coil-resistance positions.
  - **B** — Rewrite affected specs to avoid divergence (e.g., PB-TLINE: choose option B/C from plan; PB-OPTO: replace coupling with VSRC+CCCS sub-elements; PB-RELAY: extract coil-R to separate sub-element).

### R11 — 02-behavioral Shape rule 2 wrong field names (critical) + Shape rule 3 class-vs-closure mismatch (critical)

- **Findings affected**: 02-behavioral D1, D2
- **Problem**:
  - Shape rule 2 references `_branchIndex` and `_outputCap`. Actual source fields: `_branchIdx` and `_capacitorChild`. Verbatim copy → TypeScript compile error.
  - Shape rule 3 assumes class-instance fields (`this._inputPins`, `this._subElements`) but applies to factory-closure elements (`createDriverAnalogElement`, `createSplitterAnalogElement`, `createSevenSegAnalogElement`, `createRelayAnalogElement`, `createButtonLEDAnalogElement`, switching factories) that have no `this._*` fields.
- **Options for D1 (field names)**:
  - **A** — Update spec to use real field names (`_branchIdx`, `_capacitorChild`).
  - **B** — Rename source fields to match spec (broader blast radius).
- **Options for D2 (closure vs class)**:
  - **A** — Rewrite Shape rule 3 with two sub-rules (one for class-based, one for closure-based elements with concrete worked example).
  - **B** — Pre-W3 wave converting all factory closures to classes.

### R12 — W3 source-read prohibition vs spec gaps (cross: POT + MEMR + CRYSTAL + SPLITTER + MUX)

- **Findings affected**: FPOT-D1, FMEMR-D1, FCRYSTAL-D2, FBEHAV-SPLITTER-D1, FBEHAV-MUX-D1, FBEHAV-DECODER (state pool)
- **Problem**: Plan forbids W3 implementer agents from reading existing source. Multiple specs say "implementer must verify against source" or use field names that only exist in source. Implementer is asked to do the impossible.
- **Options** (resolve per-file or as a global policy):
  - **A** — Spec author resolves each gap before W3 (pre-resolves pin orders, inline relevant constants, replace field-name pseudocode with behavior descriptions).
  - **B** — Relax source-read prohibition for one-file lookups when explicitly granted by the spec.
  - **C** — Add pin-order / field-name reference appendices to engine spec so PB-* files can cross-reference without source read.

### R13 — VCVS/CCVS element-level idempotent guard (depends on R3)

- **Findings affected**: FVSRC-DC-D1
- **Problem**: PB-VCVS lacks the `if (this.branchIndex === -1)` guard that VSRC family + ngspice both require. Resolution depends on R3.

### R14 — Norton→VCVS architecture change for COMPARATOR/OPAMP (behavioral regression risk)

- **Findings affected**: FCOMP-D1 (critical), FOPAMP-D1 (critical), FOPAMP-D2 (rOut=75 default), FOPAMP-M1 (table ambiguity)
- **Problem**: PB-COMPARATOR and PB-OPAMP rewrite the existing Norton output stage as a VCVS+RES topology. No enumeration of which `comparator.test.ts` / `opamp.test.ts` assertions change. `rOut=75` default introduces 75Ω series resistance not present in current implementation. High risk of behavioral regression.
- **Options**:
  - **A** — Keep conductance-only model; do not introduce VCVS sub-element.
  - **B** — Switch to VCVS; enumerate test changes + behavioral preservation tolerance.
  - **C** — Switch to VCVS with `rOut=0` default; flag rOut>0 as opt-in.

### R15 — Test-file path correctness (mechanical, batch-wide)

- **Findings affected**: FNJFET-M1, FPJFET-M1, FNFET-M1, FPFET-M1, FFGNFET-M1, FFGPFET-M1 (batch 3); FPOLCAP-M1, FPOT-D2, FTAPXFMR-D1 (batch 1); FBEHAV-DECODER-M1 (batch 5); BATCH2-M1 (switch family); FSCHOTTKY-D1 (batch 3, missing test file)
- **Problem**: ~12 PB-* specs reference test files that don't exist or have wrong paths. Mechanical to fix once correct paths are confirmed.
- **Resolution**: One pass over each affected file with the correct path. Most are pure mechanical (path typo). FSCHOTTKY-D1 is the exception: needs decision whether to create dedicated test or redirect gate.

---

## Mechanical Fixes (apply with user approval)

The following are pure-mechanical edits with no design decision. Listed by source file (alphabetical within each batch).

### Plan / engine / pin-mapping / behavioral

| ID | Severity | File | Location | Fix |
|----|----------|------|----------|-----|
| P-plan-M1 | minor | plan.md | §Resolved-decisions, "findBranch mechanism" row | `vsrc/vsrcfbr.c:26-39` → `vsrc/vsrcfbr.c:23-37` |
| P-plan-M2 | minor | plan.md | §Wave plan W4 gate | Replace hardcoded `comparison-session.ts:2688` with stable named-anchor reference |
| P-plan-M3 | minor | plan.md | §Engine-wave exit criteria item 8 | Replace manual `grep` instruction with reference to an automated test (or escalate per R15-style) |
| P-engine-M1 | major | 00-engine.md | §A1.2 first paragraph | Rewrite the "single-site grep" instruction to scope `_initStructure` search to `src/solver/analog/*.ts` excluding `__tests__/` |
| P-engine-M2 | minor | 00-engine.md | §A4.3 parenthetical | Delete historical-provenance paragraph beginning "(The earlier spec listed `monteCarloRun`…)" |
| P-engine-M3 | minor | 00-engine.md | §A7 last two sentences | Delete decision-history prose ("previous revision proposed... Dropped...") |
| P-pinmap-M1 | minor | 01-pin-mapping.md | §Verification, first sentence | "A1.7's `setup-stamp-order.test.ts`" → "A9's `setup-stamp-order.test.ts`" |
| P-behav-M1 | minor | 02-behavioral.md | §Shape rule 1 code block | Replace `this._inputCap` with `this._capacitorChild` |

### Batch 1 — passives

| ID | Severity | File | Location | Fix |
|----|----------|------|----------|-----|
| FPOLCAP-M1 | minor | components/PB-POLCAP.md | §Verification gate item 2 | `analog-fuse.test.ts and any polarized-cap test file` → `polarized-cap.test.ts` |
| FXFMR-M1 | minor | components/PB-XFMR.md | §Factory cleanup | Add fallback clause for unrecognized setParam keys |
| FCRYSTAL-M1 | minor | components/PB-CRYSTAL.md | §Cs setup TSTALLOC table | Rename `bNode` (rows 11–13) → `extBNode` to disambiguate from branch row variable `b` |
| FSPARK-M1 | minor | components/PB-SPARK.md | §State slots opener | Remove stray `2.` numbered-list artifact |

### Batch 2 — sources/switches

| ID | Severity | File | Location | Fix |
|----|----------|------|----------|-----|
| FVSRC-DC-M1 | minor | components/PB-VSRC-DC.md, all 15 batch-2 files | §Verification gate item 3 | Delete unverifiable line "No banned closing verdicts" |
| FVSRC-AC-M1 | minor | components/PB-VSRC-AC.md | §Factory cleanup | Add `mayCreateInternalNodes: false` (omit — default) for consistency with PB-VSRC-DC |
| FCCCS-M1 | major | components/PB-CCCS.md | §Factory cleanup | Delete historical-provenance parenthetical about `branchCount: 1` |
| FCCVS-M1 | minor | components/PB-CCVS.md | §Sense-source resolution | Delete historical-provenance paragraph block |

### Batch 3 — semis A

| ID | Severity | File | Location | Fix |
|----|----------|------|----------|-----|
| FNJFET-M1 | major | components/PB-NJFET.md | §Verification gate item 2 | `njfet.test.ts` → `jfet.test.ts` |
| FPJFET-M1 | major | components/PB-PJFET.md | §Verification gate item 2 | `pjfet.test.ts` → `jfet.test.ts` |
| FNFET-M1 | major | components/PB-NFET.md | §Verification gate item 2 | `switches.test.ts` → `fets.test.ts` |
| FPFET-M1 | major | components/PB-PFET.md | §Verification gate item 2 | `switches.test.ts` → `fets.test.ts` |
| FFGNFET-M1 | major | components/PB-FGNFET.md | §Verification gate item 2 | `switches.test.ts` → `fets.test.ts` |
| FFGPFET-M1 | major | components/PB-FGPFET.md | §Verification gate item 2 | `switches.test.ts` → `fets.test.ts` |
| FBJT-M1 | minor | components/PB-BJT.md | §setup() body, comment above entries 19-21 | `bjtsetup.c:453 (entries 19-21` → `bjtsetup.c:453 (entry 19), :461-462 (entries 20-21` |
| BATCH3-M1 | minor | All 15 batch-3 files | §load() body | Add multiplicity (M parameter) scaling reminder bullet to each load() body section |

### Batch 4 — actives

| ID | Severity | File | Location | Fix |
|----|----------|------|----------|-----|
| FDIAC-M1 | minor | components/PB-DIAC.md | §Sub-element 1 ngspiceNodeMap | `{ A: "pos", K: "neg" }` → `{ A: "pos", B: "neg" }` (D_fwd); `{ A: "pos", K: "neg" }` → `{ B: "pos", A: "neg" }` (D_rev) |
| FOPAMP-M1 | major | components/PB-OPAMP.md | §Sub-element decomposition first table | Delete first standalone table; keep only "Extended decomposition with rOut" table; mark `res1` row as conditional on `rOut > 0` |
| FOPAMP-D3 (mech subset) | minor | components/PB-OPAMP.md | §Factory cleanup | Delete "remains for initial placement only" rationale prose on `defaultModel` line |

### Batch 5 — behavioral

| ID | Severity | File | Location | Fix |
|----|----------|------|----------|-----|
| BATCH5-M1 | minor | PB-BEHAV-AND/NAND/OR/NOR/XOR/XNOR/NOT (7 files) | §Verification gate item 1 | Remove "(or equivalent test file for gates)" hedge |
| FBEHAV-DRIVER-M1 | minor | components/PB-BEHAV-DRIVER.md | §setup() body, "Forward order" | `inputs → sel → output → children` → `inputs (data, enable) → output → children` |
| FBEHAV-DRIVERINV-M1 | minor | components/PB-BEHAV-DRIVERINV.md | §setup() body, "Forward order" | `inputs → sel → output → children` → `inputs (data, enable) → output → children` |
| FBEHAV-GROUND-M1 | minor | components/PB-BEHAV-GROUND.md | §Notes on no-op status | Remove `(documented in the existing source comment at ground.ts:117-119)` reference; replace with self-contained rationale |

---

## Cross-Phase Consistency Checks

### Shared-file conflicts

| File | Specs that touch it | Conflict? |
|------|---------------------|-----------|
| `digital-pin-model.ts` | 02-behavioral.md (Shape rules 1–2) | Self-contained; no cross-phase write race |
| `behavioral-gate.ts` | 7 PB-BEHAV-* gate specs (BATCH5-D1) | **YES** — all 7 W3 agents would write `setup()` to the shared `BehavioralGateElement` class. Resolved by R6+BATCH5-D1 (designate single owner OR move method to W2). |
| `behavioral-remaining.ts` | PB-BEHAV-DRIVER, DRIVERINV, SPLITTER, SEVENSEG, SEVENSEGHEX, BUTTONLED, RELAY, RELAY-DT specs | Each owns its own factory body — no direct conflict, but `createSegmentDiodeElement` is shared between SEVENSEG and BUTTONLED (FBEHAV-BUTTONLED-D1). Resolved by per-spec ownership designation. |
| `compile/types.ts` | 00-engine.md §A3.1 + 01-pin-mapping.md (MnaModel field) | Spec consistent; resolution of D1 (path correction) needed in 01-pin-mapping. |

### Phase-dependency respect

- W2 must precede W3 ✅
- W3 components mostly independent ✅, except:
  - `BehavioralGateElement.setup()` shared method (BATCH5-D1) — 7 W3 agents have a write race
  - PB-BEHAV-BUTTONLED depends on PB-BEHAV-SEVENSEG completing (FBEHAV-BUTTONLED-D1)
  - PB-NFET/PFET depend on PB-SW.setControlVoltage being defined (FNFET-D1)
  - PB-POLCAP depends on PB-DIO TSTALLOC table being inlined or cross-referenced (FPOLCAP-D1)
  - PB-OPTO load() reads `DIODE_SLOT_*` constants from PB-DIO (FOPTO-D1)
- W4 depends on all W3 complete ✅

### Plan-verification achievability

| Plan verification measure | Achievable from specs? | Notes |
|---------------------------|-----------------------|-------|
| W0 — A0 comment delete + tests green | yes | Trivial |
| W1 — sparse-expandable.test.ts green | partially | Engine D1+D2 (R9) block A9 stamp-order test from being writable |
| W2 — every component has stub setup() | partially | Engine D6 (R8) — 00-engine.md doesn't tell W2 implementer to add stubs |
| W3 — per-component stamp-order row + test green | partially | Engine D6 + many cross-cutting blockers; multiple test-file paths wrong; multiple PB specs ungrounded |
| W3 — three-surface coverage (CLAUDE.md) | not addressed | Plan D1 — W3 gate specifies only unit/integration; MCP and E2E unspecified |
| W4 — 8 parity fixtures green | not yet | Depends on W3 completion |

### Duplicate task IDs

- No two phase specs claim the same task ID. ✅
- All 74 PB-*.md files are uniquely scoped. ✅

---

## Decision-Required Items: Compact Index

For each Decision-Required item, the per-batch report contains the full options + pros/cons. The cross-cutting items above (R1–R15) drive most of these. The remaining file-specific items are:

### Non-cross-cutting Decision-Required items (per-file)

| ID | Phase / file | Title | Severity |
|----|--------------|-------|----------|
| P-plan-D1 | plan.md | W3 gate doesn't cover MCP/E2E surfaces (CLAUDE.md three-surface rule) | major |
| P-plan-D2 | plan.md | A7 "no allocElement from load()" unverifiable by automated test | major |
| P-plan-D3 | plan.md | `_registeredMnaModels` population mechanism unspecified | minor |
| P-engine-D3 | 00-engine.md | `_registeredMnaModels` source unspecified (= R4 ROOT) | major |
| P-engine-D4 | 00-engine.md | `allocateStateBuffers` references nonexistent `_poolBackedElements` field | major |
| P-engine-D5 | 00-engine.md | A9 test invokes `_setup()` declared private | major |
| P-pinmap-D1 | 01-pin-mapping.md | Wrong primary file path for MnaModel (`src/solver/analog/types.ts` vs actual `src/compile/types.ts`) | major |
| P-pinmap-D2 | 01-pin-mapping.md | NFET/PFET map value `"ctrl"` absent from allowlist | major |
| P-pinmap-D3 | 01-pin-mapping.md | MOSFET map values use JFET-style names; MOS1 C-fields are single letters | minor |
| P-pinmap-D4 | 01-pin-mapping.md | CCCS `MnaModel.hasBranchRow` not stated (= R2 cluster) | minor |
| P-behav-D6 | 02-behavioral.md | Per-task verification gate uses placeholder paths | minor |
| P-behav-D7 | 02-behavioral.md | Shape rule 1 `!_loaded` early-return guard may break existing load() | minor |
| P-behav-D8 | 02-behavioral.md | Combinational element field names not verified for Shape rule 3 | info |
| FPOLCAP-D1 | PB-POLCAP.md | Clamp diode TSTALLOC sequence not specified (cross-file PB-DIO dependency) | major |
| FXFMR-D1 | PB-XFMR.md | `MutualInductorElement.setup()` 3-param signature conflicts with `AnalogElementCore.setup(ctx)` | major |
| FCRYSTAL-D2 | PB-CRYSTAL.md | State slot derivation contradicts ngspice anchors | minor |
| FFUSE-D1 | PB-FUSE.md | `this._res.current` and `this._res.conduct` undefined fields | major |
| FFUSE-D2 | PB-FUSE.md | `ResElement` class implied but never formally defined | minor |
| FSCHOTTKY-D1 | PB-SCHOTTKY.md | Missing dedicated test file in verification gate | major |
| FTUNNEL-D1 | PB-TUNNEL.md | VCCS handle access mechanism unspecified | major |
| FFGNFET-D1 | PB-FGNFET.md | State-slot order rationale unverifiable (`ngspiceLoadOrder` values not stated) | major |
| FFGPFET-D1 | PB-FGPFET.md | Same as FFGNFET-D1 | major |
| FTRIODE-D1 | PB-TRIODE.md | gds output-conductance handle count is unresolved (4 or 6 entries?) — blocks A9 test row | **critical** |
| FADC-D2 | PB-ADC.md | `nEoc` undeclared in load() body | major |
| FADC-D3 | PB-ADC.md | No-edge behavior (CLK always-high) unspecified | minor |
| FDAC-D2 | PB-DAC.md | `allocElement(0, branch)` skip behavior depends on unspecified VCVSElement internals | major |
| FDAC-D3 | PB-DAC.md | `DAC_COMPOSITE_SCHEMA` schema/branch reconciliation | minor |
| FREALOP-D1 | PB-REAL_OPAMP.md | Setup ordering conflicts with PB-OPAMP (NGSPICE_LOAD_ORDER ordering rule unstated) | major |
| FREALOP-D2 | PB-REAL_OPAMP.md | capComp neg=0 stamp-order entry count uncertain | major |
| FREALOP-D3 | PB-REAL_OPAMP.md | load() repeated inline `_pinNodes.get()` calls | major |
| FTIMER-D2 | PB-TIMER555.md | RS-FF glue handle order inconsistent between code and verification gate | major |
| FBEHAV-MUX-D1 | PB-BEHAV-MUX.md (and DECODER) | `COMBINATIONAL_COMPOSITE_SCHEMA` name unverifiable (= R12 cluster) | minor |
| FBEHAV-SEVENSEG-D1 | PB-BEHAV-SEVENSEG.md | stampG survival rule ambiguous (referenced in batch-5 summary, body not expanded — agent inconsistency) | minor |
| FBEHAV-BUTTONLED-D2 | PB-BEHAV-BUTTONLED.md | cathode=0 claim needs verification (referenced in batch-5 summary, body not expanded — agent inconsistency) | minor |

### Cross-cutting Decision-Required items (= R1–R15 above)

See the ROOT decisions section. Each ROOT decision is itself a Decision-Required item that resolves multiple per-file findings simultaneously.

---

## Recommended Triage Order

1. **Resolve R8, R9, R11 first** — these are critical engine/behavioral spec defects that block W2 implementer agents from being able to implement *anything* (W2 stubs, A9 test infrastructure, behavioral pin-model setup bodies). Without these, no downstream work can start.
2. **Resolve R1, R5, R6 next** — these define the implementation contract for every PB-* setup() and load() body. Without these, W3 agents have no usable contract.
3. **Resolve R2, R3, R4, R7, R13** — these resolve the VSRC/VCVS/CCVS/SUBCKT/RELAY family findings simultaneously.
4. **Resolve R14** — design decision on COMPARATOR/OPAMP architecture (behavioral regression risk).
5. **Resolve R10, R12** — process/policy decisions (architectural-alignment.md, source-read prohibition).
6. **Apply R15 mechanical test-path fixes** — pure mechanical batch.
7. **Apply remaining mechanical fixes** — listed in §Mechanical Fixes table.
8. **Resolve remaining per-file Decision-Required items** — most will be reduced to mechanical edits once R1–R15 are settled.

---

## Coordinator Note: Prior Reports Deletion

When the materialize-context.sh script ran during setup, the prior `spec/reviews/phase-0..8.md` and `spec-ngspice-netlist-generator-architecture.md` reports were observed to be deleted from the working tree (verified via `git status`). The script itself only writes to `spec/.context/` and cannot delete other files; the cause is unclear. The deletions are recoverable via `git checkout HEAD -- spec/reviews/` per user direction. None of the new reports overwrite or otherwise interfere with the deleted set; they are independent files with `setup-load-split-*` naming.
