# Test fix: setup-stamp-order goldens for BJT and IND

## Problem statement

Two goldens in `src/solver/analog/__tests__/setup-stamp-order.test.ts` mismatch the
emitted TSTALLOC sequence:

- `PB-BJT TSTALLOC sequence` (test starts at line 281). Test expects 20 entries.
  Actual emission: 9 entries.
- `PB-IND TSTALLOC sequence` (test starts at line 804). Test expects 5 entries.
  Actual emission: 4 entries (one of the five entries is being emitted with an
  `extRow: undefined` field per the diff, which means it never recorded).

These tests are the contract that pins each component's `setup()` to ngspice's
`*setup.c` TSTALLOC list, line for line. They are the single canonical place
that says "this device emits these (extRow, extCol) pairs in this order." A
mismatch means the test golden is stale, the component emission is missing
calls, or both.

## Tests that fail (verbatim)

From `src/solver/analog/__tests__/setup-stamp-order.test.ts`:

- `setup-stamp-order > PB-BJT TSTALLOC sequence` — test body at lines 281-346;
  `expect(order).toEqual([...])` at line 324.
  Failure message: `expected [ { extRow: 2, extCol: 1 }, …(8) ] to deeply equal
  [ { extRow: 2, extCol: 2 }, …(19) ]` (received 9 / expected 20).

- `setup-stamp-order > PB-IND TSTALLOC sequence` — test body at lines 804-830;
  `expect(order).toEqual([...])` at line 823.
  Failure message: `expected [ …(5) ] to deeply equal [ { extRow: 1, extCol: 3 }, …(4) ]`.
  Per the verbose diff the received array is length 5 but the first four entries
  have `extRow: undefined` or `extCol: undefined`. The fifth entry `(3,3)` is
  recorded correctly. The first four are mis-keyed: the inductor reads pin keys
  `"A"` and `"B"` (`indsetup.c` calls them `INDposNode` / `INDnegNode`) and the
  test passes pin keys `["pos", 1], ["neg", 2]`, so `pinNodes.get("A")` returns
  `undefined`. See `src/components/passives/inductor.ts:226-227`:

  ```ts
  const posNode = pinNodes.get("A")!;  // INDposNode
  const negNode = pinNodes.get("B")!;  // INDnegNode
  ```

  vs. test at line 817:
  ```ts
  const el = new AnalogInductorElement(new Map([["pos", 1], ["neg", 2]]), indProps);
  ```

  The test is inconsistent with the production pin-key contract.

## Verified ngspice citations

### BJT — `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c:435-464`

23 TSTALLOC calls, verified line-by-line:

| ngspice line | TSTALLOC pair | Comment |
|---|---|---|
| 435 | (BJTcolNode, BJTcolPrimeNode) | _hCCP |
| 436 | (BJTbaseNode, BJTbasePrimeNode) | _hBBP |
| 437 | (BJTemitNode, BJTemitPrimeNode) | _hEEP |
| 438 | (BJTcolPrimeNode, BJTcolNode) | _hCPC |
| 439 | (BJTcolPrimeNode, BJTbasePrimeNode) | _hCPBP |
| 440 | (BJTcolPrimeNode, BJTemitPrimeNode) | _hCPEP |
| 441 | (BJTbasePrimeNode, BJTbaseNode) | _hBPB |
| 442 | (BJTbasePrimeNode, BJTcolPrimeNode) | _hBPCP |
| 443 | (BJTbasePrimeNode, BJTemitPrimeNode) | _hBPEP |
| 444 | (BJTemitPrimeNode, BJTemitNode) | _hEPE |
| 445 | (BJTemitPrimeNode, BJTcolPrimeNode) | _hEPCP |
| 446 | (BJTemitPrimeNode, BJTbasePrimeNode) | _hEPBP |
| 447 | (BJTcolNode, BJTcolNode) | _hCC |
| 448 | (BJTbaseNode, BJTbaseNode) | _hBB |
| 449 | (BJTemitNode, BJTemitNode) | _hEE |
| 450 | (BJTcolPrimeNode, BJTcolPrimeNode) | _hCPCP |
| 451 | (BJTbasePrimeNode, BJTbasePrimeNode) | _hBPBP |
| 452 | (BJTemitPrimeNode, BJTemitPrimeNode) | _hEPEP |
| 453 | (BJTsubstNode, BJTsubstNode) | _hSS |
| 461 | (BJTsubstConNode, BJTsubstNode) | _hSCS |
| 462 | (BJTsubstNode, BJTsubstConNode) | _hSSC |
| 463 | (BJTbaseNode, BJTcolPrimeNode) | _hBCP |
| 464 | (BJTcolPrimeNode, BJTbaseNode) | _hCPB |

`BJTsubs` is a model parameter (`LATERAL` vs default vertical) — the C code at
lines 454-460 picks `BJTsubstConNode = BJTbasePrimeNode` (LATERAL) or
`BJTcolPrimeNode` (vertical/default). It is **not** "substrate present yes/no"
— it always allocates substrate stamps because BJTsubstNode is always a real
node in ngspice's parser (the .MODEL line takes a 4th terminal that defaults
to ground). When that node is ground (node 0), digiTS's
`SparseSolver.allocElement` returns a TrashCan handle and skips the
`_insertionOrder.push` (sparse-solver.ts:412-418, mirrors ngspice spbuild.c
`spcGetElement`'s ground guard). So the ground-substrate case produces
`23 - 3 = 20` recorded insertions: entries 19, 20, 21 are all silently dropped
because they reference `BJTsubstNode = 0`.

The expected golden length is therefore 20 entries when `substNode = 0` (the
NPN-NoSubstrate-pin case used by the test).

### IND — `ref/ngspice/src/spicelib/devices/ind/indsetup.c:96-100`

5 TSTALLOC calls, verified:

| ngspice line | TSTALLOC pair |
|---|---|
| 96 | (INDposNode, INDbrEq) |
| 97 | (INDnegNode, INDbrEq) |
| 98 | (INDbrEq, INDnegNode) |
| 99 | (INDbrEq, INDposNode) |
| 100 | (INDbrEq, INDbrEq) |

All 5 are recorded when both posNode and negNode are non-zero. The expected
golden length is 5.

### DIO (sub-element used by composite specs) — `ref/ngspice/src/spicelib/devices/dio/diosetup.c:232-238`

7 TSTALLOC calls, verified:

| ngspice line | TSTALLOC pair |
|---|---|
| 232 | (DIOposNode, DIOposPrimeNode) |
| 233 | (DIOnegNode, DIOposPrimeNode) |
| 234 | (DIOposPrimeNode, DIOposNode) |
| 235 | (DIOposPrimeNode, DIOnegNode) |
| 236 | (DIOposNode, DIOposNode) |
| 237 | (DIOnegNode, DIOnegNode) |
| 238 | (DIOposPrimeNode, DIOposPrimeNode) |

### VSRC — `ref/ngspice/src/spicelib/devices/vsrc/vsrcset.c:52-55`

4 TSTALLOC calls, verified:

| ngspice line | TSTALLOC pair |
|---|---|
| 52 | (VSRCposNode, VSRCbranch) |
| 53 | (VSRCnegNode, VSRCbranch) |
| 54 | (VSRCbranch, VSRCnegNode) |
| 55 | (VSRCbranch, VSRCposNode) |

### CCCS — `ref/ngspice/src/spicelib/devices/cccs/cccsset.c:49-50`

2 TSTALLOC calls, verified:

| ngspice line | TSTALLOC pair |
|---|---|
| 49 | (CCCSposNode, CCCScontBranch) |
| 50 | (CCCSnegNode, CCCScontBranch) |

## Expected golden lengths and rationale

### PB-BJT — expected 20 entries (NOT 19, NOT 23)

Rationale:
- `bjtsetup.c:435-464` issues 23 TSTALLOC calls.
- Three of them (lines 453, 461, 462) reference `BJTsubstNode`. With substrate
  pin grounded (digiTS BJT models do not currently expose a substrate pin —
  see `src/components/semiconductors/bjt.ts:1219` `const substNode = 0;`),
  those three calls hit `SparseSolver`'s ground guard and do **not** push to
  `_insertionOrder`.
- `23 - 3 = 20` recorded insertions.
- The user prompt's "19 entries" figure is one off; the correct count is 20.

The current golden in the test (lines 324-345) lists exactly 20 entries with
the right shape. Whoever last edited the test got the count and the values
right. The mismatch is on the production side — the L1 BJT path is the one
that emits 20 entries (see `src/components/semiconductors/bjt.ts:1254-1292`),
but `createBjtElement` (the public factory the test imports) returns the L0
element (`return el0;` at line 982 inside `_createBjtElementWithPolarity`),
which only allocates 9 cross-term/diagonal stamps (lines 606-614).

So the BJT test golden is correct. The production factory selects the wrong
internal element (L0) regardless of model, because there is no model dispatch
inside `_createBjtElementWithPolarity` — it always returns `el0`.

### PB-IND — expected 5 entries

Rationale: `indsetup.c:96-100` issues 5 TSTALLOC calls; all are unconditional
(no ground guards). The current golden (lines 823-829) lists exactly 5 entries
with the right shape. The test golden is correct. The mismatch is on the test-
construction side: the test calls `new AnalogInductorElement(new Map([["pos",
1], ["neg", 2]]), ...)`, but the production class reads pin keys `"A"` /
`"B"`. Four of the five `solver.allocElement` calls receive `undefined` as
their row or column, which the sparse solver records as a malformed pair
rather than a TrashCan; the fifth entry `(branch, branch)` is correct.

## Re-record procedure

After the production fix lands, re-record by:

1. In a debugging session, call `engine.init(...); (engine as any)._setup();`.
2. Read `(engine as any)._solver._getInsertionOrder()` and copy to clipboard.
3. Validate the count against the ngspice citation:
   - PB-BJT: 23 ngspice TSTALLOC entries minus the count of substrate-touching
     entries that reference ground. With digiTS's current `substNode = 0`
     hard-coding, that's `23 - 3 = 20`. If a future change adds an external
     substrate pin, recount.
   - PB-IND: 5 ngspice TSTALLOC entries; all unconditional. Always 5.
4. Paste back into the test as the `expect(order).toEqual([...])` body, with
   one `// indsetup.c:NN` / `// bjtsetup.c:NN` comment per entry tying it to
   the source line.

The current goldens already match these counts and shapes; what changes is
the component implementation, not the goldens.

## Category

`architecture-fix`.

The test goldens describe the correct ngspice-faithful contract. The
production code does not satisfy it:

- BJT: `createBjtElement` is hard-wired to return the L0 element regardless
  of the `model` property the user / test selected. There is no level / model
  dispatch in `_createBjtElementWithPolarity`. The L1 element with the full
  20-entry TSTALLOC list exists at lines 1202-2087 but is unreachable from
  `createBjtElement`. Fix: the factory must consult the resolved model on the
  PropertyBag (e.g. `props.getStringParam("model")` or whatever the unified
  compiler hands the factory) and return `el1` when the model resolves to the
  L1 / Gummel-Poon variant. The test currently passes `BJT_NPN_DEFAULTS`
  through `props.replaceModelParams(...)` without setting a level; the
  production model-registry must therefore declare which model the test's
  parameter shape resolves to, and the factory must honor that declaration.

- IND: the `AnalogInductorElement` constructor reads pin keys `"A"` and
  `"B"` (matching `ngspiceNodeMap: { A: "pos", B: "neg" }` in
  `InductorDefinition`). The test passes a Map keyed by `"pos"` / `"neg"`,
  which the factory cannot read. Either the test should construct with
  `["A", 1], ["B", 2]` (test-side update — `contract-update` slice) **or**
  the inductor should accept either set of pin keys (production-side
  alignment). The cleanest fix is to make the test match what every other PB-
  passing test in the file does (search the file for `["pos", 1]` to find
  the same pattern in PB-CAP / PB-IND-class tests; PB-CAP uses pin keys
  `["pos", 1], ["neg", 2]` and the `AnalogCapacitorElement` reads `"pos"` /
  `"neg"` accordingly. The inductor diverges from the capacitor on this
  point.) Picking the production fix keeps consistency with the capacitor and
  preserves whatever schematic-side pin labels the editor declares; picking
  the test fix is smaller but leaves the inductor alone in keying its
  `_pinNodes` Map by `"A"` / `"B"`. **Recommend production fix** so PB-IND
  is the same shape as PB-CAP.

## Tensions / uncertainties

1. **Does digiTS BJT implement a substrate pin?** No. Confirmed by reading
   `src/components/semiconductors/bjt.ts:1219`:
   ```ts
   const substNode = 0;  // L1 setup hard-codes substrate to ground.
   ```
   And `BJT_PIN_LAYOUT` exposes only B/C/E pins (not S). So the substrate
   pin is fixed to ground by construction; the three BJTsubstNode-touching
   TSTALLOC entries are always TrashCan'd. If a future model adds the
   substrate pin, the count rises to 23 — but only when that pin is wired to
   a non-ground node.

2. **Is the L0 / L1 split intentional?** L0 is described as "the resistive
   subset" (no caps, no transit time, no excess phase, no substrate, no
   terminal resistors). It has 9 TSTALLOC entries because it skips the
   substrate junction and the terminal-resistor prime nodes. The PB-BJT
   golden was clearly written against L1. The user-facing BJT_NPN_DEFAULTS
   does not specify which level should win. If L0 is the documented default
   for behavioral simulation, the test golden should be a 9-entry list
   (subset of L1, in some order). If L1 is the documented default, the
   factory needs the dispatch fix above. **Resolving this is a
   `contract-update` decision** that the user must make: which model is the
   default for `BJT_NPN_DEFAULTS` PropertyBag, and does L0 still exist as a
   testable variant? See `spec/architectural-alignment.md` if there's an
   existing entry for the L0/L1 split; the BJT load() body's comment at
   line 729 ("L0 has no substrate junction — substrate is L1-only per the
   model-registry split (architectural-alignment.md §E1 APPROVED ACCEPT)")
   suggests there already is one, so the L0/L1 distinction is intentional
   architecture and the question is purely "which one does the test want
   to pin." **Escalate to user.**

3. **PB-IND pin-key inconsistency.** Capacitor reads `"pos"` / `"neg"`;
   inductor reads `"A"` / `"B"`. Both classes are passive 2-terminal devices
   with the same external schematic role. The asymmetry is gratuitous and
   probably an oversight. Recommend the production fix (rename inductor's
   internal pin lookups to `"pos"` / `"neg"` for symmetry with capacitor),
   but flag for user review.
