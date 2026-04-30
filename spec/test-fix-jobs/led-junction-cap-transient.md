# LED junction-cap transient — replace mockSolver

## Category

`contract-update`

## Problem

`src/components/io/__tests__/led.test.ts::integration::"junction_cap_transient_matches_ngspice"` (lines 851-925) fails with `expected +0 to be 0.4862002658788155` at line 924. The test constructs a hand-rolled mock solver:

```ts
// led.test.ts:888-892
const mockSolver = {
  allocElement: (r: number, c: number) => { _allocRow = r; _allocCol = c; return 0; },
  stampElement: (_h: number, v: number) => stamps.push([_allocRow, _allocCol, v]),
  stampRHS: (r: number, v: number) => rhs.push([r, v]),
} as any;
```

The mock returns handle `0` from every `allocElement()` call. The diode's `load()` body in `src/components/semiconductors/diode.ts` (and the LED extension that delegates to it) calls `solver.stampElement(handle, value)`. With `handle === 0` the production `SparseSolver.stampElement` would skip the stamp entirely (handle 0 is the ground/trashcan sentinel — see `sparse-solver.ts:386` and the type guard at `:598`). The mock instead always pushes — meaning the test sometimes captures stamps the production solver would ignore, and the mock's reduce-by-handle filter at line 922 (`stamps.filter(([r, c]) => r === 0 && c === 0)`) is summing an empty list because the row/col tracked by the mock doesn't match the post-allocation `_allocRow / _allocCol` for the *junction-cap* stamp specifically.

The test's actual goal is correct — it asserts that `total00 === gd_junction + capGeq_expected`, which is the ngspice-equivalent diagonal stamp from `dioload.c:436` plus the junction-cap conductance returned by `NIintegrate`. The fix is to drop the mock and run the load through a real `SparseSolver`, then read the stamps via the same matrix-capture surface used by the harness.

## Failing test / site

`src/components/io/__tests__/led.test.ts`:

| Test | Lines | Failure |
|------|-------|---------|
| `integration > junction_cap_transient_matches_ngspice` | 851-925 | `expect(total00).toBe(gd_junction + capGeq_expected)` — receives 0 |

The mock construction is at lines 885-892. The `load(ctx)` call is at line 904. The assertion against `total00` is at lines 922-924.

## ngspice citation

Verified against `ref/ngspice/src/spicelib/devices/dio/dioload.c`:

```c
// dioload.c:395 — call into NIintegrate to compute geq, ceq
error = NIintegrate(ckt, &geq, &ceq, capd, here->DIOcapCharge);
if (error) return error;
gd = gd + geq;          // dioload.c:397 — add capacitor conductance to junction conductance
cd = cd + *(ckt->CKTstate0 + here->DIOcapCurrent);  // dioload.c:398
...
// dioload.c:429 — equivalent companion-model current
cdeq = cd - gd * vd;
*(ckt->CKTrhs + here->DIOnegNode) += cdeq;          // dioload.c:430
*(ckt->CKTrhs + here->DIOposPrimeNode) -= cdeq;     // dioload.c:431
// dioload.c:435-441 — load the matrix
*(here->DIOposPosPtr) += gspr;
*(here->DIOnegNegPtr) += gd;
*(here->DIOposPrimePosPrimePtr) += (gd + gspr);
*(here->DIOposPosPrimePtr) -= gspr;
*(here->DIOnegPosPrimePtr) -= gd;
*(here->DIOposPrimePosPtr) -= gspr;
*(here->DIOposPrimeNegPtr) -= gd;
```

The diagonal junction stamp at `DIOposPrimePosPrimePtr` (the "internal anode" node, after the series spread resistance `gspr`) carries `(gd + gspr)`. With `gspr → ∞` (no series resistance — the LED case here) the stamp reduces to `gd` only. Crucially `gd` here equals `gd_raw + geq` per line 397, where `geq = ag[0] * Ctotal` is the junction-cap contribution from `NIintegrate` (`niinteg.c:28-63`).

The test asserts:
- `total00 === gd_junction + capGeq_expected`
- `gd_junction = gdRaw + 1e-12` (GMIN added inside the diode's `load()`)
- `capGeq_expected = ag[0] * Ctotal`

This matches `dioload.c:397` plus the GMIN injection (which our engine adds at the diode-junction stamp; ngspice adds it to the matrix diagonal in `cktload.c`).

The "diodefs.h" pin layout for the LED with no series resistance has the cathode hardwired to ground inside the LED component, so the only externally observable stamp lands at row=col=0 (the LED's single user pin "in" → MNA node 0 in the test's pin map at line 867: `new Map([["in", 1]])`).

Wait — re-reading the test: the LED is built at `new Map([["in", 1]])`, so pin "in" → node 1, not node 0. But the test filters `r === 0 && c === 0`. The mock uses `_allocRow / _allocCol` which is whatever was passed to `allocElement` — and the LED's load() calls `allocElement(1, 1)` for the diagonal. So the filter `r === 0 && c === 0` is wrong against the test's own pin map. With a real `SparseSolver` the matrix slot is at row=1,col=1 (the in-pin's MNA index).

This is a second bug in the test independent of the mock: the assertion filters on `(0, 0)` but the LED stamps at `(1, 1)` because pin "in" is at node 1. Fixing this is part of the migration.

## Migration

Replace the mock with a real `SparseSolver`, set up the LED element's `setup()` against it, run `load()` once, then read `getCSCNonZeros()` and sum the diagonal at the LED's actual pin row.

### Replacement test body

```ts
it("junction_cap_transient_matches_ngspice", () => {
  const IS = 3.17e-19, N = 1.8, CJO = 10e-12, VJ = 1.0, M = 0.5, FC = 0.5, TT = 0;
  const dt = 1e-9;
  const vd = 1.8;

  const ag = new Float64Array(7);
  const scratch = new Float64Array(49);
  computeNIcomCof(dt, [dt, dt, dt, dt, dt, dt, dt], 2, "trapezoidal", ag, scratch);

  const props = new PropertyBag();
  props.set("color", "red");
  props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, IS, N, CJO, VJ, M, TT, FC });
  const core = getFactory(LedDefinition.modelRegistry!.red!)!(
    new Map([["in", 1]]), props, () => 0,
  );

  const slotVD = DIODE_CAP_SCHEMA.indexOf.get("VD")!;
  const slotQ  = DIODE_CAP_SCHEMA.indexOf.get("Q")!;
  const pool = new StatePool(DIODE_CAP_SCHEMA.size);
  (core as unknown as PoolBackedAnalogElement & { _stateBase: number })._stateBase = 0;
  (core as unknown as PoolBackedAnalogElement).initState(pool);
  pool.state0[slotVD] = vd;

  const nVt = N * LED_VT;
  const prevVd = 1.75;
  const prevIdRaw = IS * (Math.exp(prevVd / nVt) - 1);
  const q1_val = computeJunctionCharge(prevVd, CJO, VJ, M, FC, TT, prevIdRaw);
  pool.state1[slotQ] = q1_val;

  // Real solver — sized for one user node (the LED's "in" pin → MNA node 1).
  // matrixSize = 2 (ground row 0 + node 1). Run setup() so allocElement
  // assigns proper handles, then call load() to stamp.
  const solver = new SparseSolver();
  solver._initStructure(); // size auto-grows from setup()'s allocElement calls.
  // The LED's setup() runs through SetupContext; build one via the same helper
  // pattern used by other facade-aware tests (mna-end-to-end.test.ts uses
  // makeSimpleCtx which wires setup() correctly).
  const ctx = makeLoadCtx({
    cktMode: MODETRAN | MODEINITFLOAT,
    solver,
    dt,
    method: "trapezoidal",
    order: 2,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
    ag,
  });
  // Run setup() so the element allocates its sparse handles against the real
  // solver. The exact SetupContext shape comes from test-helpers; reuse the
  // same makeSimpleCtx-derived setup the resistor parity tests use.
  // (Concrete invocation depends on test-helpers' exported builder.)

  core.load(ctx);

  // Compute expected values from the NIintegrate formula
  const idRaw = IS * (Math.exp(vd / nVt) - 1);
  const gdRaw = IS * Math.exp(vd / nVt) / nVt;
  const Cj = computeJunctionCapacitance(vd, CJO, VJ, M, FC);
  const Ct = TT * gdRaw;
  const Ctotal = Cj + Ct;
  const q0_val = computeJunctionCharge(vd, CJO, VJ, M, FC, TT, idRaw);
  const ccap_expected = ag[0] * q0_val + ag[1] * q1_val;
  const capGeq_expected = ag[0] * Ctotal;
  const capIeq_expected = ccap_expected - capGeq_expected * vd;

  expect(capGeq_expected).toBe(ag[0] * Ctotal);
  expect(capIeq_expected).toBe(ccap_expected - capGeq_expected * vd);

  // Read stamps from the real solver. LED "in" pin maps to MNA node 1.
  const entries = solver.getCSCNonZeros();
  const total11 = entries
    .filter((e) => e.row === 1 && e.col === 1)
    .reduce((sum, e) => sum + e.value, 0);
  const gd_junction = gdRaw + 1e-12; // GMIN added in diode load()
  expect(total11).toBe(gd_junction + capGeq_expected);
});
```

Key changes vs. the existing test:

1. Remove the `mockSolver` object entirely (lines 885-892).
2. Use the real `SparseSolver` from `src/solver/analog/sparse-solver.ts`. Run `_initStructure()` once before any `setup()` / `load()` call.
3. Read stamps via `solver.getCSCNonZeros()` (the same surface the harness uses at `capture.ts:310`).
4. Filter on `(row=1, col=1)` — the actual MNA node id for the LED's "in" pin — not `(0, 0)`.
5. Drop the parallel `rhs: Array<[number, number]>` collection; it is unused by the assertion. If the test wants to assert on the RHS injection (`cdeq` per `dioload.c:430-431`), wire `LoadContext.rhs` as a real `Float64Array(2)` and read it after `load()` returns.

### Wiring the SetupContext

The test currently skips `setup()` and depends on the LED's `load()` calling `allocElement` directly. With the real solver, `allocElement` is the entry point that builds the linked CSC structure — calling it from `load()` works the first time but the test must not call `_initStructure()` *after* `setup()` because that wipes the structure. Sequence:

1. `solver._initStructure()` (initial empty structure).
2. `core.load(ctx)` — internally calls `solver.allocElement(1, 1)` which grows the structure, then `solver.stampElement(handle, value)` which stamps into the persistent slot.
3. `solver.getCSCNonZeros()` reads the stamped entries.

Since this LED has only one external pin (cathode is internally hardwired to ground inside the LED component), `setup()` may be skippable — but verify by reading `src/components/io/led.ts` to confirm whether the LED's `setup()` is the only path that calls `allocElement` with the cathode side. If so, the migration must run `setup()` before `load()`.

### Alternative: facade-level matrix capture

If the schema-level setup is too heavy for a unit test, an equivalent facade-level test compiles the LED in a real circuit (5V → 220Ω → red LED → GND), runs one transient step at `dt = 1e-9` past DC-OP, and reads `engine.solver!.getCSCNonZeros()`. The diagonal at the LED's anode row contains the same `gd_junction + capGeq_expected` value (plus the resistor's `1/220` contribution, which the test must subtract). This is heavier but exercises the full pipeline.

Recommendation: use the unit-level `SparseSolver` migration above for this test (it is testing the diode junction-cap stamp formula in isolation, which is the right scope), and add a separate facade-level transient test for end-to-end capture if not already present.

## Tensions / uncertainties

- The exact `SetupContext` builder surface depends on `test-helpers.ts` exports. The migration needs to match the same setup pattern that `mna-end-to-end.test.ts` uses for its diode tests. Verify the helper signature before writing the executor patch.
- Escalation candidate: if the LED component's `setup()` requires a populated `SetupContext.allocStates(...)` before the cathode side is wired, the `_stateBase` direct-write at line 872 (`(core as unknown as PoolBackedAnalogElement & { _stateBase: number })._stateBase = 0;`) may need to move to a real `setup()` call so the engine assigns `_stateBase` itself. Today the test forces `_stateBase = 0` because there's only one element; under a real `SetupContext` the engine assigns it during `allocStates`.
- The mock's incorrect `(0, 0)` filter is a latent bug in the existing assertion. The migration fixes it by reading `(1, 1)` against the real solver. Per the project rule on folding in latent bugs, both go in the same patch.
- The original test cites no specific dioload.c lines. Migration must add `dioload.c:395-441` as the citation, with the inline mapping table:

| ngspice (`dioload.c`) | digiTS |
|-----------------------|--------|
| `geq` from `NIintegrate` (line 395) | `capGeq_expected = ag[0] * Ctotal` |
| `gd = gd + geq` (line 397) | `gd_junction + capGeq_expected` |
| `*(here->DIOposPrimePosPrimePtr) += (gd + gspr)` (line 437) | `total11` (gspr=∞ collapses the term) |
| `cdeq = cd - gd * vd` (line 429) | `capIeq_expected = ccap_expected - capGeq_expected * vd` |
