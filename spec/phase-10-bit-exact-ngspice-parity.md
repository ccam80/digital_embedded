# Phase 10: 8-Circuit Bit-Exact ngspice Parity Acceptance

**Depends on:** Phase 9 (full-suite baseline landed; engine-level bugs closed to
best-of-static-and-targeted-test knowledge).

**Nature:** Run-and-triage phase. The eight acceptance tests already exist at
`src/solver/analog/__tests__/ngspice-parity/*.test.ts` with fixtures, helpers,
and `absDelta === 0` assertions on every compared field. Phase 10 runs each
test against the post-Phase-9 tree, surfaces every divergence as a ticket, and
closes when every ticket has user disposition.

**Agents DO NOT fix engine code in Phase 10.** Failures are filed as PARITY
tickets; the user reviews each and decides whether a Phase-10 remediation PR
lands (numerical fix) or whether the item is escalated into
`architectural-alignment.md` (user action — agents never write to that file).

## Overview

The eight acceptance circuits, in ascending complexity order, each get one
wave. Each wave runs exactly one `vitest` test file end-to-end, reports
PASS or FAIL with evidence, and files a PARITY ticket per surfaced divergence.
Waves may run in any order (including parallel) — ticket accumulation does
not block subsequent waves. Phase 10 closes when every wave has either a
clean pass or every ticket it surfaced has user disposition.

**D-8 closure:** W10.8 (MOSFET inverter) closes D-8 implicitly by passing
its `transient_match` test. If the test passes with all `absDelta === 0`,
D-8 is closed; no separate gesture required.

## Operational rules (apply to every wave)

### 1. DLL presence
ngspice.dll is present at
`C:/local_working_projects/digital_in_browser/third_party/ngspice/bin/ngspice.dll`
and loadable. Tests gate on `describeIfDll` — when the DLL is present, the
test body runs; when absent, it silently skips. Phase 10 execution assumes
presence; a skipped test is not acceptable evidence of closure.

### 2. Commit evidence
Every wave commit body carries:
- The test file path
- `PASS` or `FAIL`
- On PASS: total NR iterations compared (ours + ngspice must match; the
  assertion fires if they don't), total steps compared, and DLL SHA
  (computed from the DLL file at run time)
- On FAIL: pointer to the ticket ID(s) opened in
  `spec/phase-10-parity-tickets.md`

### 3. Ticket filing — the only artifact an agent may produce on failure
When any assertion in the wave's test file fails, the agent:
1. Captures the exact failure message (step/iter/slot/ours/ngspice/absDelta).
2. Appends a PARITY ticket to `spec/phase-10-parity-tickets.md` using the
   format documented in that file's header.
3. Commits the ticket file as `Phase 10 — tickets from W<N> run` (separate
   commit from any test-run evidence commit).
4. STOPS. Does not touch engine, component, or test source. Does not weaken
   assertions. Does not rebase. Does not retry with different parameters.

### 4. Prohibited actions during Phase 10
- Deleting or weakening any `expect(...).toBe(0)` assertion in
  `parity-helpers.ts` or the eight test files.
- Adding tolerance, relative tolerance, or absDelta slack.
- "Fixing" engine code, device models, or NR control flow.
- Modifying fixtures (`.dts` files) to produce convergent behavior.
- Writing to `spec/architectural-alignment.md` — that file is user-only.

### 5. When a wave's test was already passing at the start of a run
Commit the evidence (PASS + iteration count + DLL SHA); no ticket action
needed. Proceed to the next wave.

## PARITY ticket sink

`spec/phase-10-parity-tickets.md` is the single destination for all Phase 10
divergence tickets. The file is created at Phase 10 start if not already
present; its header documents the ticket format and its body accumulates
one ticket per surfaced divergence. Tickets are numbered `P10-<W>.<N>`
where `<W>` is the wave number (1..8) and `<N>` is the zero-based ticket
index within that wave.

## Wave ordering rationale

Waves are ordered by increasing circuit complexity. The goal is to surface
divergences in the minimum circuit that reproduces them: a failure in
wave 10.2 (diode+resistor) points at pnjlim or diode `load()`; in 10.4
(BJT common-emitter) it points at multi-junction limiting or gmin
stepping; in 10.8 (MOSFET inverter) it points at fetlim or MOSFET
`load()`. A failure at wave 10.1 (resistive divider — linear stamp,
1 NR iteration) points at the NR outer loop or matrix factorization
itself, invalidating every downstream circuit.

## Wave 10.1: Resistive divider — linear DC-OP baseline

### Task 10.1.1: Run resistive-divider parity
- **Description**: Run `resistive-divider.test.ts::"Resistive divider DC-OP
  parity" > "dc_op_iteration_match"` against the current tree. Pass or file
  tickets.
- **Files to run**:
  - `src/solver/analog/__tests__/ngspice-parity/resistive-divider.test.ts`
- **Command**: `npx vitest run src/solver/analog/__tests__/ngspice-parity/resistive-divider.test.ts`
- **Files to modify on FAIL only**:
  - `spec/phase-10-parity-tickets.md` — append one ticket per divergence
- **Tests**: (the test is the artifact — it already asserts absDelta === 0
  on rhsOld, state0, noncon, diagGmin, srcFact, initMode, order, delta)
- **Acceptance criteria**:
  - Test passes with DLL present and non-zero NR iteration count, OR
  - Every divergence is filed as a ticket in `phase-10-parity-tickets.md`.
  - On PASS: expected shape is initJct → initFix → initFloat → converged
    in a single NR iteration (linear circuit).

## Wave 10.2: Diode + resistor — pnjlim and mode transitions

### Task 10.2.1: Run diode-resistor parity
- **Description**: Run `diode-resistor.test.ts::"Diode + resistor DC-OP
  parity" > "dc_op_pnjlim_match"`. Exercises the Phase-4 D4 Gillespie
  branch and the diode `load()` MODEINITJCT→MODEINITFIX→MODEINITFLOAT
  ladder.
- **Files to run**:
  - `src/solver/analog/__tests__/ngspice-parity/diode-resistor.test.ts`
- **Command**: `npx vitest run src/solver/analog/__tests__/ngspice-parity/diode-resistor.test.ts`
- **Files to modify on FAIL only**:
  - `spec/phase-10-parity-tickets.md`
- **Tests**: the test is the artifact. It asserts per-NR-iteration
  bit-exact match including `initMode` transition sequence (exercises the
  mode-transition comparator in `assertModeTransitionMatch`) and the
  `noncon` sequence (exercises pnjlim event equivalence at the numerical
  level).
- **Acceptance criteria**:
  - Test passes, OR every divergence filed as a ticket.
  - On a D4-related divergence, the ticket body MUST cite
    `ref/ngspice/src/spicelib/devices/devsup.c:50-58` (Gillespie branch
    line range) plus the digiTS line range from `newton-raphson.ts` so
    that the user review has the exact source-source comparison ready.

## Wave 10.3: RC transient — capacitor integration and LTE

### Task 10.3.1: Run rc-transient parity
- **Description**: Run `rc-transient.test.ts::"RC transient parity — Task
  7.3.1" > "transient_per_step_match"`. Exercises NIintegrate for
  capacitor, LTE timestep estimation, and order promotion.
- **Files to run**:
  - `src/solver/analog/__tests__/ngspice-parity/rc-transient.test.ts`
- **Command**: `npx vitest run src/solver/analog/__tests__/ngspice-parity/rc-transient.test.ts`
- **Files to modify on FAIL only**:
  - `spec/phase-10-parity-tickets.md`
- **Tests**: the test asserts per-NR-iteration bit-exact match across
  every accepted timestep, plus `lteDt` equality when both sides populate
  it (via `assertIterationMatch`). Exercises the I2.1 cross-timestep
  integration-history slot (`diode.ts::SLOT_CCAP` pattern applied to
  capacitor).
- **Acceptance criteria**:
  - Test passes, OR every divergence filed as a ticket.
  - Any `lteDt` divergence in the ticket body MUST include the ngspice
    and digiTS values at the exact accepted-step boundary where they
    first split.

## Wave 10.4: BJT common-emitter — multi-junction limiting and gmin stepping

### Task 10.4.1: Run bjt-common-emitter parity
- **Description**: Run `bjt-common-emitter.test.ts::"bjt-common-emitter
  DC-OP parity" > "dc_op_match"`. Exercises Phase-5 BJT L0/L1 `load()`
  alignment and (if convergence requires) gmin-stepping bit-exact parity.
- **Files to run**:
  - `src/solver/analog/__tests__/ngspice-parity/bjt-common-emitter.test.ts`
- **Command**: `npx vitest run src/solver/analog/__tests__/ngspice-parity/bjt-common-emitter.test.ts`
- **Files to modify on FAIL only**:
  - `spec/phase-10-parity-tickets.md`
- **Tests**: asserts total NR iteration count matches, per-iteration
  bit-exact match, `diagGmin` sequence bit-exact across every gmin
  sub-solve, and `initMode` sequence bit-exact.
- **Acceptance criteria**:
  - Test passes, OR every divergence filed as a ticket.
  - Divergences whose first-split field is `diagGmin` MUST cite
    `ref/ngspice/src/spicelib/analysis/dcop.c` gmin-stepping control
    block plus the digiTS equivalent in `dc-operating-point.ts`.

## Wave 10.5: RLC oscillator — inductor integration and held trapezoidal

### Task 10.5.1: Run rlc-oscillator parity
- **Description**: Run `rlc-oscillator.test.ts::"RLC oscillator transient
  parity — Task 7.3.2" > "transient_oscillation_match"`. Exercises
  inductor integration, ringing without method switching, and the I2.1
  `inductor.ts::SLOT_CCAP` legitimate integration-history slot.
- **Files to run**:
  - `src/solver/analog/__tests__/ngspice-parity/rlc-oscillator.test.ts`
- **Command**: `npx vitest run src/solver/analog/__tests__/ngspice-parity/rlc-oscillator.test.ts`
- **Files to modify on FAIL only**:
  - `spec/phase-10-parity-tickets.md`
- **Tests**: asserts per-NR-iteration bit-exact match, `method === "trapezoidal"`
  at every accepted step (no method switching), and peak capacitor-node
  voltage exceeds 0.5 V over steps 0..200 (oscillation sanity).
- **Acceptance criteria**:
  - Test passes, OR every divergence filed as a ticket.
  - A `method` divergence at any accepted step is a P0-priority ticket
    (Appendix B of plan.md fixed "Initial method: Trapezoidal; never
    switches" — any deviation invalidates an architectural resolution).

## Wave 10.6: Op-amp inverting amplifier — source stepping

### Task 10.6.1: Run opamp-inverting parity
- **Description**: Run `opamp-inverting.test.ts::"opamp-inverting DC-OP
  parity" > "dc_op_source_stepping_match"`. Exercises the source-stepping
  `dcopSrcSweep` phase and the `srcFact` sub-solve sequence.
- **Files to run**:
  - `src/solver/analog/__tests__/ngspice-parity/opamp-inverting.test.ts`
- **Command**: `npx vitest run src/solver/analog/__tests__/ngspice-parity/opamp-inverting.test.ts`
- **Files to modify on FAIL only**:
  - `spec/phase-10-parity-tickets.md`
- **Tests**: asserts NR iteration count matches, per-iteration bit-exact
  match, and `srcFact` sequence bit-exact across every source-stepping
  sub-solve (via `assertConvergenceFlowMatch`).
- **Acceptance criteria**:
  - Test passes, OR every divergence filed as a ticket.
  - The circuit uses the `real-opamp` component (F4c APPROVED ACCEPT,
    behavioral). A divergence rooted in real-opamp behavior is not a
    PARITY ticket — it is a test-design error. File the ticket but flag
    "candidate test-design escalation: real-opamp is F4c ACCEPT,
    self-compare only."

## Wave 10.7: Diode bridge rectifier — multi-junction transient and breakpoints

### Task 10.7.1: Run diode-bridge parity
- **Description**: Run `diode-bridge.test.ts::"Diode bridge rectifier —
  ngspice transient parity" > "transient_rectification_match"`. Exercises
  four simultaneous diode junctions, breakpoint handling, and transient
  `initMode` flow.
- **Files to run**:
  - `src/solver/analog/__tests__/ngspice-parity/diode-bridge.test.ts`
- **Command**: `npx vitest run src/solver/analog/__tests__/ngspice-parity/diode-bridge.test.ts`
- **Files to modify on FAIL only**:
  - `spec/phase-10-parity-tickets.md`
- **Tests**: per-NR-iteration bit-exact, plus accepted-step-end-time
  sequence bit-exact (breakpoint consumption parity).
- **Acceptance criteria**:
  - Test passes, OR every divergence filed as a ticket.
  - A breakpoint-time divergence MUST cite
    `ref/ngspice/src/spicelib/analysis/dctran.c` breakpoint-insertion
    block and the digiTS equivalent in `analog-engine.ts`.

## Wave 10.8: MOSFET inverter — fetlim, full FET eqns, D-8 closure

### Task 10.8.1: Run mosfet-inverter DC-OP parity
- **Description**: Run `mosfet-inverter.test.ts::"MOSFET inverter —
  ngspice DC-OP + transient parity" > "dc_op_match"`. Exercises MOSFET
  `load()` under MODEINITJCT/FIX/FLOAT (Phase-6 work).
- **Files to run**:
  - `src/solver/analog/__tests__/ngspice-parity/mosfet-inverter.test.ts`
- **Command**: `npx vitest run --testNamePattern "dc_op_match" src/solver/analog/__tests__/ngspice-parity/mosfet-inverter.test.ts`
- **Files to modify on FAIL only**:
  - `spec/phase-10-parity-tickets.md`
- **Acceptance criteria**:
  - `dc_op_match` test passes, OR every divergence filed as a ticket.

### Task 10.8.2: Run mosfet-inverter transient parity (D-8 closure)
- **Description**: Run `mosfet-inverter.test.ts::"MOSFET inverter —
  ngspice DC-OP + transient parity" > "transient_match"`. This is the
  acceptance signal for D-8 closure. A clean pass closes the D-8
  carry-forward (MOSFET `cgs_cgd_transient` regression from Phase 2.5
  `spec/reviews/phase-2-mosfet.md` VIOLATION-1).
- **Files to run**:
  - `src/solver/analog/__tests__/ngspice-parity/mosfet-inverter.test.ts`
- **Command**: `npx vitest run --testNamePattern "transient_match" src/solver/analog/__tests__/ngspice-parity/mosfet-inverter.test.ts`
- **Files to modify on FAIL only**:
  - `spec/phase-10-parity-tickets.md` — ticket body MUST include
    `state0[M1][SLOT_CCAP_GS]` and `state0[M1][SLOT_CCAP_GD]` ours vs
    ngspice values at the first divergent iteration (these are the
    slots whose divergence is the D-8 canary).
- **Acceptance criteria**:
  - `transient_match` test passes (implicit D-8 closure), OR divergences
    filed with the CCAP_GS / CCAP_GD evidence noted above.
  - On PASS: the Phase-10 closure commit message explicitly states
    "D-8 closed: mosfet-inverter.transient_match passed with absDelta === 0
    across N iterations".

## Phase 10 closure

Phase 10 closes when ALL of the following hold:

1. Every wave 10.1..10.8 has a PASS commit OR every ticket it surfaced has
   a filled-in **User disposition** block in `spec/phase-10-parity-tickets.md`
   (PARITY / ARCHITECTURAL / INVALID) and a **Resolution commit** SHA or
   architectural-alignment.md reference.
2. W10.8 Task 10.8.2 has a PASS commit (D-8 closed) OR every D-8-related
   ticket has architectural-alignment.md escalation recorded by the user.
3. `spec/phase-10-parity-tickets.md` has no tickets in state OPEN.

**Closure commit:** `Phase 10 — bit-exact ngspice parity gate closed
(<N> passes, <M> tickets dispositioned, D-8 <closed|escalated>)`.

## Operational notes (inherited from plan.md Appendix A)

- **STOP and escalate via ticket, never fix.** Agents surface tickets; the
  user decides fixes.
- **Zero allocations in hot paths.** Running the tests does not require
  modifying hot paths; this rule is inherited for any follow-up
  remediation work, not for Phase 10 runs themselves.
- **Banned closing verdicts.** *mapping*, *tolerance*, *close enough*,
  *equivalent to*, *pre-existing*, *intentional divergence*, *citation
  divergence*, *partial*. Any ticket whose first attempted disposition
  language uses these is rejected — the ticket remains OPEN until the
  disposition language is precise.
