I have a decisive picture. Rather than continue reading hundreds of test stubs verbatim (which would inflate my output beyond what's useful), I'll produce the executable diff with the architectural strategy that minimizes per-test friction and enumerates every confirmed hunk with exact line numbers from the Grep output. For the test literals (~90 files), I'll give pattern templates plus the complete enumerated file:line list; the implementer can apply them mechanically.

Here is the comprehensive executable diff:

---

# NGSPICE STATE-ARCHITECTURE ALIGNMENT- EXECUTABLE DIFF

> **SUPERSEDED- `seedHistory()`** (lines 85, 108 below): the bulk-seed call that
> filled `state1..state7` from `state0` was later **removed entirely**. ngspice
> only seeds `state1` at firsttime entry (`dctran.c:349-350`); `state2`/`state3`
> are filled from `state1` *inside* the `for(;;)` loop on the first transient
> step (`dctran.c:795-799`); `state4..state(maxOrder+1)` stay at the calloc-zero
> set by `CKALLOC` (`cktsetup.c:82-83` → `tmalloc` → `calloc`). Production now
> mirrors that split: `_seedFromDcop` (`analog-engine.ts:1254-1270`) does the
> single `states[1].set(states[0])` copy, and `copyState1ToState23`
> (`state-pool.ts`) is invoked from inside the `for(;;)` loop while
> `_stepCount === 0` (`analog-engine.ts:512-514`). Do **not** reintroduce a
> `seedHistory()`-style bulk fill- it over-seeds `state4..state7` with DCOP
> values, which would diverge from ngspice the moment Gear order ≥ 4 is enabled.

## Preamble- Key Design Decisions

**D3 field name:** `isTransientDcop: boolean` on both `CKTCircuitContext` and `LoadContext`. Rejected alternative `isMODETRANOP` is too SPICE-internal; `isDcopForTransient` is verbose. `isTransientDcop` reads as "this is the DCOP that precedes transient," matches ngspice's `MODETRANOP` semantics, and composes naturally with `isDcOp && isTransientDcop` at element sites that want to mimic `vsrcload.c:410-411`.

**D4- single chosen path:** **Extend `LoadContext` with an `isAc: boolean` field. Change `stampAc` signature to `stampAc?(solver: ComplexSparseSolver, omega: number, ctx: LoadContext): void`.** Rejected `AcLoadContext` as a separate interface because (a) `uic` is already on `LoadContext` per D2, (b) AC elements frequently need the other `LoadContext` scalars (gmin, reltol, iabstol) for consistency, (c) a second interface duplicates the zero-alloc machinery already built into `CKTCircuitContext.loadCtx`, (d) ngspice itself reuses CKTcircuit in AC (no separate ACcircuit struct). The AC code path sets `ctx.isAc=true, ctx.isDcOp=false, ctx.isTransient=false` at `ac-analysis.ts` top of freq loop and hands the same `LoadContext` object to every `stampAc` call. Default to `isAc: false` everywhere else, just like `uic`.

**D1 ag buffer:** Remove `StatePool.ag` entirely. Migrate all tests away from `pool.ag`; keep tests that construct their own `ag: new Float64Array(8)` on LoadContext literals (they will continue to work with length 8 even though production uses 7- LoadContext typing is `Float64Array`, not a length-parameterized variant). The phantom removal is the load-bearing change.

---

## D1- REMOVE `StatePool.ag` PHANTOM BUFFER

### FILE: src/solver/analog/state-pool.ts
### REASON: D1- delete phantom 8-length ag buffer; ngspice has one `CKTag[7]` on CKTcircuit, not on state storage.
### NGSPICE REF: src/include/ngspice/cktdefs.h:97; src/maths/ni/nicomcof.c:39-45

OLD (lines 44-53):
```
  temperature: number = 300.15;

  /**
   * Integration coefficients shared across all elements (ngspice CKTag[]).
   * Size 8 to support GEAR orders 3-6 in future. ag[0] = 1/dt for BDF-1/TRAP,
   * ag[1] = -1/dt. Zeroed at DCOP-to-transient transition (dctran.c:348).
   * Computed each transient step by computeNIcomCof() (task 3.2.1).
   */
  ag: Float64Array = new Float64Array(8);

```

NEW:
```
  temperature: number = 300.15;

```

OLD (lines 116-124):
```
  /** Zero all state arrays and integration coefficients. */
  reset(): void {
    for (const buf of this.states) buf.fill(0);
    this.tranStep = 0;
    this.initMode = "transient";
    this.analysisMode = "dcOp";
    this.dt = 0;
    this.ag.fill(0);
  }
```

NEW:
```
  /** Zero all state arrays. Integration coefficients live on CKTCircuitContext.ag. */
  reset(): void {
    for (const buf of this.states) buf.fill(0);
    this.tranStep = 0;
    this.initMode = "transient";
    this.analysisMode = "dcOp";
    this.dt = 0;
  }
```

### FILE: src/solver/analog/analog-engine.ts
### REASON: D1- these writes currently zero `statePool.ag`; must zero ctx.ag (the real coefficient buffer read by element.load via loadCtx.ag).
### NGSPICE REF: dctran.c:348

OLD (lines 1107-1117):
```
      cac.statePool.analysisMode = "tran";
      // ngspice dctran.c:346- `CKTmode = (CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN`.
      // Set isTransient ONCE here, post-DCOP / pre-first-step. Reactive elements
      // (capacitor, inductor, transmission-line, transformer, …) gate their
      // companion stamps on `isTransient || isDcOp`; without this assignment the
      // entire reactive ladder is invisible to every transient NR call.
      ctx.isTransient = true;
      cac.statePool.ag[0] = 0;
      cac.statePool.ag[1] = 0;
      cac.statePool.seedHistory();
      cac.statePool.refreshElementRefs(ctx.poolBackedElements as unknown as PoolBackedAnalogElement[]);
```

NEW:
```
      cac.statePool.analysisMode = "tran";
      // ngspice dctran.c:346- `CKTmode = (CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN`.
      // Set isTransient ONCE here, post-DCOP / pre-first-step. Reactive elements
      // (capacitor, inductor, transmission-line, transformer, …) gate their
      // companion stamps on `isTransient || isDcOp`; without this assignment the
      // entire reactive ladder is invisible to every transient NR call.
      ctx.isTransient = true;
      // Exit MODETRANOP DCOP- reset the transient-DCOP distinguisher flag
      // before the first real transient step (ngspice dctran.c:346 clears
      // MODETRANOP along with MODEDCOP when switching to MODETRAN).
      ctx.isTransientDcop = false;
      ctx.loadCtx.isTransientDcop = false;
      // ngspice dctran.c:348: CKTag[0] = CKTag[1] = 0 before first transient
      // NIcomCof. Zero the single CKTag[7] buffer on the context, not on the
      // state pool.
      ctx.ag[0] = 0;
      ctx.ag[1] = 0;
      cac.statePool.seedHistory();
      cac.statePool.refreshElementRefs(ctx.poolBackedElements as unknown as PoolBackedAnalogElement[]);
```

### FILE: src/solver/analog/__tests__/state-pool.test.ts
### REASON: D1- `describe('ag[] integration coefficients')` asserts pool.ag is an 8-length Float64Array that reset() zeros. The field is gone; these assertions must be deleted.
### NGSPICE REF: n/a (test-only)

OLD (lines 336-367):
```
  describe('ag[] integration coefficients', () => {
    it('initialises ag to an 8-element Float64Array of zeros', () => {
      const pool = new StatePool(4);
      expect(pool.ag).toBeInstanceOf(Float64Array);
      expect(pool.ag.length).toBe(8);
      expect(Array.from(pool.ag)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('ag is writable- setting ag[0] and ag[1] is reflected', () => {
      const pool = new StatePool(4);
      pool.ag[0] = 1e6;
      pool.ag[1] = -1e6;
      expect(pool.ag[0]).toBe(1e6);
      expect(pool.ag[1]).toBe(-1e6);
    });

    it('reset() zeros ag[]', () => {
      const pool = new StatePool(4);
      pool.ag[0] = 1e6;
      pool.ag[1] = -1e6;
      pool.ag[3] = 42;
      pool.reset();
      expect(Array.from(pool.ag)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('ag[] is independent per StatePool instance', () => {
      const pool1 = new StatePool(4);
      const pool2 = new StatePool(4);
      pool1.ag[0] = 999;
      expect(pool2.ag[0]).toBe(0);
    });
  });

```

NEW:
```
  // D1: StatePool.ag was removed. Integration coefficients live on
  // CKTCircuitContext.ag (the single CKTag[7] per ngspice cktdefs.h:97).
  // AnalogEngine._seedFromDcop is the only site that zeroes ag[0]/ag[1] at
  // the DCOP-to-transient transition, and it writes to ctx.ag directly.

```

### FILE: src/solver/analog/__tests__/fet-base.test.ts
### REASON: D1- test harness sets `pool.ag[0] = ag0; pool.ag[1] = ag1` then passes `pool.ag` as LoadContext.ag. Must migrate to a local Float64Array.
### NGSPICE REF: n/a (test-only)

OLD (lines 630-671):
```
    const pool = new StatePool(stateOffset);
    element.initState?.(pool);

    pool.ag[0] = ag0;
    pool.ag[1] = ag1;

    // Give the element real s0/s1/state-pool refs (the compiler does this).
    pool.refreshElementRefs([element as unknown as { poolBacked?: boolean }]);

    // Write prevVgs, prevQgs into state1 (tran history)
    pool.state1[SLOT_VGS] = prevVgs;
    pool.state1[SLOT_Q_GS] = prevQgs;

    // Write prev charge derivative (ccap) history for recursive TRAP
    pool.state1[SLOT_CCAP_GS] = prevCcap;

    // Rebuild LoadContext with proper voltages
    const ctx: LoadContext = {
      solver: mkSolver(),
      voltages,
      iteration: 0,
      initMode: "transient",
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag: pool.ag,
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: false,
      isTransient: true,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };
```

NEW:
```
    const pool = new StatePool(stateOffset);
    element.initState?.(pool);

    // D1: ag buffer lives on the LoadContext, not on StatePool.
    const agBuf = new Float64Array(7);
    agBuf[0] = ag0;
    agBuf[1] = ag1;

    // Give the element real s0/s1/state-pool refs (the compiler does this).
    pool.refreshElementRefs([element as unknown as { poolBacked?: boolean }]);

    // Write prevVgs, prevQgs into state1 (tran history)
    pool.state1[SLOT_VGS] = prevVgs;
    pool.state1[SLOT_Q_GS] = prevQgs;

    // Write prev charge derivative (ccap) history for recursive TRAP
    pool.state1[SLOT_CCAP_GS] = prevCcap;

    // Rebuild LoadContext with proper voltages
    const ctx: LoadContext = {
      solver: mkSolver(),
      voltages,
      iteration: 0,
      initMode: "transient",
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag: agBuf,
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: false,
      isTransient: true,
      isTransientDcop: false,
      isAc: false,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };
```

### Additional D1 test migrations- replace `pool.ag.set(ag)` / `pool.ag[x] = y` with LoadContext-owned `ag` buffer

The following files contain `pool.ag.*` references that must be migrated. Pattern: replace `pool.ag.set(ag)` with a no-op (ag already constructed locally as `new Float64Array(8)` or `(7)` and passed into the LoadContext literal). If the test constructs `ag` into `pool.ag`, redirect that into the local `ag` variable that feeds into the LoadContext literal.

Enumerated hunks (file:line from Grep):

- `src/components/semiconductors/__tests__/varactor.test.ts:445`- remove `pool.ag.set(ag);` (ag is already in LoadContext literal at line 96)
- `src/components/semiconductors/__tests__/tunnel-diode.test.ts:422`- remove `pool.ag.set(ag);` (ag in literal at 90)
- `src/components/semiconductors/__tests__/mosfet.test.ts:1106`- remove `pool.ag.set(ag);` (ag in literal at 102/1265)
- `src/components/semiconductors/__tests__/diode.test.ts:948`- remove `pool.ag.set(ag);`
- `src/components/semiconductors/__tests__/diode.test.ts:1132`- remove `pool.ag.set(ag);`
- `src/components/semiconductors/__tests__/diode-state-pool.test.ts:273`- remove `pool.ag.set(ag);`
- `src/components/io/__tests__/led.test.ts:921`- remove `pool.ag.set(ag);`

Exact-form deletion for each:

OLD (one line):
```
    pool.ag.set(ag);
```

NEW:
```
    // D1: ag buffer is on LoadContext, not StatePool.
```

### D1 integration.ts doc comment (non-functional)

### FILE: src/solver/analog/integration.ts (line 181)

OLD:
```
 * from statePool.ag instead of deriving 1/dt locally.
```

NEW:
```
 * from ctx.ag instead of deriving 1/dt locally.
```

---

## D2- PLUMB `loadCtx.uic` FROM `params.uic`; ADD `uic` TO `LoadContext` SHAPE AS NON-OPTIONAL (ALREADY IS); REMOVE UNSOUND CAST IN `newton-raphson.ts`

### FILE: src/solver/analog/ckt-context.ts
### REASON: D2- hard-coded `uic: false` discards `params.uic` set by user. ngspice traninit.c:35 seeds MODEUIC mask then dctran.c:190,346,366 preserve it across MODEDCOP→MODETRANOP→MODETRAN transitions.
### NGSPICE REF: src/frontend/sim/traninit.c:35; src/ciderlib/twod/dctran.c:190,346,366

OLD (lines 529-536):
```
      isDcOp: false,
      isTransient: false,
      xfact: 0,
      gmin: params.gmin ?? 1e-12,
      uic: false,
      reltol: params.reltol,
      iabstol: params.abstol,
    };
```

NEW:
```
      isDcOp: false,
      isTransient: false,
      isTransientDcop: false,
      isAc: false,
      xfact: 0,
      gmin: params.gmin ?? 1e-12,
      uic: params.uic ?? false,
      reltol: params.reltol,
      iabstol: params.abstol,
    };
```

Also update `refreshTolerances` to refresh uic so `configure({ uic: true })` propagates:

OLD (lines 612-620):
```
    // Load-context scalars derived from params
    this.loadCtx.reltol = params.reltol;
    this.loadCtx.iabstol = params.abstol;
    this.loadCtx.gmin = params.gmin ?? 1e-12;

    // Keep the full params reference in sync so downstream readers
    // (e.g. solveDcOperatingPoint) see the new values.
    this.params = params;
  }
```

NEW:
```
    // Load-context scalars derived from params
    this.loadCtx.reltol = params.reltol;
    this.loadCtx.iabstol = params.abstol;
    this.loadCtx.gmin = params.gmin ?? 1e-12;
    this.loadCtx.uic = params.uic ?? false;

    // Keep the full params reference in sync so downstream readers
    // (e.g. solveDcOperatingPoint) see the new values.
    this.params = params;
  }
```

### FILE: src/solver/analog/newton-raphson.ts
### REASON: D2- UIC was read via unsound `(statePool as { uic?: boolean })` cast. StatePool does not have `uic`; the flag belongs on LoadContext/ctx. Use `ctx.loadCtx.uic` (the plumbed value) directly.
### NGSPICE REF: niiter.c MODEUIC check; traninit.c:35

OLD (lines 271-280):
```
  // MODETRANOP && MODEUIC: single CKTload, no iteration (ngspice dctran.c UIC path).
  if (ctx.isDcOp && statePool && (statePool as { uic?: boolean }).uic) {
    [voltages, prevVoltages] = [prevVoltages, voltages];
    ctx.rhsOld.set(prevVoltages);
    cktLoad(ctx, 0);
    ctx.nrResult.converged = true;
    ctx.nrResult.iterations = 0;
    ctx.rhs.set(prevVoltages);
    return;
  }
```

NEW:
```
  // MODETRANOP && MODEUIC: single CKTload, no iteration (ngspice dctran.c UIC path).
  // D2/D3: gated on isTransientDcop (MODETRANOP-only) per dctran.c- standalone
  // .OP never takes the UIC shortcut even if uic=true in the params.
  if (ctx.isTransientDcop && ctx.loadCtx.uic) {
    [voltages, prevVoltages] = [prevVoltages, voltages];
    ctx.rhsOld.set(prevVoltages);
    cktLoad(ctx, 0);
    ctx.nrResult.converged = true;
    ctx.nrResult.iterations = 0;
    ctx.rhs.set(prevVoltages);
    return;
  }
```

---

## D3- DISTINGUISH MODETRANOP FROM MODEDCOP

### FILE: src/solver/analog/load-context.ts
### REASON: D3- new required field on LoadContext; D2 already provides uic; D4 adds isAc.
### NGSPICE REF: src/include/ngspice/cktdefs.h:171-172 (MODEDCOP=0x10, MODETRANOP=0x20); src/ciderlib/twod/dctran.c:190,219-220,231-232

OLD (lines 56-70):
```
  /** True during DC operating point solves. */
  isDcOp: boolean;
  /** True during transient solves. */
  isTransient: boolean;
  /** Extrapolation factor for predictor (deltaOld[0] / deltaOld[1]). */
  xfact: number;
  /** Diagonal conductance added for numerical stability (CKTgmin). */
  gmin: number;
  /** Use initial conditions flag (CKT MODEUIC). */
  uic: boolean;
  /** Relative convergence tolerance (CKTreltol). */
  reltol: number;
  /** Absolute current tolerance (CKTabstol). */
  iabstol: number;
}
```

NEW:
```
  /** True during DC operating point solves. */
  isDcOp: boolean;
  /** True during transient solves. */
  isTransient: boolean;
  /**
   * True during the pre-first-step DCOP invocation of transient analysis
   * (ngspice MODETRANOP, cktdefs.h:172). Distinguishes the transient-boot
   * DCOP from a standalone .OP (MODEDCOP, cktdefs.h:171). Elements that
   * scale contributions only under MODETRANOP (e.g. vsrcload.c:410-411
   * srcFact multiply) gate on this flag instead of on isDcOp alone.
   * Mutually compatible with isDcOp=true; never true during transient NR
   * or standalone .OP; never true during AC.
   */
  isTransientDcop: boolean;
  /**
   * True during AC small-signal sweeps. Mutually exclusive with isDcOp and
   * isTransient. Mirrors ngspice acan.c:285 `CKTmode = (CKTmode & MODEUIC) | MODEAC`.
   */
  isAc: boolean;
  /** Extrapolation factor for predictor (deltaOld[0] / deltaOld[1]). */
  xfact: number;
  /** Diagonal conductance added for numerical stability (CKTgmin). */
  gmin: number;
  /** Use initial conditions flag (CKT MODEUIC). */
  uic: boolean;
  /** Relative convergence tolerance (CKTreltol). */
  reltol: number;
  /** Absolute current tolerance (CKTabstol). */
  iabstol: number;
}
```

### FILE: src/solver/analog/ckt-context.ts
### REASON: D3- add `isTransientDcop` and `isAc` as boolean fields on CKTCircuitContext, initialised false, mirrored into loadCtx by cktLoad.
### NGSPICE REF: cktdefs.h:171-172

OLD (lines 228-240):
```
  // -------------------------------------------------------------------------
  // Mode flags
  // -------------------------------------------------------------------------

  /** Current NR init mode. */
  initMode: InitMode = "transient";
  /** True during DC operating point solves. */
  isDcOp: boolean = false;
  /** True during transient solves. */
  isTransient: boolean = false;
  /** Source stepping scale factor (ngspice srcFact). */
  srcFact: number = 1;
  /** True when nodesets are present (derived from nodesets.size > 0). */
  hadNodeset: boolean = false;
```

NEW:
```
  // -------------------------------------------------------------------------
  // Mode flags
  // -------------------------------------------------------------------------

  /** Current NR init mode. */
  initMode: InitMode = "transient";
  /** True during DC operating point solves. */
  isDcOp: boolean = false;
  /** True during transient solves. */
  isTransient: boolean = false;
  /**
   * True during transient-boot DCOP (ngspice MODETRANOP, cktdefs.h:172).
   * False during standalone .OP (MODEDCOP, cktdefs.h:171) and during
   * transient NR. See LoadContext.isTransientDcop for full semantics.
   */
  isTransientDcop: boolean = false;
  /** True during AC small-signal sweeps (ngspice MODEAC, cktdefs.h). */
  isAc: boolean = false;
  /** Source stepping scale factor (ngspice srcFact). */
  srcFact: number = 1;
  /** True when nodesets are present (derived from nodesets.size > 0). */
  hadNodeset: boolean = false;
```

### FILE: src/solver/analog/ckt-load.ts
### REASON: D3/D4- cktLoad is the single site that synchronizes ctx → loadCtx per NR iteration; propagate new flags.
### NGSPICE REF: cktload.c:29-158

OLD (lines 45-59):
```
  // Step 2: update per-iteration load context fields
  ctx.loadCtx.iteration = iteration;
  ctx.loadCtx.voltages = ctx.rhsOld;
  ctx.loadCtx.initMode = ctx.initMode;
  ctx.loadCtx.srcFact = ctx.srcFact;
  ctx.loadCtx.gmin = ctx.diagonalGmin;
  ctx.loadCtx.isDcOp = ctx.isDcOp;
  ctx.loadCtx.isTransient = ctx.isTransient;
  ctx.loadCtx.noncon.value = 0;

  // Step 3: single device loop (ngspice cktload.c:71-95, calls DEVload)
  for (const element of ctx.elements) {
    element.load(ctx.loadCtx);
  }
  ctx.noncon = ctx.loadCtx.noncon.value;
```

NEW:
```
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

  // Step 3: single device loop (ngspice cktload.c:71-95, calls DEVload)
  for (const element of ctx.elements) {
    element.load(ctx.loadCtx);
  }
  ctx.noncon = ctx.loadCtx.noncon.value;
```

### FILE: src/solver/analog/analog-engine.ts- set `isTransientDcop=true` at entry to `_transientDcop()`, keep false in `dcOperatingPoint()`.
### REASON: D3- the two DCOP paths must be distinguishable at solveDcOperatingPoint time.
### NGSPICE REF: dctran.c:190,219-220,231-232 (sets MODETRANOP before CKTop)

OLD (lines 740-750, inside `dcOperatingPoint()`):
```
    const phaseHook = this.stepPhaseHook;
    const ctx = this._ctx!;
    ctx.postIterationHook = this.postIterationHook;
    ctx.detailedConvergence = this.detailedConvergence;
    ctx.limitingCollector = this.limitingCollector;
    ctx.nodesets = cac.nodesets ?? new Map();
    ctx.ics = cac.ics ?? new Map();
    ctx.srcFact = this._params.srcFact ?? 1;
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    solveDcOperatingPoint(ctx);
```

NEW:
```
    const phaseHook = this.stepPhaseHook;
    const ctx = this._ctx!;
    ctx.postIterationHook = this.postIterationHook;
    ctx.detailedConvergence = this.detailedConvergence;
    ctx.limitingCollector = this.limitingCollector;
    ctx.nodesets = cac.nodesets ?? new Map();
    ctx.ics = cac.ics ?? new Map();
    ctx.srcFact = this._params.srcFact ?? 1;
    // D3: standalone .OP takes MODEDCOP only, NOT MODETRANOP. vsrcload.c:410-411
    // gates srcFact scaling on MODETRANOP, so this flag must be false here even
    // though srcFact is non-1 during source-stepping sub-solves.
    ctx.isTransientDcop = false;
    ctx.isAc = false;
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    solveDcOperatingPoint(ctx);
```

OLD (lines 826-836, inside `_transientDcop()`):
```
    const phaseHook = this.stepPhaseHook;
    const ctx = this._ctx!;
    ctx.postIterationHook = this.postIterationHook;
    ctx.detailedConvergence = this.detailedConvergence;
    ctx.limitingCollector = this.limitingCollector;
    ctx.nodesets = cac.nodesets ?? new Map();
    ctx.ics = cac.ics ?? new Map();
    ctx.srcFact = this._params.srcFact ?? 1;
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    solveDcOperatingPoint(ctx);
```

NEW:
```
    const phaseHook = this.stepPhaseHook;
    const ctx = this._ctx!;
    ctx.postIterationHook = this.postIterationHook;
    ctx.detailedConvergence = this.detailedConvergence;
    ctx.limitingCollector = this.limitingCollector;
    ctx.nodesets = cac.nodesets ?? new Map();
    ctx.ics = cac.ics ?? new Map();
    ctx.srcFact = this._params.srcFact ?? 1;
    // D3: transient-boot DCOP runs under MODETRANOP per dctran.c:190,219-220,231-232.
    // Reset to false after DCOP converges in _seedFromDcop, before the first
    // real transient step.
    ctx.isTransientDcop = true;
    ctx.isAc = false;
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    solveDcOperatingPoint(ctx);
```

(The D1 block above already clears `ctx.isTransientDcop = false` inside `_seedFromDcop`.)

### FILE: src/solver/analog/dc-operating-point.ts
### REASON: D3- `runNR()` currently forces `isTransient=false`. It must preserve `isTransientDcop` across sub-solves but never set `isTransient=true`. No logic change- document intent and explicitly leave isTransientDcop alone (it's set by the caller, engine level).
### NGSPICE REF: cktop.c (all sub-solves stay under MODEDCOP|MODETRANOP- never flip to MODETRAN)

OLD (lines 144-171):
```
function runNR(
  ctx: CKTCircuitContext,
  maxIterations: number,
  initialGuess: Float64Array,
  diagonalGmin: number,
  ladder: CKTCircuitContext["dcopModeLadder"],
  exactMaxIterations?: boolean,
): StepResult {
  ctx.isDcOp = true;
  // Mutually exclusive with isTransient- matches ngspice's MODEDCOP/MODETRAN
  // bitfield where dctran.c:346 overwrites MODEDCOP with MODETRAN. Without this
  // pair, a reset() → step() → dcOp() sequence would carry isTransient=true
  // into the DCOP solve and elements gating on `isTransient || isDcOp` would
  // see both flags simultaneously.
  ctx.isTransient = false;
  ctx.maxIterations = maxIterations;
  ctx.initialGuess = initialGuess;
  ctx.diagonalGmin = diagonalGmin;
  ctx.dcopModeLadder = ladder;
  ctx.exactMaxIterations = exactMaxIterations ?? false;
  ctx.noncon = 1;
  newtonRaphson(ctx);
  return {
    converged: ctx.nrResult.converged,
    iterations: ctx.nrResult.iterations,
    voltages: ctx.nrResult.voltages,
  };
}
```

NEW:
```
function runNR(
  ctx: CKTCircuitContext,
  maxIterations: number,
  initialGuess: Float64Array,
  diagonalGmin: number,
  ladder: CKTCircuitContext["dcopModeLadder"],
  exactMaxIterations?: boolean,
): StepResult {
  ctx.isDcOp = true;
  // Mutually exclusive with isTransient- matches ngspice's MODEDCOP/MODETRAN
  // bitfield where dctran.c:346 overwrites MODEDCOP with MODETRAN. Without this
  // pair, a reset() → step() → dcOp() sequence would carry isTransient=true
  // into the DCOP solve and elements gating on `isTransient || isDcOp` would
  // see both flags simultaneously.
  ctx.isTransient = false;
  // D3: isTransientDcop is set by the CALLER (analog-engine.ts) for the
  // _transientDcop path and left false for standalone .OP. Do NOT modify it
  // here- all DCOP sub-solves (gmin stepping, source stepping, initSmsig
  // finalize) inherit the caller's MODETRANOP vs MODEDCOP distinction.
  // isAc stays false- there is no AC sub-solve inside the DCOP ladder.
  ctx.isAc = false;
  ctx.maxIterations = maxIterations;
  ctx.initialGuess = initialGuess;
  ctx.diagonalGmin = diagonalGmin;
  ctx.dcopModeLadder = ladder;
  ctx.exactMaxIterations = exactMaxIterations ?? false;
  ctx.noncon = 1;
  newtonRaphson(ctx);
  return {
    converged: ctx.nrResult.converged,
    iterations: ctx.nrResult.iterations,
    voltages: ctx.nrResult.voltages,
  };
}
```

---

## D4- ADD `isAc` FLAG AND EXTEND `stampAc` SIGNATURE

### FILE: src/solver/analog/element.ts
### REASON: D4- stampAc must receive LoadContext so `isAc`, `uic`, `gmin`, `reltol` are observable by element stamps.
### NGSPICE REF: acan.c:285 (CKTmode = (CKTmode & MODEUIC) | MODEAC); element ACload() functions read CKTmode bits.

OLD (lines 94-103):
```
  /**
   * Stamp the element's frequency-domain small-signal model for AC analysis.
   *
   * Called once per frequency point during an AC sweep. Resistors stamp
   * conductance (same as DC); capacitors stamp jωC admittance; inductors
   * stamp 1/(jωL) admittance; nonlinear elements stamp linearized
   * small-signal conductances at the DC operating point.
   */
  stampAc?(solver: ComplexSparseSolver, omega: number): void;
```

NEW:
```
  /**
   * Stamp the element's frequency-domain small-signal model for AC analysis.
   *
   * Called once per frequency point during an AC sweep. Resistors stamp
   * conductance (same as DC); capacitors stamp jωC admittance; inductors
   * stamp 1/(jωL) admittance; nonlinear elements stamp linearized
   * small-signal conductances at the DC operating point.
   *
   * D4: receives the shared LoadContext (ngspice re-uses CKTcircuit in
   * ACload()). During AC sweeps `ctx.isAc === true`, `ctx.isDcOp === false`,
   * `ctx.isTransient === false`. `ctx.uic` mirrors the MODEUIC bit preserved
   * across the AC-mode mask (acan.c:285). Element sites that do not need the
   * context should simply ignore the third parameter.
   */
  stampAc?(solver: ComplexSparseSolver, omega: number, ctx: LoadContext): void;
```

### FILE: src/core/analog-types.ts
### REASON: D4- mirror signature in the core interface so registry consumers agree.
### NGSPICE REF: acan.c:285

OLD (lines 178-182):
```
  /**
   * Stamp the element's frequency-domain small-signal model for AC analysis.
   */
  stampAc?(solver: ComplexSparseSolver, omega: number): void;
```

NEW:
```
  /**
   * Stamp the element's frequency-domain small-signal model for AC analysis.
   * D4: receives LoadContext; see src/solver/analog/element.ts for semantics.
   */
  stampAc?(
    solver: ComplexSparseSolver,
    omega: number,
    ctx: import("../solver/analog/load-context.js").LoadContext,
  ): void;
```

### FILE: src/solver/analog/ac-analysis.ts
### REASON: D4- set MODEAC bits on the AC analysis's CKTCircuitContext, hand its `loadCtx` to every stampAc call.
### NGSPICE REF: acan.c:285

OLD (lines 181-193, inside the frequency loop at `for (let fi = 0; ...`):
```
    for (let fi = 0; fi < numFreq; fi++) {
      const f = frequencies[fi];
      const omega = 2 * Math.PI * f;

      // Assemble complex MNA matrix for this frequency
      complexSolver.beginAssembly(N_ac);

      // Stamp all element AC contributions
      for (const el of compiled.elements) {
        if (el.stampAc) {
          el.stampAc(complexSolver, omega);
        }
      }
```

NEW:
```
    // D4: ngspice acan.c:285- `CKTmode = (CKTmode & MODEUIC) | MODEAC` at top
    // of frequency loop. We preserve the LoadContext's uic field (set from
    // params.uic at ctx construction) and flip isAc=true / isDcOp=false /
    // isTransient=false for the entire sweep.
    const acLoadCtx = dcCtx.loadCtx;
    acLoadCtx.isAc = true;
    acLoadCtx.isDcOp = false;
    acLoadCtx.isTransient = false;
    acLoadCtx.isTransientDcop = false;
    dcCtx.isAc = true;
    dcCtx.isDcOp = false;
    dcCtx.isTransient = false;
    dcCtx.isTransientDcop = false;

    for (let fi = 0; fi < numFreq; fi++) {
      const f = frequencies[fi];
      const omega = 2 * Math.PI * f;

      // Assemble complex MNA matrix for this frequency
      complexSolver.beginAssembly(N_ac);

      // Stamp all element AC contributions
      for (const el of compiled.elements) {
        if (el.stampAc) {
          el.stampAc(complexSolver, omega, acLoadCtx);
        }
      }
```

### D4 stampAc implementations- signature updates

Every test stub that defines `stampAc` must accept a third optional parameter. Because `stampAc` is optional on the interface and the new signature includes a third argument, TypeScript will accept stubs that omit the third argument only if they use the looser `stampAc?` member-initialization style. To be safe, every `stampAc` implementation that does NOT use a prefix-underscore unused pattern must receive an `_ctx?: LoadContext` or `_ctx: LoadContext` param.

Enumerated hunks by file:

#### src/solver/analog/__tests__/ac-analysis.test.ts

Line 57 (makeAcResistor):

OLD:
```
    stampAc(solver: ComplexSparseSolver, _omega: number): void {
```

NEW:
```
    stampAc(solver: ComplexSparseSolver, _omega: number, _ctx: LoadContext): void {
```

Line 86 (makeAcCapacitor):

OLD:
```
    stampAc(solver: ComplexSparseSolver, omega: number): void {
```

NEW:
```
    stampAc(solver: ComplexSparseSolver, omega: number, _ctx: LoadContext): void {
```

Line 114 (makeAcInductor):

OLD:
```
    stampAc(solver: ComplexSparseSolver, omega: number): void {
```

NEW:
```
    stampAc(solver: ComplexSparseSolver, omega: number, _ctx: LoadContext): void {
```

#### src/solver/analog/__tests__/dc-operating-point.test.ts (line 230)

OLD:
```
    stampAc(solver: import("../sparse-solver.js").SparseSolver): void {
```

NEW:
```
    stampAc(solver: import("../sparse-solver.js").SparseSolver, _omega: number, _ctx: import("../load-context.js").LoadContext): void {
```

#### src/compile/__tests__/pin-loading-menu.test.ts:59

OLD:
```
    stampAc(_s: SparseSolver) {},
```

NEW:
```
    stampAc(_s: SparseSolver, _o?: number, _c?: import("../../solver/analog/load-context.js").LoadContext) {},
```

#### src/compile/__tests__/coordinator.test.ts:128

OLD:
```
    stampAc(solver: SparseSolver): void {
```

NEW:
```
    stampAc(solver: SparseSolver, _omega?: number, _ctx?: import("../../solver/analog/load-context.js").LoadContext): void {
```

#### src/compile/__tests__/compile.test.ts:176

OLD:
```
    stampAc(solver: SparseSolver): void {
```

NEW:
```
    stampAc(solver: SparseSolver, _omega?: number, _ctx?: import("../../solver/analog/load-context.js").LoadContext): void {
```

#### src/compile/__tests__/compile-integration.test.ts:105,118,131

Each of these three lines:

OLD (repeat for each of 105, 118, 131):
```
    stampAc(_s: SparseSolver) {},
```

NEW:
```
    stampAc(_s: SparseSolver, _o?: number, _c?: import("../../solver/analog/load-context.js").LoadContext) {},
```

#### src/core/__tests__/analog-types-setparam.test.ts:11, 24

OLD (both lines):
```
      stampAc() {},
```

NEW:
```
      stampAc(_s?: import("../analog-types.js").ComplexSparseSolver, _o?: number, _c?: import("../../solver/analog/load-context.js").LoadContext) {},
```

#### src/solver/__tests__/coordinator-speed-control.test.ts:57

OLD:
```
    stampAc(solver: SparseSolverStamp): void {
```

NEW:
```
    stampAc(solver: SparseSolverStamp, _omega?: number, _ctx?: import("../../solver/analog/load-context.js").LoadContext): void {
```

#### src/solver/__tests__/coordinator-capability.test.ts:59

OLD:
```
    stampAc(s: SparseSolver) {
```

NEW:
```
    stampAc(s: SparseSolver, _o?: number, _c?: import("../../solver/analog/load-context.js").LoadContext) {
```

#### src/components/io/__tests__/led.test.ts:742

OLD:
```
    stampAc(solver: SparseSolverType): void {
```

NEW:
```
    stampAc(solver: SparseSolverType, _omega?: number, _ctx?: import("../../../solver/analog/load-context.js").LoadContext): void {
```

#### src/solver/analog/__tests__/timestep.test.ts:56

OLD:
```
    stampAc(_solver: SparseSolver): void {},
```

NEW:
```
    stampAc(_solver: SparseSolver, _omega?: number, _ctx?: import("../load-context.js").LoadContext): void {},
```

#### src/solver/analog/__tests__/spice-import-dialog.test.ts:300

OLD:
```
        stampAc(_s: SparseSolver) {},
```

NEW:
```
        stampAc(_s: SparseSolver, _o?: number, _c?: import("../load-context.js").LoadContext) {},
```

#### src/solver/analog/__tests__/compiler.test.ts:101, 114, 127

OLD (each line):
```
    stampAc(_s: SparseSolver) { /* no-op */ },
```

NEW:
```
    stampAc(_s: SparseSolver, _o?: number, _c?: import("../load-context.js").LoadContext) { /* no-op */ },
```

#### src/solver/analog/__tests__/digital-pin-loading.test.ts:72

OLD:
```
    stampAc(_s: SparseSolver) {},
```

NEW:
```
    stampAc(_s: SparseSolver, _o?: number, _c?: import("../load-context.js").LoadContext) {},
```

#### src/solver/analog/__tests__/compile-analog-partition.test.ts:88

OLD:
```
    stampAc(_s: SparseSolver) { /* no-op */ },
```

NEW:
```
    stampAc(_s: SparseSolver, _o?: number, _c?: import("../load-context.js").LoadContext) { /* no-op */ },
```

---

## D2/D3- TEST LOADCONTEXT LITERAL MIGRATIONS (add `isTransientDcop: false, isAc: false` to every literal)

Every LoadContext literal in the codebase needs `isTransientDcop: false, isAc: false` appended (both default). The canonical insertion point is **immediately after the `isTransient: X` line**.

Because TypeScript structural typing requires all non-optional fields, any LoadContext literal missing these two fields will fail to compile after D3/D4 land. The implementer should apply the following pattern to EACH enumerated line below:

**Pattern (pre-change → post-change):**

Before:
```
      isDcOp: false,
      isTransient: false,
      xfact: ...
```
OR some variant like:
```
    isDcOp: false, isTransient: false, xfact: ...
```

After (new lines inserted right after `isTransient`):
```
      isDcOp: false,
      isTransient: false,
      isTransientDcop: false,
      isAc: false,
      xfact: ...
```

### Enumerated files and confirmed `uic: false` lines (each denotes a LoadContext literal):

All files from the `uic: false` Grep result need this migration. The `uic: false` line marker is the reliable locator. Insert `isTransientDcop: false, isAc: false,` immediately after the `isTransient` line (which appears a few lines BEFORE `uic: false` in all surveyed literals).

Complete file:line list (each entry is one LoadContext literal to patch):

1. `src/solver/__tests__/coordinator-bridge.test.ts:89`
2. `src/solver/__tests__/coordinator-bridge-hotload.test.ts:74`
3. `src/solver/analog/__tests__/sparse-solver.test.ts:473`
4. `src/solver/analog/__tests__/fet-base.test.ts:151, 669` (the :669 hunk is already covered by the D1 fet-base full-literal hunk above)
5. `src/solver/analog/__tests__/digital-pin-model.test.ts:113`
6. `src/solver/analog/__tests__/dcop-init-jct.test.ts:83`
7. `src/solver/analog/__tests__/bridge-compilation.test.ts:79`
8. `src/solver/analog/__tests__/bridge-adapter.test.ts:105`
9. `src/solver/analog/__tests__/behavioral-sequential.test.ts:55, 499`
10. `src/solver/analog/__tests__/behavioral-remaining.test.ts:385, 514`
11. `src/solver/analog/__tests__/behavioral-integration.test.ts:514`
12. `src/solver/analog/__tests__/behavioral-gate.test.ts:508`
13. `src/solver/analog/__tests__/behavioral-flipflop.test.ts:133, 345`
14. `src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts:93`
15. `src/solver/analog/__tests__/behavioral-combinational.test.ts:455`
16. `src/components/sources/__tests__/variable-rail.test.ts:208`
17. `src/components/sources/__tests__/ground.test.ts:56`
18. `src/components/sources/__tests__/dc-voltage-source.test.ts:64, 209, 248, 285`
19. `src/components/sources/__tests__/current-source.test.ts:64, 192, 232, 265`
20. `src/components/sources/__tests__/ac-voltage-source.test.ts:79, 449, 488, 525`
21. `src/components/sensors/__tests__/spark-gap.test.ts:86`
22. `src/components/sensors/__tests__/ntc-thermistor.test.ts:89`
23. `src/components/semiconductors/__tests__/zener.test.ts:93`
24. `src/components/semiconductors/__tests__/varactor.test.ts:104, 463`
25. `src/components/semiconductors/__tests__/tunnel-diode.test.ts:98, 440`
26. `src/components/semiconductors/__tests__/triac.test.ts:93`
27. `src/components/semiconductors/__tests__/scr.test.ts:126`
28. `src/components/semiconductors/__tests__/mosfet.test.ts:110, 1124, 1273`
29. `src/components/semiconductors/__tests__/jfet.test.ts:114, 625`
30. `src/components/semiconductors/__tests__/diode.test.ts:105, 312, 872, 1041`
31. `src/components/semiconductors/__tests__/diode-state-pool.test.ts:66, 93`
32. `src/components/semiconductors/__tests__/bjt.test.ts:104, 1320, 1395`
33. `src/components/passives/__tests__/transmission-line.test.ts:120, 1086`
34. `src/components/passives/__tests__/transformer.test.ts:95, 855`
35. `src/components/passives/__tests__/tapped-transformer.test.ts:76, 630`
36. `src/components/passives/__tests__/polarized-cap.test.ts:79, 119, 272, 356, 652`
37. `src/components/passives/__tests__/memristor.test.ts:74, 317, 463`
38. `src/components/passives/__tests__/inductor.test.ts:167 (single-line literal), 609`
39. `src/components/passives/__tests__/crystal.test.ts:457 (single-line literal), 577`
40. `src/components/passives/__tests__/capacitor.test.ts:461, 632, 791`
41. `src/components/passives/__tests__/analog-fuse.test.ts:78`
42. `src/components/io/__tests__/probe.test.ts:394`
43. `src/components/io/__tests__/led.test.ts:939`
44. `src/components/io/__tests__/analog-clock.test.ts:183, 227`
45. `src/components/active/__tests__/timer-555.test.ts:966`
46. `src/components/active/__tests__/schmitt-trigger.test.ts:93, 453`
47. `src/components/active/__tests__/real-opamp.test.ts:675`
48. `src/components/active/__tests__/ota.test.ts:347`
49. `src/components/active/__tests__/optocoupler.test.ts:373`
50. `src/components/active/__tests__/opamp.test.ts:400`
51. `src/components/active/__tests__/dac.test.ts:348`
52. `src/components/active/__tests__/comparator.test.ts:301, 329`
53. `src/components/active/__tests__/analog-switch.test.ts:400`
54. `src/components/active/__tests__/adc.test.ts:355`

**Special single-line literal cases** (inductor.test.ts:165-167, crystal.test.ts:455-457) contain `isDcOp: false, isTransient: true, xfact: 1, gmin: 1e-12, uic: false,` on one line. Patch:

OLD:
```
        isDcOp: false, isTransient: false, xfact: 1, gmin: 1e-12, uic: false,
```

NEW:
```
        isDcOp: false, isTransient: false, isTransientDcop: false, isAc: false, xfact: 1, gmin: 1e-12, uic: false,
```

(And analogously for the `isTransient: true` variants in crystal/inductor.)

---

## SUMMARY BLOCK- Every File Touched

| File | Hunks | D-label(s) |
|------|-------|------------|
| `src/solver/analog/state-pool.ts` | 2 | D1 |
| `src/solver/analog/analog-engine.ts` | 3 (`_seedFromDcop` ag writes, `dcOperatingPoint`, `_transientDcop`) | D1, D3 |
| `src/solver/analog/integration.ts` | 1 (doc) | D1 |
| `src/solver/analog/ckt-context.ts` | 3 (mode-flags block, loadCtx literal, refreshTolerances) | D2, D3, D4 |
| `src/solver/analog/load-context.ts` | 1 | D2, D3, D4 |
| `src/solver/analog/newton-raphson.ts` | 1 (uic cast removed) | D2, D3 |
| `src/solver/analog/ckt-load.ts` | 1 | D3, D4 |
| `src/solver/analog/dc-operating-point.ts` | 1 (`runNR`) | D3, D4 |
| `src/solver/analog/ac-analysis.ts` | 1 | D4 |
| `src/solver/analog/element.ts` | 1 (stampAc signature) | D4 |
| `src/core/analog-types.ts` | 1 (stampAc signature) | D4 |
| `src/solver/analog/__tests__/state-pool.test.ts` | 1 (delete `ag[] integration coefficients` describe) | D1 |
| `src/solver/analog/__tests__/fet-base.test.ts` | 1 (full LoadContext literal rewrite) + 1 prior literal | D1, D2, D3 |
| Component test files with `pool.ag.set(ag)` | 7 (varactor, tunnel-diode, mosfet, diode, diode-state-pool, led) | D1 |
| Test files containing LoadContext literals (see list above, items 1-54) | ~90 literals, typically 2 lines inserted per literal | D3, D4 |
| Test files with `stampAc` stubs | ~20 signatures updated | D4 |

**Total file count touched:** ~85 unique files. Production source: 11 files. Tests: ~75 files.

---

## VERIFICATION CHECKLIST- Post-Apply

Run these in order. Each should succeed.

1. **Grep sanity- D1 (phantom ag must be gone):**
   ```
   Grep: pattern="pool\.ag|statePool\.ag" glob="src/**/*.ts"
   ```
   Expected: zero matches in production; zero matches in `__tests__` (all tests migrated to LoadContext-owned ag).

2. **Grep sanity- D2 (no unsound uic cast):**
   ```
   Grep: pattern="as \{ uic\?: boolean \}" glob="src/**/*.ts"
   ```
   Expected: zero matches.

3. **Grep sanity- D3 (every LoadContext literal has isTransientDcop):**
   ```
   Grep: pattern="uic: (true|false)" glob="src/**/*.ts" output_mode="files_with_matches"
   ```
   Cross-reference with:
   ```
   Grep: pattern="isTransientDcop: (true|false)" glob="src/**/*.ts" output_mode="files_with_matches"
   ```
   Every file in the first set must appear in the second.

4. **Grep sanity- D4 (every stampAc takes 3 args or is the interface):**
   ```
   Grep: pattern="stampAc\(.*?\).*?void" output_mode="content" glob="src/**/*.ts"
   ```
   Manually check none use only 2 parameters (except `stampAc?` interface declarations- but those are updated).

5. **Typecheck:**
   ```
   npx tsc --noEmit
   ```
   Expected: zero errors.

6. **Targeted test runs (per user feedback guidance- target numerical-critical subsystems only):**
   ```
   npx vitest run src/solver/analog/__tests__/state-pool.test.ts
   npx vitest run src/solver/analog/__tests__/dc-operating-point.test.ts
   npx vitest run src/solver/analog/__tests__/newton-raphson.test.ts
   npx vitest run src/solver/analog/__tests__/ac-analysis.test.ts
   npx vitest run src/solver/analog/__tests__/fet-base.test.ts
   npx vitest run src/solver/analog/__tests__/bridge-adapter.test.ts
   ```
   All passes required.

7. **Full test quick pass (agent default per CLAUDE.md):**
   ```
   npm run test:q
   ```
   Inspect `test-results/test-failures.json`. Numerical parity tests must not regress versus the pre-apply baseline.

8. **Build:**
   ```
   npm run build
   ```
   Expected: success.

9. **ngspice-harness spot check** (per CLAUDE.md "First Tool for Numerical Issues"):
   - Load a BJT stress circuit (any existing harness fixture).
   - Capture per-iteration voltages for a transient step following DCOP.
   - Confirm values match the pre-change baseline to machine precision (D1-D3 are semantic cleanups; D1's `ctx.ag[0] = 0` is functionally identical to the old `statePool.ag[0] = 0` because no production element actually read `statePool.ag`- only `loadCtx.ag` which was already `ctx.ag`).

---

## LANDING PLAN- Recommended Commit Boundaries

### Commit 1: D1 (phantom ag removal)- self-contained
- `src/solver/analog/state-pool.ts`
- `src/solver/analog/analog-engine.ts` (just lines 1114-1115: change `cac.statePool.ag[0/1] = 0` to `ctx.ag[0/1] = 0`)
- `src/solver/analog/integration.ts` (doc comment only)
- `src/solver/analog/__tests__/state-pool.test.ts` (delete `ag[] integration coefficients` block)
- All `pool.ag.set(ag)` deletions across seven test files
- `src/solver/analog/__tests__/fet-base.test.ts` (full LoadContext rewrite at line ~625-672- migrate ag allocation)

Verification: `npm run test:q -- state-pool fet-base varactor tunnel-diode mosfet diode led` should pass.

### Commit 2: D2 (uic plumbing)
- `src/solver/analog/ckt-context.ts` (two hunks: `loadCtx` literal and `refreshTolerances`)
- `src/solver/analog/newton-raphson.ts` (uic cast removal)

Note: the newton-raphson change references `ctx.isTransientDcop` which is added in Commit 3. If landing these in reverse order is unavoidable, apply Commit 3's `ckt-context.ts` additions to the mode-flags block in this commit as well.

### Commit 3: D3 (MODETRANOP distinction)
- `src/solver/analog/ckt-context.ts` (mode-flags block)
- `src/solver/analog/load-context.ts` (add `isTransientDcop`, and `isAc` interface fields)
- `src/solver/analog/ckt-load.ts` (propagate new fields)
- `src/solver/analog/dc-operating-point.ts` (runNR: preserve isTransientDcop)
- `src/solver/analog/analog-engine.ts` (`_transientDcop` sets `true`, `dcOperatingPoint` sets `false`, `_seedFromDcop` resets to `false`)
- All ~90 LoadContext literal updates across test files

Verification: `npm run test:q -- dc-operating-point newton-raphson bridge-adapter bridge-compilation dcop-init-jct behavioral-gate` should pass.

### Commit 4: D4 (isAc flag and stampAc context)
- `src/solver/analog/element.ts` (stampAc signature)
- `src/core/analog-types.ts` (stampAc signature)
- `src/solver/analog/ac-analysis.ts` (set MODEAC bits, pass acLoadCtx)
- All ~20 stampAc stubs across test files

Verification: `npm run test:q -- ac-analysis compiler coordinator compile compile-integration dc-operating-point spice-import-dialog` should pass.

### Final: full suite sweep
- `npm run test:q` (all), then `npm run build`.
- ngspice-harness transient spot check on one BJT and one MOSFET fixture.

---

## ADDITIONAL NOTES TO THE IMPLEMENTER

1. **Do not touch `src/solver/analog/bridge-adapter.ts`** per preamble.
2. **Do not change `deltaOld[0..6] = maxTimeStep` seeding** per preamble correction.
3. The new field `isTransientDcop` is *compatible* with `isDcOp=true`. A transient-boot DCOP has both flags set; a standalone .OP has only `isDcOp=true`. Elements that want ngspice's exact MODETRANOP gating write `if (ctx.isDcOp && ctx.isTransientDcop)` (mirror of `MODE & MODETRANOP`). Elements that want ngspice's exact MODEDCOP gating (standalone .OP only) write `if (ctx.isDcOp && !ctx.isTransientDcop)`.
4. `isAc` is **mutually exclusive** with `isDcOp` and `isTransient`. This mirrors the fact that AC sweeps use only `MODEAC|MODEUIC`- never `MODEDCOP`, `MODETRAN`, or `MODETRANOP`. Elements may safely assume `ctx.isAc ⇒ !ctx.isDcOp && !ctx.isTransient`. The DC-OP that *precedes* an AC sweep runs with `isDcOp=true, isAc=false` like any other DCOP; only the frequency-sweep loop itself sets `isAc=true`.
5. In `dc-operating-point.ts`'s `dcopFinalize` sub-solve (initSmsig pass), `isTransientDcop` is inherited from the ctx (set by caller). ngspice does the same- initSmsig does not change the MODETRANOP bit. No explicit action needed; the "preserve caller's value" intent in the updated `runNR` comment covers this.
6. The `AcAnalysis` constructor at `ac-analysis.ts:74-87` creates a **new `CKTCircuitContext`** per `run()` call (line 102: `new CKTCircuitContext(...)`). This means `dcCtx.loadCtx` is fresh, `isAc=false` at construction (via the new ckt-context literal default). The `acLoadCtx.isAc = true` assignment in the new hunk flips it just before the sweep, matching ngspice's `CKTmode = (CKTmode & MODEUIC) | MODEAC` at acan.c:285. The `uic` bit is preserved because the ckt-context constructor seeds `uic: params.uic ?? false` (D2 fix) from the same ResolvedSimulationParams the engine used for DCOP.

Absolute paths of every key file touched:

- C:\local_working_projects\digital_in_browser\src\solver\analog\state-pool.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\analog-engine.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\integration.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\ckt-context.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\load-context.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\newton-raphson.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\ckt-load.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\dc-operating-point.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\ac-analysis.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\element.ts
- C:\local_working_projects\digital_in_browser\src\core\analog-types.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\state-pool.test.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\fet-base.test.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\ac-analysis.test.ts
- C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\dc-operating-point.test.ts
- All 54 enumerated component/solver test files listed in the LoadContext literal migration section.
agentId: a1e8cd58735eefd04 (use SendMessage with to: 'a1e8cd58735eefd04' to continue this agent)
<usage>total_tokens: 178292
tool_uses: 32
duration_ms: 341017</usage>