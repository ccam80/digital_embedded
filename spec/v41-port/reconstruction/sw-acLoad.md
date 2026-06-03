# Reconstruction spec — `sw#recon/acLoad`

Rebuild the ngspice voltage-controlled-switch **AC small-signal load**
(`SWacLoad`) — propagate the switch state saved by the DC/transient `load()`
into the AC pass and stamp the selected on/off conductance into the AC matrix —
as a `stampAc` method on the digiTS switch element classes
(`AnalogSwitchSPSTElement`, `AnalogSwitchSPDTElement`,
`src/components/active/analog-switch.ts`). This is a v26-baseline rebuild: the
`SWacLoad` AC entry exists in v26 ngspice already (`swacload.c`, Author 1985
Gordon Jacobs), and digiTS has the SW DC/transient port (`swload.c`,
`swsetup.c`, `swtrunc.c`) but never had a sanctioned `SWacLoad` spec governing
its AC stamp.

`sw` is an **IN** device class (`device-class-scope.md:44`), so the AC
small-signal load is a v26-baseline reconstruction item — not an accepted
divergence and not an open question. The IN-class completeness rule
(`device-class-scope.md:8-16`) forbids OMITTING any ngspice device behavior; the
voltage-controlled switch participates in AC analysis exactly like every other
analog device, so its `SWacLoad` body must be ported bit-exact. SPST is the
direct port of the ngspice `SW` (VSWITCH) primitive; SPDT is the digiTS
extension built from two complementary `SW` instances (`analog-switch.ts:21-27`),
so the AC body runs once per SW path.

This spec implements the **RESOLVED** ruling of open question #45
(Q-BJT-STAMPAC), `OPEN-QUESTIONS-WORKLOG.md:108, 412`: an AC-implemented IN-class
device "needs `stampAc`" as a reconstruction item, mirroring the `cap` pilot
(`cap#recon/stampAc`, `device-class-scope.md:35`). #45 is framed against `bjt`
but states the general AC+IN rule — every IN device that participates in AC
gains a `stampAc` reconstruction; `sw` is the same situation (AC matrix present,
IN class, no prior AC spec). There is no SW-specific AC open question because the
direction is not in doubt: ngspice `SWacLoad` is unambiguous. This recon also
bakes in the **RESOLVED** ruling of #34 (Batch G,
`OPEN-QUESTIONS-WORKLOG.md:447-455`): the `Math.max(_rOn,1e-3)` /
`Math.max(_rOff,rOn*2)` resistance floors are a default-independent parity bug
and must be REMOVED — the AC stamp reads the same floor-free conductance as
`load()` so stamp == emit == ngspice.

Authoring contract: this spec is **documentation**. No code. No tests. The
implementer authors the TypeScript edit against this spec; the verifier checks
the edit against the ngspice citations herein. `AnalogSwitchSPSTElement` and
`AnalogSwitchSPDTElement` both receive the change; the SPDT body is the SPST
body applied to each of its two SW paths.

Per `CLAUDE.md` comment-hygiene: every reconstructed source comment cites the
current `ref/ngspice/src/spicelib/devices/sw/<file>` line and explains the
mechanism in present tense, with no `v26`/`v41`/era tags and no migration
narrative.

## Current digiTS state

digiTS already carries `stampAc` methods on both switch classes
(`analog-switch.ts:327-345` SPST, `analog-switch.ts:533-557` SPDT). They are
**structurally present but not spec-governed**, and they currently stamp through
the floored conductance that #34 condemns. This recon is the spec those methods
must conform to; the implementer reconciles the existing code to it (chiefly the
floor removal and the state-read citation).

| Concern | Current digiTS | ngspice `swacload.c` | Status |
|---|---|---|---|
| State read | `this._pool.states[0][_stateBase + SLOT_STATE] \| 0` (`analog-switch.ts:333`) | `(int) ckt->CKTstate0[here->SWswitchstate]` (`swacload.c:26`) | Present; matches — `SWswitchstate = SWstate+0` (`swdefs.h:60`) maps to `SLOT_STATE=0` (`analog-switch.ts:99`) |
| Conductance select | `current_state ? 1/rOnNow : 1/rOffNow` (`analog-switch.ts:339`) | `current_state ? model->SWonConduct : model->SWoffConduct` (`swacload.c:28`) | Present; truthiness test matches — but reads FLOORED `rOnNow`/`rOffNow` (`analog-switch.ts:334-335`), which #34 removes |
| Four matrix stamps | `stampElement(_hPP,+g); (_hPN,-g); (_hNP,-g); (_hNN,+g)` (`analog-switch.ts:341-344`) | `*(SWposPosPtr)+=g; *(SWposNegPtr)-=g; *(SWnegPosPtr)-=g; *(SWnegNegPtr)+=g` (`swacload.c:30-33`) | Present; real-part stamp, sign pattern matches |
| Handle source | `_hPP/_hPN/_hNP/_hNN` from `setup()` (`analog-switch.ts:305-308`) | `SWposPosPtr` … allocated in `SWsetup` TSTALLOC (`swsetup.c:50-53`) | Present; same four pointers `SWload` writes the real half of (`swload.c:142-145`) |
| Resistance floor | `Math.max(_rOn,1e-3)` / `Math.max(_rOff,_rOn*2)` (`analog-switch.ts:334-335`) | NONE — `SWonConduct`/`SWoffConduct` used raw | **BUG (#34): REMOVE** — stamp must equal the emitted unfloored value |

The existing `stampAc` already uses the correct AC primitive: `stampElement`
(the real-part accumulate, `sparse-solver.ts:66`), NOT `stampElementImag`
(`sparse-solver.ts:72`). This is correct and load-bearing: the switch
conductance is purely resistive (a real `g`), so `SWacLoad` writes only the real
half of each cell — unlike `CAPacLoad`, which writes only the imaginary half
(`capacitor.ts:462-474`). The recon preserves the `stampElement` choice and adds
no imaginary contribution.

With this recon `APPLIED`, the two blocked v41 hunks (`swacload.c#h001`,
`swacload.c#h002`, final section) apply onto the spec-governed baseline as
ordinary per-hunk deltas.

## Part A — State propagation (rebuild of `SWacLoad`'s state read)

`SWacLoad` does NOT re-run the switch state machine. In AC analysis the
operating point is fixed; ngspice "just propagate[s] the state" (`swacload.c:24`)
that the preceding DC operating-point `SWload` pass committed to `CKTstate0`.
The state is read, not recomputed.

ngspice (`swacload.c:26`):

```c
/* In AC analysis, just propogate the state... */
current_state = (int) ckt->CKTstate0[here->SWswitchstate];
```

The producer is `SWload` (`swload.c:132`):
`ckt->CKTstate0[here->SWswitchstate] = current_state;` — the DC operating point
commits the converged switch state (one of `REALLY_OFF=0`, `REALLY_ON=1`,
`HYST_OFF=2`, `HYST_ON=3`, `swload.c:26-27`) into state slot `SWswitchstate =
SWstate+0` (`swdefs.h:60`). `SWacLoad` reads that exact slot back.

ngspice → digiTS identifier mapping:

| ngspice identifier | `swacload.c` line | digiTS identifier | `analog-switch.ts` |
|---|---|---|---|
| `ckt->CKTstate0[here->SWswitchstate]` | `:26` | `this._pool.states[0][this._stateBase + SLOT_STATE]` | `:333` (SPST), `:543`/`:551` (SPDT) |
| `SWswitchstate` (= `SWstate+0`, `swdefs.h:60`) | header | `SLOT_STATE = 0` | `:99` |
| `(int) …` cast | `:26` | `… \| 0` (truncate-to-int32) | `:333` |
| `here->SWcond` (DC conductance cache) | `swload.c:140` | not needed in AC — recomputed from state + params | — |

The `(int)` cast (`swacload.c:26`) truncates the `double` state slot toward zero.
digiTS reproduces it with the `| 0` int32 coercion (`analog-switch.ts:333`). The
slot only ever holds the integer sentinels 0/1/2/3, so the cast is exact; the
`| 0` is retained for parity-of-form with ngspice's explicit `(int)`.

For SPDT the producer slots are `SLOT_STATE` of the COM-NO path (`_stateBase+0`)
and `SLOT_STATE` of the COM-NC path (`_stateBase+2`), written by the two
`swLoadHandles` calls in SPDT `load()` (`analog-switch.ts:509-530`). `SWacLoad`
reads each path's committed state independently (`analog-switch.ts:543, 551`).

## Part B — Conductance selection (rebuild of `swacload.c:28`)

ngspice (`swacload.c:28`):

```c
g_now = current_state ? model->SWonConduct : model->SWoffConduct;
```

This is a C **truthiness** test on the integer state: any non-zero state
(`REALLY_ON=1`, `HYST_OFF=2`, `HYST_ON=3`) selects `SWonConduct`; only
`REALLY_OFF=0` selects `SWoffConduct`. This differs from the DC pin-current
selection (`getPinCurrents`, `analog-switch.ts:395-397`) and the `load()`
selection (`swLoadHandles`, `analog-switch.ts:240-242`), which both test the
explicit pair `(current_state === REALLY_ON) || (current_state === HYST_ON)`
matching `swload.c:135`. **`SWacLoad` uses the looser truthiness test — this is
ngspice behavior, not a digiTS choice, and must be matched bit-exact.** In normal
operation the operating point only ever commits `REALLY_OFF` (0) or `REALLY_ON`
(1) at convergence, so the two tests agree; but the truthiness form is what
`swacload.c:28` writes and the recon ports it verbatim.

`SWonConduct` / `SWoffConduct` are the model conductances
(`swdefs.h:77-78`); `SWsetup` defaults them to `1/Ron` and `1/Roff`
(`swsetup.c:34-39`). digiTS computes them per-instance from the hot-loadable
`rOn`/`rOff` params:

```ts
// swacload.c:28 — g_now = current_state ? SWonConduct : SWoffConduct.
// Any non-zero committed state (REALLY_ON / HYST_OFF / HYST_ON) selects the on
// conductance; only REALLY_OFF (0) selects the off conductance (C truthiness,
// swacload.c:28). SWonConduct = 1/Ron, SWoffConduct = 1/Roff (swsetup.c:34-39).
const g_now = current_state ? 1 / this._rOn : 1 / this._rOff;
```

ngspice → digiTS identifier mapping:

| ngspice identifier | `swacload.c` line | digiTS identifier | source |
|---|---|---|---|
| `current_state ? … : …` | `:28` | `current_state ? … : …` (truthiness) | `analog-switch.ts:339` |
| `model->SWonConduct` | `:28` (`swdefs.h:77`) | `1 / this._rOn` | `analog-switch.ts:267` (`SWonConduct=1/Ron`, `swsetup.c:35`) |
| `model->SWoffConduct` | `:28` (`swdefs.h:78`) | `1 / this._rOff` | `analog-switch.ts:268` (`SWoffConduct=1/Roff`, `swsetup.c:39`) |

### #34 floor removal (baked in)

The existing `stampAc` computes `rOnNow = Math.max(this._rOn, 1e-3)` and
`rOffNow = Math.max(this._rOff, rOnNow*2)` (`analog-switch.ts:334-335`) and
stamps `1/rOnNow` / `1/rOffNow`. ngspice `SWacLoad` has NO such floor — it stamps
`SWonConduct`/`SWoffConduct` raw. Per #34 (`OPEN-QUESTIONS-WORKLOG.md:447-455`),
the floors are removed across `load()`, `getPinCurrents`, and AC; the conductance
the AC pass stamps is `1/this._rOn` / `1/this._rOff` (unfloored), identical to
what the netlist generator emits to the ngspice deck
(`netlist-generator.ts` `requireParam`, `OPEN-QUESTIONS-WORKLOG.md:449-451`).
This makes stamp == emit == ngspice. The recon mandates the unfloored read in
`stampAc` consistently with the #34 floor removal in the DC/transient paths.

## Part C — Matrix stamp (rebuild of `swacload.c:30-33`)

ngspice (`swacload.c:30-33`):

```c
*(here->SWposPosPtr) += g_now;
*(here->SWposNegPtr) -= g_now;
*(here->SWnegPosPtr) -= g_now;
*(here->SWnegNegPtr) += g_now;
```

This is the canonical 2×2 conductance stamp between the switch's positive
(`SWposNode`) and negative (`SWnegNode`) signal nodes: `+g` on the two
diagonal cells, `-g` on the two off-diagonal cells. It writes the **real** part
of each cell (no `+1` imaginary offset, unlike `CAPacLoad`'s `*(...Ptr+1)`),
because the switch admittance is a pure real conductance.

The four pointers are the SAME cells `SWsetup` allocated via TSTALLOC
(`swsetup.c:50-53`) and `SWload` writes the DC half of (`swload.c:142-145`):

| ngspice TSTALLOC | `swsetup.c` line | ngspice `(row,col)` | digiTS handle | `analog-switch.ts` (SPST) |
|---|---|---|---|---|
| `SWposPosPtr` | `:50` | `(SWposNode, SWposNode)` | `_hPP = allocElement(_nIn, _nIn)` | `:305` |
| `SWposNegPtr` | `:51` | `(SWposNode, SWnegNode)` | `_hPN = allocElement(_nIn, _nOut)` | `:306` |
| `SWnegPosPtr` | `:52` | `(SWnegNode, SWposNode)` | `_hNP = allocElement(_nOut, _nIn)` | `:307` |
| `SWnegNegPtr` | `:53` | `(SWnegNode, SWnegNode)` | `_hNN = allocElement(_nOut, _nOut)` | `:308` |

(`SWposNode`→`_nIn`, `SWnegNode`→`_nOut`; `analog-switch.ts:262-263`.) The
allocation order is the TSTALLOC sequence line-for-line, so the AC stamp reuses
`setup()`'s handles with no new AC-side allocation — mirroring ngspice, where
`SWsetup` allocates once and both `SWload` and `SWacLoad` stamp through the same
pointers.

### SPST `stampAc` body

```ts
stampAc(solver: SparseSolverStamp, _omega: number, _ctx: LoadContext): void {
  // swacload.c:24-26 — AC analysis propagates the operating-point switch state;
  // it does not re-run the state machine. Read the state SWload committed to
  // CKTstate0[SWswitchstate] (swload.c:132); SWswitchstate = SWstate+0
  // (swdefs.h:60) is SLOT_STATE.
  const current_state = (this._pool.states[0][this._stateBase + SLOT_STATE]) | 0;
  // swacload.c:28 — g_now = current_state ? SWonConduct : SWoffConduct (C
  // truthiness: any non-zero committed state selects the on conductance).
  // SWonConduct = 1/Ron, SWoffConduct = 1/Roff (swsetup.c:35,39). No resistance
  // floor — the stamped conductance equals the value emitted to the ngspice deck.
  const g_now = current_state ? 1 / this._rOn : 1 / this._rOff;
  // swacload.c:30-33 — real-part 2×2 conductance stamp; the admittance is purely
  // resistive, so there is no imaginary contribution (no stampElementImag).
  solver.stampElement(this._hPP, +g_now);   // *(SWposPosPtr) += g_now
  solver.stampElement(this._hPN, -g_now);   // *(SWposNegPtr) -= g_now
  solver.stampElement(this._hNP, -g_now);   // *(SWnegPosPtr) -= g_now
  solver.stampElement(this._hNN, +g_now);   // *(SWnegNegPtr) += g_now
}
```

`omega` is unused: `SWacLoad` reads no frequency (`swacload.c` has no
`ckt->CKTomega` reference), because a resistor's admittance is
frequency-independent. The parameter is retained for the `stampAc` interface
(`capacitor.ts:462`) and prefixed `_omega` per the unused-parameter convention.

### SPDT `stampAc` body

The SPDT element is two complementary SW instances sharing one control voltage
(`analog-switch.ts:21-27, 424-432`). `SWacLoad` runs once per SW path, reading
each path's committed `SLOT_STATE` and stamping that path's four handles:

```ts
stampAc(solver: SparseSolverStamp, _omega: number, _ctx: LoadContext): void {
  // swacload.c:24-33 applied to both complementary SW paths. Each path runs the
  // SWacLoad body against its own committed state and its own four handles.
  const s0 = this._pool.states[0];

  // COM-NO path (state slot _stateBase+0).
  const stateNO = (s0[this._stateBase + 0]) | 0;          // swacload.c:26
  const gNO = stateNO ? 1 / this._rOn : 1 / this._rOff;   // swacload.c:28
  solver.stampElement(this._hNO_PP, +gNO);                // swacload.c:30
  solver.stampElement(this._hNO_PN, -gNO);                // swacload.c:31
  solver.stampElement(this._hNO_NP, -gNO);                // swacload.c:32
  solver.stampElement(this._hNO_NN, +gNO);                // swacload.c:33

  // COM-NC path (state slot _stateBase+2).
  const stateNC = (s0[this._stateBase + 2]) | 0;          // swacload.c:26
  const gNC = stateNC ? 1 / this._rOn : 1 / this._rOff;   // swacload.c:28
  solver.stampElement(this._hNC_PP, +gNC);                // swacload.c:30
  solver.stampElement(this._hNC_PN, -gNC);                // swacload.c:31
  solver.stampElement(this._hNC_NP, -gNC);                // swacload.c:32
  solver.stampElement(this._hNC_NN, +gNC);                // swacload.c:33
}
```

The SPDT path handles are allocated in SPDT `setup()` (COM-NO at
`analog-switch.ts:490-493`, COM-NC at `analog-switch.ts:496-499`), each four-cell
group following the `swsetup.c:50-53` TSTALLOC order with `(pos=nCom,
neg=nNO)` / `(pos=nCom, neg=nNC)`.

## Part D — Reactivity / dispatch (how `stampAc` is invoked)

`stampAc` is the AC-pass entry the engine calls in place of `load()` during AC
analysis (the same dispatch the `cap` pilot established, `capacitor.ts:462`).
Method-presence is the reactivity gate (`element.ts` AC-stamp detection, the
same mechanism the capacitor uses): a class that defines `stampAc` participates
in the AC matrix fill. Both switch classes already define it
(`analog-switch.ts:327, 533`), so dispatch is already wired; this recon only
governs the body.

The DC operating-point solve runs first (committing `CKTstate0[SWswitchstate]`
via `SWload`, `swload.c:132`), then the AC pass calls `stampAc` per element at
each swept frequency. Because `g_now` is frequency-independent, the switch
stamps the identical four real values at every frequency in the sweep — the
operating-point conductance frozen across the AC band, exactly as `SWacLoad`
does (it has no per-frequency term).

## Acceptance criteria

1. `AnalogSwitchSPSTElement.stampAc` reads the committed switch state from
   `this._pool.states[0][this._stateBase + SLOT_STATE]` with an int coercion
   (`| 0`), reproducing `(int) ckt->CKTstate0[here->SWswitchstate]`
   (`swacload.c:26`; `SWswitchstate = SWstate+0`, `swdefs.h:60`). It does NOT
   re-run the SW state machine.
2. The conductance is selected by the **truthiness** test
   `current_state ? gOn : gOff` (`swacload.c:28`) — any non-zero committed state
   selects the on conductance — NOT the `REALLY_ON || HYST_ON` pair test used by
   `load()`/`getPinCurrents`. `gOn = 1/this._rOn`, `gOff = 1/this._rOff`
   (`SWonConduct`/`SWoffConduct`, `swsetup.c:35,39`).
3. The `Math.max(_rOn,1e-3)` / `Math.max(_rOff,_rOn*2)` resistance floors are
   REMOVED from `stampAc` (and, per #34, from `load()` and `getPinCurrents`):
   the stamped AC conductance equals the unfloored `1/_rOn` / `1/_rOff` emitted
   to the ngspice deck. ngspice has no floor.
4. The four matrix cells are stamped via `solver.stampElement` (real part):
   `+g` on `_hPP`/`_hNN`, `-g` on `_hPN`/`_hNP` (`swacload.c:30-33`). No
   `stampElementImag` call — the switch admittance is purely resistive, so the
   imaginary half is untouched. The handles are the `setup()` handles
   (`analog-switch.ts:305-308`, `swsetup.c:50-53` TSTALLOC order); no new AC-side
   allocation.
5. `AnalogSwitchSPDTElement.stampAc` runs the `SWacLoad` body once per SW path:
   COM-NO reads `_stateBase+0` and stamps `_hNO_*`; COM-NC reads `_stateBase+2`
   and stamps `_hNC_*`. Each path uses its own committed state and its own four
   handles (`analog-switch.ts:490-499`).
6. `omega` / `_ctx` are unused (`SWacLoad` reads no `CKTomega`); the stamp is
   frequency-independent and identical at every swept frequency.
7. Every reconstructed comment cites the current
   `ref/ngspice/src/spicelib/devices/sw/<file>:line` and explains the mechanism
   in present tense — no `v26`/`v41`/era tags, no migration narrative.
8. With `sw#recon/acLoad` `APPLIED`, the two blocked v41 hunks
   (`swacload.c#h001`, `swacload.c#h002`, next section) apply onto the
   spec-governed baseline as ordinary per-hunk deltas. `build-ledger.mjs`
   re-runs cleanly with the recon `APPLIED` and the two hunks unblocked.
9. An AC sweep on an SPST switch in each committed state — a fixture biased so
   the operating-point solve commits `REALLY_ON` (e.g. ctrl above
   `vThreshold + vHysteresis`) and a second biased to `REALLY_OFF` — produces the
   AC matrix entries (the four `±g_now` cells) matching the ngspice DLL at every
   swept frequency, plus an SPDT fixture exercising both complementary paths.
   Verified via the `harness_*` MCP AC tool chain (`harness_start` →
   `harness_run_ac` → `harness_first_divergence` → `harness_matrix_diff` →
   `harness_get_attempt`), with `firstDivergence` null across all four signal
   classes (voltage / matrix / state / shape). Bit-exact under the
   matched-arithmetic-order constraint — no tolerance qualifier.

## Blocked hunks (apply after the recon)

These two v41 hunks are `blockedBy: sw#recon/acLoad` in `ledger.json` and apply
as ordinary per-hunk deltas once the spec-governed baseline above is `APPLIED`:

| Hunk | ngspice anchor | what it adds onto the baseline |
|---|---|---|
| `swacload.c#h001` | `swacload.c` (state read / conductance select) | accessor / state-read delta atop the `(int)CKTstate0[SWswitchstate]` + truthiness-select baseline |
| `swacload.c#h002` | `swacload.c` (matrix stamp) | `ptr→Ptr` accessor-rename / stamp delta atop the four-cell `±g_now` real-part stamp baseline |

(The exact per-hunk content is set by each hunk's `ledger.json`
hunkHeader/docLineRange; both apply onto the `stampAc` body this spec governs.
Any remaining sw hunks — `swsetup.c`/`swload.c`/`swtrunc.c`/`swdefs.h` accessor
renames and the #34 floor-removal code fix — are resolved independently per their
`ledger.json` planningNotes and do NOT block on this recon.)

## BUILD NOTE — run-1 escalation fix (shared-file commit discipline + comment hygiene)

All three sw recons (acLoad / trunc / icParam) edit the single file
`analog-switch.ts`. Two run-1 blockers to avoid:
1. **Commit only THIS recon's scoped lines.** Do not stage unrelated hunks into a
   recon commit. In particular the `swload.c:90` internalerror (the MODEINITFLOAT
   branch — replace the silent `current_state = HYST_OFF` fallback with
   `throw new Error("bad value for previous state in swload")`) is a SEPARATE
   state-machine hunk, NOT part of acLoad (stampAc), trunc (getLteTimestep), or
   icParam (IC plumbing). Port it as its own concern; do not fold it into a recon
   commit. In run 1 staging it into the acLoad commit blocked all three sw recons.
2. **No era tags in comments** (CLAUDE.md). The run-1 worktree comment "the message
   is the v41 wording" carries the banned `v41` term. Cite `swload.c:90` + a
   present-tense mechanism instead.

Status: RATIFIED 2026-05-30 (user, batch).
