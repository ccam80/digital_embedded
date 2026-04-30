# Test fix: setup-stamp-order goldens for OPTO and TIMER555

## Problem statement

Two composite-component goldens in
`src/solver/analog/__tests__/setup-stamp-order.test.ts` mismatch the emitted
TSTALLOC sequence:

- `PB-OPTO TSTALLOC sequence` (test starts at line 1055) — test expects 33
  entries; actual emission is 22.
- `PB-TIMER555 TSTALLOC sequence` (test starts at line 1870) — test expects
  46 entries; actual emission is 35.

In both cases the failure traces to the same root cause: the BJT sub-element
inside each composite emits 9 TSTALLOC entries (the L0 path) where the test
golden expects 20 (the L1-with-grounded-substrate path).

These tests cannot be finalized in isolation. The composite refactor described
in `spec/test-fix-jobs/composite-component-base.md` changes how composite
components enumerate sub-elements and apportion `setup()` order between
device-level and composite-level allocations. The test goldens may shift in
their tail (composite-owned glue handle position) and possibly elsewhere
depending on how the refactor lands.

## Tests that fail (verbatim)

From `src/solver/analog/__tests__/setup-stamp-order.test.ts`:

- `setup-stamp-order > PB-OPTO TSTALLOC sequence` — body lines 1055-1144;
  `expect(order).toEqual([...])` at line 1104.
  Failure message: `expected [ { extRow: 1, extCol: 1 }, …(21) ] to deeply
  equal [ { extRow: 1, extCol: 1 }, …(32) ]` (received 22 / expected 33).

- `setup-stamp-order > PB-TIMER555 TSTALLOC sequence` — body lines 1870-2021;
  `expect(order).toEqual([...])` at line 1964.
  Failure message: `expected [ { extRow: 4, extCol: 4 }, …(34) ] to deeply
  equal [ { extRow: 4, extCol: 4 }, …(45) ]` (received 35 / expected 46).

The 11-entry shortfall in both cases matches exactly: BJT L1 with grounded
substrate emits 20 entries; BJT L0 emits 9; `20 - 9 = 11`. Both composites
contain exactly one BJT sub-element.

## Verified ngspice citations

(These are the per-sub-element citations; the composite goldens are
aggregates.)

### DIO — `ref/ngspice/src/spicelib/devices/dio/diosetup.c:232-238` — 7 entries

| ngspice line | TSTALLOC pair |
|---|---|
| 232 | (DIOposNode, DIOposPrimeNode) |
| 233 | (DIOnegNode, DIOposPrimeNode) |
| 234 | (DIOposPrimeNode, DIOposNode) |
| 235 | (DIOposPrimeNode, DIOnegNode) |
| 236 | (DIOposNode, DIOposNode) |
| 237 | (DIOnegNode, DIOnegNode) |
| 238 | (DIOposPrimeNode, DIOposPrimeNode) |

When `RS = 0`, digiTS aliases `DIOposPrimeNode = DIOposNode` (no internal
node). All 7 calls still record (no ground-guarded calls because both
`DIOposNode` and `DIOnegNode` are non-zero terminals in the OPTO sub-circuit
context).

### VSRC — `ref/ngspice/src/spicelib/devices/vsrc/vsrcset.c:52-55` — 4 entries

| ngspice line | TSTALLOC pair |
|---|---|
| 52 | (VSRCposNode, VSRCbranch) |
| 53 | (VSRCnegNode, VSRCbranch) |
| 54 | (VSRCbranch, VSRCnegNode) |
| 55 | (VSRCbranch, VSRCposNode) |

### CCCS — `ref/ngspice/src/spicelib/devices/cccs/cccsset.c:49-50` — 2 entries

| ngspice line | TSTALLOC pair |
|---|---|
| 49 | (CCCSposNode, CCCScontBranch) |
| 50 | (CCCSnegNode, CCCScontBranch) |

### BJT — `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c:435-464` — 23 calls / 20 recorded

23 calls per the source. With substrate node grounded (digiTS hard-codes
`substNode = 0` per `src/components/semiconductors/bjt.ts:1219`), entries 19,
20, 21 (the three BJTsubstNode-touching pairs) are TrashCan'd by the sparse
solver and not recorded. Recorded count: 20. See
`spec/test-fix-jobs/setup-stamp-order-bjt-ind.md` for the full per-line
breakdown.

### RES — `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49` — 4 entries

| ngspice line | TSTALLOC pair |
|---|---|
| 46 | (RESposNode, RESposNode) |
| 47 | (RESnegNode, RESnegNode) |
| 48 | (RESposNode, RESnegNode) |
| 49 | (RESnegNode, RESposNode) |

### VCVS — `ref/ngspice/src/spicelib/devices/vcvs/vcvsset.c:53-58` — 6 entries (when both ctrl pins and out pins are non-zero)

| ngspice line | TSTALLOC pair |
|---|---|
| 53 | (VCVSposNode, VCVSbranch) |
| 54 | (VCVSnegNode, VCVSbranch) |
| 55 | (VCVSbranch, VCVSposNode) |
| 56 | (VCVSbranch, VCVSnegNode) |
| 57 | (VCVSbranch, VCVScontPosNode) |
| 58 | (VCVSbranch, VCVScontNegNode) |

## Sub-element TSTALLOC inventory (predicted aggregate)

### PB-OPTO (4 sub-elements)

OptocouplerCompositeElement composes (per
`src/components/active/optocoupler.ts:317-355`):

1. dLed (DIO, RS=0): 7 entries
2. vSense (VSRC, 0V sense): 4 entries
3. cccsCouple (CCCS, links vSense branch → BJT base): 2 entries
4. bjtPhoto (BJT NPN, base = internal `nBase`, collector/emitter = external):
   20 entries (with substNode=0 → TrashCan-skipped)

Total: `7 + 4 + 2 + 20 = 33` entries. Matches the test golden.

### PB-TIMER555 (composite, more elements)

Timer555CompositeElement composes (per
`src/components/active/timer-555.ts:478-547`):

1. rDiv1 (RES): 4 entries
2. rDiv2 (RES): 4 entries
3. rDiv3 (RES): 4 entries
4. comp1 (VCVS): 6 entries
5. comp2 (VCVS): 6 entries
6. bjtDis (BJT NPN, B = internal `nDisBase`, C = external DIS, E = external GND):
   20 entries (substNode=0 → TrashCan-skipped)
7. outModel (DigitalOutputPinModel, OUT = external, GND = external):
   1 self-stamp diagonal at OUT
8. CAP children of outModel: 0 entries (cOut=0 default → no caps allocated)
9. Composite-owned RS-FF glue handle: 1 entry at (nDisBase, nDisBase)

Total: `4 + 4 + 4 + 6 + 6 + 20 + 1 + 0 + 1 = 46` entries. Matches the test
golden.

## Expected golden lengths

- PB-OPTO: 33 entries.
- PB-TIMER555: 46 entries.

The test goldens already encode 33 / 46 with the right shape (see test lines
1104-1143 and 1964-2020 respectively). The mismatch is on the production
side.

## Re-record procedure (after composite refactor)

1. Land `spec/test-fix-jobs/composite-component-base.md` first. That spec
   defines how composite components enumerate sub-elements and where the
   composite-owned glue handles get allocated relative to sub-element
   `setup()` calls.

2. Land the BJT model-dispatch fix described in
   `spec/test-fix-jobs/setup-stamp-order-bjt-ind.md`. After that, the BJT
   sub-element inside each composite emits 20 entries instead of 9.

3. In a debugging session, instantiate the composite via its registered
   model factory (`OptocouplerDefinition.modelRegistry["behavioral"].factory`
   for OPTO, `Timer555Definition.modelRegistry["bipolar"].factory` for 555),
   wire up the test's pin Map exactly as the test body does, call
   `engine.init(circuit); (engine as any)._setup();`, then read
   `(engine as any)._solver._getInsertionOrder()`.

4. Validate the count against the per-sub-element ngspice citations:
   - OPTO: `7 (DIO) + 4 (VSRC) + 2 (CCCS) + 20 (BJT)` = 33.
   - TIMER555: `3×4 (RES) + 2×6 (VCVS) + 20 (BJT) + 1 (outModel) + 0 (caps) +
     1 (RS-FF glue) = 46`.

5. Paste back into the test, with one comment per entry tying it to the
   originating ngspice file:line. The current goldens already do this — the
   re-record should preserve those comments and only update entries whose
   `extRow` / `extCol` shifted under the refactor.

## Category

`contract-update`, with hard dependency on `composite-component-base.md`.

The PB-OPTO and PB-TIMER555 goldens themselves are correct for the
ngspice-faithful contract. They cannot land independently because:

1. The composite-component-base refactor may shift the composite-owned glue
   handle's position (currently at the very end of the TSTALLOC sequence per
   PB-TIMER555 line 2019; the refactor may move it).

2. The BJT sub-element fix (`setup-stamp-order-bjt-ind.md`) must land before
   the composite emissions can match the goldens. Without that fix, both
   composites are 11 entries short.

Calling this `contract-update` rather than `architecture-fix` because the
test goldens are already the canonical contract. The architectural work is
elsewhere (BJT model dispatch + composite-base refactor); once both land,
this test passes by virtue of its already-correct goldens, modulo any
glue-handle reshuffles the refactor introduces.

## Dependencies

1. `spec/test-fix-jobs/composite-component-base.md` — composite-base refactor
   must land first. The TSTALLOC ordering between sub-elements is governed
   by `getSubElements()` order (currently NGSPICE_LOAD_ORDER ascending, per
   each composite's `setup()` body); the refactor must preserve that or the
   goldens lose their first-principles ngspice mapping.

2. `spec/test-fix-jobs/setup-stamp-order-bjt-ind.md` — BJT model dispatch
   fix must land first or in the same wave. Without it, the BJT
   sub-element in each composite emits 9 entries (L0) instead of 20 (L1
   with grounded substrate).

## Tensions / uncertainties

1. **DigitalOutputPinModel emission count.** The PB-TIMER555 golden line
   2017 records exactly one entry from `outModel`: `(extRow: 6, extCol: 6)`,
   the OUT diagonal. This is consistent with `DigitalOutputPinModel.setup()`
   allocating one self-diagonal and no other entries when `nOut > 0` and the
   default `cOut = 0` skips the capacitor child. Need to verify by reading
   `src/solver/analog/digital-pin-model.ts:setup()`. If `setup()` allocates
   more entries (e.g. an internal node + diagonal) the predicted count
   shifts. **Verify before re-recording.**

2. **Capacitor child elements.** The `Timer555CompositeElement.collectPinModelChildren`
   call returns child `AnalogCapacitorElement` instances. With `cOut = 0`
   (Timer555 factory line 739), the output pin model creates zero capacitor
   children. Confirm that `collectPinModelChildren` returns an empty array
   when `cOut === 0`; otherwise the predicted count for PB-TIMER555 rises by
   `4 × (number of cap children)`.

3. **Composite-base refactor scope on getSubElements.** The current
   composites both override `getSubElements()` to return sub-elements in
   `setup()` order (matching NGSPICE_LOAD_ORDER ascending). If the refactor
   changes that contract (e.g. requires alphabetical, or external-pin order),
   the TSTALLOC sequence of every composite test in this file changes. Need
   to know the refactor's `getSubElements()` invariant before pinning these
   goldens.

4. **TIMER555 has model variants (`bipolar` and `cmos`).** Both call the
   same factory `createTimer555Element`, but the `cmos` variant changes
   `vDrop` from 1.5 to 0.1. The TSTALLOC list does not depend on `vDrop`
   (it only affects load() RHS), so the golden length is the same for both
   variants. The PB-TIMER555 test pins the `bipolar` model explicitly (test
   line 1941: `Timer555Definition.modelRegistry!["bipolar"]!`), which is
   correct.

5. **OPTO has a single behavioral model.** The factory is non-dispatching
   on model. No tension here, but if a future user-introduced opto model
   variant changes the BJT level (e.g. uses L0 photo-transistor), the
   golden changes. Re-record post-refactor.

6. **TrashCan recording invariant.** This whole spec depends on the
   `SparseSolver._insertionOrder` skipping ground-row / ground-column
   allocations. Verified at `src/solver/analog/sparse-solver.ts:412-418`
   (the user prompt's "spbuild.c:272-273" reference confirms the ngspice
   semantics). If that invariant ever changes, every test in
   `setup-stamp-order.test.ts` shifts.
