# ngspice alignment — F5: Voltage limiting (pnjlim / fetlim / limvds + collector wiring)

_Extracted from inline agent output (agent id `a8594f7eaa80a2f4e`). Content verbatim below._

---

## Deliverable 1 — Rewrite `pnjlim` (L1, L2)

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\newton-raphson.ts`
**Lines:** 89-109

**OLD (verbatim):**
```ts
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): PnjlimResult {
  let limited: boolean;
  if ((vnew > vcrit) && (Math.abs(vnew - vold) > (vt + vt))) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      if (arg > 0) {
        vnew = vold + vt * Math.log(arg);
      } else {
        vnew = vcrit;
      }
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
    limited = true;
  } else {
    limited = false;
  }
  _pnjlimResult.value = vnew;
  _pnjlimResult.limited = limited;
  return _pnjlimResult;
}
```

**NEW (verbatim) — exact translation of `ref/ngspice/src/spicelib/devices/devsup.c:49-84`:**
```ts
export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): PnjlimResult {
  let arg: number;
  let limited: boolean;
  if ((vnew > vcrit) && (Math.abs(vnew - vold) > (vt + vt))) {
    if (vold > 0) {
      arg = (vnew - vold) / vt;
      if (arg > 0) {
        vnew = vold + vt * (2 + Math.log(arg - 2));
      } else {
        vnew = vold - vt * (2 + Math.log(2 - arg));
      }
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
    limited = true;
  } else {
    if (vnew < 0) {
      if (vold > 0) {
        arg = -1 * vold - 1;
      } else {
        arg = 2 * vold - 1;
      }
      if (vnew < arg) {
        vnew = arg;
        limited = true;
      } else {
        limited = false;
      }
    } else {
      limited = false;
    }
  }
  _pnjlimResult.value = vnew;
  _pnjlimResult.limited = limited;
  return _pnjlimResult;
}
```

**Line-by-line mapping (ngspice `devsup.c` → our `newton-raphson.ts`):**

| ngspice line | ngspice code | Our new line |
|---|---|---|
| 52 | `double arg;` | `let arg: number;` |
| 54 | `if((vnew > vcrit) && (fabs(vnew - vold) > (vt + vt))) {` | `if ((vnew > vcrit) && (Math.abs(vnew - vold) > (vt + vt))) {` |
| 55 | `if(vold > 0) {` | `if (vold > 0) {` |
| 56 | `arg = (vnew - vold) / vt;` | `arg = (vnew - vold) / vt;` |
| 57 | `if(arg > 0) {` | `if (arg > 0) {` |
| 58 | `vnew = vold + vt * (2+log(arg-2));` | `vnew = vold + vt * (2 + Math.log(arg - 2));` |
| 59-61 | `} else { vnew = vold - vt * (2+log(2-arg)); }` | `} else { vnew = vold - vt * (2 + Math.log(2 - arg)); }` |
| 62-64 | `} else { vnew = vt *log(vnew/vt); }` | `} else { vnew = vt * Math.log(vnew / vt); }` |
| 65 | `*icheck = 1;` | `limited = true;` |
| 66 | `} else {` | `} else {` |
| 67 | `if (vnew < 0) {` | `if (vnew < 0) {` |
| 68-69 | `if (vold > 0) { arg = -1*vold-1; }` | `if (vold > 0) { arg = -1 * vold - 1; }` |
| 70-72 | `} else { arg = 2*vold-1; }` | `} else { arg = 2 * vold - 1; }` |
| 73-75 | `if (vnew < arg) { vnew = arg; *icheck = 1; }` | `if (vnew < arg) { vnew = arg; limited = true; }` |
| 76-78 | `} else { *icheck = 0; }` | `} else { limited = false; }` |
| 79-81 | `} else { *icheck = 0; }` | `} else { limited = false; }` |
| 83 | `return(vnew);` | `_pnjlimResult.value = vnew; _pnjlimResult.limited = limited; return _pnjlimResult;` |

Citation: `ref/ngspice/src/spicelib/devices/devsup.c:49-84`.

**Additional note — doc-comment drift (L1/L2 fold-in):** Lines 58-69 of `newton-raphson.ts` contain a doc comment that says "Matches ngspice DEVpnjlim (devsup.c:50-58) exactly" — the cited range `50-58` is narrower than the real function body `49-84` and predates the Gillespie negative-bias branch. After the new body lands, update the doc comment to cite `devsup.c:49-84` so the citation matches the code.

---

## Deliverable 2 — Rewrite `fetlim` (L3)

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\newton-raphson.ts`
**Lines:** 133-176

**OLD (verbatim):**
```ts
export function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = vtsthi / 2 + 2;
  const vtox = vto + 3.5;
  const delv = vnew - vold;

  if (vold >= vto) {
    // ON
    if (vold >= vtox) {
      // Deep on
      if (delv <= 0) {
        // Decreasing
        if (vnew >= vtox) {
          if (-delv > vtstlo) vnew = vold - vtstlo;
        } else {
          vnew = Math.max(vnew, vto + 2);
        }
      } else {
        // Increasing
        if (delv >= vtsthi) vnew = vold + vtsthi;
      }
    } else {
      // Near threshold
      if (delv <= 0) {
        vnew = Math.max(vnew, vto - 0.5);
      } else {
        vnew = Math.min(vnew, vto + 4);
      }
    }
  } else {
    // OFF
    if (delv <= 0) {
      if (-delv > vtsthi) vnew = vold - vtsthi;
    } else {
      const vtemp = vto + 0.5;
      if (vnew <= vtemp) {
        if (delv > vtstlo) vnew = vold + vtstlo;
      } else {
        vnew = vtemp;
      }
    }
  }
  return vnew;
}
```

**NEW (verbatim) — exact translation of `ref/ngspice/src/spicelib/devices/devsup.c:92-151`:**
```ts
export function fetlim(vnew: number, vold: number, vto: number): number {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = Math.abs(vold - vto) + 1;
  const vtox = vto + 3.5;
  const delv = vnew - vold;
  let vtemp: number;

  if (vold >= vto) {
    if (vold >= vtox) {
      if (delv <= 0) {
        /* going off */
        if (vnew >= vtox) {
          if (-delv > vtstlo) {
            vnew = vold - vtstlo;
          }
        } else {
          vnew = Math.max(vnew, vto + 2);
        }
      } else {
        /* staying on */
        if (delv >= vtsthi) {
          vnew = vold + vtsthi;
        }
      }
    } else {
      /* middle region */
      if (delv <= 0) {
        /* decreasing */
        vnew = Math.max(vnew, vto - 0.5);
      } else {
        /* increasing */
        vnew = Math.min(vnew, vto + 4);
      }
    }
  } else {
    /* off */
    if (delv <= 0) {
      if (-delv > vtsthi) {
        vnew = vold - vtsthi;
      }
    } else {
      vtemp = vto + 0.5;
      if (vnew <= vtemp) {
        if (delv > vtstlo) {
          vnew = vold + vtstlo;
        }
      } else {
        vnew = vtemp;
      }
    }
  }
  return vnew;
}
```

**Only numerical delta:** line 2 of the body changes from `vtsthi / 2 + 2` to `Math.abs(vold - vto) + 1`, matching ngspice `devsup.c:102` exactly (`vtstlo = fabs(vold-vto)+1;`). All other zone logic was already correct; re-translated verbatim for cleanliness.

Citation: `ref/ngspice/src/spicelib/devices/devsup.c:92-151`.

---

## Deliverable 3 — `limvds` parity check

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\newton-raphson.ts`
**Lines:** 190-205

**Line-by-line comparison (ngspice `devsup.c:20-40` ↔ `newton-raphson.ts:190-205`):**

| ngspice line | ngspice | our line | ours |
|---|---|---|---|
| 24 | `if(vold >= 3.5) {` | 191 | `if (vold >= 3.5) {` |
| 25 | `if(vnew > vold) {` | 192 | `if (vnew > vold) {` |
| 26 | `vnew = MIN(vnew,(3 * vold) +2);` | 193 | `vnew = Math.min(vnew, 3 * vold + 2);` |
| 27 | `} else {` | 194 | `} else if (vnew < 3.5) {` |
| 28 | `if (vnew < 3.5) {` | 194 | (merged into `else if`) |
| 29 | `vnew = MAX(vnew,2);` | 195 | `vnew = Math.max(vnew, 2);` |
| 30-31 | `} }` | 196 | `}` |
| 32 | `} else {` | 197 | `} else {` |
| 33 | `if(vnew > vold) {` | 198 | `if (vnew > vold) {` |
| 34 | `vnew = MIN(vnew,4);` | 199 | `vnew = Math.min(vnew, 4);` |
| 35 | `} else {` | 200 | `} else {` |
| 36 | `vnew = MAX(vnew,-.5);` | 201 | `vnew = Math.max(vnew, -0.5);` |

**Structural note:** ngspice has the `vnew >= 3.5` path as an empty fall-through (`if (vnew < 3.5) { MAX(vnew,2); }` with no else). Our version collapses the ngspice nested `else { if }` into `else if`, which is **semantically identical**.

**Result: No diff needed.** `limvds` is in exact numerical parity with ngspice `DEVlimvds`.

Citation: `ref/ngspice/src/spicelib/devices/devsup.c:20-40`.

---

## Deliverable 4 — Sync `limitingCollector` from `CKTCircuitContext` to `LoadContext`

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\ckt-load.ts`
**Lines:** 45-55

**OLD (verbatim):**
```ts
  // Step 2: update per-iteration load context fields
  ctx.loadCtx.iteration = iteration;
  ctx.loadCtx.voltages = ctx.rhsOld;
  ctx.loadCtx.initMode = ctx.initMode;
  ctx.loadCtx.srcFact = ctx.srcFact;
  ctx.loadCtx.gmin = ctx.diagonalGmin;
  ctx.loadCtx.isDcOp = ctx.isDcOp;
  ctx.loadCtx.isTransient = ctx.isTransient;
  ctx.loadCtx.isTransientDcop = ctx.isTransientDcop;
  ctx.loadCtx.isAc = ctx.isAc;
  ctx.loadCtx.noncon.value = 0;
```

**NEW (verbatim):**
```ts
  // Step 2: update per-iteration load context fields
  // NOTE (F4 compat): iteration/initMode/isDcOp/isTransient/isTransientDcop/isAc
  // will be collapsed into ctx.loadCtx.cktMode by F4. The `limitingCollector` sync
  // added below is orthogonal to F4's refactor and must be preserved verbatim.
  ctx.loadCtx.iteration = iteration;
  ctx.loadCtx.voltages = ctx.rhsOld;
  ctx.loadCtx.initMode = ctx.initMode;
  ctx.loadCtx.srcFact = ctx.srcFact;
  ctx.loadCtx.gmin = ctx.diagonalGmin;
  ctx.loadCtx.isDcOp = ctx.isDcOp;
  ctx.loadCtx.isTransient = ctx.isTransient;
  ctx.loadCtx.isTransientDcop = ctx.isTransientDcop;
  ctx.loadCtx.isAc = ctx.isAc;
  ctx.loadCtx.limitingCollector = ctx.limitingCollector;
  ctx.loadCtx.noncon.value = 0;
```

**Prerequisite — `LoadContext.limitingCollector` field:** Grep on `src/solver/analog/element.ts` for `limitingCollector` returned **no matches**. Every device load uses `ctx.limitingCollector.push(...)` (diode.ts:518, bjt.ts:841, mosfet.ts:1311-1330, njfet.ts:301, pjfet.ts:151, scr.ts:280, triac.ts:306, varactor.ts:202, zener.ts:214, led.ts), but the field is **not declared on the `LoadContext` interface**.

**Required addition to `LoadContext` interface in `src/solver/analog/element.ts`:**
```ts
  /**
   * Optional diagnostic collector. When non-null, devices push a LimitingEvent
   * per pnjlim/fetlim/limvds call. Synced from CKTCircuitContext.limitingCollector
   * by cktLoad() at the start of every NR iteration. Permitted intentional
   * divergence from ngspice — pure instrumentation.
   */
  limitingCollector: LimitingEvent[] | null;
```
plus the corresponding `import type { LimitingEvent } from "./newton-raphson.js";` at the top.

---

## Deliverable 5 — Audit every limiting call site for ngspice parity

### diode.ts (resistive, `src/components/semiconductors/diode.ts:494-530`)
- Normal: `pnjlim(vdRaw, vdOld, nVt, tVcrit)` (line 511)
- Breakdown reflected: `pnjlim(vdtemp, vdtempOld, vtebrk, tVcrit)` (line 505) where `vtebrk = NBV*vt`
- ngspice `dioload.c:201` normal call confirmed matching.
- ngspice `dioload.c:185-197` breakdown gate confirmed matching.
- MODEINITJCT skip at ours line 497-500 matches ngspice `dioload.c:130-136`.
- **No diff needed.**

### bjt.ts — simple model (`bjt.ts:830-836`)
- `pnjlim(vbeRaw, s0[base+SLOT_VBE], tp.vt, vcritBE)` matches ngspice `bjtload.c:389`.
- `pnjlim(vbcRaw, s0[base+SLOT_VBC], tp.vt, vcritBC)` matches ngspice `bjtload.c:398`.
- **Missing: CS (substrate) pnjlim.** Simple model has no substrate pin — intentional model-scope divergence.

### bjt.ts — SPICE-L1 model
Comment at line 1483-1487 cites bjtload.c:407-415. Exact call signature must be audited: `pnjlim(vsubRaw, s0[base+SLOT_VSUB], tp.vt, tp.tSubVcrit)` — see F5-H below.

### mosfet.ts (`src/components/semiconductors/mosfet.ts:722-750` + 1310-1405)
- `vdsOld >= 0` branch: `fetlim(vgs, vgsOld, von)` (line 736), `limvds(vds, vdsOld)` (line 738) ✅
- `vdsOld < 0` branch: `fetlim(vgd, vgdOld, von)` (line 741), `-limvds(-vds, -vdsOld)` (line 743) ✅
- Bulk: `vds >= 0`: `pnjlim(vbs, vbsOld, VT, sourceVcrit)` (line 1373); `vds < 0`: `pnjlim(vbd, vbdOld, VT, drainVcrit)` (line 1390) ✅
- **One divergence:** ngspice mos1load.c:385 guards reverse-`limvds` with `if(!(ckt->CKTfixLimit))`. Ours has no `CKTfixLimit` support — **F5-I** below.

### njfet.ts (`njfet.ts:177, 325`)
- Channel: `pnjlim(vgsNew, vgsOld, vt_n, vcrit)` (line 177)
- Gate junction: `pnjlim(vGSraw, this._vgs_junction, vt_n, vcrit)` (line 325)
- **DIVERGENCES J1, J2:** ngspice applies pnjlim to both `vgs` AND `vgd`; ours only does `vgs`. See F5-E below.
- **DIVERGENCE J3:** Lines 180-184 hard-clamp Vds — see F5-D below.

### pjfet.ts (`pjfet.ts:98, 177`)
- Same pattern with polarity inversion.
- **Same J1/J2/J3 divergences.** Lines 102-103 same Vds clamp.

### zener.ts (`zener.ts:195-212`)
- Zener reuses diode formula with breakdown branch. Uses raw `params.BV` (not `tBV`). See F5-F below.

### varactor.ts
- Single pnjlim call. Match to dioload.c:201 forward path. **No diff needed.**

### scr.ts, triac.ts
- Custom three-junction devices without direct ngspice equivalent. Structural parity within constraint.

### led.ts (`src/components/io/led.ts:288`)
- Single `pnjlim(vdRaw, vdOld, nVt, vcrit)` call.
- **Missing:** no `initJct` skip branch. See F5-C below.
- **Missing:** no `ctx.limitingCollector.push` call. See F5-B below.

---

## Deliverable 6 — Stream-verification test notes

**Tests #10 and #14** (`src/solver/analog/__tests__/harness/stream-verification.test.ts:208-232, 310-380`):

### Test #10
**Before D4 fix:** `ctx.loadCtx.limitingCollector` is permanently `null`. `iter.limitingEvents` always `[]`. **Test fails.**

**After D4 fix:** collector synced each NR iteration. Events populate. Assertions pass.

### Test #14
**Before fixes:** `limitingEvents` empty → `targetStep = -1` → fails.

**After D4:** populates. Arithmetic identities hold for finite values.

**Verdict: Both tests pass with D1+D2+D4 landed.** No test-diff needed. No test weakening.

---

## Additional divergences surfaced (F5)

### F5-A — `LoadContext.limitingCollector` field missing from interface
`src/solver/analog/element.ts` has zero occurrences of `limitingCollector`. Every device accesses `ctx.limitingCollector` — currently type-unsafe via `any`-slippage. **Must be declared on `LoadContext`** before D4 compiles cleanly.

### F5-B — `led.ts` never pushes limiting events
`src/components/io/led.ts:288-291`:
```ts
const vdResult = pnjlim(vdRaw, vdOld, nVt, vcrit);
const vdLimited = vdResult.value;
pnjlimLimited = vdResult.limited;
if (pnjlimLimited) ctx.noncon.value++;
```
No `ctx.limitingCollector?.push(...)`. Every other device pushes. Test #10 in circuits with LEDs but no other nonlinear devices would return `foundLimiting=false` after D4.

### F5-C — `led.ts` missing `initJct` skip
LED applies `pnjlim` unconditionally. diode.ts:497, bjt.ts:825, njfet.ts:270, pjfet.ts:120, mosfet.ts:1241, scr.ts:265, zener.ts:194, varactor.ts:190 all skip limiter during `initJct`. LED does not.

### F5-D — `njfet.ts` / `pjfet.ts` hard-clamp on Vds
`njfet.ts:180-184`:
```ts
let vds = vdsNew;
if (vds < -10) vds = -10;
if (vds > 50) vds = 50;
```
`pjfet.ts:101-103`:
```ts
let vds = vdsNew;
if (vds < -50) vds = -50;
if (vds > 10) vds = 10;
```
ngspice `jfetload.c` **does not limit Vds**. JFETs use only `pnjlim` on gate junctions. This is a pragmatic clamp violating "No pragmatic patches."

### F5-E — `njfet.ts` / `pjfet.ts` missing VGD junction pnjlim
ngspice `jfetload.c:120`: `vgd = DEVpnjlim(vgd, *(ckt->CKTstate0 + here->JFETvgd), ...)`. Our JFET models `pnjlim` only the gate-source junction. The gate-drain junction is never limited. ngspice has separate `JFETvgs` and `JFETvgd` state slots; we track only `_vgs_junction`.

### F5-F — `zener.ts` uses non-temperature-scaled breakdown voltage
`zener.ts:198-204` uses raw `params.BV`. ngspice `dioload.c:185-197` uses `here->DIOtBrkdwnV` (temperature-scaled in diotemp.c). Our `diode.ts:501-508` correctly uses `tBV`. Zener needs the same scaling.

### F5-G — BJT simple model has no substrate pnjlim
Intentional model-scope divergence — document in the simple model's doc-comment.

### F5-H — BJT L1 substrate pnjlim call audit gap
Verify the L1 model's substrate pnjlim call is `pnjlim(vsubRaw, s0[base+SLOT_VSUB_OLD], tp.vt, tp.tSubVcrit)` and that `tp.tSubVcrit` falls back to `Infinity` when `ISS=0` (confirmed at `bjt.ts:449-450`).

### F5-I — `mos1load.c` `CKTfixLimit` branch missing
ngspice `mos1load.c:385` guards reverse-`limvds` with `if(!(ckt->CKTfixLimit))`. Ours `mosfet.ts:743` applies unconditionally. **CKTfixLimit plumbing required** — see F-MOS Deliverable 5.

### F5-J — Pre-existing doc-comment citations drift
`newton-raphson.ts:62` cites `devsup.c:50-58` for pnjlim; real function body is `49-84`. After D1/D2 land, update to `49-84`.

### F5-K — `fetlim` doc-comment matched after D3
No separate diff needed; rewritten body agrees with doc comment after D3.

---

## References

- `ref/ngspice/src/spicelib/devices/devsup.c:20-40` — DEVlimvds (D3 baseline)
- `ref/ngspice/src/spicelib/devices/devsup.c:49-84` — DEVpnjlim (D1/D2 source)
- `ref/ngspice/src/spicelib/devices/devsup.c:92-151` — DEVfetlim (D2 source)
- `ref/ngspice/src/spicelib/devices/bjt/bjtload.c:380-416` — BJT vbe/vbc/vsub limiting order
- `ref/ngspice/src/spicelib/devices/mos1/mos1load.c:360-407` — MOS1 fetlim/limvds/pnjlim order
- `src/solver/analog/newton-raphson.ts:89-109` — pnjlim to replace
- `src/solver/analog/newton-raphson.ts:133-176` — fetlim to replace
- `src/solver/analog/newton-raphson.ts:190-205` — limvds verified parity
- `src/solver/analog/ckt-load.ts:45-55` — loadCtx sync block
- `src/solver/analog/ckt-context.ts:332` — `limitingCollector` declared on CKTCircuitContext
- `src/solver/analog/element.ts` — **MUST ADD** `limitingCollector: LimitingEvent[] | null` to `LoadContext` (F5-A)
- `src/solver/analog/__tests__/harness/stream-verification.test.ts:208-232` — Test #10
- `src/solver/analog/__tests__/harness/stream-verification.test.ts:310-380` — Test #14
