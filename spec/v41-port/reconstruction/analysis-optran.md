# Reconstruction spec — `analysis#recon/opTran`

Status: BUILDABLE 2026-06-02 — the stiff-fixture blocker is RESOLVED. The fixture is an
**inductor-induced DC branch-current singularity** (two source-pinned nodes bridged by an
ideal inductor): `v1 1 0 dc 3 / v2 2 0 dc 5 / l1 1 2 1m`. Confirmed against the v41 DLL —
the static ladder fails as singular on `l1#branch` (gmin/source-resistant, since gmin is a
node-to-ground conductance and cannot constrain a branch current), OPtran settles to a
unique 3V/5V OP with zero drift over a 1000× `opfinaltime` sweep, and adding any series R
makes it converge statically (proving the inductor short is the cause). It is trivially
`.dts`-expressible (2 vsources + 1 inductor). Remaining to build: the optran option
plumbing (`ResolvedSimulationParams` + a harness `optran` `NgspiceJobAnalysis` variant +
MCP knob), the OPtran driver, and the `.dts` fixture. Recon PENDING, ready to build. See
**ESC-025**.

Port ngspice's `OPtran` (`optran.c`) — the operating-point-via-pseudo-transient
**last-resort convergence fallback** — and its call site in `CKTop`
(`cktop.c:101-108`). This is the behavioral half of the `analysis/cktop.c#h001`
escalation (the cosmetic/restructure parts of that hunk are Decision-1 OUT; the
`OPtran` integration is IN, per the user ruling).

## Why (the divergence) + scope

`CKTop` (`cktop.c:34-116`) attempts DC-OP convergence in escalating fallbacks:
direct `NIiter` -> gmin stepping -> source stepping -> **`OPtran`**
(`cktop.c:104`). digiTS's `solveDcOperatingPoint` implements direct + gmin +
source stepping but **not** the `OPtran` fallback, so a circuit that exhausts the
static methods has one fewer recovery path than ngspice.

**OPtran is opt-in.** `optran.c:51` `nooptran = TRUE` by default; `OPtran`
returns `oldconverged` immediately unless the `optran` command/option set
`opstepsize`/`opfinaltime`/`opramptime` (`optran.c:71-187, 314-315`). So porting
it does **not** change digiTS's default DC-OP path — it adds a fallback that
activates only when the `optran` option is set. Lower-risk than a default-path
change; the acceptance criteria pin "default-off => byte-identical to today".

## ngspice mechanism

**Call site (`cktop.c:101-108`):** after source stepping, `converged =
OPtran(ckt, converged)`; `106`/non-zero => "Transient op failed".

**`OPtran` (`optran.c:289-845`)** — "a simple transient simulation from time 0
to opfinaltime ... derived from dctran.c by removing all un-needed parts"
(`optran.c:284-288`). It leaves the matrix at the settled OP. Structure:
- **Init** (`optran.c:321-413`): if `opramptime>0`, zero `CKTrhsOld`/`CKTstate0`
  and solve with `CKTsrcFact=0` (`:326-338`); set `CKTmaxStep=CKTstep=opstepsize`
  (`:355-357`), `delta = MIN(opfinaltime/100, CKTstep)/10` (`:359`), seed the
  breakpoint array `[0, opfinaltime]` (`:378-382`), `CKTorder=1`,
  `CKTmode = (CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN` (`:409`), copy
  `state0 -> state1` (`:412-413`).
- **Timestep loop** (`nextTime:`/`resume:` `optran.c:424-843`): `CKTaccept`
  (`:443`); breakpoint clear/limit; `CKTdelta = MIN(CKTdelta, CKTmaxStep)`; at a
  breakpoint cut order to 1 + limit delta (`:503-530`); rotate `CKTdeltaOld[]`
  and `CKTstates[]` (`:643-651`); inner solve loop: `optime += CKTdelta`; **supply
  ramp** `CKTsrcFact = 0.5*(1 - cos(pi*optime/opramptime))` when `opramptime>0`
  (`:662-664`); `NIcomCof`; `NIiter(CKTtranMaxIter)` (`:697`); on non-convergence
  cut `CKTdelta/=8` + order 1 (`:720-733`); on convergence `CKTtrunc(&newdelta)`
  for LTE timestep control (`:766`), accept/grow or reject/shrink; finish when
  `optime ~= opfinaltime` (`:476-482`, returns OK with the matrix at the OP).
  Timestep-too-small (`CKTdelta <= CKTdelmin`) -> `E_TIMESTEP` (`:807-814`).

It REUSES the transient kernel: `NIiter`, `CKTtrunc`, `CKTaccept`, `NIcomCof`,
the `CKTstates`/`CKTdeltaOld` rotation, breakpoint handling.

## digiTS target + approach

digiTS already has the transient kernel `OPtran` reuses: the NR solve, the
timestep controller (LTE/`CKTtrunc` counterpart `cktTerr`), breakpoint handling
(`TimestepController`), `state0/1/2/3` rotation, `NIcomCof` companion-coef. So
the port is mostly **wiring**, not new numerics:
1. **`CKTop` fallback** in `solveDcOperatingPoint` (`dc-operating-point.ts`):
   after source stepping fails and only if the `optran` option is set, invoke an
   OPtran driver; map its return (OK / timestep-too-small) to the DC-OP outcome.
2. **OPtran driver**: a pseudo-transient run from 0 to `opfinaltime` reusing
   `MNAEngine`'s transient stepping (the `stepToTime`/timestep-controller path),
   with `CKTmode = MODEUIC?|MODETRAN|MODEINITTRAN` then `MODEINITPRED`, the
   `opstepsize`/`opfinaltime` step config, the `delta=MIN(opfinaltime/100,step)/10`
   seed, the breakpoint `[0,opfinaltime]`, and the **supply ramp**
   `srcFact = 0.5*(1 - cos(pi*optime/opramptime))` when `opramptime>0`. No output
   capture; on reaching `opfinaltime` the engine state IS the OP.
3. **`optran` option** plumbing: `opstepsize`/`opfinaltime`/`opramptime` +
   `nooptran` default-true, on `ResolvedSimulationParams` / the option surface
   (the `com_optran` counterpart — a params field, not a CLI command).

| ngspice | digiTS | source |
|---|---|---|
| `CKTop` ... `OPtran(ckt, converged)` | `solveDcOperatingPoint` post-source-step fallback | `cktop.c:101-108` |
| `nooptran` (default true) | `params.optran` disabled by default | `optran.c:51,314-315` |
| `opstepsize`/`opfinaltime`/`opramptime` | the same fields on the option surface | `optran.c:48-50,71-187` |
| pseudo-transient 0..opfinaltime, no output | OPtran driver reusing `MNAEngine` transient stepping | `optran.c:284-845` |
| `CKTsrcFact = 0.5*(1-cos(pi*optime/opramptime))` | the supply-ramp factor in the OPtran loop | `optran.c:662-664` |
| `CKTmode = MODEUIC?\|MODETRAN\|MODEINITTRAN` then `MODEINITPRED` | the OPtran-pass cktMode sequence | `optran.c:409,417,707,731` |
| `NIiter`/`CKTtrunc`/`CKTaccept`/`NIcomCof`/state rotation | the existing digiTS transient kernel (reused, not re-ported) | `optran.c:697,766,443,667,643-651` |

## Acceptance criteria

1. `solveDcOperatingPoint` gains an `OPtran` fallback after source stepping,
   invoked ONLY when the `optran` option is set; the call-site + outcome mapping
   match `cktop.c:101-108`.
2. The OPtran driver reproduces `optran.c`'s pseudo-transient: step config
   (`opstepsize`/`opfinaltime`), `delta` seed, mode sequence (incl. the
   `optran.c:731` `MODEINITTRAN` re-arm on non-converged-firsttime), supply ramp,
   LTE timestep control (incl. the `optran.c:754-759` firsttime LTE-skip on the
   first accepted point), timestep-too-small -> error — reusing digiTS's transient
   kernel (no re-ported numerics).
3. **Default-off invariant:** with the `optran` option unset, DC-OP is
   byte-for-byte identical to today (the fallback never runs).
4. With `optran` enabled, a circuit that exhausts direct + gmin + source stepping
   converges via OPtran to an OP **bit-exact** to the ngspice DLL's OPtran run
   (`harness_first_divergence` null across classes). Verified via the harness on the
   inductor-singular fixture `v1 1 0 dc 3 / v2 2 0 dc 5 / l1 1 2 1m` (singular on
   `l1#branch`, gmin/source-resistant, OPtran settles to a unique 3V/5V OP, zero drift over
   a 1000× `opfinaltime` sweep; series R makes it converge statically — confirmed against
   the v41 DLL). Authored as a `.dts` (2 vsources + 1 inductor).
5. No `v26`/`v41`/era tags; present-tense citations to `optran.c`/`cktop.c`.

## tsFiles (implementer-confirmed)

`src/solver/analog/dc-operating-point.ts` (the `CKTop` fallback + OPtran driver),
`src/solver/analog/analog-engine.ts` (reuse of the transient stepping for the
pseudo-transient), and the option surface for `optran`/`opstepsize`/`opfinaltime`/
`opramptime` (`analog-engine-interface.ts` / params). Structurally-forced files
per the standard scope rule.

## Blocked hunks

`analysis/cktop.c#h001` — the behavioral `OPtran` integration applies onto this
baseline. (The cosmetic/restructure portions of that hunk are Decision-1 OUT and
do not block here.) Confirm the exact hunk split at apply time.

## Open item (flag, not a blocker)

`optran.c` carries XSPICE event + LTRA + SHARED_MODULE branches and a `dbs`
debugger extern — all Decision-1 OUT (no digiTS counterpart). The port targets
the non-XSPICE, non-LTRA core path; the `#ifdef`-guarded blocks are accepted
divergences, not ported.
