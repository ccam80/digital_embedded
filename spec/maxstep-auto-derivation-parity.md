# maxStep auto-derivation parity gap

**Status:** PROPOSED. Not in scope of any current phase.
**Surfaced by:** the timestep-control vocabulary audit on 2026-04-25.
**Author:** Claude (Opus 4.7) for user review.

## Problem

ngspice's `traninit.c:23-32` is the only general entry point that sets
`CKTmaxStep`. It uses an **auto-derivation rule** when the user does not
supply an explicit `tmax` on the `.tran` line:

```c
ckt->CKTmaxStep = job->TRANmaxStep;
if (ckt->CKTmaxStep == 0) {
    if (ckt->CKTstep < (ckt->CKTfinalTime - ckt->CKTinitTime) / 50.0)
        ckt->CKTmaxStep = ckt->CKTstep;
    else
        ckt->CKTmaxStep = (ckt->CKTfinalTime - ckt->CKTinitTime) / 50.0;
}
```

In words: if the user omits `tmax`, ngspice picks `CKTmaxStep = MIN(CKTstep,
(finalTime − initTime) / 50)`. Only when `CKTmaxStep` is non-zero — i.e. when
the user *explicitly* set a maxStep — does ngspice use the user's value
unmodified.

**digiTS does not do this.** `src/core/analog-engine-interface.ts:181` reads:

```ts
const maxTimeStep = params.maxTimeStep ?? DEFAULT_SIMULATION_PARAMS.maxTimeStep;
```

When the caller omits `maxTimeStep`, we fall through to the static module-
level default `DEFAULT_SIMULATION_PARAMS.maxTimeStep = 10e-6`
(`analog-engine-interface.ts:143`). The default is **independent of the
caller's `tStop` and `outputStep`**.

## Why this matters numerically

Every other quantity that ngspice derives at transient init is keyed on
`CKTmaxStep`:

| Quantity            | Formula                          | ngspice site         |
|---------------------|----------------------------------|----------------------|
| `CKTdelmin`         | `1e-11 * CKTmaxStep`             | `traninit.c:34`      |
| `CKTminBreak`       | `5e-5 * CKTmaxStep`              | `dctran.c:157`       |
| `CKTdeltaOld[0..6]` | `CKTmaxStep`                     | `dctran.c:316-317`   |
| top-of-step clamp   | `dt = MIN(dt, CKTmaxStep)`       | `dctran.c:540`       |
| at-breakpoint clamp | `0.1 * MIN(CKTsaveDelta, gap)`   | `dctran.c:572-573`   |
| at-breakpoint floor | `MAX(dt, CKTdelmin * 2)` (#ifndef XSPICE) | `dctran.c:588` |

Our timestep controller now (post-2026-04-25 fix) derives `_delmin` and
`_minBreak` from `params.maxTimeStep` exactly like ngspice. For every other
quantity in this table, we already key on `params.maxTimeStep`. So when the
caller's `params.maxTimeStep` agrees with ngspice's `CKTmaxStep`, our top-
of-step flow is structurally identical.

**The gap is one level up: caller-supplied `params.maxTimeStep` does not
agree with ngspice's `CKTmaxStep` when the caller omits it.**

For a typical comparison run with `tStop = 1e-3`, `outputStep = 1e-5`, no
user `tmax`:

| Engine    | maxStep                                       | value  |
|-----------|-----------------------------------------------|--------|
| ngspice   | `MIN(CKTstep, finalTime/50) = MIN(1e-5, 2e-5)` | `1e-5` |
| digiTS    | `DEFAULT_SIMULATION_PARAMS.maxTimeStep`        | `10e-6` |

Same value here, by coincidence. Now consider `tStop = 2e-3`,
`outputStep = 1e-5`, no user `tmax`:

| Engine    | maxStep                                          | value  |
|-----------|--------------------------------------------------|--------|
| ngspice   | `MIN(1e-5, 4e-5) = 1e-5`                          | `1e-5` |
| digiTS    | `DEFAULT_SIMULATION_PARAMS.maxTimeStep = 10e-6`   | `10e-6` |

Still match by coincidence (both 1e-5). Now consider `tStop = 100e-3`,
`outputStep = 1e-3`, no user `tmax`:

| Engine    | maxStep                                          | value  |
|-----------|--------------------------------------------------|--------|
| ngspice   | `MIN(1e-3, 2e-3) = 1e-3`                          | `1e-3` |
| digiTS    | `10e-6`                                            | `10e-6` |

**Now they diverge by 100×.** Every derived quantity diverges by the same
ratio:
- `_delmin` ngspice 1e-14 vs digiTS 1e-16
- `_minBreak` ngspice 5e-8 vs digiTS 5e-10
- `_deltaOld` seed ngspice 1e-3 vs digiTS 1e-5
- per-step `MIN(dt, maxStep)` ceiling ngspice 1e-3 vs digiTS 1e-5
- at-breakpoint `0.1 * gap` clamp behaves identically only because `gap`
  doesn't scale with maxStep — the clamp will *fire* in different regions

The numerical consequences are not "tolerance band" issues, they are
structural: the two engines walk different stepping schedules from step 0,
and any bit-exact comparison test that doesn't *explicitly* configure
`params.maxTimeStep` is comparing two different jobs.

## Why the comparison harness happens to be fine today

`src/solver/analog/__tests__/harness/comparison-session.ts:599-601` does:

```ts
const resolvedMaxStep = maxStep != null
  ? maxStep
  : Math.min(tstep, (tStop - tStart) / 50);
```

The harness already implements the ngspice rule **on the digiTS side** before
calling `engine.configure(...)`. So inside the harness, both engines see the
same `maxStep` and the parity tests work. This is a band-aid — it lives in
the harness, not in `resolveSimulationParams` — so any production caller
(MCP server, postMessage adapter, app-init, headless tests outside the
harness) hits the static `10e-6` default instead.

Two consequences:

1. The harness is the *only* call site that produces ngspice-equivalent
   defaults. Every other caller silently runs a different stepping
   schedule than `.tran` would in ngspice.
2. The structural rule lives in two places (harness + ngspice). When the
   `traninit.c:27-32` rule changes (it has been touched by ngspice
   maintainers historically — see "macspice 3f4 / A. Wilson" comment at
   `traninit.c:25`), only one of the two copies will be updated.

## Proposed scope

The fix is in `src/core/analog-engine-interface.ts:180-200`
(`resolveSimulationParams`). Three steps:

1. When `params.maxTimeStep` is omitted **and** `params.tStop` and
   `params.outputStep` are both available, derive
   `maxTimeStep = MIN(outputStep, (tStop - tStart) / 50)` exactly per
   `traninit.c:27-32`. Use `tStart = 0` until digiTS supports a non-zero
   transient start time (ngspice's `CKTinitTime`).
2. When `params.maxTimeStep` is omitted **and** `params.tStop` is not
   provided (streaming mode), keep the existing
   `DEFAULT_SIMULATION_PARAMS.maxTimeStep` fallback. ngspice cannot run a
   transient analysis without a finalTime, so streaming mode is
   structurally outside ngspice's domain — the static default is the
   closest analogue.
3. Delete the harness-side branch at `comparison-session.ts:599-601`. The
   `resolveSimulationParams` change makes it redundant; deleting it
   forces every future caller through the same code path and removes the
   "two copies of the rule" maintenance trap.

After step 3, the harness's `engine.configure({ tStop, maxTimeStep, ... })`
becomes `engine.configure({ tStop, outputStep, ... })` — the engine derives
maxStep from tStop+outputStep itself. (`outputStep` is currently passed via
`params.outputStep` already; `resolveSimulationParams:189` reads it for the
firstStep computation.)

## Out of scope

- `CKTinitTime` support. ngspice's `(finalTime - initTime) / 50` allows
  `.tran <step> <stop> <start>`. digiTS has no transient start-time
  parameter today. Treat `tStart = 0` until that is added; revisit then.
- The `CKTmaxStep == 0` user-supplied path. ngspice treats user-supplied
  zero the same as omitted; digiTS's `params.maxTimeStep` is `?: number`,
  so omitted and zero are distinct. Decide per call site: production
  callers should treat `params.maxTimeStep === 0` as omitted (matches
  ngspice); harness callers already do.
- Device-driven maxStep overrides (`txlload.c:128`, `cplload.c:150`).
  These are transmission-line-specific stability cuts; digiTS does not
  yet implement transmission line elements, and when it does, those
  models can register their own maxStep clamps via the
  TimestepController public API.

## Verification

After the fix, this property holds:

> For any `params: SimulationParams` with `tStop` and `outputStep` set
> and `maxTimeStep` omitted, `resolveSimulationParams(params).maxTimeStep`
> equals what ngspice's `traninit.c:27-32` would set for the same job.

A direct unit test in `src/core/__tests__/resolve-simulation-params.test.ts`
covering:
- both bounds of the MIN: `outputStep < (tStop-0)/50` and the converse
- the streaming fallback: tStop omitted → defaults
- explicit user maxStep: passed through unmodified

is sufficient for the type. Existing comparison tests verify the harness
deletion doesn't break parity (they were keyed on the harness branch).

## Cross-references

- Sibling fix: `_delmin` and `_minBreak` derivation in `timestep.ts`
  (landed 2026-04-25). That fix corrected the *use* of `maxTimeStep` for
  ngspice-keyed quantities. This problem is one level up: making sure
  `params.maxTimeStep` itself agrees with `CKTmaxStep` when the caller
  omits it.
- Architectural alignment: this is structural (matches the criteria in
  `spec/architectural-alignment.md` §0 — the two engines do not expose
  the same default-derivation behaviour). Per the rules in that doc,
  agents do not add items to it. User decides whether this becomes a
  FIX item there, or a numerical fix-list item.
