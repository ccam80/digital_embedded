# harness-comparison-matrix-divergence

## Problem statement

`assertIterationMatch` (parity-helpers.ts:50-205) reports five matrix-entry
divergences between digiTS and ngspice. The matrix-entry block
(parity-helpers.ts:333-372) pairs entries by `(row, col)` after skipping
ground row/col (`row === 0 || col === 0`) — that skip is documented as the
ngspice TrashCan convention (parity-helpers.ts:340-345) and is the only
permitted asymmetry. Every other paired cell must satisfy
`absDelta === 0`.

The five reported failures are described in the task as "5 matrix-entry
divergences" without (row, col) coordinates. The investigation below
documents how to extract those coordinates from the harness so a downstream
agent can categorise each one.

## Sites

- Test harness comparator:
  `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\ngspice-parity\parity-helpers.ts:333-372`
  (`_assertMatrixMatch`).
- Comparison driver:
  `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\harness\comparison-session.ts`.
- Snapshot recorder:
  `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\harness\capture.ts`.
- Per-iteration matrix is captured by digiTS at the post-load, pre-LU
  point (so the harness compares matched stamping outputs, not factored
  matrices).
- ngspice-side capture is at `ref/ngspice/src/maths/ni/niiter.c:684-844`
  (CSC snapshot built into `ni_mxColPtr` / `ni_mxRowIdx` / `ni_mxVals`).

## Investigation procedure

The five `(row, col, ours, ngspice)` tuples must be pulled from the harness.
The procedure:

### Step 1 — Run the failing parity test in matrix-walking mode

Replace the loop's first `assertIterationMatch` call (in any one of the
four parity-helpers test files) with the matrix-only check from
parity-helpers.ts:333-372 inlined into the test, dumping every divergence
to stdout instead of throwing on the first:

```ts
import { ComparisonSession } from "../harness/comparison-session.js";
const session = new ComparisonSession({ dtsPath, dllPath: DLL_PATH });
await session.init();
await session.runDcOp();

const ours = session.ourSession;
const ngspice = session.ngspiceSessionAligned ?? session.ngspiceSession;

for (let si = 0; si < ours.steps.length; si++) {
  const ourStep = ours.steps[si], ngStep = ngspice.steps[si];
  for (let ai = 0; ai < ourStep.attempts.length; ai++) {
    const ourAttempt = ourStep.attempts[ai], ngAttempt = ngStep.attempts[ai];
    for (let ii = 0; ii < ourAttempt.iterations.length; ii++) {
      const o = ourAttempt.iterations[ii], n = ngAttempt.iterations[ii];
      const ngByCell = new Map<string, number>();
      for (const e of n.matrix) {
        if (e.row === 0 || e.col === 0) continue;
        ngByCell.set(`${e.row},${e.col}`, e.value);
      }
      const ourByCell = new Map<string, number>();
      for (const e of o.matrix) {
        if (e.row === 0 || e.col === 0) continue;
        ourByCell.set(`${e.row},${e.col}`, e.value);
      }
      const allCells = new Set([...ourByCell.keys(), ...ngByCell.keys()]);
      for (const cell of allCells) {
        const ourVal = ourByCell.get(cell);
        const ngVal = ngByCell.get(cell);
        if (ourVal === undefined) {
          console.log(`MISSING-OURS si=${si} ai=${ai} ii=${ii} cell=${cell} ng=${ngVal}`);
        } else if (ngVal === undefined) {
          console.log(`MISSING-NG    si=${si} ai=${ai} ii=${ii} cell=${cell} ours=${ourVal}`);
        } else if (Math.abs(ourVal - ngVal) !== 0) {
          console.log(`DIVERGE       si=${si} ai=${ai} ii=${ii} cell=${cell} ours=${ourVal} ng=${ngVal} delta=${Math.abs(ourVal - ngVal)}`);
        }
      }
    }
  }
}
```

The five entries the task names should print as `DIVERGE` lines. If any
print as `MISSING-*`, those are structural divergences (one engine stamps
into a row/col the other doesn't) and they are categorised differently
(see below).

### Step 2 — Map (row, col) to (device, terminal pair)

The harness records matrix row/col labels:
`comparison-session.ts:797-810` shows `ourTopology.matrixRowLabels` and
`matrixColLabels` mapping numeric row to a label like `"R1.A→R1.B"` or a
node name. Use them:

```ts
const labels = session.ourSession.topology.matrixRowLabels; // Map<number, string>
console.log(`row ${row} = ${labels.get(row)}`);
```

For diagonal entries (`row === col`), the cell holds the sum of all
self-conductances stamped into that node. For off-diagonals, the cell
holds the bilateral coupling (negative conductance from one device's
contribution).

### Step 3 — Trace each divergent cell back to a device-load callsite

For every reported (row, col), the contributing devices are those whose
`load()` allocated a stamp handle for that cell pair via
`solver.allocElement(row, col)`. Grep for `allocElement` in the production
code and read those device's load functions.

| Likely cell | Producing device class | Production file |
|---|---|---|
| Diagonal at a diode anode-prime node | `createDiodeElement` (`_hPPPP`) | `src\components\semiconductors\diode.ts:521` |
| Diagonal at a BJT base-prime node | `createSpiceL1BjtElement` | `src\components\semiconductors\bjt.ts` |
| Diagonal at a MOSFET drain-prime node | `createSpiceL1MosfetElement` | `src\components\semiconductors\mosfet.ts` |
| Diagonal at a capacitor terminal | capacitor `load()` (geq*ag0 stamp) | `src\components\passives\capacitor.ts` |
| Branch-row coupling (V-source) | `makeDcVoltageSource.load()` | `src\components\sources\dc-voltage-source.ts` |

Then read the corresponding ngspice file (per the citation table in
`dc-op-parity-divergence.md`) and compare the stamp formulas.

### Step 4 — Classify

For each of the five divergences, the answer is one of:

- **Structural mismatch** (`MISSING-OURS` / `MISSING-NG`): one engine stamps
  into a cell the other does not. This is `architecture-fix`. Common
  causes:
  - digiTS missing a stamp that ngspice has (e.g., a series-resistance arm
    of a BJT not allocated in setup).
  - ngspice missing a stamp digiTS has (e.g., digiTS allocates a stamp for a
    pin that's wired to ground; ngspice routes that to TrashCan, but the
    harness's row/col=0 skip is supposed to catch this — investigate).
- **Value divergence at the few-ULP scale** (delta in 1e-16 to 1e-13 band
  for cells of order 1e-3 to 1e+3): single-cell FP ordering inside one
  device's load body. Category: `few-ULP`. Fix: reorder the additions in
  the digiTS device's `load()` to match ngspice's statement order
  byte-for-byte.
- **Value divergence at larger scale**: `architecture-fix`. Fix: identify
  the missing/wrong contribution in the digiTS load body.

## Verified ngspice citations

For each row/col category in §Step 3, here are the verified ngspice
sites:

- **Diode load matrix stamps**:
  `ref/ngspice/src/spicelib/devices/dio/dioload.c:435-441` — verified.
  Stamps: `DIOposPosPtr += gspr`, `DIOnegNegPtr += gd`,
  `DIOposPrimePosPrimePtr += (gd + gspr)`, `DIOposPosPrimePtr -= gspr`,
  `DIOnegPosPrimePtr -= gd`, `DIOposPrimePosPtr -= gspr`,
  `DIOposPrimeNegPtr -= gd`. RHS at lines 429-431.
- **Diode three-region IV**:
  `dioload.c:245-265` (forward / reverse-cubic / breakdown).
- **GMIN injection inside dioload**:
  `dioload.c:290-314` — verified. `gd = gd + ckt->CKTgmin; cd = cd +
  CKTgmin*vd`.
- **NIiter pre-LU snapshot CSC layout**:
  `niiter.c:684-844` — verified. Note line 706-720 documents the
  `CKTmaxEqNum` vs `AllocatedSize` mismatch caused by ground-route
  TrashCan stamps; the snapshot iterates only `[1, min(CKTmaxEqNum+1,
  AllocatedSize+1))`.

## Per-divergence categorisation

Cannot be done from this spec alone — depends on the (row, col, ours,
ngspice) tuples that come out of Step 1. The shape is:

| Divergence # | Likely class (after Step 1-2) |
|---|---|
| 1-5 | TBD by downstream investigator using the procedure above |

A rule of thumb: structural mismatches (one-sided cells) are always
`architecture-fix`. Value mismatches in the 1e-16 to 1e-13 absolute range
on a cell of magnitude 1 are candidates for `few-ULP`; anything larger is
`architecture-fix`.

## Recommendation

The default classification is **`architecture-fix`**. Reasoning:

1. ngspice device load functions are the spec (per `CLAUDE.md` "SPICE-Correct
   Implementations Only"). Any digiTS divergence in stamp values is
   prima-facie a digiTS bug.
2. `few-ULP` is allowed only when the divergence is in a single
   accumulation-order rearrangement on one cell, and only when the spec
   explicitly tolerates it. CLAUDE.md does not.

If after Step 1-2 a divergence is shown to be a single-cell, ULP-scale
ordering disagreement that ngspice itself is order-sensitive about, that
specific divergence becomes `few-ULP` and the fix is to copy the ngspice
addition order exactly.

## Category

**`architecture-fix`** (default; per-divergence reclassification possible
after the (row, col) coordinates are pulled).

## Tensions / uncertainties

1. **The "×5" framing assumes 5 distinct cells.** If the same divergent
   cell appears in 5 successive iterations of the same step, the count
   reflects iterations not cells. The harness reports per-iteration so the
   shape is ambiguous from the task description alone.

   **`[ESCALATE: needs user clarification on whether ×5 means five
   distinct (row, col) pairs or five iteration occurrences of one or more
   pairs.]`**

2. **TrashCan-routed stamps may bypass the harness's matrix capture.**
   ngspice routes ground-touching stamps into `TrashCan` (one slot for all
   ground rows/cols). The harness skips row/col 0 entirely
   (parity-helpers.ts:344-345). If a digiTS stamp lands on row 0 of the
   sparse solver but the corresponding ngspice stamp lands in TrashCan,
   the harness will not see the divergence — but if a digiTS stamp lands
   on row 1 (a real node) and ngspice routes the same physical stamp into
   TrashCan because the node is wired to ground in the netlist, the
   harness will see the digiTS-side stamp as `MISSING-NG`. That's a
   `contract-update` against the test's row/col=0 skip OR an
   `architecture-fix` against digiTS' use of ground routing — needs a
   decision.

   **`[ESCALATE: needs user decision on whether ground-routing semantics
   should be a project-wide architectural alignment item.]`**

3. **`comparison-session.ts:_assertMatrixStructuralParity()` runs after
   `runDcOp()` / `runTransient()`.** If structural parity fails (different
   matrix dimension, different row labels), the per-iteration assertion
   never runs. A "matrix-entry divergence" at that level is a different
   kind of failure (label mismatch, not value mismatch).

   **`[ESCALATE: confirm via Step 1 console output whether the structural
   assertion fires first or whether the divergences are genuinely value
   divergences on paired cells.]`**
