# Spec Review — Progress Snapshot

**Session date**: 2026-04-27
**Coordinator**: claude-orchestrator:review-spec
**Combined report**: `spec/reviews/spec-review-combined.md`
**Scope**: setup-load-split (4 master spec files + 74 PB-* component specs)

This file tracks which decisions landed in this session, the implementer outputs, and the items remaining for a future session to pick up.

---

## ROOT decisions — landed

| ID | Title | User chose | Implementer | Status |
|----|-------|------------|-------------|--------|
| R1 | Pin-node access pattern | `this._pinNodes.get("label")!` (Map-based, label-blind, cost amortized once-per-compile) | `imp-r1` | landed |
| R2 | hasBranchRow | Drop entirely (dead relic — 1 match in source, only in test file) | `imp-r2` (died at usage limit, completed by `imp-cleanup` + per-file implementers) | landed (verified: 0 hasBranchRow matches under `spec/setup-load-split/components/`) |
| R3 | makeCur idempotency | ngspice-aligned: makeCur non-idempotent + element-level guard everywhere | `imp-vsrc-family` (00-engine.md by `imp-engine-mega`) | landed |
| R4 | findBranchFor iteration | `ctx.findDevice(name)` (digiTS pattern, leverages R7 recursive _deviceMap); eliminate `_registeredMnaModels` | `imp-engine-mega` + `imp-vsrc-family` | landed |
| R5 | Pool / temp access | Add `state0: Float64Array` + `state1: Float64Array` to LoadContext (ngspice-aligned mirror of `CKTstate0`/`CKTstate1`); `temp` already on LoadContext | `imp-engine-mega` (engine spec) + `imp-actives` + `imp-misc-passives` | landed (engine spec + active composites updated; `_stateOffset → _stateBase` rename incomplete — see Cleanup pending below) |
| R6 | Cross-element setter APIs | Hybrid per case: `setCtrlVoltage` defined in PB-SW; `setOutputVoltage` replaced with `setParam("vOH", v) + setLogicLevel(q)` for TIMER555; `pinNodeIds = [...]` for SCR/TRIAC | `imp-r6` | landed |
| R7 | _deviceMap recursive sub-element registration | Recursive _deviceMap in init() with `/` namespace separator | `imp-r7` | landed |
| R8 | W2 stub setup() spec location | Add §A3.2 to 00-engine.md | `imp-engine` (initial round) | landed |
| R9-D1 | _translate insertion-order semantics | Match ngspice exactly: one push per allocElement call, push at top before either branch | `imp-engine` (initial round) | landed |
| R9-D2 | _insertionOrder reset behavior | Setup-only lifetime, never reset (ngspice-aligned) | `imp-engine-mega` (§A1.7) | landed |
| R10 | architectural-alignment.md blockers | Rewrite affected specs to avoid divergence: PB-TLINE → ideal-TRA port; PB-OPTO → VSRC+CCCS sub-elements; PB-RELAY/RELAY-DT → extract coil-R as RES sub-element | `imp-r10` | landed |
| R11 | 02-behavioral Shape rules 2 & 3 | Rename source fields + add pre-W3 W2.5 class-conversion wave | `imp-pinmap-behav`, `imp-plan` (W2.5 added to plan.md) | landed |
| R12 | W3 source-read prohibition vs spec gaps | Spec author resolves each gap pre-W3 (no source reads needed) | `imp-r12-behav` (PB-BEHAV-SPLITTER, PB-BEHAV-MUX, PB-BEHAV-DECODER, PB-BEHAV-SEVENSEGHEX), `imp-misc-passives` (PB-POT, PB-MEMR), `imp-vsrc-family` (PB-CRYSTAL) | landed |
| R14 | Norton→VCVS for OPAMP/COMPARATOR | Switch to VCVS, rOut=75 default + flag regression risk; pre-implementation checklist mandates baseline + escalation | `imp-r14` | landed |
| R15 | Test-file path correctness | Mechanical batch fixes (NJFET/PJFET/NFET/PFET/FGNFET/FGPFET, POLCAP, POT, TAPXFMR, DECODER, SCHOTTKY, etc.) | mechanical-fix implementers | landed |

## Per-file Decision-Required items — landed

| ID | File | Resolution | Implementer |
|----|------|------------|-------------|
| Engine D4 | 00-engine.md §A5.1 | Add `_poolBackedElements: readonly AnalogElement[]` field to CKTCircuitContext, populated at construction from `circuit.elements.filter(isPoolBacked)` | `imp-engine-mega` |
| Engine D5 | 00-engine.md §A9 | Use `(engine as any)._setup()` cast in test (private bypass, contained scope) | `imp-engine-mega` |
| FXFMR-D1 | PB-XFMR | MutualInductorElement constructor stores `(coupling, l1, l2)`; setup(ctx) reads this._l1.branchIndex / this._l2.branchIndex | `imp-misc-passives` |
| FTRIODE-D1 | PB-TRIODE (critical) | 6 handles: 4 VCCS + 2 gds composite-owned (gds always nonzero per Koren) | `imp-misc-passives` |
| FBEHAV-SEVENSEGHEX-D1 | PB-BEHAV-SEVENSEGHEX (critical) | Dedicated `createSevenSegHexAnalogElement` factory; SevenSegHexDefinition.modelRegistry.behavioral.factory swapped | `imp-r12-behav` |
| FANALOG_SWITCH-D1 | PB-ANALOG_SWITCH (critical) | `setCtrlVoltage` defined on SwitchElement (PB-SW); `setSwState` added for SPDT NC path | `imp-r6` |
| FANALOG_SWITCH-D2 | PB-ANALOG_SWITCH (critical) | SPDT NC path computes `ncOn = vCtrl < vThreshold - vHyst/2` explicitly + setSwState (replaces -vCtrl negation) | `imp-r6` |
| FSUBCKT-D1 | PB-SUBCKT (critical) | `_deviceMap` populated recursively; `/` separator; ctx.findDevice resolves namespaced labels | `imp-r7` |
| FFUSE-D1 | PB-FUSE | Inline RES logic on FuseElement; drop ResElement sub-element entirely | `imp-misc-passives` |
| FREALOP-D1 | (engine + PB-OPAMP, PB-REAL_OPAMP) | Enforce NGSPICE_LOAD_ORDER for sub-elements within composites (engine §A6.4) | `imp-engine-mega` + `imp-actives` |
| FREALOP-D3 | PB-REAL_OPAMP | Cache _inP, _inN as instance fields in construction; load() uses cached fields | `imp-actives` |
| FCOMP-D2 | PB-COMPARATOR | _latchActive derived inline from `ctx.state0[stateBase + OUTPUT_LATCH]`; rSat parameterized (default 1.0Ω) | `imp-actives` |
| FTIMER-D2 | PB-TIMER555 | RS-FF glue handle moved AFTER all sub-element setups (composite-owned allocations last) | `imp-actives` |
| FTIMER-D3 | PB-TIMER555 | setOutputVoltage replaced with `setParam("vOH", v) + setLogicLevel(q)` (no new method on DigitalOutputPinModel) | `imp-r6` |
| FADC-D1 | PB-ADC | `pool` references replaced with `ctx.state0`; `_stateOffset → _stateBase` (R5 cluster) | `imp-actives` |
| FADC-D2 | PB-ADC | Added missing `const nEoc = this._pinNodes.get("EOC")!` declaration in load() | `imp-actives` |
| FADC-D3 | PB-ADC | Documented no-edge behavior (CLK always-high → EOC never fires; correct clock-driven semantics) | `imp-actives` |
| FNFET-D1 | PB-NFET (and PB-PFET) | `setControlVoltage` renamed to `setCtrlVoltage` (PB-SW defines the method) | `imp-r6` |
| FOPAMP-D1, FOPAMP-D2, FOPAMP-D3 | PB-OPAMP | VCVS architecture, rOut=75 default, regression-risk warnings + pre-implementation checklist | `imp-r14` + `imp-actives` |
| FCOMP-D1 | PB-COMPARATOR | VCVS architecture, regression-risk warnings + pre-implementation checklist | `imp-r14` |
| FRELAY-D1 | PB-RELAY (and PB-RELAY-DT) | `findBranchFor` uses `ctx.findDevice` with namespaced label `${relayLabel}/_coil` | `imp-r7` |
| FCRYSTAL-D1, FCRYSTAL-D2 | PB-CRYSTAL | findBranchFor uses ctx.findDevice; state-slot derivation grounded in CRYSTAL_SCHEMA (no per-component breakdown that contradicted ngspice anchors) | `imp-vsrc-family` |
| FPOLCAP-D1 | PB-POLCAP | Clamp DIO TSTALLOC sequence inlined (entries 5-8) for self-containment | `imp-misc-passives` |
| FNTC-D1 | PB-NTC | `ctx.temp` clarification (already on LoadContext; spec error was the only issue) | `imp-misc-passives` |
| FTAPXFMR-D1, FTAPXFMR-D2 | PB-TAPXFMR | Mandate dedicated tapped-transformer.test.ts; replace `updateDerivedParams` with explicit per-key inline recomputation | `imp-misc-passives` |
| FPOT-D1, FPOT-D2 | PB-POT | Pre-resolve pin-order to A/W/B; correct test-file path | `imp-misc-passives` |
| FMEMR-D1 | PB-MEMR | Drop "implementer must read source" note; flag 01-pin-mapping.md inconsistency for separate fix | `imp-misc-passives` |

## Mechanical fixes — landed

All ~30 mechanical fixes from the §Mechanical Fixes table in `spec-review-combined.md` were applied in the first round of implementers (`imp-engine`, `imp-plan`, `imp-pinmap-behav`, `imp-batch1` through `imp-batch5`). Spot-verified via per-implementer line-range summaries.

---

## Cleanup pending (mechanical, lock-released)

### `_stateOffset` → `_stateBase` rename (incomplete)

`imp-cleanup` finished the residual `hasBranchRow` removal from PB-OPTO/RELAY/RELAY-DT/TLINE but exited mid-task before completing the `_stateOffset` rename. **17 files still contain `_stateOffset`** and need bulk rename to `_stateBase` (the canonical field name declared in `00-engine.md` §A3 AnalogElementCore interface).

Affected files (under `spec/setup-load-split/components/`):
- PB-TLINE, PB-POLCAP, PB-ZENER, PB-VARACTOR, PB-SW, PB-SPARK, PB-SCHOTTKY, PB-PMOS, PB-PJFET, PB-NMOS, PB-NJFET, PB-DIO, PB-BJT, PB-ANALOG_SWITCH, PB-XFMR, PB-CAP, PB-IND

For each: replace all occurrences of `_stateOffset` with `_stateBase` (use Edit's `replace_all: true`). No other change.

Verification: `Grep _stateOffset` over `spec/setup-load-split/` should return zero matches after.

---

## Session 2 (2026-04-27) — All pending items landed

All decisions from `## ROOT decisions — pending` and `## Per-file Decision-Required items — pending` were resolved by user decision and applied to spec by parallel implementer agents (imp-A through imp-N + imp-LM + imp-J{1..5} variants). All 22 changes verified by wave-verifier — 22/22 PASS. Stale `BATCH4-D2-impJ` task lock + 67 file locks cleared mid-session.

### Items landed in session 2

| ID | Decision | Files touched |
|----|----------|---------------|
| P-plan-D1 | C + adjusted W4 gate (resistive-divider only, not all 8 fixtures) | plan.md |
| P-plan-D2 | Verifier-agent gated; manual-grep wording removed | plan.md, 00-engine.md §A7 |
| BATCH1-D2 | C — guard only when shunt structurally possible; new 00-engine.md §A6.6 codifies | 00-engine.md §A6.6 |
| P-pinmap-D1 | A — `src/compile/types.ts`, hedge dropped | 01-pin-mapping.md |
| P-pinmap-D2 | New option D — NFET/PFET map G→`contPos` (ngspice controlling-pair vocabulary; allowlist stays pure) | 01-pin-mapping.md |
| P-pinmap-D3 | B — MOSFET map uses MOS-accurate single letters `g/d/s/b`; allowlist extended | 01-pin-mapping.md |
| P-behav-D6 | A — concrete test-file table per behavioral group | 02-behavioral.md |
| P-behav-D7 | B (ngspice-aligned) — `_loaded` guard removed from setup() | 02-behavioral.md Shape rule 1 |
| P-behav-D8 | A — concrete field-name table for combinational classes (`_dataPins[][]`, `_inPin`, `_selPins`, `_outPins`) | 02-behavioral.md Shape rule 3 |
| FSCHOTTKY-D1 | A — create dedicated schottky.test.ts with 4 assertion areas | PB-SCHOTTKY.md |
| FTUNNEL-D1 | B — readonly accessor on VccsAnalogElement; field-name reconciliation (short-form `pCtP/pCtN/nCtP/nCtN` matching real `_hPCtP/...` fields) | PB-VCCS.md, PB-TUNNEL.md |
| FFGNFET-D1 + FFGPFET-D1 | A — explicit values `CAP=17`, `MOS=35`; setup() uses sorted-array iteration | PB-FGNFET.md, PB-FGPFET.md |
| BATCH4-D2 | Setup-mocking removal sub-bullet on the 5 active composites | PB-COMPARATOR/SCHMITT/OPAMP/REAL_OPAMP/TIMER555 |
| FDIAC-D1 | A with verified ngspice anchor — RS=0 alias rule inlined per `dio/diosetup.c:204-208` | PB-DIAC.md |
| FSCR-D2 | B applied to ALL 74 PB-* files — Setup-mocking removal sub-bullet on every component verification gate | All 74 PB-*.md |
| FBEHAV-BUTTONLED-D1 | C — `createSegmentDiodeElement.setup()` extracted to W2.6 (real body in 00-engine.md §A3.2) | plan.md, 00-engine.md, PB-BEHAV-BUTTONLED.md, PB-BEHAV-SEVENSEG.md |
| FBEHAV-BUTTONLED-D2 | B — contradictory "future variant" example removed; cathode-zero guard grounded in §A6.6 | PB-BEHAV-BUTTONLED.md |
| FBEHAV-SEVENSEG-D1 | C — new W3-final-cleanup task scheduled to last Relay-family W3 (delete stampG() if zero callers remain) | plan.md, PB-BEHAV-SEVENSEG.md |
| BATCH5-D1 | C — `BehavioralGateElement.setup()` extracted to W2.7 (real body); 7 gate W3 tasks now confirm-only | plan.md, 00-engine.md, 7 PB-BEHAV-{NOT,AND,NAND,OR,NOR,XOR,XNOR}.md |
| _stateOffset rename | Mechanical bulk rename to `_stateBase` across 17 component files | 17 PB-*.md |
| MEMR consistency | Already correct in 01-pin-mapping.md ("1× RES (state-dependent G)") — no edit needed | n/a |

### Outstanding (deferred to a follow-up session if any)

- **None from the original review.** All ROOT (R1–R15) and per-file Decision-Required items are landed.
- The `architectural-alignment.md` file remains absent — only the user can create it (per CLAUDE.md hard rule). All R10-affected specs were rewritten to avoid divergence rather than depend on the file.

### Notes for next session

- The W2 wave now has SIX named sub-tasks: W2.1–W2.5 (existing), W2.6 (createSegmentDiodeElement.setup), W2.7 (BehavioralGateElement.setup). Each W2.6/W2.7 paragraph in 00-engine.md §A3.2 contains the real body, not a stub.
- W4 gate is now a single-fixture gate (resistive-divider). Subsequent parity-fixture debugging is OUT OF SCOPE for the orchestrated implementation — the user takes over.
- The "Setup-mocking removal" sub-bullet text is identical across all 74 PB-* files — search any one for the canonical wording.
- Lock state at session end: all task and file locks released.

---

## Per-file Decision-Required items — historical (resolved in session 2 above)

### plan.md
| ID | Title | Severity |
|----|-------|----------|
| P-plan-D1 | W3 gate doesn't cover MCP/E2E surfaces (CLAUDE.md three-surface rule). Needs decision: explicit three-surface gate per component, batch gate at W4, or argue existing E2E suffices. | major |
| P-plan-D2 | A7 "no allocElement from load()" verifiability. Resolved partially via P-plan-M3 (manual grep replaced with test-enforced gate description); needs verification that the actual A7-convention test exists/will exist. | major |

### 01-pin-mapping.md
| ID | Title | Severity |
|----|-------|----------|
| P-pinmap-D1 | Wrong primary file path for MnaModel: `src/solver/analog/types.ts` vs actual `src/compile/types.ts`. Mech-leaning. | major |
| P-pinmap-D2 | NFET/PFET ngspiceNodeMap uses `G: "ctrl"` but `"ctrl"` is not in the verification allowlist (which is ngspice-derived). Resolve: add to allowlist, drop G from map, or mark NFET/PFET as 'no top-level map'. | major |
| P-pinmap-D3 | NMOSFET/PMOSFET map values use JFET-style names ("gate"/"drain"/"source") but ngspice MOS1 fields are single-letter (`d`/`g`/`s`/`b`). Allowlist's stated ngspice-derived provenance is inaccurate. Resolve: accept current vocab + fix provenance claim, or use MOS-accurate single letters. | minor |
| P-pinmap-D4 | CCCS hasBranchRow not stated → resolved via R2 (hasBranchRow dropped entirely; CCCS branch-presence inferred from `branchIndex`). No further action. | n/a |

### 02-behavioral.md
| ID | Title | Severity |
|----|-------|----------|
| P-behav-D6 | Per-task verification gate uses placeholder paths (`<file>.test.ts` with wildcards). Resolve: enumerate exact test-file paths per component group, or add a self-discovering grep instruction. | minor |
| P-behav-D7 | Shape rule 1 `if (!this._loaded) return` early-return guard may break existing load() if _loaded=false pins still allocate diagonal handle. Resolve: keep guard + match in load(), or remove guard + always allocate. | minor |
| P-behav-D8 | Combinational element field names (BehavioralMuxElement, BehavioralDemuxElement, BehavioralDecoderElement) not verified for Shape rule 3 applicability. Resolve: enumerate exact field names per class, or add directive to read class definition. | info |

### Component specs
| ID | File | Title | Severity |
|----|------|-------|----------|
| FSCHOTTKY-D1 | PB-SCHOTTKY | Missing dedicated test file in verification gate; spec cites schottky.test.ts which doesn't exist. Resolve: create dedicated test file or redirect gate to spice-model-overrides-prop.test.ts. | major |
| FTUNNEL-D1 | PB-TUNNEL | VCCS handle access mechanism unspecified — load() reaches into private _h* fields on VCCS sub-element. Resolve: direct cross-class field access (Option A), expose readonly accessor on VCCS (Option B), or TunnelDiode owns own setup/load (Option C). | major |
| FFGNFET-D1, FFGPFET-D1 | PB-FGNFET, PB-FGPFET | State-slot ordering rationale claimed via `ngspiceLoadOrder` is unverifiable (spec doesn't state CAP and MOS ngspiceLoadOrder values). Resolve: state explicit values, or remove rationale and rely on explicit construction order. | major |
| BATCH4-D2 | PB-COMPARATOR/SCHMITT/OPAMP/REAL_OPAMP/TIMER555 | Verification gates lack minimum assertion requirements. Resolve: add minimum assertion (`init() + _setup()` + insertion-order length check), or treat stamp-order test as sufficient. | major |
| FBEHAV-BUTTONLED-D1 | PB-BEHAV-BUTTONLED | ButtonLED depends on SEVENSEG completing (createSegmentDiodeElement.setup()) — intra-W3 sequential dependency contradicts plan's "W3 can land in any order". Resolve: assign ownership to BUTTONLED, extract to W2/W2.5, or merge SEVENSEG and BUTTONLED into single task. | major |
| FBEHAV-BUTTONLED-D2 | PB-BEHAV-BUTTONLED | cathode=0 claim needs verification (referenced in batch-5 summary, body not expanded by review agent — agent inconsistency). | minor |
| FBEHAV-SEVENSEG-D1 | PB-BEHAV-SEVENSEG | stampG survival rule ambiguous (referenced in batch-5 summary, body not expanded by review agent — agent inconsistency). | minor |
| BATCH5-D1 | PB-BEHAV-AND/NAND/OR/NOR/XOR/XNOR/NOT | Shared `BehavioralGateElement.setup()` write-race when 7 W3 agents run in parallel. Resolve: designate single owner (NOT, AND), or move setup() to W2/W2.5. | major |
| BATCH3-D2 | PB-RELAY (resolved via R10), PB-OPTO (resolved via R10) | Coil-R + CCCS coupling positions had no ngspice anchor → resolved via R10 architectural rewrites. | n/a |
| FDIAC-D1 | PB-DIAC | Sub-element posPrimeNode identity when RS=0 not explicitly stated. Resolve: add conditional text inline, or cross-reference PB-DIO. | major |
| FSCR-D2 | PB-SCR | scr.test.ts assertion specification missing — gate currently only requires file to be GREEN. Resolve: assert specific stamp sequence in scr.test.ts, or treat stamp-order test as sufficient. | major |

### Cross-cutting
| ID | Title | Severity |
|----|-------|----------|
| BATCH1-D2 | Ground-skip guard policy is inconsistent across passive specs (some guard `(aNode !== 0)`, some don't; engine behavior of `allocElement(0, x)` is unstated). Resolve: allocElement silently skips ground (remove guards), allocElement is unsafe (add guards everywhere), or guard only when shunt structurally possible. | minor |
| 01-pin-mapping inconsistency | MEMR is described as "1× VCCS" in 01-pin-mapping.md but PB-MEMR.md says "1× RES (state-dependent G)". Coordinator note from `imp-misc-passives` flagged this for separate fix. Resolve: update 01-pin-mapping.md MEMR row from VCCS → RES. | minor |

---

## Aggregation notes for next-session pickup

1. **Combined report is the source of truth**: `spec/reviews/spec-review-combined.md` lists all ROOT decisions and per-file findings with options A/B/C and pros/cons. Cross-reference IDs (`P-plan-D1`, `FXFMR-D1`, etc.) are stable.

2. **Per-batch reports** (`setup-load-split-{plan,00-engine,01-pin-mapping,02-behavioral,batch-1-passives,batch-2-sources,batch-3-semis-a,batch-4-actives,batch-5-behav}.md`) contain the full per-finding option enumerations for any item that needs more detail than the combined report's compact index.

3. **Implementer agent prompts**: each implementer task in this session was scoped to a specific file group. To re-run a task or compose a new one, follow the same pattern (file ownership disjoint, per-edit specifications, lock-aware).

4. **Lock state**: as of this snapshot, all `spec/.locks/tasks/*` are released. R2 was the only stale lock cleared (user-authorized) in this session.

5. **Outstanding blockers** before W3 implementation can begin in earnest:
   - All "pending" Decision-Required items above (none are critical — most are major or minor refinements)
   - `_stateOffset` → `_stateBase` rename cleanup (mechanical, listed above)
   - W2.5 wave (newly added in this session) needs its actual implementation: factory-closure-to-class refactor + field renames in `src/solver/analog/digital-pin-model.ts` and call sites. The spec contract is ready; the implementation is a separate work stream.
   - W2 stub spec (added §A3.2 in this session) is now ready to drive W2 implementer agents.

6. **Verification gate**: nothing in the resolved set has been verified by a separate verifier pass. Per CLAUDE.md "Verification Gate" rule, verifier agents should run on each batch of spec edits to confirm the implementer's output matches the user's chosen option. This was not done in this session due to volume; recommended for next session.

7. **Prior reports note**: the materialize-context.sh script's hook side-effect deleted `spec/reviews/phase-0..8.md` at session start (root cause unclear). Files are recoverable via `git checkout HEAD -- spec/reviews/`. The new `setup-load-split-*` reports are independent and do not interfere.
