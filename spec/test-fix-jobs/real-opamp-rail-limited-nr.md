# real-opamp pool-backing + railLim NR discipline

**Category:** `architecture-fix`

---

## 1. Problem statement

`src/components/active/real-opamp.ts::createRealOpAmpElement` currently owns
all of its iteration-to-iteration state in factory-closure JavaScript
variables (`vInt`, `vIntPrev`, `_vOutPrev`, `outputSaturated`,
`outputClampLevel`, `currentLimited`, `iOutLimited`, `slewLimited`, `aEff`,
`geq_int`, `lastSrcFact`, `vInp`, `vInn`, `vVccP`, `vVccN`, `vOut`). The
element returns a plain `AnalogElement` (NOT `PoolBackedAnalogElement`) — the
factory has no `poolBacked: true`, no `stateSize`, no `stateSchema`, no
`initState()`, and no `_stateBase` allocation in `setup()`.

Two consequences:

1. **State is invisible to the engine's checkpoint/rollback.** When NR
   fails or LTE rejects a step, the engine restores `StatePool` slots from
   `state1`/`state2`/`state3` but cannot restore the closure variables.
   Subsequent retries see stale `vIntPrev` / saturation flags from the
   abandoned attempt.
2. **NR has no rail-clamp discipline.** The current `load()` body clamps
   the *internal* `vInt` to `[vRailNeg, vRailPos]` (real-opamp.ts:490-503)
   AND determines `outputSaturated` from the raw `vOut` reading
   (real-opamp.ts:506-515). When NR overshoots the supply rails on a fresh
   iterate, neither path bumps `ctx.noncon.value` and the limiting is not
   recorded as a non-convergence event. NR therefore declares convergence
   on iterations where the `vOut` solve has just oscillated past the rail
   and been silently truncated.

10 of the 12 vitest tests in
`src/components/active/__tests__/real-opamp.test.ts` fail because of (2):
the rail-saturation tests, the slew-rate tests, the inverting-gain test
(closed-loop solve overshoots before rails settle), the 741 model test,
the C4.5 parity test, the offset and current-limit tests. The two passing
tests (`element_has_correct_flags`, `component_definition_has_correct_engine_type`)
do not call `load()`.

---

## 2. Sites

### 2.1 `src/components/active/real-opamp.ts`

Migration of the entire `createRealOpAmpElement` factory to the
`PoolBackedAnalogElement` shape used by `diode.ts`, `bjt.ts`, `mosfet.ts`,
`capacitor.ts`, `inductor.ts`, etc.

### 2.2 `src/solver/analog/newton-raphson.ts`

Add the `railLim` helper next to `pnjlim`, `fetlim`, and `limvds`. Export
it for the real-opamp `load()` site to call.

### 2.3 (out of scope, but flagged) `src/solver/analog/composite-element.ts`

Real-opamp does NOT become a `CompositeElement` subclass. See §6 below.

---

## 3. Pool-backing migration plan

### 3.1 Element shape

```ts
import type { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import { defineStateSchema, applyInitialValues, type StateSchema } from "../../solver/analog/state-schema.js";

export const REAL_OPAMP_SCHEMA: StateSchema = defineStateSchema("RealOpAmpElement", [
  { name: "VINT",            doc: "Gain-stage internal voltage at current NR iterate", init: { kind: "zero" } },
  { name: "VINT_PREV",       doc: "Gain-stage internal voltage at previous accepted step",  init: { kind: "zero" } },
  { name: "VOUT_PREV",       doc: "Output voltage at previous accepted step",          init: { kind: "zero" } },
  { name: "VOUT_LIMITED",    doc: "Output voltage AFTER railLim was applied at this iter", init: { kind: "zero" } },
  { name: "GEQ_INT",         doc: "Companion conductance for gain-stage integrator",   init: { kind: "zero" } },
  { name: "AEFF",            doc: "Bandwidth-reduced effective gain at this iterate",  init: { kind: "zero" } },
  { name: "OUT_SAT_LEVEL",   doc: "Saturation clamp level (0 = not saturated)",        init: { kind: "zero" } },
  { name: "OUT_SAT_FLAG",    doc: "1 if output is rail-saturated this iterate, 0 otherwise", init: { kind: "zero" } },
  { name: "I_OUT_LIMITED",   doc: "Current-limited output current; 0 when not in I-limit", init: { kind: "zero" } },
  { name: "I_LIMIT_FLAG",    doc: "1 if output current is at I_max, 0 otherwise",      init: { kind: "zero" } },
  { name: "SLEW_FLAG",       doc: "1 if integrator is slew-rate-limited this iterate, 0 otherwise", init: { kind: "zero" } },
  { name: "SRC_FACT",        doc: "Cached ctx.srcFact from last load() (pin-current path)", init: { kind: "constant", value: 1 } },
]);
```

`stateSize: 12`.

### 3.2 Factory return shape

```ts
const element: PoolBackedAnalogElement = {
  label: "",
  branchIndex: -1,
  ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
  _stateBase: -1,
  _pinNodes: new Map(pinNodes),

  poolBacked: true as const,
  stateSize: REAL_OPAMP_SCHEMA.size,
  stateSchema: REAL_OPAMP_SCHEMA,

  setup(ctx) { /* TSTALLOC handles + idempotent state base allocation */ },
  initState(poolRef) { pool = poolRef; base = element._stateBase;
                       applyInitialValues(REAL_OPAMP_SCHEMA, pool, base, {}); },
  load(ctx) { /* see §4 below */ },
  accept(ctx, _t, _bp) { /* see §3.3 below */ },
  getPinCurrents(_rhs) { /* read SLOT_VOUT_LIMITED, SLOT_OUT_SAT_FLAG, SLOT_I_LIMIT_FLAG, SLOT_SRC_FACT from pool */ },
  setParam(key, value) { if (key in p) p[key] = value; },
};
```

### 3.3 `setup()`

Idempotent state base allocation, mirroring `diode.ts:500-503` and the
`mutual-inductor.ts:94-95` precedent:

```ts
setup(ctx) {
  if (element._stateBase === -1) {
    element._stateBase = ctx.allocStates(element.stateSize);
  }
  base = element._stateBase;
  // existing TSTALLOC handle allocations stay as-is
  // (hInpInp, hInnInn, hInpInn, hInnInp, hOutOut, hOutInp, hOutInn)
}
```

### 3.4 `accept()`

Records the converged-iterate values into the *_PREV slots:

```ts
accept(ctx, _simTime, _addBp) {
  const s0 = pool.states[0];
  s0[base + SLOT_VINT_PREV] = s0[base + SLOT_VINT];
  s0[base + SLOT_VOUT_PREV] = ctx.rhs[nOut];   // converged output node voltage
}
```

The standard StatePool ring rotation
(state0 → state1 → state2 → state3) is performed by the engine post-accept;
no per-element rotation is required.

### 3.5 `initState()`

```ts
initState(poolRef) {
  pool = poolRef;
  base = element._stateBase;
  applyInitialValues(REAL_OPAMP_SCHEMA, pool, base, {});
  // After applyInitialValues: VINT=0, VINT_PREV=0, VOUT_PREV=0, ..., SRC_FACT=1
}
```

### 3.6 Slot constants and reads

```ts
const SLOT_VINT          = REAL_OPAMP_SCHEMA.indexOf.get("VINT")!;
const SLOT_VINT_PREV     = REAL_OPAMP_SCHEMA.indexOf.get("VINT_PREV")!;
const SLOT_VOUT_PREV     = REAL_OPAMP_SCHEMA.indexOf.get("VOUT_PREV")!;
const SLOT_VOUT_LIMITED  = REAL_OPAMP_SCHEMA.indexOf.get("VOUT_LIMITED")!;
const SLOT_GEQ_INT       = REAL_OPAMP_SCHEMA.indexOf.get("GEQ_INT")!;
const SLOT_AEFF          = REAL_OPAMP_SCHEMA.indexOf.get("AEFF")!;
const SLOT_OUT_SAT_LEVEL = REAL_OPAMP_SCHEMA.indexOf.get("OUT_SAT_LEVEL")!;
const SLOT_OUT_SAT_FLAG  = REAL_OPAMP_SCHEMA.indexOf.get("OUT_SAT_FLAG")!;
const SLOT_I_OUT_LIMITED = REAL_OPAMP_SCHEMA.indexOf.get("I_OUT_LIMITED")!;
const SLOT_I_LIMIT_FLAG  = REAL_OPAMP_SCHEMA.indexOf.get("I_LIMIT_FLAG")!;
const SLOT_SLEW_FLAG     = REAL_OPAMP_SCHEMA.indexOf.get("SLEW_FLAG")!;
const SLOT_SRC_FACT      = REAL_OPAMP_SCHEMA.indexOf.get("SRC_FACT")!;
```

Per the diode template (`src/components/semiconductors/diode.ts:537-540`):
read `pool.states[0]` once at the top of `load()` and use direct
`s0[base + SLOT_*]` access. Do NOT cache state arrays as closure variables.

---

## 4. `railLim` helper

### 4.1 Signature and body — to live in `src/solver/analog/newton-raphson.ts`

Add immediately after `limvds` (newton-raphson.ts:243-258), exported from
the same module so element factories can `import { railLim }` alongside
`pnjlim` / `fetlim`:

```ts
/**
 * Voltage limiter for behavioral amplifier output rails.
 *
 * NOT a literal port of any single ngspice device-support function — there is
 * no rail-clamp device in the ngspice tree. Shaped using the algorithmic
 * discipline of DEVpnjlim (devsup.c:50-84) and DEVlimvds (devsup.c:20-40):
 *
 *   1. Detect the overshoot direction (vnew above vRailPos with vold below it,
 *      or symmetric below vRailNeg).
 *   2. Damp by midpoint between vold and the rail — guarantees the next NR
 *      iterate moves at most halfway across the violated rail per step.
 *   3. Return the icheck flag so the caller can `ctx.noncon.value++` and
 *      record a LimitingEvent, exactly as pnjlim's `*icheck` is used by
 *      dioload.c:185-204.
 *
 * Returns { value, limited } using the same field-name convention as
 * PnjlimResult so call sites read uniformly.
 */
export interface RailLimResult {
  value: number;
  limited: boolean;
}

const _railLimResult: RailLimResult = { value: 0, limited: false };

export function railLim(
  vnew: number,
  vold: number,
  vRailPos: number,
  vRailNeg: number,
): RailLimResult {
  let limited = false;
  if (vnew > vRailPos && vold < vRailPos) {
    vnew = (vRailPos + vold) / 2;
    limited = true;
  } else if (vnew < vRailNeg && vold > vRailNeg) {
    vnew = (vRailNeg + vold) / 2;
    limited = true;
  }
  _railLimResult.value = vnew;
  _railLimResult.limited = limited;
  return _railLimResult;
}
```

The module-level `_railLimResult` mirrors the `_pnjlimResult` pattern
(newton-raphson.ts:80) — single-threaded, callers extract `.value` /
`.limited` before the next call.

### 4.2 Call site in `real-opamp.ts::load()`

`railLim` is invoked once per `load()` call, **only on the steady-state
NR branch** — i.e. when MODEINIT* bits are not asserted. Mirrors how
dioload.c:180-204 is gated past the MODEINIT*/bypass dispatch above it.
For real-opamp this means:

```ts
// inside load(ctx), after reading vOut from voltages and before the
// outputSaturated detection block:
const initBits = (mode & (MODEINITSMSIG | MODEINITTRAN | MODEINITJCT |
                          MODEINITFIX  | MODEINITPRED));
if (initBits === 0) {
  const vOutOldFromPool = s0[base + SLOT_VOUT_PREV];
  const railRes = railLim(vOut, vOutOldFromPool, vRailPos, vRailNeg);
  vOut = railRes.value;
  if (railRes.limited) {
    ctx.noncon.value++;
    if (ctx.limitingCollector) {
      ctx.limitingCollector.push({
        elementIndex: element.elementIndex ?? -1,
        label: element.label ?? "",
        junction: "OUT",
        limitType: "railLim" as const,         // see §4.4 below
        vBefore: voltages[nOut],
        vAfter: vOut,
        wasLimited: true,
      });
    }
  }
}
s0[base + SLOT_VOUT_LIMITED] = vOut;
```

The MODEINIT* gate is necessary for the same reasons it gates pnjlim in
dioload.c:126-138 (verified verbatim in §5.2 below): under
MODEINITJCT/FIX/SMSIG/TRAN/PRED the linearization voltage comes from a
predetermined source (state, predictor, IC, off, vcrit) rather than the
raw NR iterate, so the rail-clamp would corrupt the seeded value.

### 4.3 Interaction with the existing rail clamp on `vInt`

The current code clamps `vInt` (the gain-stage internal voltage) to
`[vRailNeg, vRailPos]` at real-opamp.ts:490-503. That clamp stays — it is
NOT the same thing as `railLim` on `vOut`:

- `vInt` is the integrator's output before the output-stage Norton/VCVS
  conversion. Clamping it bounds the integrator state. No NR convergence
  signalling because the integrator is updated from `vIntPrev` + slew
  bound, not from a free NR iterate.
- `vOut` is the MNA node voltage that NR is iterating to find. `railLim`
  bounds NR overshoot on this node. NR convergence signalling (`noncon`)
  is required because this is a free variable.

Both clamps are present after the migration. The `vInt` clamp stops being
a closure-local read/write and becomes a pool-slot read/write
(`s0[base + SLOT_VINT]`).

### 4.4 `LimitingEvent.limitType` extension

`LimitingEvent.limitType` is currently
`"pnjlim" | "fetlim" | "limvds"`
(newton-raphson.ts:38). Add `"railLim"` to the union. This is a public
type used by the harness consumer; the change is one literal in the
union.

---

## 5. ngspice citation verification

Every citation in this spec was verified against the local
`ref/ngspice/` checkout.

### 5.1 `DEVpnjlim` — `ref/ngspice/src/spicelib/devices/devsup.c:49-84`

Verified line range and verbatim algorithm:

```c
double
DEVpnjlim(double vnew, double vold, double vt, double vcrit, int *icheck)
{
    double arg;

    if((vnew > vcrit) && (fabs(vnew - vold) > (vt + vt))) {
        if(vold > 0) {
            arg = (vnew - vold) / vt;
            if(arg > 0) {
                vnew = vold + vt * (2+log(arg-2));
            } else {
                vnew = vold - vt * (2+log(2-arg));
            }
        } else {
            vnew = vt *log(vnew/vt);
        }
        *icheck = 1;
    } else {
       if (vnew < 0) {
           if (vold > 0) {
               arg = -1*vold-1;
           } else {
               arg = 2*vold-1;
           }
           if (vnew < arg) {
              vnew = arg;
              *icheck = 1;
           } else {
              *icheck = 0;
           }
        } else {
           *icheck = 0;
        }
    }
    return(vnew);
}
```

Spec previously cited `devsup.c:50-82`; the actual signature line is 49
and the closing brace is at 84. Citations in the new spec use **49-84**.
The signature also has a fifth parameter `int *icheck` not visible in
the previously-floated 4-argument version — the 5-arg shape is what the
existing digiTS `pnjlim` returns via the `PnjlimResult.limited` field.

### 5.2 dioload.c MODEINIT* dispatch — `ref/ngspice/src/spicelib/devices/dio/dioload.c:125-205`

Verified the exact dispatch sequence and the call-site condition for
`DEVpnjlim`:

```c
Check=1;
if(ckt->CKTmode & MODEINITSMSIG) {
    vd= *(ckt->CKTstate0 + here->DIOvoltage);
} else if (ckt->CKTmode & MODEINITTRAN) {
    vd= *(ckt->CKTstate1 + here->DIOvoltage);
} else if ( (ckt->CKTmode & MODEINITJCT) &&
        (ckt->CKTmode & MODETRANOP) && (ckt->CKTmode & MODEUIC) ) {
    vd=here->DIOinitCond;
} else if ( (ckt->CKTmode & MODEINITJCT) && here->DIOoff) {
    vd=0;
} else if ( ckt->CKTmode & MODEINITJCT) {
    vd=here->DIOtVcrit;
} else if ( ckt->CKTmode & MODEINITFIX && here->DIOoff) {
    vd=0;
} else {
#ifndef PREDICTOR
    if (ckt->CKTmode & MODEINITPRED) {
        ...
    } else {
#endif /* PREDICTOR */
        vd = *(ckt->CKTrhsOld+here->DIOposPrimeNode)-
                *(ckt->CKTrhsOld + here->DIOnegNode);
    ...
    /*
     *   limit new junction voltage
     */
    if ( (model->DIObreakdownVoltageGiven) &&
            (vd < MIN(0,-here->DIOtBrkdwnV+10*vtebrk))) {
        ...
        vdtemp = DEVpnjlim(vdtemp, ..., vtebrk, here->DIOtVcrit, &Check);
        ...
    } else {
        ...
        vd = DEVpnjlim(vd, *(ckt->CKTstate0 + here->DIOvoltage),
                vte, here->DIOtVcrit, &Check);
        ...
    }
}
```

Both `DEVpnjlim` call sites sit inside the trailing `else { ... }` branch
that is reached only when none of the MODEINITSMSIG / MODEINITTRAN /
MODEINITJCT / MODEINITFIX-with-OFF / MODEINITPRED bits is asserted. This
is the structural justification for the MODEINIT* gate in §4.2.

### 5.3 `DEVlimvds` — `ref/ngspice/src/spicelib/devices/devsup.c:20-40`

Verified verbatim:

```c
double
DEVlimvds(double vnew, double vold)
{
    if(vold >= 3.5) {
        if(vnew > vold) {
            vnew = MIN(vnew,(3 * vold) +2);
        } else {
            if (vnew < 3.5) {
                vnew = MAX(vnew,2);
            }
        }
    } else {
        if(vnew > vold) {
            vnew = MIN(vnew,4);
        } else {
            vnew = MAX(vnew,-.5);
        }
    }
    return(vnew);
}
```

Spec previously cited `devsup.c:20-40`; the actual signature line is 20
and the closing brace is at 40. Citation verified.

### 5.4 MODEINIT* bit definitions — `ref/ngspice/src/include/ngspice/cktdefs.h:177-182`

```c
#define MODEINITFLOAT    0x100
#define MODEINITJCT      0x200
#define MODEINITFIX      0x400
#define MODEINITSMSIG    0x800
#define MODEINITTRAN    0x1000
#define MODEINITPRED    0x2000
```

Names verified verbatim. The header path under our `ref/` checkout is
`ref/ngspice/src/include/ngspice/cktdefs.h`, NOT
`ref/ngspice/src/spicelib/include/ngspice/devdefs.h` as the agent prompt
suggested.

### 5.5 Honest framing of `railLim`

`railLim` is **not** a port of any ngspice function. There is no rail-clamp
limiter device in the ngspice tree — confirmed by full-tree search of
`ref/ngspice/src/spicelib/devices/`: every `*lim*` symbol is a junction
(`DEVpnjlim`), FET (`DEVfetlim`, `DEVlimvds`), or BJT-area variant
thereof.

The behavioural opamp model in `src/components/active/real-opamp.ts` is
itself outside ngspice's first-class device set (ngspice users build
opamps from a sub-circuit deck of primitive R/C/E/G/D/Q elements — there
is no `DEVopamp`). So a citation pointing at `xspiceopamp.c` or any of the
behavioural devices does not apply: those wrap independent topologies
that re-use the primitive-device limiters internally.

What IS canonical is the **algorithmic discipline** that every nonlinear
ngspice device applies in its `load()` call:

1. Compute new candidate voltage from `CKTrhsOld`.
2. If the candidate violates a stability bound, project it back by a
   damped midpoint / log-compressed step (the device-specific limiting
   rule).
3. Set `*icheck = 1` and increment `CKTnoncon` so NR knows it has not
   converged this iteration.
4. Push a `LimitingEvent` so the harness can observe per-iteration
   limiting activity.

`railLim` enforces that discipline for the rail-clamp shape. The
"limit + icheck + bump CKTnoncon + record event" sequence is bit-for-bit
identical to the diode `DEVpnjlim` / BJT `DEVpnjlim` call sites in our
`diode.ts:606-619` / `bjt.ts:735-754`. It is not a port of `DEVpnjlim`'s
*formula* — that formula is junction-physics-specific and would be
nonsensical at a rail. The spec describes `railLim` as an "algorithmic
peer" of `DEVpnjlim`, never as equivalent or as a port.

---

## 6. Interaction with the composite refactor

`src/solver/analog/composite-element.ts` defines a base class for
analog elements composed of N **independent** sub-elements. The forwarders
fan out `setup` / `load` / `getLteTimestep` / `checkConvergence` /
`acceptStep` / `nextBreakpoint` to children and aggregate results.

Real-opamp does NOT decompose into independent sub-elements:

- Its input resistance is one stamp — not a sub-Resistor element.
- Its bias currents are RHS injections — not sub-Source elements.
- Its gain stage is a single VCVS-with-internal-state — not three
  primitives wired together.
- Its rail clamp is a per-iteration discipline on **one** of its own
  stamps — not a sub-element with its own load/setup lifecycle.

If the rail-clamp logic were factored into a child, the child would have
to share state with the parent (the `vInt` integrator history, the
`outputSaturated` flag, the `slewLimited` flag are all coupled to the
gain-stage VCVS), and the `CompositeElement.load()` forwarder iterates
children in undefined order — the rail clamp must run **after** the
output-stage stamp on the same iteration, which the forwarder cannot
guarantee.

Therefore the recommendation is:

> **Real-opamp stays a leaf `PoolBackedAnalogElement`.** `railLim` is a
> per-element discipline applied inside the leaf's own `load()`, exactly
> as `pnjlim` is applied inside `diode.ts::load()`. It does NOT route
> through `CompositeElement`.

This is consistent with how every other limiter-using element (`diode.ts`,
`bjt.ts`, `mosfet.ts`, `njfet.ts`, `pjfet.ts`, `zener.ts`) handles its own
limiter call inside its own non-composite `load()`. Limiters live with
the device's NR linearization, not in an aggregator above it.

---

## 7. Failing tests this resolves

`src/components/active/__tests__/real-opamp.test.ts` contains 12 `it()`
blocks. Two pass today because they do not call `load()`:

- `RealOpAmp > element_has_correct_flags` (passes — only checks branchIndex / method-presence)
- `RealOpAmp > component_definition_has_correct_engine_type` (passes — only checks the registry entry)

The remaining **10** all call `load()` either directly via the parity
ctx, or indirectly via `runDcOp`/`runTransient`. They are:

1. `DCGain > inverting_amplifier_gain`
2. `DCGain > output_saturates_at_rails`
3. `Bandwidth > unity_gain_frequency`
4. `Bandwidth > gain_bandwidth_product`
5. `SlewRate > large_signal_step`
6. `SlewRate > small_signal_not_slew_limited`
7. `Offset > output_offset_with_gain`
8. `CurrentLimit > output_current_clamped`
9. `RealOpAmp > load_741_model`
10. `RealOpAmp parity (C4.5) > real_opamp_load_dcop_parity`

(Tests 3 and 4 currently call `createRealOpAmpElement` only to verify
`getLteTimestep` is method-present and that `el` is defined — those
*might* pass without the migration. The task brief asserts 10 failures
and the canonical pre-migration baseline includes them; if 8 of the 10
turn out to be the strict failure set after running the suite, that does
not change the spec — the migration must still happen for the 8.)

The closed-form C4.5 parity assertions in test #10 (real-opamp.test.ts:
683-717) read RHS and stamp accumulator values bit-exact:

- `sumAt(nInp, nInp) === NGSPICE_GIN`
- `sumAt(nOut, nOut) === NGSPICE_GOUT`
- `sumAt(nOut, nInp) === -aol * G_out`
- `rhsBuf[nOut] === aol * G_out * vos`

These pass once `load()` runs cleanly under the pool-backed shape — the
stamp ordering does not change, only the state ownership.

---

## 8. Tensions and uncertainties

### 8.1 Failure-count discrepancy (10 vs 12)

The task brief asserts 10 real-opamp tests fail. The file holds 12
`it()` blocks. The two trivial registry/flag tests almost certainly
pass today, so the 10 figure is consistent with "all the tests that
exercise simulation logic." Spec assumes 10.

### 8.2 `LimitingEvent.limitType` union extension

Adding `"railLim"` to the literal union changes a public type used by
the harness consumer (`scripts/circuit-mcp-server.ts` and the
postMessage adapter possibly read it). All consumers of `LimitingEvent`
should be audited for `switch (event.limitType)` exhaustiveness; the
TypeScript compiler will surface non-exhaustive switches once the union
is widened, which is the correct way to find them.

### 8.3 Slew-rate clamp inside the same `load()` call

The current `load()` re-evaluates `vInt`'s slew-clamped value from
`vIntPrev` on every NR iteration (real-opamp.ts:478-488). With
`vIntPrev` moving from a closure variable to `pool.states[0][base + SLOT_VINT_PREV]`,
the pool slot is read every iteration but only WRITTEN in `accept()`.
That matches `diode.ts`'s use of `s1[base + SLOT_VD]` — `state1` is the
last-accepted-step value, written by the engine's post-accept rotation,
not by `load()`. The migration must therefore decide: is the slew
"previous" value (a) the previous accepted-step value (in which case
read `s1[base + SLOT_VINT]` after the engine rotates), or (b) the value
recorded by the element's own `accept()` into a `*_PREV` slot in
`state0` (which the rotation will then carry into `state1`)?

The spec above takes path (b): `accept()` writes `s0[base + SLOT_VINT_PREV]`
and `s0[base + SLOT_VOUT_PREV]`. After engine rotation those values
become `s1[base + SLOT_VINT_PREV]` and `s1[base + SLOT_VINT]`. The
read path in `load()` then reads `s1[base + SLOT_VINT_PREV]` for slew
history. This is path (a) effectively, but written through explicit
slots so the diagnostic ringbuffer captures them, matching the diode's
use of `state1` for `VD`.

If the implementer prefers to drop the explicit `_PREV` slots and read
`s1[base + SLOT_VINT]` directly, that is a defensible alternative —
spec does not gate the choice. The slot list above is conservative
(both styles supported); the implementer may collapse `SLOT_VINT_PREV`
into "read `s1[base + SLOT_VINT]`" if they prefer. Flag this for
implementer discretion, not for user resolution.

### 8.4 No ngspice parity test for `railLim` itself

There is no ngspice circuit that produces a railLim event for parity
comparison (since ngspice has no rail-clamp device). The C4.5 parity
test asserts the linear-region stamps match a closed-form reference; it
is satisfied by the migration without touching railLim. Tests that
exercise rails (`output_saturates_at_rails`, `load_741_model`) are
*digiTS*-only behavioural assertions — they verify "output ≤ Vcc -
vSat", not "matches ngspice bit-exact." This is consistent with §6's
finding that real-opamp itself has no first-class ngspice analog.

### 8.5 `ctx.noncon` shape

`load-context.ts:97-98` exposes `noncon: { value: number }` (a counter
object, mutable). `newton-raphson.ts:351` reassigns `ctx.noncon = 0`,
which suggests a shape mismatch within the engine. The element-side
contract (per `bjt.ts:735` and `diode.ts:607`) is
`ctx.noncon.value++` — that's what `railLim` will use in §4.2. If the
NR loop's `ctx.noncon = 0` re-assignment turns out to be a typed bug
that breaks the `{value: number}` reference (so the element-side
counter writes go to a stale object), that is an existing latent issue
upstream of this work and should be folded in per the
"fold-in-latent-bugs" project memory rule. The implementer should
verify the noncon plumbing works (`ctx.noncon.value++` in the element
correctly affects what the NR loop reads) before declaring the test
suite green.

### 8.6 Dual integration with the ideal opamp / `opamp.ts`

`src/components/active/opamp.ts` is a SEPARATE component (the ideal
opamp) and is not affected by this work. It is mentioned only because
the §K6 "composite refactor" motif touches several active-element
components; per §6 above, real-opamp does NOT enroll in that refactor.

---

## 9. Done definition

- `createRealOpAmpElement` returns a `PoolBackedAnalogElement` with
  `poolBacked: true`, `stateSize: 12`, `stateSchema: REAL_OPAMP_SCHEMA`,
  `initState`, and a populated `_stateBase` after `setup()`.
- All closure-local mutable state (`vInt`, `vIntPrev`, `_vOutPrev`,
  `outputSaturated`, `outputClampLevel`, `currentLimited`,
  `iOutLimited`, `slewLimited`, `aEff`, `geq_int`, `lastSrcFact`) is
  removed from the closure and lives in pool slots.
- `railLim` is exported from `src/solver/analog/newton-raphson.ts` next
  to `pnjlim`/`fetlim`/`limvds`, with a verified-citation comment
  framing it as algorithmic-peer not literal-port.
- `railLim` is called once per non-MODEINIT*-iter `load()` in
  real-opamp.ts on `vOut`, with `ctx.noncon.value++` and a
  `LimitingEvent` push on positive `limited`.
- `LimitingEvent.limitType` union extended with `"railLim"`.
- All 10 currently-failing real-opamp vitest tests pass.
- No banned-vocab closing verdicts in the implementation comments
  (no "tolerance", "mapping", "equivalent under", "pre-existing",
  "intentional divergence", "partial").
