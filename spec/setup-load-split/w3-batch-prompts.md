# W3 Per-Component Wave — Implementer Prompts

**Status:** PLANNED — awaiting user "go" signal. The in-flight "wave 2" agent (W2.5 stub-spread + factory-to-class conversions for switching/* and behavioral-*) must finish and `batch-3` must be fully verified before any of these can spawn. The hybrid-state hooks enforce this.

This document holds the full prompt body for each W3 implementer agent. The hybrid-state.json `batch-4` and `batch-5` entries reference these by `task_group_id`.

---

## Wave structure

- **Wave A — `batch-4`**, 9 task_groups (concurrent, all sonnet, all `run_in_background:true`).
- **Wave B — `batch-5`**, 9 task_groups (concurrent, all sonnet, all `run_in_background:true`). Spawns only after batch-4 fully verifies (every group_status == "passed").

**Excluded from this batch:**
- `PB-SUBCKT` / `subcircuit/*` — special structural decomposition path, not in standard component layer.
- `PB-BEHAV-{AND,NAND,NOT,NOR,OR,XOR,XNOR}` — already served by W2.7 `BehavioralGateElement.setup()` body landed in batch-3 group 3.A1. Per-gate `ngspiceNodeMap` registration is in scope of the in-flight wave-2 agent. Not in either wave.

---

## Master prompt — read this first (applies to every W3 agent)

> Every per-agent prompt below extends this master template. Read every section.

```text
# W3 Implementation Assignment — {agent_id}

You are a W3 per-component implementer for the setup/load split migration.

## Project
- **Root**: C:/local_working_projects/digital_in_browser
- **Spec dir**: spec/setup-load-split/
- **Master plan**: spec/setup-load-split/plan.md (Wave W3 section)
- **Engine contract**: spec/setup-load-split/00-engine.md (§A2 SetupContext, §A6 factory)
- **Pin maps**: spec/setup-load-split/01-pin-mapping.md (your component's row)

## Your scope — STRICT FILE LIST

You own ONLY these source files for setup() body migration:
{file_list}

You MUST read these PB-*.md spec files and port their setup() / load() bodies line-for-line:
{pb_spec_list}

## Core task — for each PB-*.md spec you own

1. Replace the W2 throw-stub `setup()` method body with the real body specified
   in the PB-*.md "setup() body — alloc only" section.
2. Move every `allocElement` call currently in `load()`, `accept()`, or the
   constructor of your owned element into the new `setup()` body. Cache each
   returned handle as a private instance field with the name listed in the
   PB-*.md TSTALLOC table ("digiTS handle" column).
3. Rewrite `load()` to write through the cached handles only. No new
   `allocElement` calls in load(). No new state allocations in load(). Per
   CLAUDE.md "SPICE-Correct Implementations Only" rule, port value-side
   equations from the cited ngspice load.c file line-for-line.
4. Apply factory cleanup per PB-*.md "Factory cleanup" section:
   - Drop `internalNodeIds` and `branchIdx` parameters (3-param signature
     `(pinNodes, props, getTime)` per A6.3)
   - Drop `branchCount` and `getInternalNodeCount` from MnaModel registration
     if present
   - Add `mayCreateInternalNodes: true` if the spec says so
   - Add `ngspiceNodeMap: {...}` to the ComponentDefinition per
     01-pin-mapping.md and PB-*.md "Pin mapping" section
   - Add `findBranchFor` callback if the spec says so (only for elements
     with branch rows: VSRC, VCVS, CCVS, IND, etc.)

## Hard boundaries — read every line

**TESTS ARE RED ACROSS THE PROJECT.** This is the expected W2/W3 intermediate
state described in plan.md "Half-state risk" section. Components without
migrated setup() bodies are throwing `"PB-${name} not yet migrated"`. DO NOT
attempt to fix red tests in files you do not own.

**Call-site fix scope:** You MAY edit call sites that invoke a function you
edited in your owned files (e.g., factory closures whose signature you changed
under A6.3). You MAY NOT touch any other file. If a call-site fix would
require changes to more than one extra file outside your owned set, STOP and
surface (see "Surface, don't chase").

**Forbidden:** reading existing digiTS component source for guidance
(plan.md L113-114). Port from the PB-*.md spec contract and ngspice anchor
files only. The existing TS source is OUT OF BOUNDS as a reference;
post-W3 review may compare against it if a divergence is suspected, but you
are not the post-W3 reviewer.

**Source of truth** is the `setup()` body listing in your PB-*.md file,
line-for-line, and the `setup-stamp-order.test.ts` row(s) for your component.
The TSTALLOC insertion order is a hard contract.

## Surface, don't chase

If you encounter ANY of the following, STOP, write a `CLARIFICATION NEEDED`
entry to spec/progress.md describing the issue precisely (file/line/spec
reference/exact failure), and call `stop-for-clarification.sh` as your final
bash command. DO NOT broaden scope to investigate.

- Spec ambiguity you cannot resolve from PB-*.md + 00-engine.md +
  01-pin-mapping.md alone
- A flow-on TypeScript error in a file outside your scope, beyond the
  call-site fix allowance
- A test failure in your owned component's test file that cannot be
  explained by spec compliance (e.g., a test asserts a stamp order or a
  value that contradicts the spec)
- An unexpected interaction with another component (e.g., your composite
  imports a sub-element that is itself stub-throwing — the in-flight
  wave-2 agent owns sub-element stubs)
- Any compile-time or runtime behavior that doesn't match what the spec
  predicts

You have NO scope to deviate from the spec, and NO scope to chase failures
into other files. The user decides what to do with surfaced issues.

## Banned closing verdicts (CLAUDE.md)

When discussing parity with ngspice, NEVER use these as closing verdicts:
*mapping*, *tolerance*, *equivalent to*, *pre-existing*, *intentional
divergence*, *citation divergence*, *partial*. If you would use one, STOP
and escalate per CLAUDE.md guidance — the item belongs in
spec/architectural-alignment.md (architectural divergence) or
spec/fix-list-phase-2-audit.md (numerical bug), not as an in-line
justification. Agents do not edit architectural-alignment.md.

## Test policy — DO NOT RUN TESTS

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split":

- DO NOT run tests. The full suite is RED by design at this stage of W3.
- DO NOT report numerical mismatches.
- DO NOT modify test files to "make tests pass".

Verification is strictly **spec compliance** against the PB-*.md spec
contract and the cited ngspice anchor file (e.g., `ressetup.c:46-49`).
PASS = your source code matches spec line-for-line. FAIL = source code
deviates from spec.

Your green-gate (replaces any "Verification gate" item in PB-*.md that
mentions test files — those are legacy and being mass-edited out):

1. `setup()` body matches the PB-*.md "setup() body — alloc only" listing
   line-for-line.
2. TSTALLOC sequence in your `setup()` matches the order in the cited
   ngspice anchor file (e.g., `ressetup.c:46-49` -> PP, NN, PN, NP).
3. Factory cleanup applied per PB-*.md "Factory cleanup": 3-param signature
   `(pinNodes, props, getTime)`, no `internalNodeIds`/`branchIdx`, drop
   `branchCount`/`getInternalNodeCount` if present.
4. `ngspiceNodeMap` registered per `01-pin-mapping.md` and PB-*.md
   "Pin mapping" section.
5. `load()` writes through cached handles only — zero `allocElement` calls.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND,
   etc.).
8. No banned closing verdicts in any commit/report.

Anyone tempted to "fix" a failing test must STOP and call
`stop-for-clarification.sh`. The user decides whether the test is wrong
(separate cleanup task) or whether the spec needs revision.

## Reporting

When finished, append a section to `spec/progress.md`:

  ## Task {agent_id}: {short title}
  - **Status**: complete | clarification-needed
  - **Files modified**: {list}
  - **PB-* specs ported**: {list}
  - **Spec-compliance audit**: {green-gate items 1-8 confirmed, or which failed}
  - **Surfaced issues**: {list of CLARIFICATION NEEDED items, or "none"}
  - **Unexpected flow-on**: {list, or "none"}
  - **Banned-verdict audit**: confirmed-clean | {what slipped}

Then call as your FINAL bash command:
  - `complete-implementer.sh` on a normal finish
  - `stop-for-clarification.sh` if you took the clarification exit

## Context files — read in this order

1. `CLAUDE.md` (project rules — non-negotiable)
2. `spec/.context/rules.md` (implementation rules)
3. `spec/.context/lock-protocol.md` (lock coordination)
4. `spec/setup-load-split/plan.md` (wave plan, especially W3 section)
5. `spec/setup-load-split/00-engine.md` (A2 SetupContext, A6 factory)
6. `spec/setup-load-split/01-pin-mapping.md` (your components' rows)
7. {pb_spec_list}
8. `spec/test-baseline.md` (pre-existing failures — DO NOT investigate)
9. `spec/progress.md` (to append your status / clarification entries)
```

---

## Wave A — `batch-4`

### 4.A.bjt

- **Owned files:** `src/components/semiconductors/bjt.ts`
- **PB specs:** `spec/setup-load-split/components/PB-BJT.md`
- **Notes for agent:**
  - PB-BJT covers BOTH NPN and PNP — the two are polarity-polymorphic per the
    PB-BJT "NPN/PNP polymorphism" section. setup() is polarity-independent;
    polarity sign is applied only in load().
  - 23 TSTALLOC entries — high-stamp-count, but mechanical. Substrate (entries
    19-21) stamps into ground (node 0) unconditionally per spec; do not
    conditionally skip.
  - Substrate-connection alias (entries 16/17 → `_hSubstConSubstCon`) is a
    pointer alias, NOT a new alloc.
  - `BJTm` multiplicity scaling on load — per PB-BJT note, the M parameter
    is partition: "instance".
- **Test file:** `src/components/semiconductors/__tests__/bjt.test.ts`

### 4.A.mosfet

- **Owned files:** `src/components/semiconductors/mosfet.ts`
- **PB specs:** `spec/setup-load-split/components/PB-NMOS.md`,
  `spec/setup-load-split/components/PB-PMOS.md`
- **Notes for agent:**
  - NMOS and PMOS are mechanical-replication twins under one MOSFET element
    class with polarity flag. Port the NMOS setup() body, then verify PMOS
    is structurally identical (polarity sign applies in load() only).
  - The mosfet.ts file may host SPICE level-1/2/3 model variants — only the
    setup() body is in scope here; ngspice-level fidelity differences live
    in load().
- **Test file:** `src/components/semiconductors/__tests__/mosfet.test.ts` (if
  present — read directory; if absent, surface).

### 4.A.jfet

- **Owned files:** `src/components/semiconductors/njfet.ts`,
  `src/components/semiconductors/pjfet.ts`
- **PB specs:** `spec/setup-load-split/components/PB-NJFET.md`,
  `spec/setup-load-split/components/PB-PJFET.md`
- **Notes for agent:**
  - Mechanical-replication twins. Port njfet.ts first, then pjfet.ts is the
    same structure with polarity flag.
- **Test files:** `src/components/semiconductors/__tests__/njfet.test.ts`,
  `src/components/semiconductors/__tests__/pjfet.test.ts` (if present).

### 4.A.diode

- **Owned files:**
  - `src/components/semiconductors/diode.ts`
  - `src/components/semiconductors/zener.ts`
  - `src/components/semiconductors/schottky.ts`
  - `src/components/semiconductors/varactor.ts`
- **PB specs:**
  - `PB-DIO.md` (base diode — 7 TSTALLOC, 1 conditional internal node, 5 state slots)
  - `PB-ZENER.md`
  - `PB-SCHOTTKY.md`
  - `PB-VARACTOR.md`
- **Notes for agent:**
  - The 4 diode-family elements share the DIO setup() topology with parameter
    differences (BV, IS, RS) — mechanical replication. Port PB-DIO.md
    completely, then apply the per-PB delta sections to the variants.
  - **Tunnel-diode is NOT in this group** — its topology is VCCS, not DIO,
    per plan.md "Resolved decisions" row. It is in 5.B.semi-other.
- **Test files:** the matching `__tests__/{name}.test.ts` files in
  `src/components/semiconductors/__tests__/`.

### 4.A.behav-remaining

- **Owned files:** `src/solver/analog/behavioral-remaining.ts`
- **PB specs:**
  - `PB-BEHAV-DRIVER.md`
  - `PB-BEHAV-DRIVERINV.md`
  - `PB-BEHAV-SPLITTER.md`
  - `PB-BEHAV-SEVENSEG.md`
  - `PB-BEHAV-SEVENSEGHEX.md`
  - `PB-BEHAV-BUTTONLED.md`
  - `PB-BEHAV-GROUND.md`
- **Notes for agent:**
  - Per plan.md W2.6, `createSegmentDiodeElement.setup()` body should already
    have been written by the in-flight wave-2 agent. If you find it still
    stub-throwing, that is a SURFACE (not a fix). Report the W2.6 gap and
    stop.
  - Per plan.md W2.5, all factory closures in this file should already be
    converted to classes implementing `AnalogElementCore`. If you find a
    surviving factory-closure pattern, SURFACE and stop.
  - PB-BEHAV-SEVENSEGHEX implementer note (plan.md L139-145) — the existing
    SevenSegHex pin-label resolution is fine if existing tests pass; you
    verify at W3 time, no new code if green.
- **Test file:** none direct (behavioral-remaining is exercised through
  component test files); rely on `setup-stamp-order.test.ts` rows + the
  parent component test files (e.g., `src/components/io/__tests__/*.test.ts`
  for SEVENSEG, BUTTONLED).

### 4.A.behav-combinational

- **Owned files:** `src/solver/analog/behavioral-combinational.ts`
- **PB specs:**
  - `PB-BEHAV-MUX.md`
  - `PB-BEHAV-DEMUX.md`
  - `PB-BEHAV-DECODER.md`
- **Notes for agent:**
  - Same factory-closure-to-class precondition as behav-remaining. Surface if
    not converted.
- **Test files:** `src/components/wiring/__tests__/{mux,demux,decoder}.test.ts`.

### 4.A.switching-fets

- **Owned files:** `src/components/switching/nfet.ts`,
  `src/components/switching/pfet.ts`
- **PB specs:** `PB-NFET.md`, `PB-PFET.md`
- **Notes for agent:**
  - Both NFET and PFET are composites that decompose to a single SW
    sub-element (PB-NFET §"Sub-element decomposition"). The composite's
    setup() forwards to `this._sw.setup(ctx)`.
  - SW sub-element setup() body is identical for both — pin map differs only
    in `D`/`S` role (PFET inverts polarity at load time).
  - PFET is mechanical replication of NFET; port NFET first.
- **Test files:** `src/components/switching/__tests__/{nfet,pfet}.test.ts`
  (if present).

### 4.A.switching-fgfets

- **Owned files:** `src/components/switching/fgnfet.ts`,
  `src/components/switching/fgpfet.ts`
- **PB specs:** `PB-FGNFET.md`, `PB-FGPFET.md`
- **Notes for agent:**
  - Floating-gate variants — same composite-to-SW pattern as NFET/PFET, with
    additional gate-capacitor sub-element per PB spec.
- **Test files:** matching `__tests__/{fgnfet,fgpfet}.test.ts` if present.

### 4.A.active-opamps

- **Owned files:**
  - `src/components/active/opamp.ts`
  - `src/components/active/real-opamp.ts`
  - `src/components/active/ota.ts`
  - `src/components/active/comparator.ts`
  - `src/components/active/schmitt-trigger.ts`
- **PB specs:**
  - `PB-OPAMP.md` (composite: VCVS + RES if rOut>0 — 1 internal node `vint`)
  - `PB-REAL_OPAMP.md`
  - `PB-OTA.md`
  - `PB-COMPARATOR.md`
  - `PB-SCHMITT.md`
- **Notes for agent:**
  - PB-OPAMP §"Default rOut=75 — behavioral change warning" is critical:
    the default 75Ω rOut introduces a series resistance NOT present in the
    current Norton-based OpAmp. You MUST run opamp.test.ts BEFORE making
    changes to record baseline assertions, then re-run after; for any test
    that fails ONLY because of the 75Ω drop, REPORT (do not silently fix
    or patch). The user decides whether to update the test, change the
    default to rOut=0, or other resolution.
  - All five elements are composites; sub-element ordering follows
    NGSPICE_LOAD_ORDER ordinal ascending per A6.4.
- **Test files:** matching `__tests__/{opamp,real-opamp,ota,comparator,
  schmitt-trigger}.test.ts`.

---

## Wave B — `batch-5`

### 5.B.switching-transgate-sw

- **Owned files:**
  - `src/components/switching/trans-gate.ts`
  - `src/components/switching/switch.ts`
  - `src/components/switching/switch-dt.ts`
- **PB specs:** `PB-TRANSGATE.md`, `PB-SW.md`, `PB-SW-DT.md`
- **Notes for agent:**
  - PB-SW is the canonical 4-stamp SW element. PB-TRANSGATE composites two
    SW sub-elements (one for each polarity). PB-SW-DT extends with
    double-throw branching.
- **Test files:** matching `__tests__/{trans-gate,switch,switch-dt}.test.ts`.

### 5.B.switching-relay-fuse

- **Owned files:**
  - `src/components/switching/relay.ts`
  - `src/components/switching/relay-dt.ts`
  - `src/components/switching/fuse.ts`
- **PB specs:** `PB-RELAY.md`, `PB-RELAY-DT.md`, `PB-FUSE.md`
- **Test files:** matching `__tests__/{relay,relay-dt,fuse}.test.ts`. Note
  that `relay.test.ts` already exists per directory listing.

### 5.B.active-controlled-sources

- **Owned files:**
  - `src/components/active/vccs.ts`
  - `src/components/active/vcvs.ts`
  - `src/components/active/cccs.ts`
  - `src/components/active/ccvs.ts`
- **PB specs:** `PB-VCCS.md`, `PB-VCVS.md`, `PB-CCCS.md`, `PB-CCVS.md`
- **Notes for agent:**
  - The four controlled sources are mechanical replication around two
    structural axes: voltage-vs-current input × voltage-vs-current output.
  - VCVS and CCVS have a branch row (V-output sources). Apply the
    `findBranchFor` callback per A4 / spec.
  - Element-level findBranch guard: per plan.md "Resolved decisions",
    each VSRC/VCVS/CCVS element setup() wraps `ctx.makeCur` in
    `if (this.branchIndex === -1) { ... }` — NOT idempotent on the ctx side;
    guard discipline lives on the element.
- **Test files:** matching `__tests__/{vccs,vcvs,cccs,ccvs}.test.ts`.

### 5.B.active-misc

- **Owned files:**
  - `src/components/active/adc.ts`
  - `src/components/active/dac.ts`
  - `src/components/active/analog-switch.ts`
  - `src/components/active/optocoupler.ts`
  - `src/components/active/timer-555.ts`
- **PB specs:** `PB-ADC.md`, `PB-DAC.md`, `PB-ANALOG_SWITCH.md`,
  `PB-OPTO.md`, `PB-TIMER555.md`
- **Notes for agent:**
  - Heterogeneous group — read each PB spec carefully. ADC/DAC are
    composites; OPTO is a 2-element composite; TIMER555 is a multi-element
    composite.
  - Apply A6.4 sub-element ordering rule for each composite.
- **Test files:** matching `__tests__/*.test.ts`.

### 5.B.passives-simple

- **Owned files:**
  - `src/components/passives/resistor.ts`
  - `src/components/passives/inductor.ts`
  - `src/components/passives/polarized-cap.ts`
  - `src/components/passives/potentiometer.ts`
  - `src/components/passives/analog-fuse.ts`
- **PB specs:** `PB-RES.md`, `PB-IND.md`, `PB-POLCAP.md`, `PB-POT.md`, `PB-AFUSE.md`
- **Inherited complete (do not re-migrate):**
  - `src/components/passives/capacitor.ts` / `PB-CAP.md` — migrated by 5.B.adc-dac as a blocking
    dependency (cross-batch). Verified spec-compliant during remediation-pass-1: 4 TSTALLOC entries
    with ground guards, `ctx.allocStates(stateSize)`, handles cached as `_hPP`/`_hNN`/`_hPN`/`_hNP`.
    The `5.B.passives-simple` agent MUST NOT re-migrate this file. Audit only.
  - `src/components/passives/analog-fuse.ts` / `PB-AFUSE.md` — migrated by 5.B.fuse. Verified
    spec-compliant. The same analog `FuseElement` also serves PB-FUSE (see PB-FUSE.md note);
    `switching/fuse.ts` is the digital-side wrapper that imports `createAnalogFuseElement` from
    here. Audit only; no re-migration.
- **Notes for agent:**
  - PB-RES is the canonical 4-stamp passive. Remaining items are extensions:
    - IND — adds 1 branch row, `findBranchFor` callback
    - POLCAP — adds 1 state slot (charge), 0 internal nodes
    - POT — 3-pin (A/B/Wiper) → typically 2 RES sub-elements (composite)
- **Test files:** matching `__tests__/*.test.ts`.

### 5.B.passives-complex

- **Owned files:**
  - `src/components/passives/transformer.ts`
  - `src/components/passives/tapped-transformer.ts`
  - `src/components/passives/memristor.ts`
  - `src/components/passives/crystal.ts`
- **PB specs:** `PB-XFMR.md`, `PB-TAPXFMR.md`, `PB-MEMR.md`, `PB-CRYSTAL.md`
- **Notes for agent:**
  - PB-MEMR per plan.md "Resolved decisions": 1× RES with state-dependent G
    updated each load(); `_w` integrated in `accept()`. NOT VCCS.
  - XFMR / TAPXFMR have multiple branch rows (mutual inductance) — apply
    `findBranchFor` per spec.
  - CRYSTAL is RLC composite.
- **Test files:** matching `__tests__/*.test.ts`.

### 5.B.sources

- **Owned files:**
  - `src/components/sources/ac-voltage-source.ts`
  - `src/components/sources/dc-voltage-source.ts`
  - `src/components/sources/variable-rail.ts`
  - `src/components/sources/current-source.ts`
- **PB specs:** `PB-VSRC-AC.md`, `PB-VSRC-DC.md`, `PB-VSRC-VAR.md`,
  `PB-ISRC.md`
- **Notes for agent:**
  - All three voltage sources have a branch row + `findBranchFor` callback.
    Element-level findBranch guard pattern (`if (this.branchIndex === -1)`)
    applies — see plan.md "Resolved decisions" / "findBranch mechanism".
  - ISRC has no branch row.
- **Test files:** matching `__tests__/*.test.ts`.

### 5.B.semi-other

- **Owned files:**
  - `src/components/semiconductors/diac.ts`
  - `src/components/semiconductors/scr.ts`
  - `src/components/semiconductors/triac.ts`
  - `src/components/semiconductors/triode.ts`
  - `src/components/semiconductors/tunnel-diode.ts`
- **PB specs:** `PB-DIAC.md`, `PB-SCR.md`, `PB-TRIAC.md`, `PB-TRIODE.md`,
  `PB-TUNNEL.md`
- **Notes for agent:**
  - PB-TRIODE per plan.md "Resolved decisions": 1× VCCS topology + 2 extra
    `gds` output-conductance handles. Six total handles per PB-TRIODE
    FTRIODE-D1.
  - PB-TUNNEL: 1× VCCS (control pair aliases output pair), NOT DIO topology.
  - SCR/TRIAC/DIAC are thyristor-family composites.
- **Test files:** matching `__tests__/*.test.ts` (e.g., `scr.test.ts` exists
  per directory listing).

### 5.B.sensors

- **Owned files:**
  - `src/components/sensors/ldr.ts`
  - `src/components/sensors/ntc-thermistor.ts`
  - `src/components/sensors/spark-gap.ts`
- **PB specs:** `PB-LDR.md`, `PB-NTC.md`, `PB-SPARK.md`
- **Notes for agent:**
  - All three are RES-based with state-dependent conductance (light, temp,
    breakdown). Setup() is RES-shaped (4 stamps each).
  - Smallest agent in the wave.
- **Test files:** matching `__tests__/*.test.ts`.

---

## Spawn cadence (for the coordinator at /go time)

When the user issues "go":

1. Confirm batch-3 group_status is fully `passed` and the in-flight wave-2
   agent has reported done.
2. Read `spec/.hybrid-state.json` to confirm batch-4 metadata is intact.
3. Spawn all 9 batch-4 implementers in **one message**, each as a background
   `claude-orchestrator:implementer` Task with `model: "sonnet"` and the
   prompt assembled from the master template + per-agent overlay above.
4. Wait via `TaskOutput(task_id, block=true)` for each.
5. Re-read state, process `spec/progress.md` for any `CLARIFICATION NEEDED`,
   then commit, clear locks, spawn the wave-verifier for batch-4.
6. After batch-4 verifies green, repeat for batch-5.
7. After batch-5 verifies green, the W3 setup-load-split work is complete
   modulo the deferred TLINE / SUBCKT decisions.
