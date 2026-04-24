# Phase 0 audit resolution — closed at commit `b07db497bf7ce948ee31871b2a7be33378388527`

This document records the per-identifier resolution for every banned identifier enumerated in
Task 0.3.1's audit manifest. It serves as the interpretation reference for Phase 9.1.1's
re-run of `phase-0-identifier-audit.test.ts`.

---

## Per-identifier resolution table

| Identifier | Resolution | Evidence | Cited-at |
|---|---|---|---|
| `derivedNgspiceSlots` | deleted-in-Phase-0 | zero hits in `src/`, `scripts/`, `e2e/` | 0.1.1 |
| `DerivedNgspiceSlot` | deleted-in-Phase-0 | zero hits in `src/`, `scripts/`, `e2e/` | 0.1.1 |
| `_updateOp` | deleted-in-Phase-0 | zero hits in `src/`, `scripts/`, `e2e/` | 0.1.2 |
| `_stampCompanion` | deleted-in-Phase-0 | zero hits in `src/`, `scripts/`, `e2e/` | 0.1.2 |
| `InitMode` (type name) | deleted-in-Phase-0 | zero hits for `\bInitMode\b` in `src/` (field names `initMode`, `resolvedInitMode` are distinct by word-boundary and were not deleted) | 0.1.2 |
| `CoupledInductorState` | deleted-in-Phase-0 | zero hits in `src/`, `scripts/`, `e2e/` | 0.1.2 |
| `createState` | deleted-in-Phase-0 | zero hits in `src/`, `scripts/`, `e2e/` | 0.1.2 |
| `_ctxInitMode` | absent | zero hits — identifier never existed in this codebase | |
| `_firsttime` | absent | zero hits — identifier never existed in this codebase | |
| `firstNrForThisStep` | absent | zero hits — identifier never existed in this codebase | |
| `loadCtx.iteration` | absent | zero hits — field access pattern never existed in this codebase | |
| `ctx.initMode` | absent | zero hits — field access pattern never existed in this codebase | |
| `ctx.isDcOp` | absent | zero hits — field access pattern never existed in this codebase | |
| `ctx.isTransient` | absent | zero hits — field access pattern never existed in this codebase | |
| `ctx.isAc` | absent | zero hits — field access pattern never existed in this codebase | |
| `ctx.isTransientDcop` | absent | zero hits — field access pattern never existed in this codebase | |
| `statePool.analysisMode` | absent | zero hits — field access pattern never existed in this codebase | |
| `pool.uic` | absent | zero hits — field access pattern never existed in this codebase | |
| `poolBackedElements` | absent | zero hits — identifier never existed in this codebase | |
| `refreshElementRefs` | absent | zero hits — identifier never existed in this codebase | |
| `MNAAssembler` | absent | zero hits — identifier never existed in this codebase | |
| `TUNNEL_DIODE_MAPPING` | absent | zero hits — identifier never existed in this codebase | |
| `VARACTOR_MAPPING` | absent | zero hits — identifier never existed in this codebase | |
| `junctionCap` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_GD_JUNCTION` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_ID_JUNCTION` | absent | zero hits — identifier never existed in this codebase | |
| `L1_SLOT_CAP_GEQ_*` (family) | absent | zero hits for any `L1_SLOT_CAP_GEQ` prefix — identifiers never existed in this codebase | |
| `SLOT_CAP_GEQ_GS` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_CAP_GEQ_GD` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_CAP_GEQ_DB` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_CAP_GEQ_SB` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_CAP_GEQ_GB` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_IEQ_GS` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_IEQ_GD` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_IEQ_DB` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_IEQ_SB` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_IEQ_GB` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_Q_GS` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_Q_GD` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_Q_GB` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_Q_DB` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_Q_SB` | absent | zero hits — identifier never existed in this codebase | |
| `SLOT_CAP_GEQ` (bare short-form) | refactored-in-Phase-0 | zero hits in `src/` after Tasks 0.2.1 and 0.2.2 collapsed these into `load()` locals in `tunnel-diode.ts` and `led.ts` | 0.2.1, 0.2.2 |
| `SLOT_CAP_IEQ` (bare short-form) | refactored-in-Phase-0 | zero hits in `src/` after Tasks 0.2.1 and 0.2.2 collapsed these into `load()` locals in `tunnel-diode.ts` and `led.ts` | 0.2.1, 0.2.2 |
| `SLOT_V` (tunnel-diode / LED cross-method slot) | refactored-in-Phase-0 | zero hits for the cross-method `SLOT_V` declaration in `tunnel-diode.ts` and `led.ts` after Task 0.2.1 and 0.2.2 (the identifier was declared only in those two files; no hits elsewhere) | 0.2.1, 0.2.2 |
| `_prevVoltage` (in `digital-pin-model.ts`) | refactored-in-Phase-0 | zero hits in `digital-pin-model.ts`; only remaining hits are in `src/solver/analog/__tests__/digital-pin-model.test.ts` lines 400, 405, 407 — these are test assertions that the field does not exist (see allowlist entry below) | 0.2.3 |
| `_prevCurrent` (in `digital-pin-model.ts`) | refactored-in-Phase-0 | zero hits in `digital-pin-model.ts`; only remaining hits are in `src/solver/analog/__tests__/digital-pin-model.test.ts` lines 400, 406, 408 — test assertions that the field does not exist (see allowlist entry below) | 0.2.3 |
| `accept()` method (in `digital-pin-model.ts`) | refactored-in-Phase-0 | method removed from both `DigitalOutputPinModel` and `DigitalInputPinModel` as part of Task 0.2.3; zero hits in production source | 0.2.3 |
| `_prevClockVoltage` | local-ok | edge-detection latch in flipflop and sequential elements; see allowlist section below | |
| `Math.min(vd/nVt, 700)` / `Math.exp(700)` thermal-exp clamp | test-reference-ok | one hit: `src/components/semiconductors/__tests__/tunnel-diode.test.ts:217`; see allowlist section below | |
| `(vds < -10)` Vds clamp | absent | zero hits in `src/`, `scripts/`, `e2e/` | |
| `(vds > 50)` Vds clamp | absent | zero hits in `src/`, `scripts/`, `e2e/` | |

---

## Bucket sections

### (1) Truly absent — identifiers that never landed or were already gone before Phase 0

The following identifiers appear in the audit manifest because they were candidates for
introduction during earlier phases, or because their analogs in ngspice were reviewed and
confirmed never to have been ported to this codebase. They returned zero hits before any
Phase 0 work started.

- `_ctxInitMode`, `_firsttime`, `firstNrForThisStep`
- `loadCtx.iteration`, `ctx.initMode`, `ctx.isDcOp`, `ctx.isTransient`, `ctx.isAc`, `ctx.isTransientDcop`
- `statePool.analysisMode`, `pool.uic`
- `poolBackedElements`, `refreshElementRefs`
- `MNAAssembler`
- `TUNNEL_DIODE_MAPPING`, `VARACTOR_MAPPING`
- `junctionCap`
- `SLOT_GD_JUNCTION`, `SLOT_ID_JUNCTION`
- All MOSFET per-terminal cap slot names: `L1_SLOT_CAP_GEQ_*`, `SLOT_CAP_GEQ_GS`, `SLOT_CAP_GEQ_GD`, `SLOT_CAP_GEQ_DB`, `SLOT_CAP_GEQ_SB`, `SLOT_CAP_GEQ_GB`, `SLOT_IEQ_GS`, `SLOT_IEQ_GD`, `SLOT_IEQ_DB`, `SLOT_IEQ_SB`, `SLOT_IEQ_GB`, `SLOT_Q_GS`, `SLOT_Q_GD`, `SLOT_Q_GB`, `SLOT_Q_DB`, `SLOT_Q_SB`
- `(vds < -10)` and `(vds > 50)` Vds clamp patterns

These identifiers are included in the audit manifest so that Phase 9.1.1's re-run will
detect any future introduction immediately, even if introduced by a reviewer unfamiliar with
this audit history.

### (2) Deleted in Wave 0.1

**Task 0.1.1** — `derivedNgspiceSlots` / `DerivedNgspiceSlot`

The `DerivedNgspiceSlot` interface and the `DeviceMapping.derivedNgspiceSlots` optional field
were defined in `src/solver/analog/__tests__/harness/types.ts` and read in three call sites:
`ngspice-bridge.ts`, `compare.ts`, and `parity-helpers.ts`. No `DEVICE_MAPPING` in
`device-mappings.ts` ever populated the field; all three reader branches therefore executed
against `undefined` unconditionally. Task 0.1.1 deleted the interface, the optional field,
all three reader branches, and the `derivedNgspiceSlots.VSB` comment reference in
`harness-integration.test.ts`. Zero hits confirmed across `src/`, `scripts/`, `e2e/`.

**Task 0.1.2** — `_updateOp`, `_stampCompanion`, `InitMode` (type), `CoupledInductorState`, `createState`

These identifiers appeared only inside orientation comments that were written to help readers
understand post-A1 structural changes. With Phase 0 establishing the audit baseline, those
comments became stale documentation that would cause the identifier-audit test to report
unexpected hits. Task 0.1.2 stripped them from:

- `src/components/semiconductors/bjt.ts` — module-header "No `_updateOp`/`_stampCompanion`" sentence
- `src/components/semiconductors/mosfet.ts` — module header and line 884 inline comment
- `src/components/semiconductors/njfet.ts` — module header and lines 264-265 inline block
- `src/components/semiconductors/pjfet.ts` — module header and lines 233-234 inline block
- `src/components/semiconductors/varactor.ts` — paragraph at lines 13-17
- `src/components/semiconductors/__tests__/bjt.test.ts` — deletion-history commentary at lines 6 and 323
- `src/components/semiconductors/__tests__/jfet.test.ts` — deletion-history commentary at lines 9-10
- `src/components/semiconductors/__tests__/diode.test.ts` — `Math.min(vd/nVt, 700)` deletion note at line 703
- `src/components/active/__tests__/timer-555.test.ts` — deletion-history commentary at line 6
- `src/solver/analog/__tests__/ckt-mode.test.ts` — `InitMode` string-union historical mention at line 5
- `src/solver/analog/coupled-inductor.ts` — `CoupledInductorState and createState()` deletion note at lines 9-10
- `src/solver/analog/__tests__/harness/device-mappings.ts` — "(Track B) `_updateOp`/`_stampCompanion` collapse" sentence

Zero hits confirmed for all five identifiers across `src/`, `scripts/`, `e2e/`.

### (3) Refactored in Wave 0.2

**Tasks 0.2.1 and 0.2.2** — `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, `SLOT_V` (bare short-form names)

`tunnel-diode.ts` and `led.ts` each carried three state-pool slots (`SLOT_CAP_GEQ`,
`SLOT_CAP_IEQ`, `SLOT_V`) that functioned as cross-method transfer storage: written to `s0`
at the start of `load()` and read back in the same call for stamping, never read from prior-step
arrays. Task 0.2.1 collapsed these into `load()` locals in `tunnel-diode.ts`; Task 0.2.2
performed the same collapse in `led.ts`. The cap-variant state schema shrank from 9 to 6
slots in both files (retaining `SLOT_Q` and `SLOT_CCAP` as genuine NIintegrate history).
Zero hits confirmed for all three bare short-form identifiers across `src/`.

**Task 0.2.3** — `_prevVoltage`, `_prevCurrent`, `accept()` method (in `digital-pin-model.ts`)

`DigitalOutputPinModel` and `DigitalInputPinModel` carried private `_prevVoltage` and
`_prevCurrent` fields implementing trapezoidal-integration companion math, plus an
`accept(ctx, voltage)` method. This was per-object integration state (A1-rule violation) and
also contained a correctness bug: both `q0` and `q1` were computed from `_prevVoltage`,
making the trapezoidal delta always zero. Task 0.2.3 replaced the private-field approach with
a real `AnalogCapacitorElement` child following the `TransmissionLineElement` composite
pattern. The three identifiers were removed from `digital-pin-model.ts`.

The string `_prevVoltage` and `_prevCurrent` appear in
`src/solver/analog/__tests__/digital-pin-model.test.ts` at lines 400, 405, 406, 407, 408 only as
string literals inside `hasOwnProperty` assertions that verify the fields no longer exist.
These are `test-reference-ok` hits (the audit manifest allowlists them with that reason).

### (4) Allowlisted with reason

**`_prevClockVoltage` — `local-ok`**

`_prevClockVoltage` is a rising-edge-detection latch used by clock-triggered flip-flop and
sequential logic elements. It stores the clock pin's voltage at the end of each accepted
timestep so the next `load()` call can detect a rising edge by comparison. This is
per-element scalar state (not integration history) and is outside the A1-rule scope that
bans per-object integration history arrays. It exists in:

- `src/solver/analog/behavioral-flipflop.ts` — lines 76, 148, 192, 195, 196, 227 (and equivalent sections for additional flip-flop classes within the same file at lines 258, 318, 350, 369 and 514, 584, 632, 678)
- `src/solver/analog/behavioral-sequential.ts` — lines 73, 136, 169, 190
- `src/solver/analog/behavioral-flipflop/d-async.ts` — lines 53, 110, 138, 159
- `src/solver/analog/behavioral-flipflop/jk-async.ts` — lines 54, 113, 142, 172
- `src/solver/analog/behavioral-flipflop/jk.ts` — lines 53, 108, 135, 155
- `src/solver/analog/behavioral-flipflop/rs.ts` — lines 55, 113, 146, 179
- `src/solver/analog/behavioral-flipflop/t.ts` — lines 53, 106, 132, 147

The audit manifest allowlists all of these with reason "edge-detection latch, not integration
history, outside A1 rule scope."

**`Math.min(vd/nVt, 700)` / thermal-exp clamp — `test-reference-ok`**

`src/components/semiconductors/__tests__/tunnel-diode.test.ts:217` contains:

```
const dIThermal = (1e-14 / 0.02585) * Math.exp(Math.min(vMid / 0.02585, 700));
```

This is a test-side expected-value computation that derives the reference current for an
assertion. It is not the banned production clamp (which was deleted in an earlier phase and
lived in the device's `load()` function). The audit manifest allowlists this one site with
reason "test-side reference computation, not the banned clamp."

---

## How to re-run this audit

The machine-verification companion to this report is:

```
src/solver/analog/__tests__/phase-0-identifier-audit.test.ts
```

Run it with:

```
npx vitest run src/solver/analog/__tests__/phase-0-identifier-audit.test.ts
```

The test walks `src/`, `scripts/`, and `e2e/` (excluding `node_modules/`, `dist/`,
`ref/ngspice/`, `spec/`, `.git/`, and its own file) and checks every banned identifier in the
manifest against the filesystem. Any hit not covered by the manifest's `allowlist` causes an
immediate test failure with the offending file paths and line numbers printed.

Phase 9.1.1 re-runs this test as its final sweep. A green run with zero unexpected hits
confirms that no banned identifier has been reintroduced since Phase 0 closed.

---

## Phase 3 Wave 3.3 rule additions

Three banned-literal rules were appended to the audit manifest in Task 3.3.6 to ban the
invented `IntegrationMethod` identifiers deleted by Wave 3.3.

| Rule ID | Pattern | Scope | Allowlist | Resolution | Cited-at |
|---|---|---|---|---|---|
| `bdf1-literal` | `/(["'])bdf1\1/` | `src/**/*.ts` (all, via SCOPE_DIRS walker) | empty | deleted-in-Phase-3 — purged from all of `src/` by Tasks 3.3.1, 3.3.2, 3.3.3. ngspice has no BDF-1 selectable method (cktdefs.h:107-108); order 1 under either method uses trap-1 coefficients per nicomcof.c:40-41. | 3.3.6 |
| `bdf2-literal` | `/(["'])bdf2\1/` | `src/**/*.ts` (all, via SCOPE_DIRS walker) | empty | deleted-in-Phase-3 — collapsed into `"gear"` per cktdefs.h:107-108 (TRAPEZOIDAL=1, GEAR=2). Order 2 routes through solveGearVandermonde. | 3.3.6 |
| `integrationMethod-auto` | `/integrationMethod\s*:\s*["']auto["']/` | `src/**/*.ts` (all, via SCOPE_DIRS walker) | empty | deleted-in-Phase-3 — `"auto"` was never resolved to a concrete method anywhere in the engine. Default changed to `"trapezoidal"` per cktntask.c:99. | 3.3.6 |
| `bdf-hyphenated` | `/BDF[-_ ][12]/i` | `src/**/*.ts`, `scripts/**/*.ts`, `e2e/**/*.ts` (all, via SCOPE_DIRS walker) | empty | purged-in-Phase-3-Cleanup — 'BDF-1' / 'BDF-2' (and _1 / _2 / space-1 / space-2 variants, any case) is the banned prose name for integration methods. Order 1 under trapezoidal or gear uses trap-1 coefficients (nicomcof.c:40-41); what was called BDF-2 is GEAR order 2 (nicomcof.c:52-127). Use 'order-1 trap', 'backward Euler', or 'gear order 2' instead. | C-3.4.4 |
| `bdf-substring` | `/bdf[12]/i` | `src/**/*.ts`, `scripts/**/*.ts`, `e2e/**/*.ts` (all, via SCOPE_DIRS walker) | empty | purged-in-Phase-3-Cleanup — 'bdf1' / 'bdf2' (any case, any position — standalone literal, suffix of an identifier, substring of a constant label, etc.) is banned. Covers 'rBdf2', 'NGSPICE_REF_BDF2', 'updateCompanion_bdf1', 'BDF1'-run-together-in-prose, etc. Rename to 'order1_trap' / 'order2_gear' / 'gear2' / 'rGear2' / 'NGSPICE_REF_GEAR2' as appropriate. Regex deliberately has no word-boundary anchors — the 3.3.6 rules already scope to quoted literals; this rule catches identifier-embedded cases they miss. | C-3.4.4 |
