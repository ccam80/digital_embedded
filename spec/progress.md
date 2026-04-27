
## Task R3: makeCur non-idempotent + element-level guard everywhere — SKIPPED (file lock conflict)
- **Status**: skipped
- **Agent**: implementer
- **Reason**: All 4 target files held by task lock R2-drop-hasBranchRow after 5s retry. Per protocol: released R3 task lock, no file locks were acquired.
- **Files that need editing**: `spec/setup-load-split/00-engine.md`, `spec/setup-load-split/components/PB-VCVS.md`, `spec/setup-load-split/components/PB-CCVS.md`, `spec/setup-load-split/plan.md`
- **No other tasks available in this wave assignment**

## Task R6-hybrid-cross-element-setter-apis: Cross-element setter APIs (spec edits)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `spec/setup-load-split/components/PB-SW.md` — Added §Public API with `setCtrlVoltage(v)` and `setSwState(on)` method specs including field declarations and reset-after-load semantics
  - `spec/setup-load-split/components/PB-ANALOG_SWITCH.md` — Added cross-reference comments on both `setCtrlVoltage` calls (SPST and SPDT NO path); replaced SPDT NC path `-vCtrl` negation with explicit `setSwState(ncOn)` pattern using threshold comparison (Option A from FANALOG_SWITCH-D2)
  - `spec/setup-load-split/components/PB-NFET.md` — Renamed `setControlVoltage` to `setCtrlVoltage` with cross-reference comment
  - `spec/setup-load-split/components/PB-PFET.md` — Renamed `setControlVoltage` to `setCtrlVoltage` with cross-reference comment
  - `spec/setup-load-split/components/PB-TIMER555.md` — Replaced `setOutputVoltage(vOut)` with `setParam("vOH", vOut)` + `setLogicLevel(q)` pattern; added hot-loadable-params note
  - `spec/setup-load-split/components/PB-SCR.md` — Replaced `setPinNode("X", node)` calls with `pinNodeIds = [B, C, E]` array assignments; added note about no `setPinNode` API on AnalogElementCore
  - `spec/setup-load-split/components/PB-TRIAC.md` — Replaced all 4× `setPinNode` call blocks with `pinNodeIds = [B, C, E]` array assignments for Q1–Q4; added note
- **Tests**: N/A (spec-only edits — no code files modified)

## Task R5: Extend LoadContext with state0/state1 (ngspice-aligned)
- **Status**: partial
- **Agent**: implementer
- **Files created**: none
- **Files modified**: none
- **Tests**: N/A (spec-only edits)
- **If partial — remaining work**: All file locks for this task (spec/setup-load-split/00-engine.md, PB-ADC.md, PB-OPTO.md, PB-SCHMITT.md, PB-TIMER555.md, PB-COMPARATOR.md, PB-REAL_OPAMP.md, PB-NTC.md) were held by task R2-drop-hasBranchRow at the time this implementer ran. After two retry attempts (5s apart), all locks remained BUSY. Task was skipped per lock protocol. A fresh implementer must acquire locks after R2 completes and implement: (1) Add state0/state1 fields to LoadContext in 00-engine.md with accompanying paragraph on state-vector access pattern; (2) Add _stateBase field declaration to AnalogElementCore interface in 00-engine.md §A3; (3) Replace pool.states[0]/pool.states[1] references with ctx.state0/ctx.state1 and rename _stateOffset → _stateBase in PB-ADC.md, PB-OPTO.md, PB-SCHMITT.md, PB-TIMER555.md, PB-COMPARATOR.md, PB-REAL_OPAMP.md; (4) Fix PB-NTC.md §load() body to remove the incorrect claim about ctx.temp not being on LoadContext — replace with direct ctx.temp read statement.

## Task R14: PB-COMPARATOR / PB-OPAMP keep VCVS architecture, rOut=75 default, flag regression risk
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `spec/setup-load-split/components/PB-COMPARATOR.md`
  - `spec/setup-load-split/components/PB-OPAMP.md`
- **Tests**: N/A (spec-only edits, no source code changed)
- **Summary of changes**:
  - Edit 1 (PB-COMPARATOR.md §Sub-element decomposition): Added "Behavioral regression risk (FCOMP-D1, FCOMP-D2 resolution)" paragraph after the VCVS description — 3-step pre/post run protocol + hot field declarations for `_latchActive` and `rSat`.
  - Edit 2 (PB-OPAMP.md §Construction): Added "Default rOut=75 — behavioral change warning (FOPAMP-D2 resolution)" paragraph after the factory body sketch — 3-step run protocol with three user-decision options.
  - Edit 3a (PB-COMPARATOR.md): Added "Pre-implementation checklist (W3 implementer)" section before §Verification gate — baseline capture, assertion identification, and escalation requirement.
  - Edit 3b (PB-OPAMP.md): Added "Pre-implementation checklist (W3 implementer)" section before §Verification gate — baseline capture, 75Ω load-current shift identification, and no-silent-fix escalation requirement.

## Task FXFMR-D1: MutualInductorElement stores l1/l2 at construction — SKIPPED (file lock conflict)
- **Status**: skipped
- **Agent**: implementer
- **Reason**: File lock for `spec/setup-load-split/components/PB-XFMR.md` was held by task R2-drop-hasBranchRow after two attempts (5s apart). Per protocol: released FXFMR-D1 task lock, no file locks were acquired.
- **Files that need editing**: `spec/setup-load-split/components/PB-XFMR.md`
- **No other tasks available in this wave assignment**

## Task FTRIODE-D1: PB-TRIODE 6-handle setup — SKIPPED (file lock conflict)
- **Status**: skipped
- **Agent**: implementer
- **Reason**: Both target files (`spec/setup-load-split/components/PB-TRIODE.md` and `spec/setup-load-split/plan.md`) held by task R2-drop-hasBranchRow after 5s retry (two attempts). Per protocol: released FTRIODE-D1 task lock, no file locks were acquired.
- **Files that need editing**: `spec/setup-load-split/components/PB-TRIODE.md`, `spec/setup-load-split/plan.md`
- **No other tasks available in this wave assignment**

## Task VSRC-family-combined-R2-R3-R4: Drop hasBranchRow / idempotency guards / findBranchFor standardization
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - spec/setup-load-split/components/PB-VSRC-DC.md
  - spec/setup-load-split/components/PB-VSRC-AC.md
  - spec/setup-load-split/components/PB-VSRC-VAR.md
  - spec/setup-load-split/components/PB-VCVS.md
  - spec/setup-load-split/components/PB-CCVS.md
  - spec/setup-load-split/components/PB-CCCS.md
  - spec/setup-load-split/components/PB-VCCS.md
  - spec/setup-load-split/components/PB-IND.md (no edit — guard already present, findBranchFor instance-bound acceptable per spec)
  - spec/setup-load-split/components/PB-CRYSTAL.md
- **Tests**: N/A (spec-only edits; no code tests written)
- **Edit summary**:
  - R2: Removed `hasBranchRow: true` line and associated prose from PB-VCVS; removed `hasBranchRow omitted` lines from PB-CCCS and PB-VCCS factory cleanup sections
  - R3: Wrapped unconditional `ctx.makeCur` in `if (this.branchIndex === -1)` guard in PB-VCVS (citation: vcvsset.c:41-44) and PB-CCVS (citation: ccvsset.c:58-62); removed idempotency-via-ctx.makeCur prose; PB-VSRC-DC/AC/VAR/IND/CRYSTAL guards already present — no edit
  - R4: Replaced free-variable `instance.*` bodies in PB-VSRC-DC/AC/VAR findBranchFor with standardized ctx.findDevice pattern; replaced type-narrowing bodies in PB-VCVS/CCVS findBranchFor with standard pattern; PB-IND instance-bound pattern left as acceptable per spec
  - R12/FCRYSTAL-D1: PB-CRYSTAL findBranchFor replaced with ctx.findDevice pattern; "implementer should verify" instruction removed
  - R12/FCRYSTAL-D2: State slots section replaced — broken "Ls contributes 5, Cs contributes 5, C0 contributes 5" framing dropped; replaced with single grounded statement referencing CRYSTAL_SCHEMA; `_stateOffset` renamed to `_stateBase` throughout setup() body and fields declaration

## Task MEGA-00-engine-edits: 00-engine.md MEGA edit (R2/R3/R4/R5/R9-D2/Engine-D4/Engine-D5/FREALOP-D1)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: spec/setup-load-split/00-engine.md
- **Tests**: N/A (spec-only edit, no code changed)
- **Edits applied**:
  1. Edit 1 (R2): Replaced §A3.1 "Branch-row tracking" paragraph — updated hasBranchRow drop note to match specified text.
  2. Edit 2 (R3): Removed idempotent JSDoc from makeCur in §A2 interface; added non-idempotent prose block with guard pattern and ngspice anchors after the interface closing brace.
  3. Edit 3 (R4): Replaced _findBranch body in §A4.2 to use _deviceMap lookup instead of _registeredMnaModels; removed _registeredMnaModels bullet from engine state additions; added findBranchFor? optional method and _stateBase field to AnalogElementCore in §A3.
  4. Edit 4 (R5): Added §A5.5 documenting LoadContext.state0/state1 fields with state-vector access prose and temp note; _stateBase already added to §A3.
  5. Edit 5 (R9-D2): Replaced _insertionOrder reset sentence in §A1.7 with full Lifetime paragraph specifying _resetForAssembly() does NOT touch it.
  6. Edit 6 (Engine-D4): Added _poolBackedElements field declaration and constructor change paragraph to §A5.1.
  7. Edit 7 (Engine-D5): Added A9 test pattern paragraph with (engine as any)._setup() escape hatch and rationale.
  8. Edit 8 (FREALOP-D1): Inserted new §A6.4 "Sub-element ordering rule"; renumbered existing §A6.4→§A6.5, §A6.5→§A6.6(omitted), §A6.6→§A6.7 Topology, §A6.6→§A6.8 ConcreteCompiledAnalogCircuit.

## Task R12-source-read-gap-fixes: R12 source-read gap fixes for behavioral specs + SEVENSEGHEX dedicated factory
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - spec/setup-load-split/components/PB-BEHAV-SEVENSEGHEX.md
  - spec/setup-load-split/components/PB-BEHAV-SPLITTER.md
  - spec/setup-load-split/components/PB-BEHAV-MUX.md
  - spec/setup-load-split/components/PB-BEHAV-DECODER.md
- **Tests**: N/A (spec-only edits, no code changes)
- **Summary of edits applied**:
  - SEVENSEGHEX: entire body replaced with dedicated `createSevenSegHexAnalogElement` factory spec (new distinct factory, BCD decode in load(), 8 SegmentDiodeElement instances, W3 verification gate, migration note, source-read exception, ngspice anchor: NONE)
  - SPLITTER: load() body pseudocode with internal field names replaced with behavioral description (no concrete field names; references post-W2.5 naming convention)
  - MUX: `COMBINATIONAL_COMPOSITE_SCHEMA is empty` reference in State pool section replaced with behavioral description of no-own-state-slots; COMBINATIONAL_COMPOSITE_SCHEMA dropped as spec contract (retained only in an e.g. parenthetical in the advisory sentence per the task-prescribed replacement text)
  - DECODER: same State pool replacement as MUX; test file path verified correct (`src/solver/analog/__tests__/behavioral-combinational.test.ts`)
  - No `hasBranchRow` lines found or needed to remove in any file

## Task pb-remaining-hasBranchRow: Pure R2 hasBranchRow drops across remaining PB-* files
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - spec/setup-load-split/components/PB-ADC.md
  - spec/setup-load-split/components/PB-ANALOG_SWITCH.md
  - spec/setup-load-split/components/PB-BJT.md
  - spec/setup-load-split/components/PB-DIAC.md
  - spec/setup-load-split/components/PB-DIO.md
  - spec/setup-load-split/components/PB-FGNFET.md
  - spec/setup-load-split/components/PB-FGPFET.md
  - spec/setup-load-split/components/PB-ISRC.md
  - spec/setup-load-split/components/PB-NFET.md
  - spec/setup-load-split/components/PB-NJFET.md
  - spec/setup-load-split/components/PB-NMOS.md
  - spec/setup-load-split/components/PB-OTA.md
  - spec/setup-load-split/components/PB-PFET.md
  - spec/setup-load-split/components/PB-PJFET.md
  - spec/setup-load-split/components/PB-PMOS.md
  - spec/setup-load-split/components/PB-SCHOTTKY.md
  - spec/setup-load-split/components/PB-SCR.md
  - spec/setup-load-split/components/PB-SPARK.md
  - spec/setup-load-split/components/PB-SUBCKT.md
  - spec/setup-load-split/components/PB-SW-DT.md
  - spec/setup-load-split/components/PB-SW.md
  - spec/setup-load-split/components/PB-TRANSGATE.md
  - spec/setup-load-split/components/PB-TRIAC.md
  - spec/setup-load-split/components/PB-TUNNEL.md
  - spec/setup-load-split/components/PB-VARACTOR.md
  - spec/setup-load-split/components/PB-ZENER.md
- **Tests**: N/A (spec-only edits, no code changed)
- **If partial — remaining work**: none

## Task R10: Rewrite PB-TLINE, PB-OPTO, PB-RELAY, PB-RELAY-DT to avoid architectural divergence
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `spec/setup-load-split/components/PB-TLINE.md`
  - `spec/setup-load-split/components/PB-OPTO.md`
  - `spec/setup-load-split/components/PB-RELAY.md`
  - `spec/setup-load-split/components/PB-RELAY-DT.md`
- **Tests**: N/A (spec-only edits; no code changed)
- **Summary**:
  - PB-TLINE: full rewrite as ideal-TRA flat element. Drops lumped RLCG model. Documents exact 22-stamp TSTALLOC sequence from trasetup.c:71-92 with all handle field names. 4 internal nodes (brEq1, brEq2, intNode1, intNode2) per trasetup.c:37-59. ngspiceNodeMap { inP:"pos1", inN:"neg1", outP:"pos2", outN:"neg2" }.
  - PB-OPTO: replaces digiTS-internal CCCS coupling (hBaseAnode/hBaseCathode) with 4 named sub-elements: dLed (DIO) + vSense (VSRC 0V in series for current sensing) + cccsCouple (CCCS, gain=CTR) + bjtPhoto (BJT). No composite-level allocElement calls remain. Adds _nSenseMid internal node.
  - PB-RELAY: coil resistance extracted from IND coil into separate coilR (RES) sub-element. 3 sub-elements: coilL (IND, 5 stamps) + coilR (RES, 4 stamps) + contactSW (SW, 4 stamps) = 13 entries total, all ngspice-anchored. Adds _nCoilMid internal node. Removes old hRpp/hRnn/hRpn/hRnp handle fields from IND coil.
  - PB-RELAY-DT: same as PB-RELAY plus second contact. 4 sub-elements: coilL + coilR + swNO + swNC = 17 entries (5+4+4+4), all ngspice-anchored. Adds _nCoilMid internal node.

## Task actives-combined-r2-r5-frealop-d1: Actives combined — R2 (drop hasBranchRow) + R5 (state0/state1 access) + FREALOP-D1 (NGSPICE_LOAD_ORDER for OPAMP)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `spec/setup-load-split/components/PB-DAC.md`
  - `spec/setup-load-split/components/PB-COMPARATOR.md`
  - `spec/setup-load-split/components/PB-OPAMP.md`
  - `spec/setup-load-split/components/PB-REAL_OPAMP.md`
  - `spec/setup-load-split/components/PB-TIMER555.md`
  - `spec/setup-load-split/components/PB-SCHMITT.md`
  - `spec/setup-load-split/components/PB-ADC.md`
- **Tests**: N/A (spec-only edits — no TypeScript source modified, no tests to run)
- **Edits applied per file**:
  - PB-DAC.md: Edit 1 (R2 — dropped `hasBranchRow` from Factory cleanup)
  - PB-COMPARATOR.md: Edit 1 (R2 — dropped `hasBranchRow`); Edit 4 (FCOMP-D2 — `_latchActive` now derived from `ctx.state0[this._stateBase + OUTPUT_LATCH]`; `_p.rSat` declared as model parameter default 1.0Ω; `_stateOffset` → `_stateBase` in setup/load bodies)
  - PB-OPAMP.md: Edit 1 (R2 — dropped `hasBranchRow`); Edit 3 (FREALOP-D1 — setup() reordered: RES before VCVS per NGSPICE_LOAD_ORDER; added §A6.4 ordering note; verification gate updated to expect RES 4 entries then VCVS 6 entries when rOut > 0)
  - PB-REAL_OPAMP.md: Edit 1 (R2 — dropped `hasBranchRow`); Edit 7 (FREALOP-D3 — added `_inP`/`_inN` cached fields to construction; load() updated to use `this._inP`/`this._inN` instead of inline `_pinNodes.get()` calls)
  - PB-TIMER555.md: Edit 1 (R2 — dropped `hasBranchRow`); Edit 2 (R5 — `pool.states[0]` → `ctx.state0`, `_stateOffset` → `_stateBase` in setup/load bodies); Edit 5 (FTIMER-D2 — RS-FF glue handle `_hDisBaseDisBase` moved to AFTER outModel.setup() and CAP children; ordering rationale and verification gate updated)
  - PB-SCHMITT.md: Edit 1 (R2 — dropped `hasBranchRow: false`); Edit 2 (R5 — `this._pool.states[0]` → `ctx.state0`, `_stateOffset` → `_stateBase` in setup/load bodies)
  - PB-ADC.md: Edit 2 (R5 — `pool.states[0]` → `ctx.state0`, `_stateOffset` → `_stateBase` in setup/accept bodies); Edit 6 (FADC-D2 — added missing `const nEoc = this._pinNodes.get("EOC")!` in load(); FADC-D3 — added no-edge behavior paragraph after closing code block)

## Task imp-B-pinmap-edits: Apply 5 decisions to 01-pin-mapping.md
- **Status**: complete
- **Agent**: implementer (imp-B)
- **Files created**: none
- **Files modified**: spec/setup-load-split/01-pin-mapping.md
- **Tests**: n/a (spec-only edit, no tests run per instructions)
- **Decisions applied**:
  - DECISION 1 (P-pinmap-M1): already-landed — line 226 already reads "A9's `setup-stamp-order.test.ts`"
  - DECISION 2 (P-pinmap-D1): heading changed to "### `src/compile/types.ts` — `MnaModel`" with hedge parenthetical removed
  - DECISION 3 (MEMR): no-op — only Memristor reference (line 102) already correctly says RES; no stray VCCS-attached-to-memristor references exist anywhere in the file
  - DECISION 4 (P-pinmap-D2): NFET and PFET rows updated to `{ G: "contPos", D: "pos", S: "neg" }` with the full VCVS/VCCS controlling-pair parenthetical
  - DECISION 5 (P-pinmap-D3): NMOSFET/PMOSFET maps changed to single-letter `{ G: "g", S: "s", D: "d" }` / `{ G: "g", D: "d", S: "s" }` with MOS1bNode parenthetical; Verification §3 allowlist extended with `"d"`, `"g"`, `"s"`, `"b"` and an explanatory clause that JFET keeps long names per `jfet/jfetset.c` while MOSFET uses single letters per `mos1/mos1set.c`

## Task PB-SCHOTTKY-D2: _stateOffset rename + verification-gate fix
- **Status**: complete
- **Agent**: implementer (imp-D2)
- **Files created**: (none)
- **Files modified**: spec/setup-load-split/components/PB-SCHOTTKY.md
- **Tests**: n/a (spec-only edit)
- **Notes**: Renamed 2 occurrences of `_stateOffset` to `_stateBase` (zero remaining confirmed via Grep). Replaced verification-gate item 2 with detailed creation requirement + assertions for `src/components/semiconductors/__tests__/schottky.test.ts`. Items 1 and 3 preserved untouched.

## Task P-behav-D6-D7-D8: Apply imp-C decisions to spec/setup-load-split/02-behavioral.md
- **Status**: complete
- **Agent**: implementer (imp-C)
- **Files created**: (none)
- **Files modified**: spec/setup-load-split/02-behavioral.md
- **Tests**: n/a (spec-only edit, no test run required by task)
- **Notes**: Applied D6 (concrete test-path table in W3 verification gate), D7 (removed `_loaded` guard from Shape rule 1 setup() body and added rationale; Shape rule 2 had no `_loaded` guard so no edit there), D8 (per-class field-name table from reading `src/solver/analog/behavioral-combinational.ts`).

## Task FTUNNEL-D1-impE: VCCS readonly stamps accessor + PB-TUNNEL destructure
- **Status**: complete
- **Agent**: implementer (imp-E)
- **Files created**: none
- **Files modified**: spec/setup-load-split/components/PB-VCCS.md, spec/setup-load-split/components/PB-TUNNEL.md
- **Tests**: n/a (spec-only edits, no code or tests touched)
- **Notes**:
  - PB-VCCS.md: added new `## VccsAnalogElement.stamps — readonly accessor for composite users` subsection between `## TSTALLOC sequence`/`setup() body` and `## load() body — value writes only`. Defines a readonly `get stamps()` returning `{ hPosCPos, hPosCNeg, hNegCPos, hNegCNeg }`.
  - PB-TUNNEL.md: in §"load() body — value writes only", replaced the four `this._vccs._hPosCPos|_hPosCNeg|_hNegCPos|_hNegCNeg` direct private-field access lines with a single `const { hPosCPos, hPosCNeg, hNegCPos, hNegCNeg } = this._vccs.stamps;` destructure plus `solver.stampElement(hPosCPos, +g)` etc. using the local consts. No encapsulation-violation rationale commentary was present in the file, so no commentary deletion was required.
  - Out-of-scope observation (NOT modified): PB-VCCS.md's setup() body block currently uses different field names `_hPCtP/_hPCtN/_hNCtP/_hNCtN` while the FTUNNEL-D1 decision (and the new accessor body) reads from `_hPosCPos/_hPosCNeg/_hNegCPos/_hNegCNeg`. The accessor as written matches the user's exact-quoted decision text. The PB-VCCS setup() body field naming inconsistency was outside this task's scope.

## Task imp-D1: bulk rename _stateOffset -> _stateBase
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: spec/setup-load-split/components/PB-TLINE.md, PB-POLCAP.md, PB-ZENER.md, PB-VARACTOR.md, PB-SW.md, PB-SPARK.md, PB-PMOS.md, PB-PJFET.md, PB-NMOS.md, PB-NJFET.md, PB-DIO.md, PB-BJT.md, PB-ANALOG_SWITCH.md, PB-XFMR.md, PB-CAP.md, PB-IND.md (16 files, replace_all)
- **Tests**: pure mechanical doc rename — no test execution required; verified zero remaining _stateOffset occurrences in components directory.

## Task FFGNFET-D1 + FFGPFET-D1: Explicit ngspiceLoadOrder values
- **Status**: complete
- **Agent**: implementer
- **Files created**: (none)
- **Files modified**: spec/setup-load-split/components/PB-FGNFET.md, spec/setup-load-split/components/PB-FGPFET.md
- **Tests**: n/a (spec-only edits)
- **Decision applied**: Option A — replaced vague "CAP first, then MOS" claim with concrete `NGSPICE_LOAD_ORDER.CAP = 17` and `NGSPICE_LOAD_ORDER.MOS = 35` values from `src/core/analog-types.ts:53-71`. Updated setup() body code blocks in both specs to use sort-by-ngspiceLoadOrder idiom rather than hard-coded `_cap.setup(ctx); _mos.setup(ctx);` ordering.

## Task PB-DIAC-rs0-alias: Add RS=0 posPrimeNode alias rule (ngspice diosetup.c:204-208)
- **Status**: complete
- **Agent**: implementer
- **Files created**: (none)
- **Files modified**: spec/setup-load-split/components/PB-DIAC.md
- **Tests**: n/a (markdown spec edit)

## Task imp-K-buttonled: BUTTONLED decisions (FBEHAV-BUTTONLED-D1, D2)
- **Status**: complete
- **Agent**: implementer
- **Files created**: (none)
- **Files modified**:
  - spec/setup-load-split/plan.md
  - spec/setup-load-split/00-engine.md
  - spec/setup-load-split/components/PB-BEHAV-BUTTONLED.md
  - spec/setup-load-split/components/PB-BEHAV-SEVENSEG.md
- **Tests**: N/A (spec-edit task, no executable changes)
- **Summary**:
  - DECISION 1 (D1): added W2.6 task line in plan.md §"Wave plan" extracting `createSegmentDiodeElement.setup()` body to W2; added matching exception paragraph in 00-engine.md §A3.2 specifying the real setup body (with BATCH1-D2 Option C guard policy reference); rewrote dependency sections in PB-BEHAV-BUTTONLED.md and PB-BEHAV-SEVENSEG.md to point at W2.6 ownership rather than cross-task race.
  - DECISION 2 (D2): replaced contradictory "ButtonLED where cathode could be non-zero in future variants" justification (previously in PB-BEHAV-SEVENSEG.md lines 35 and 139) with positive grounding in BATCH1-D2 Option C / engine spec §A6.6, asserting the guard is permanent and not removable in future variants. Same one-line note added to PB-BEHAV-BUTTONLED.md "Pin model TSTALLOCs" section.

## Task FSCR-D2-imp-J5: Setup-mocking removal sub-bullet for 15 PB-* files
- **Status**: skipped (lock conflict)
- **Agent**: implementer (imp-J5)
- **Files created**: none
- **Files modified**: none
- **Tests**: not run (no edits made)
- **Conflict**: All 15 target file locks held by peer task `BATCH4-D2-impJ` (timestamps 2026-04-27T22:25:18..22+12:00). Retried once after 5s — still BUSY. Per lock-protocol Conflict Handling, skipped task without acquiring locks. Note: the peer task name `BATCH4-D2-impJ` overlaps with my assigned task scope — coordinator may have assigned the same 15 files twice. The peer is actively editing these files; either it will append the same sub-bullet (in which case my task is duplicate), or coordinator should reassign me to a non-overlapping scope after it completes.

## Task FSCR-D2-imp-J1: Append "Setup-mocking removal" sub-bullet to 8 PB-BEHAV-* spec files
- **Status**: complete
- **Agent**: implementer (imp-J1)
- **Files created**: (none)
- **Files modified**:
  - spec/setup-load-split/components/PB-BEHAV-DRIVER.md
  - spec/setup-load-split/components/PB-BEHAV-DRIVERINV.md
  - spec/setup-load-split/components/PB-BEHAV-GROUND.md
  - spec/setup-load-split/components/PB-BEHAV-DEMUX.md
  - spec/setup-load-split/components/PB-BEHAV-SEVENSEGHEX.md
  - spec/setup-load-split/components/PB-BEHAV-SPLITTER.md
  - spec/setup-load-split/components/PB-BEHAV-MUX.md
  - spec/setup-load-split/components/PB-BEHAV-DECODER.md
- **Tests**: N/A (spec-only edits)
- **Notes**: Sub-bullet wording is identical across all 8 files. For PB-BEHAV-GROUND, the verification gate did not previously name a `*.test.ts` file; per assignment instructions, added a new item naming `behavioral-remaining.test.ts` (since `behavioral-ground.test.ts` does not exist) and placed the sub-bullet under it. Renumbered subsequent items (3, 4) accordingly. For all other 7 files, the sub-bullet was placed directly under the existing item that names the test file (item 1 in each case).

## Task PB-TUNNEL-fix (imp-N): SKIPPED — file lock conflict
- **Status**: skipped
- **Agent**: implementer (imp-N)
- **Reason**: spec/setup-load-split/components/PB-TUNNEL.md is held by BATCH4-D2-impJ (lock acquired 2026-04-27T22:25:23+12:00). Retried after 5s wait, still busy.
- **Assignment scope**: single file only — no alternative tasks available for self-continuation.
- **Locks released**: task lock PB-TUNNEL-fix released; no file locks were ever acquired.

## Task FSCR-D2-setup-mock-removal (imp-J2): Append Setup-mocking removal sub-bullet to 14 PB-* files — SKIPPED (file lock conflict)
- **Status**: skipped
- **Agent**: implementer (imp-J2)
- **Reason**: All 14 target file locks held by active task `BATCH4-D2-impJ` after 5s retry. Per lock protocol: released task lock, no file locks were acquired.
- **Files that need editing** (append the FSCR-D2 setup-mock-removal sub-bullet immediately under the item that names the component test file in §"Verification gate"):
  - `spec/setup-load-split/components/PB-RES.md` — under item 2 (`src/components/passives/__tests__/resistor.test.ts`), §"Verification gate" line 75
  - `spec/setup-load-split/components/PB-CAP.md` — under item 2 (`src/components/passives/__tests__/capacitor.test.ts`), §"Verification gate" line 89
  - `spec/setup-load-split/components/PB-IND.md` — under item 2 (inductor test file), §"Verification gate" line 124
  - `spec/setup-load-split/components/PB-AFUSE.md` — under item 2 (`src/components/passives/__tests__/analog-fuse.test.ts`), §"Verification gate" line 97
  - `spec/setup-load-split/components/PB-LDR.md` — under item 2 (`src/components/sensors/__tests__/ldr.test.ts`), §"Verification gate" line 96
  - `spec/setup-load-split/components/PB-CRYSTAL.md` — under item 2 (Crystal test file), §"Verification gate" line 220
  - `spec/setup-load-split/components/PB-FUSE.md` — under item 2 (`src/components/switching/__tests__/fuse.test.ts`), §"Verification gate" line 106
  - `spec/setup-load-split/components/PB-NTC.md` — under item 2 (`src/components/sensors/__tests__/ntc-thermistor.test.ts`), §"Verification gate" line 100
  - `spec/setup-load-split/components/PB-MEMR.md` — under item 2 (Memristor test file), §"Verification gate" line 94
  - `spec/setup-load-split/components/PB-POT.md` — under item 2 (`src/components/passives/__tests__/potentiometer.test.ts`), §"Verification gate" line 106
  - `spec/setup-load-split/components/PB-TAPXFMR.md` — under item 2 (`src/components/passives/__tests__/tapped-transformer.test.ts`), §"Verification gate" line 171
  - `spec/setup-load-split/components/PB-POLCAP.md` — under item 2 (`src/components/passives/__tests__/polarized-cap.test.ts`), §"Verification gate" line 148
  - `spec/setup-load-split/components/PB-XFMR.md` — under item 2 (`src/components/passives/__tests__/transformer.test.ts`), §"Verification gate" line 205
  - `spec/setup-load-split/components/PB-TLINE.md` — under item 1 (`src/components/passives/__tests__/transmission-line.test.ts`; this file uses item 1 to name the component test file because item 2 is the setup-stamp-order check), §"Verification gate" line 195. PB-TLINE is currently BLOCKED — still add the sub-bullet so the spec contract is complete when the block lifts.
- **Sub-bullet text to append (verbatim, IDENTICAL in every file)**:

      - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.

- **No other tasks available in this wave assignment**

