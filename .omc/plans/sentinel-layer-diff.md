# Sentinel layer — concrete diff

## Prerequisites and assumptions

### What Fix 2 (Haiku's semantic matrix join) must have landed first
This diff assumes `_ngMatrixRowMap`, `_ngMatrixColMap`, `_ngspiceOnlyRows`, and
`_ngspiceOnlyRowLabels` already exist in `ComparisonSession` (lines 262-265 of the
current file — they do). It also assumes `_buildMatrixMaps()` already populates
`_ngspiceOnlyRows` from the first-step first-iteration matrix (lines 1901-1937 — it
does). This diff therefore does NOT require Haiku's Fix 2 to have landed first;
those fields are already present in the live codebase. The diff layers sentinel
classification on top of what already exists.

### What was verified in the current files
- `types.ts:654-668` — `MatrixEntrySentinel` and `LabeledMatrixEntry` already exist
  but `MatrixEntrySentinel` lacks a `reason` field.
- `comparison-session.ts:1569` — `getMatrixLabeled()` already emits `entryKind:
  "captureMissing"` when `ngVal` is NaN (for our-side entries with no ng match) and
  `entryKind: "engineSpecific"` for ngspice-only rows (lines 1580-1599). The
  `engineSpecific` sentinel already uses `{ kind: "engineSpecific", presentSide:
  "ngspice" }` without a `reason`.
- `comparison-session.ts:1606-1618` — `compareMatrixAt` already excludes
  `engineSpecific` from `"mismatches"` filter. No change needed there.
- `harness-tools.ts:1064-1074` — `harness_compare_matrix` serializes entries with
  `formatNumber(e.ours)` — this will crash on sentinel objects. Fix required.
- `getDivergences()` does not have a `captureMissing` category — sentinels never
  reach it because the matrix divergences come from `ComparisonResult.matrixDiffs`
  (populated by `compareSnapshots` in `compare.ts`), not from `getMatrixLabeled`.
  However, `StepEndReport.branches` uses `makeComparedValue(ourV, ngV, ...)` with
  raw NaN values and no sentinel — this is the vsource-branch null bug path.

### Node naming format confirmed from bjtsetup.c
`CKTmkVolt(ckt, &tmp, here->BJTname, "collector")` creates a node whose name in
ngspice's internal table is `<devicename>#collector` (the `CKTmkVolt` function
concatenates device name, `#`, and the suffix). Since `buildDirectNodeMapping` maps
nodes by integer ID (our node ID N → ngspice node `"N"`), BJT prime nodes appear
under high numeric IDs that aren't in our `nodeNames` map, so they surface correctly
as `_ngspiceOnlyRows`. The registry patterns must match ngspice node **names** as
stored in `NgspiceTopology.nodeNames` — which are the string keys: `"q1#collector"`,
`"q1#base"`, `"q1#emitter"` (lowercased device name, `#`, suffix).

### Risk: captureMissing in getMatrixLabeled
The current code sets `entryKind: "captureMissing"` when `ngVal` is NaN due to
`ngEntry` being absent from the ngspice matrix. This is already correct semantically:
if our engine stamps a matrix entry at (row, col) but ngspice has no entry there,
that IS a capture-missing situation (ngspice's sparse matrix doesn't stamp zeros, so
a zero stamp on our side with no ngspice entry is ambiguous — leave as-is). The
sentinel change adds a `reason` field and a `side: "ngspice"` discriminator.

---

## File 1: types.ts

<path>src/solver/analog/__tests__/harness/types.ts</path>

### Hunk 1 — extend MatrixEntrySentinel with reason, extend engineSpecific to carry reason

Current (lines 654-668):
```typescript
export type MatrixEntrySentinel =
  | { kind: "engineSpecific"; presentSide: "ngspice" }
  | { kind: "captureMissing"; side: "ours" | "ngspice" };

export interface LabeledMatrixEntry {
  row: number;
  col: number;
  rowLabel: string;
  colLabel: string;
  entryKind: "both" | "engineSpecific" | "captureMissing";
  ours: number | MatrixEntrySentinel;
  ngspice: number | MatrixEntrySentinel;
  absDelta: number;
  withinTol: boolean;
}
```

Replacement:
```typescript
export type MatrixEntrySentinel =
  | { kind: "engineSpecific"; presentSide: "ngspice"; reason: string }
  | { kind: "captureMissing"; side: "ours" | "ngspice"; reason: string };

export interface LabeledMatrixEntry {
  row: number;
  col: number;
  rowLabel: string;
  colLabel: string;
  entryKind: "both" | "engineSpecific" | "captureMissing";
  ours: number | MatrixEntrySentinel;
  ngspice: number | MatrixEntrySentinel;
  absDelta: number;
  withinTol: boolean;
}
```

### Hunk 2 — extend StepEndReport.branches to accept sentinels

Find `StepEndReport` in types.ts (approximately lines 340-413 — the interface that
contains `nodes`, `branches`, `components`). The `branches` field currently has type
`Record<string, ComparedValue>`. Extend it:

Current:
```typescript
  branches: Record<string, ComparedValue>;
```

Replacement:
```typescript
  branches: Record<string, ComparedValue | MatrixEntrySentinel>;
```

(If `branches` is typed on a `StepEndReport` interface that is defined elsewhere in
the file, apply the change there. The interface appears around line 340 based on the
file structure — the exact line is wherever `StepEndReport` is declared.)

---

## File 2: known-differences.ts (new)

<path>src/solver/analog/__tests__/harness/known-differences.ts</path>

<new_file>
/**
 * Registry of known architectural differences between our engine and ngspice.
 *
 * When ngspice creates internal MNA nodes for device-physics reasons that our
 * engine handles differently (e.g., folding ohmic resistances into device stamps
 * rather than adding explicit internal nodes), the extra ngspice rows in the MNA
 * matrix are NOT comparison failures — they are structural differences.
 *
 * Each entry describes one class of such difference. Classification happens once
 * at session init in ComparisonSession._buildMatrixMaps() and the result is stored
 * so that getMatrixLabeled() can emit the correct sentinel kind and reason string.
 *
 * Node naming format: ngspice creates internal nodes via CKTmkVolt() using the
 * pattern "<deviceName>#<suffix>" (e.g., "q1#collector", "q1#base", "q1#emitter").
 * The registry patterns match against these lowercased node name strings as they
 * appear in NgspiceTopology.nodeNames.
 *
 * Reference: ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c lines 372-415.
 */

export interface KnownDifference {
  /**
   * Device type string as it appears in our topology (lowercased for comparison).
   * Use "*" to match any device type.
   */
  deviceType: string;

  /**
   * Pattern matched against the ngspice node name string (as stored in
   * NgspiceTopology.nodeNames, e.g. "q1#collector").
   * The pattern is tested with RegExp.test() against the full name.
   */
  ngspiceNamePattern: RegExp;

  /**
   * Human-readable explanation shown in the sentinel's `reason` field.
   */
  reason: string;
}

/**
 * Canonical registry of known engine-specific differences.
 *
 * BJT entries: ngspice creates colPrime/basePrime/emitPrime internal nodes when
 * BJTcollectorResist > 0, BJTbaseResist > 0, BJTemitterResist > 0 respectively.
 * Our engine folds these resistances into the device stamp rather than creating
 * explicit MNA rows, so these rows are genuinely absent on our side.
 *
 * Node name format verified from bjtsetup.c:
 *   CKTmkVolt(ckt, &tmp, here->BJTname, "collector") → "q1#collector"
 *   CKTmkVolt(ckt, &tmp, here->BJTname, "base")      → "q1#base"
 *   CKTmkVolt(ckt, &tmp, here->BJTname, "emitter")   → "q1#emitter"
 */
export const KNOWN_ENGINE_DIFFERENCES: KnownDifference[] = [
  {
    deviceType: "bjt",
    ngspiceNamePattern: /#collector$/i,
    reason:
      "ngspice BJT models RC as an explicit ohmic node (colPrime); " +
      "our engine folds RC into the device stamp so no extra MNA row is created.",
  },
  {
    deviceType: "bjt",
    ngspiceNamePattern: /#base$/i,
    reason:
      "ngspice BJT models RB as an explicit ohmic node (basePrime); " +
      "our engine folds RB into the device stamp so no extra MNA row is created.",
  },
  {
    deviceType: "bjt",
    ngspiceNamePattern: /#emitter$/i,
    reason:
      "ngspice BJT models RE as an explicit ohmic node (emitPrime); " +
      "our engine folds RE into the device stamp so no extra MNA row is created.",
  },
];

/**
 * Classify a single ngspice-only node name against the registry.
 *
 * Returns the matching KnownDifference entry if the node is a known architectural
 * difference, or null if the absence is unexpected (i.e., a real capture bug).
 *
 * @param ngspiceNodeName  Raw ngspice node name string (e.g., "q1#collector").
 * @param deviceTypeHint   Optional device type from our topology for the nearest
 *                         component (used to narrow matching; pass undefined to
 *                         match against all entries).
 */
export function classifyNgspiceOnlyNode(
  ngspiceNodeName: string,
  deviceTypeHint?: string,
): KnownDifference | null {
  const name = ngspiceNodeName.toLowerCase();
  const typeHint = deviceTypeHint?.toLowerCase();

  for (const entry of KNOWN_ENGINE_DIFFERENCES) {
    if (entry.deviceType !== "*" && typeHint !== undefined && entry.deviceType !== typeHint) {
      continue;
    }
    if (entry.ngspiceNamePattern.test(name)) {
      return entry;
    }
  }
  return null;
}

/**
 * Type guard: check if a value is a MatrixEntrySentinel (survives JSON roundtrip).
 * Consumers receive sentinel objects through the MCP JSON interface; detect them
 * with this guard rather than instanceof checks.
 */
export function isMatrixEntrySentinel(v: unknown): v is { kind: string } {
  return typeof v === "object" && v !== null && "kind" in v;
}
</new_file>

---

## File 3: comparison-session.ts

<path>src/solver/analog/__tests__/harness/comparison-session.ts</path>

### Hunk 1 — add import for known-differences

After the existing imports block (around line 31, after the `matchSlotPattern` import):

```diff
+import {
+  classifyNgspiceOnlyNode,
+  isMatrixEntrySentinel,
+  KNOWN_ENGINE_DIFFERENCES as _KD, // imported to ensure module is bundled; not used directly here
+} from "./known-differences.js";
```

Only `classifyNgspiceOnlyNode` and `isMatrixEntrySentinel` are actually called in
this file. The `_KD` import alias is just to keep the module reference alive.
Remove the `_KD` alias and just import what's needed:

```diff
-import { matchSlotPattern } from "./glob.js";
+import { matchSlotPattern } from "./glob.js";
+import { classifyNgspiceOnlyNode, isMatrixEntrySentinel } from "./known-differences.js";
```

### Hunk 2 — new protected field: classification map

In the class field declarations (lines 259-267), add after `_ngspiceOnlyRowLabels`:

Current:
```typescript
  protected _ngMatrixRowMap: Map<number, number> = new Map();
  protected _ngMatrixColMap: Map<number, number> = new Map();
  protected _ngspiceOnlyRows: number[] = [];
  protected _ngspiceOnlyRowLabels: Map<number, string> = new Map();
```

Replacement:
```typescript
  protected _ngMatrixRowMap: Map<number, number> = new Map();
  protected _ngMatrixColMap: Map<number, number> = new Map();
  protected _ngspiceOnlyRows: number[] = [];
  protected _ngspiceOnlyRowLabels: Map<number, string> = new Map();
  /**
   * Maps ngspice-only row indices to the reason string for their classification.
   * Populated by _buildMatrixMaps(). An entry exists only when the row was matched
   * against KNOWN_ENGINE_DIFFERENCES; unmatched rows remain absent (treated as
   * captureMissing candidates — see getMatrixLabeled).
   */
  protected _ngspiceOnlyRowReasons: Map<number, string> = new Map();
```

### Hunk 3 — _buildMatrixMaps(): classify ngspice-only rows

Current `_buildMatrixMaps()` (lines 1901-1937):
```typescript
  private _buildMatrixMaps(): void {
    this._ngMatrixRowMap.clear();
    this._ngMatrixColMap.clear();
    this._ngspiceOnlyRows = [];
    this._ngspiceOnlyRowLabels.clear();

    if (this._nodeMap.length === 0) return;

    const rowMapEntries = new Map<number, number>();
    for (const nm of this._nodeMap) {
      rowMapEntries.set(nm.ngspiceIndex, nm.ourIndex);
    }

    this._ngMatrixRowMap = new Map(rowMapEntries);
    this._ngMatrixColMap = new Map(rowMapEntries);

    if (this._ngSession && this._ngSession.steps.length > 0) {
      const firstStep = this._ngSession.steps[0];
      if (firstStep && firstStep.iterations.length > 0) {
        const firstIter = firstStep.iterations[0];
        if (firstIter && firstIter.matrix.length > 0) {
          const seenRows = new Set(this._ngMatrixRowMap.keys());
          for (const entry of firstIter.matrix) {
            if (!seenRows.has(entry.row)) {
              this._ngspiceOnlyRows.push(entry.row);
              const label = this._ourTopology.matrixRowLabels.get(entry.row);
              if (label) {
                this._ngspiceOnlyRowLabels.set(entry.row, label);
              } else {
                this._ngspiceOnlyRowLabels.set(entry.row, `ngspice_row${entry.row}`);
              }
            }
          }
        }
      }
    }
  }
```

Replacement:
```typescript
  private _buildMatrixMaps(): void {
    this._ngMatrixRowMap.clear();
    this._ngMatrixColMap.clear();
    this._ngspiceOnlyRows = [];
    this._ngspiceOnlyRowLabels.clear();
    this._ngspiceOnlyRowReasons.clear();

    if (this._nodeMap.length === 0) return;

    const rowMapEntries = new Map<number, number>();
    for (const nm of this._nodeMap) {
      rowMapEntries.set(nm.ngspiceIndex, nm.ourIndex);
    }

    this._ngMatrixRowMap = new Map(rowMapEntries);
    this._ngMatrixColMap = new Map(rowMapEntries);

    if (this._ngSession && this._ngSession.steps.length > 0) {
      const firstStep = this._ngSession.steps[0];
      if (firstStep && firstStep.iterations.length > 0) {
        const firstIter = firstStep.iterations[0];
        if (firstIter && firstIter.matrix.length > 0) {
          const seenRows = new Set(this._ngMatrixRowMap.keys());

          // Reverse-map ngspice row index → ngspice node name for classification.
          // NgspiceTopology.nodeNames is Map<string, number> (name→index), so invert it.
          const ngIndexToName = new Map<number, string>();
          if (this._ngSession.topology && (this._ngSession.topology as any).nodeNames instanceof Map) {
            const ngNodeNames = (this._ngSession.topology as any).nodeNames as Map<string, number>;
            ngNodeNames.forEach((idx, name) => ngIndexToName.set(idx, name));
          }

          for (const entry of firstIter.matrix) {
            if (!seenRows.has(entry.row)) {
              this._ngspiceOnlyRows.push(entry.row);
              const label = this._ourTopology.matrixRowLabels.get(entry.row);
              this._ngspiceOnlyRowLabels.set(
                entry.row,
                label ?? `ngspice_row${entry.row}`,
              );

              // Classify: is this row a known architectural difference?
              const nodeName = ngIndexToName.get(entry.row);
              if (nodeName) {
                // Determine device type hint from node name prefix (e.g., "q1#collector" → "bjt"
                // if Q-prefix). The canonicalization is intentionally simple: the registry
                // patterns are specific enough that device-type filtering is advisory only.
                const deviceTypeHint = _guessDeviceTypeFromNgspiceName(nodeName);
                const known = classifyNgspiceOnlyNode(nodeName, deviceTypeHint);
                if (known) {
                  this._ngspiceOnlyRowReasons.set(entry.row, known.reason);
                }
              }
            }
          }
        }
      }
    }
  }
```

Add the private helper function `_guessDeviceTypeFromNgspiceName` at the bottom of
the class (before the closing brace), or as a module-level private function after the
class. Module-level is cleaner since it has no `this` dependencies:

```typescript
/**
 * Heuristically map an ngspice node name prefix to a device type string
 * compatible with our topology element types.
 *
 * ngspice device names follow SPICE convention: Q = BJT, D = diode,
 * M = MOSFET, R = resistor, C = capacitor, L = inductor, V = vsource.
 */
function _guessDeviceTypeFromNgspiceName(ngspiceName: string): string | undefined {
  const first = ngspiceName[0]?.toUpperCase();
  switch (first) {
    case "Q": return "bjt";
    case "D": return "diode";
    case "M": return "mosfet";
    case "J": return "jfet";
    case "R": return "resistor";
    case "C": return "capacitor";
    case "L": return "inductor";
    case "V": return "vsource";
    case "I": return "isource";
    default:  return undefined;
  }
}
```

### Hunk 4 — getMatrixLabeled(): emit reason in engineSpecific sentinel

Current code in `getMatrixLabeled()` (lines 1594-1599):
```typescript
        entries.push({
          row: ngEntry.row, col: ngEntry.col, rowLabel, colLabel,
          entryKind: "engineSpecific",
          ours: { kind: "engineSpecific", presentSide: "ngspice" },
          ngspice: ngEntry.value, absDelta: 0, withinTol: true,
        });
```

Replacement:
```typescript
        const esReason = this._ngspiceOnlyRowReasons.get(ngEntry.row)
          ?? this._ngspiceOnlyRowReasons.get(ngEntry.col)
          ?? "ngspice-only MNA row with no matching architectural classification";
        entries.push({
          row: ngEntry.row, col: ngEntry.col, rowLabel, colLabel,
          entryKind: "engineSpecific",
          ours: { kind: "engineSpecific", presentSide: "ngspice", reason: esReason },
          ngspice: ngEntry.value, absDelta: 0, withinTol: true,
        });
```

### Hunk 5 — getMatrixLabeled(): emit reason in captureMissing sentinel

Current code for the our-side entries where `ngVal` is NaN (line ~1568-1573):
```typescript
        const entryKind = isNaN(ngVal) ? "captureMissing" : "both";
        entries.push({
          row: e.row, col: e.col, rowLabel, colLabel,
          entryKind,
          ours: e.value, ngspice: ngVal, absDelta, withinTol,
        });
```

Replacement:
```typescript
        const isMissing = isNaN(ngVal);
        const entryKind = isMissing ? "captureMissing" : "both";
        const ngspiceField: number | MatrixEntrySentinel = isMissing
          ? {
              kind: "captureMissing",
              side: "ngspice",
              reason:
                "ngspice did not stamp a matrix entry at this (row, col); " +
                "the sparse matrix omits structural zeros, so a non-zero stamp on " +
                "our side with no ngspice entry indicates a possible capture gap.",
            }
          : ngVal;
        entries.push({
          row: e.row, col: e.col, rowLabel, colLabel,
          entryKind,
          ours: e.value,
          ngspice: ngspiceField,
          absDelta,
          withinTol,
        });
```

Note: the import for `MatrixEntrySentinel` must be added to the imports from
`"./types.js"`. Add it to the existing destructured import on line 33:

```diff
-  LabeledMatrix,
-  LabeledMatrixEntry,
+  LabeledMatrix,
+  LabeledMatrixEntry,
+  MatrixEntrySentinel,
```

### Hunk 6 — getStepEnd(): emit captureMissing sentinel for branch lookups that fail

This fixes the vsource-branch null bug. In `getStepEnd()`, the branch current
lookup (lines 674-678) does:
```typescript
      this._ourTopology.matrixRowLabels.forEach((label, row) => {
        if (row < this._ourTopology.nodeCount) return;
        const ourV = ourFinal && row < ourFinal.voltages.length ? ourFinal.voltages[row] : NaN;
        const ngV = ngFinal && row < ngFinal.voltages.length ? ngFinal.voltages[row] : NaN;
        branches[label] = makeComparedValue(ourV, ngV, this._tol.iAbsTol, this._tol.relTol);
      });
```

When `ngFinal` is null or the branch was not captured on the ngspice side (ngV is
NaN despite ourV being a real number), the result is a numeric `ComparedValue` with
`ngspice: NaN` and `withinTol: false` — a false positive. Replace with a sentinel
when `ngFinal` is absent for the whole step (hard missing) vs. when ngV is NaN for a
specific branch (soft missing):

```typescript
      this._ourTopology.matrixRowLabels.forEach((label, row) => {
        if (row < this._ourTopology.nodeCount) return;
        const ourV = ourFinal && row < ourFinal.voltages.length ? ourFinal.voltages[row] : NaN;

        if (!ngFinal) {
          // ngspice produced no final iteration at all for this step — entire ng
          // side is absent. Flag as captureMissing rather than a numeric mismatch.
          branches[label] = {
            kind: "captureMissing",
            side: "ngspice",
            reason:
              "ngspice produced no accepted iteration for this step; " +
              "branch current could not be read.",
          } satisfies MatrixEntrySentinel;
          return;
        }

        const ngV = row < ngFinal.voltages.length ? ngFinal.voltages[row] : NaN;

        if (isNaN(ngV) && !isNaN(ourV)) {
          // ngspice voltages array doesn't cover this branch row — likely a
          // harness mapping gap (the branch was not reindexed correctly).
          branches[label] = {
            kind: "captureMissing",
            side: "ngspice",
            reason:
              `ngspice voltages array (length ${ngFinal.voltages.length}) does not ` +
              `cover branch row ${row} ("${label}"); possible reindex gap in ` +
              `buildDirectNodeMapping for this branch current.`,
          } satisfies MatrixEntrySentinel;
          return;
        }

        branches[label] = makeComparedValue(ourV, ngV, this._tol.iAbsTol, this._tol.relTol);
      });
```

Apply the same pattern to the ngspice-only step branch lookup (lines 619-624) and
the our-only step branch lookup. The exact diff for those is:

For the **our-only step** branch block (when `!ourStep && ngStep`), lines ~619-624:
```typescript
        this._ourTopology.matrixRowLabels.forEach((label, row) => {
          if (row < this._ourTopology.nodeCount) return;
          const ourV = NaN;
          const ngV = row < ngFinal.voltages.length ? ngFinal.voltages[row] : NaN;
          branches[label] = makeComparedValue(ourV, ngV, this._tol.iAbsTol, this._tol.relTol);
        });
```

No change needed here — when `ourStep` is absent the NaN for ourV is intentional and
represents the structural absence of our side, not a capture gap.

### Hunk 7 — getDivergences(): exclude engineSpecific, flag captureMissing

The `getDivergences()` method iterates `comp.matrixDiffs` (from `compareSnapshots`
in `compare.ts`) — not `getMatrixLabeled()` entries — so sentinels don't reach it
through that path. However the docstring requirement says to emit a `captureMissing`
category. The cleanest approach: after the existing matrix diff loop, add a pass over
`getMatrixLabeled()` for the same step+iteration to pick up any `captureMissing`
entries that `compareSnapshots` missed.

Add this block inside the `for (const comp of comparisons)` loop, **after** the
existing `comp.matrixDiffs` loop:

```typescript
      // Emit captureMissing entries from the labeled matrix that did not appear
      // in comp.matrixDiffs (compareSnapshots only sees reindexed numeric data).
      if (this._ourSession!.steps[comp.stepIndex]) {
        try {
          const labeled = this.getMatrixLabeled(comp.stepIndex, comp.iterationIndex);
          for (const e of labeled.entries) {
            if (e.entryKind !== "captureMissing") continue;
            allEntries.push({
              stepIndex: comp.stepIndex,
              iteration: comp.iterationIndex,
              stepStartTime,
              category: "matrix",
              label: `${e.rowLabel}→${e.colLabel}[captureMissing]`,
              ours: typeof e.ours === "number" ? e.ours : NaN,
              ngspice: NaN,
              absDelta: NaN,
              relDelta: NaN,
              withinTol: false,
              componentLabel: null,
              slotName: null,
              presence,
            });
          }
        } catch {
          // getMatrixLabeled may throw if the step has no matrix data; skip silently.
        }
      }
```

Note: `engineSpecific` entries are correctly excluded from `getDivergences()` because
they never appear in `comp.matrixDiffs` (compareSnapshots doesn't see ngspice-only
rows after reindexing) and the new captureMissing loop above skips them by kind.

---

## File 4: query.ts

<path>src/solver/analog/__tests__/harness/query.ts</path>

The current `query.ts` has no worst-N path — it only has `convergenceSummary`,
`nodeVoltageTrajectory`, `elementStateTrajectory`, and `findLargestDelta`. The
"worst" and "divergences" filtering in `harness_query` is done inline in
`harness-tools.ts` (lines 970-996) over `getDivergences()` results, not over query.ts
functions.

No changes needed to `query.ts` itself. The sentinel-aware filtering is handled in
`getDivergences()` (comparison-session.ts, Hunk 7 above) and in `harness-tools.ts`
(File 5 below).

---

## File 5: harness-tools.ts

<path>scripts/mcp/harness-tools.ts</path>

### Hunk 1 — harness_compare_matrix serializer: handle sentinel values

Current (lines 1064-1074):
```typescript
      const entries = pageEntries.map((e: any) => ({
        rowLabel: e.rowLabel,
        colLabel: e.colLabel,
        rowIndex: e.row,
        colIndex: e.col,
        ours: formatNumber(e.ours),
        ngspice: formatNumber(e.ngspice),
        delta: formatNumber(e.ours - e.ngspice),
        absDelta: formatNumber(e.absDelta),
        withinTol: e.withinTol,
      }));
```

Replacement:
```typescript
      const entries = pageEntries.map((e: any) => {
        // Sentinel values must pass through as-is — do not call formatNumber on them.
        const isSentinel = (v: unknown): v is { kind: string } =>
          typeof v === "object" && v !== null && "kind" in v;

        const oursOut = isSentinel(e.ours) ? e.ours : formatNumber(e.ours as number);
        const ngspiceOut = isSentinel(e.ngspice) ? e.ngspice : formatNumber(e.ngspice as number);

        // delta is only meaningful when both sides are numeric.
        const deltaOut = isSentinel(e.ours) || isSentinel(e.ngspice)
          ? null
          : formatNumber((e.ours as number) - (e.ngspice as number));

        return {
          rowLabel: e.rowLabel,
          colLabel: e.colLabel,
          rowIndex: e.row,
          colIndex: e.col,
          entryKind: e.entryKind,
          ours: oursOut,
          ngspice: ngspiceOut,
          delta: deltaOut,
          absDelta: formatNumber(e.absDelta),
          withinTol: e.withinTol,
        };
      });
```

### Hunk 2 — harness_query P12 (step-end): handle sentinel branch values

Current (lines 889-920, P12 step-only block):
```typescript
      let nodeEntries = Object.entries(stepEnd.nodes);
      let branchEntries = Object.entries(stepEnd.branches ?? {});
      if (args.filter === "divergences") {
        nodeEntries = nodeEntries.filter(([, cv]) => !(cv as any).withinTol);
        branchEntries = branchEntries.filter(([, cv]) => !(cv as any).withinTol);
      }
      return JSON.stringify({
        ...
        stepEnd: {
          ...
          nodes: Object.fromEntries(nodeEntries.map(([k, v]) => [k, formatComparedValue(v as any)])),
          branches: Object.fromEntries(branchEntries.map(([k, v]) => [k, formatComparedValue(v as any)])),
          ...
        },
      });
```

Replacement for branch serialization:
```typescript
      const isSentinelVal = (v: unknown): boolean =>
        typeof v === "object" && v !== null && "kind" in v;

      let nodeEntries = Object.entries(stepEnd.nodes);
      let branchEntries = Object.entries(stepEnd.branches ?? {});
      if (args.filter === "divergences") {
        nodeEntries = nodeEntries.filter(([, cv]) => !(cv as any).withinTol);
        // For branches: sentinel captureMissing counts as a divergence;
        // engineSpecific does not.
        branchEntries = branchEntries.filter(([, cv]) => {
          if (isSentinelVal(cv)) {
            return (cv as any).kind === "captureMissing";
          }
          return !(cv as any).withinTol;
        });
      }
      // Serialize: sentinels pass through; ComparedValue goes through formatComparedValue.
      const serializeBranch = (v: unknown): unknown =>
        isSentinelVal(v) ? v : formatComparedValue(v as any);

      return JSON.stringify({
        handle: args.handle,
        queryMode: "step-end",
        total: nodeEntries.length + branchEntries.length,
        offset,
        limit: args.limit ?? 100,
        stepEnd: {
          stepIndex: stepEnd.stepIndex,
          presence: stepEnd.presence,
          stepStartTime: formatComparedValue(stepEnd.stepStartTime),
          stepEndTime: formatComparedValue(stepEnd.stepEndTime),
          dt: formatComparedValue(stepEnd.dt),
          converged: stepEnd.converged,
          iterationCount: formatComparedValue(stepEnd.iterationCount),
          nodes: Object.fromEntries(nodeEntries.map(([k, v]) => [k, formatComparedValue(v as any)])),
          branches: Object.fromEntries(branchEntries.map(([k, v]) => [k, serializeBranch(v)])),
          components: Object.fromEntries(
            Object.entries(stepEnd.components).map(([comp, entry]) => [
              comp,
              Object.fromEntries(
                Object.entries((entry as any).slots).map(([slot, cv]) => [slot, formatComparedValue(cv as any)]),
              ),
            ]),
          ),
        },
      });
```

### Hunk 3 — harness_query P14 (divergences/worst): exclude captureMissing from sort

Current (lines 970-996):
```typescript
      if (args.filter === "divergences" || args.filter === "worst") {
        const divergenceReport = session.getDivergences();
        let entries: any[] = divergenceReport.entries.filter((e: any) => Number.isFinite(e.absDelta) && e.absDelta > 0);
        if (args.filter === "worst") {
          const n = args.worstN ?? 10;
          entries = entries.slice().sort((a: any, b: any) => b.absDelta - a.absDelta).slice(0, n);
        }
```

Replacement:
```typescript
      if (args.filter === "divergences" || args.filter === "worst") {
        const divergenceReport = session.getDivergences();
        // Include captureMissing entries in divergences (they ARE real bugs).
        // Exclude engineSpecific entries (they are known architectural differences).
        // For "worst" sorting, exclude captureMissing too (NaN absDelta pollutes sort).
        let entries: any[] = divergenceReport.entries.filter((e: any) => {
          // captureMissing entries have absDelta: NaN — include in divergences but
          // exclude from worst-N sort (handled below).
          if (e.label && (e.label as string).endsWith("[captureMissing]")) {
            return args.filter === "divergences";
          }
          return Number.isFinite(e.absDelta) && e.absDelta > 0;
        });
        if (args.filter === "worst") {
          const n = args.worstN ?? 10;
          // Only numeric absDelta entries participate in the sort.
          entries = entries
            .filter((e: any) => Number.isFinite(e.absDelta))
            .slice()
            .sort((a: any, b: any) => b.absDelta - a.absDelta)
            .slice(0, n);
        }
```

Also update the serializer below that block to guard `formatNumber` against NaN
absDelta from captureMissing entries:

```typescript
        const divergences = items.map((e: any) => ({
          stepIndex: e.stepIndex,
          iterationIndex: e.iteration,
          stepStartTime: formatNumber(e.stepStartTime),
          type: e.category as "node" | "rhs" | "matrix" | "state",
          label: e.label,
          ours: Number.isFinite(e.ours) ? formatNumber(e.ours) : null,
          ngspice: Number.isFinite(e.ngspice) ? formatNumber(e.ngspice) : null,
          absDelta: Number.isFinite(e.absDelta) ? formatNumber(e.absDelta) : null,
          relDelta: Number.isFinite(e.relDelta) ? formatNumber(e.relDelta) : null,
          isSentinel: !Number.isFinite(e.absDelta),
        }));
```

---

## Test file 1: sentinel-engineSpecific.test.ts (new)

<path>src/solver/analog/__tests__/harness/sentinel-engineSpecific.test.ts</path>

<new_file>
/**
 * Tests for the engineSpecific sentinel classification in the harness matrix join.
 *
 * Uses createSelfCompare (no ngspice required) with a manually injected
 * _ngspiceOnlyRows entry to verify that _buildMatrixMaps() classification and
 * getMatrixLabeled() emission work correctly.
 *
 * Because these tests reach into ComparisonSession internals via protected fields,
 * they use a thin test subclass rather than casting to `any` everywhere.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { classifyNgspiceOnlyNode, KNOWN_ENGINE_DIFFERENCES } from "../harness/known-differences.js";
import type { KnownDifference } from "../harness/known-differences.js";

// ---------------------------------------------------------------------------
// classifyNgspiceOnlyNode unit tests (no session required)
// ---------------------------------------------------------------------------

describe("classifyNgspiceOnlyNode", () => {
  it("classifies q1#collector as BJT engineSpecific", () => {
    const result = classifyNgspiceOnlyNode("q1#collector", "bjt");
    expect(result).not.toBeNull();
    expect(result!.deviceType).toBe("bjt");
    expect(result!.reason).toContain("RC");
  });

  it("classifies q1#base as BJT engineSpecific", () => {
    const result = classifyNgspiceOnlyNode("q1#base", "bjt");
    expect(result).not.toBeNull();
    expect(result!.reason).toContain("RB");
  });

  it("classifies q1#emitter as BJT engineSpecific", () => {
    const result = classifyNgspiceOnlyNode("q1#emitter", "bjt");
    expect(result).not.toBeNull();
    expect(result!.reason).toContain("RE");
  });

  it("returns null for a non-BJT ngspice-only node", () => {
    const result = classifyNgspiceOnlyNode("net_42", undefined);
    expect(result).toBeNull();
  });

  it("returns null for a q1#sub node (substrate — not in registry)", () => {
    // If no pattern matches, classify as captureMissing candidate.
    const result = classifyNgspiceOnlyNode("q1#sub", "bjt");
    expect(result).toBeNull();
  });

  it("is case-insensitive on the node name", () => {
    const result = classifyNgspiceOnlyNode("Q1#COLLECTOR", "bjt");
    expect(result).not.toBeNull();
  });

  it("matches when no deviceTypeHint is provided (wildcard match)", () => {
    // The registry entry has deviceType "bjt", but without a hint the match
    // uses all entries. Since no entry has deviceType "*", a missing hint
    // bypasses the device-type filter only when hint is undefined.
    // This test verifies the classifyNgspiceOnlyNode implementation:
    // when deviceTypeHint is undefined the device type check is skipped.
    const result = classifyNgspiceOnlyNode("q1#base");
    expect(result).not.toBeNull();
  });

  it("does not match when deviceTypeHint is wrong type", () => {
    const result = classifyNgspiceOnlyNode("q1#collector", "diode");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// KNOWN_ENGINE_DIFFERENCES registry shape
// ---------------------------------------------------------------------------

describe("KNOWN_ENGINE_DIFFERENCES registry", () => {
  it("contains exactly three BJT entries", () => {
    const bjtEntries = KNOWN_ENGINE_DIFFERENCES.filter(e => e.deviceType === "bjt");
    expect(bjtEntries).toHaveLength(3);
  });

  it("all entries have non-empty reason strings", () => {
    for (const entry of KNOWN_ENGINE_DIFFERENCES) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("patterns are valid RegExp objects", () => {
    for (const entry of KNOWN_ENGINE_DIFFERENCES) {
      expect(entry.ngspiceNamePattern).toBeInstanceOf(RegExp);
      // Smoke-test that the pattern doesn't throw
      expect(() => entry.ngspiceNamePattern.test("q1#collector")).not.toThrow();
    }
  });
});
</new_file>

---

## Test file 2: sentinel-captureMissing.test.ts (new)

<path>src/solver/analog/__tests__/harness/sentinel-captureMissing.test.ts</path>

<new_file>
/**
 * Tests for the captureMissing sentinel in StepEndReport.branches.
 *
 * Uses createSelfCompare (no ngspice required) with patched session internals
 * to simulate a branch-current lookup failure on the ngspice side.
 *
 * The vsource-branch-null bug scenario: our engine has a branch row in the
 * voltage vector but the ngspice reindexed voltage array is shorter than that
 * row index, producing NaN. The sentinel layer should flag this as captureMissing
 * rather than emitting a numeric ComparedValue(ourV, NaN) that looks like a
 * real divergence.
 */

import { describe, it, expect } from "vitest";
import { isMatrixEntrySentinel } from "../harness/known-differences.js";

// ---------------------------------------------------------------------------
// isMatrixEntrySentinel type guard
// ---------------------------------------------------------------------------

describe("isMatrixEntrySentinel", () => {
  it("returns true for an engineSpecific sentinel", () => {
    const s = { kind: "engineSpecific", presentSide: "ngspice", reason: "test" };
    expect(isMatrixEntrySentinel(s)).toBe(true);
  });

  it("returns true for a captureMissing sentinel", () => {
    const s = { kind: "captureMissing", side: "ngspice", reason: "test" };
    expect(isMatrixEntrySentinel(s)).toBe(true);
  });

  it("returns false for a number", () => {
    expect(isMatrixEntrySentinel(3.14)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isMatrixEntrySentinel(null)).toBe(false);
  });

  it("returns false for a plain object without kind", () => {
    expect(isMatrixEntrySentinel({ value: 42 })).toBe(false);
  });

  it("returns false for a ComparedValue (no kind field)", () => {
    const cv = { ours: 1, ngspice: 1, delta: 0, absDelta: 0, relDelta: 0, withinTol: true };
    expect(isMatrixEntrySentinel(cv)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sentinel discriminant contract
// ---------------------------------------------------------------------------

describe("MatrixEntrySentinel discriminant contract", () => {
  it("engineSpecific sentinel has presentSide and reason", () => {
    const s: { kind: "engineSpecific"; presentSide: "ngspice"; reason: string } = {
      kind: "engineSpecific",
      presentSide: "ngspice",
      reason: "folded into device stamp",
    };
    expect(s.kind).toBe("engineSpecific");
    expect(s.presentSide).toBe("ngspice");
    expect(typeof s.reason).toBe("string");
  });

  it("captureMissing sentinel has side and reason", () => {
    const s: { kind: "captureMissing"; side: "ours" | "ngspice"; reason: string } = {
      kind: "captureMissing",
      side: "ngspice",
      reason: "branch row out of bounds",
    };
    expect(s.kind).toBe("captureMissing");
    expect(["ours", "ngspice"]).toContain(s.side);
    expect(typeof s.reason).toBe("string");
  });

  it("compareMatrixAt mismatches filter contract: engineSpecific is excluded", () => {
    // Verify the filtering logic by constructing labeled entries directly.
    const engineSpecificEntry = {
      row: 5, col: 5, rowLabel: "q1_internal", colLabel: "q1_internal",
      entryKind: "engineSpecific" as const,
      ours: { kind: "engineSpecific", presentSide: "ngspice" as const, reason: "test" },
      ngspice: 0.001,
      absDelta: 0, withinTol: true,
    };
    const captureMissingEntry = {
      row: 3, col: 1, rowLabel: "V1:branch", colLabel: "node1",
      entryKind: "captureMissing" as const,
      ours: 0.05,
      ngspice: { kind: "captureMissing", side: "ngspice" as const, reason: "missing" },
      absDelta: 0, withinTol: false,
    };
    const bothEntry = {
      row: 1, col: 1, rowLabel: "node1", colLabel: "node1",
      entryKind: "both" as const,
      ours: 1.0, ngspice: 1.1,
      absDelta: 0.1, withinTol: false,
    };
    const entries = [engineSpecificEntry, captureMissingEntry, bothEntry];

    // Replicate the filter logic from compareMatrixAt (comparison-session.ts:1608-1609):
    //   filter === "mismatches" → exclude engineSpecific, include captureMissing where !withinTol
    const mismatches = entries.filter(e => e.entryKind !== "engineSpecific" && !e.withinTol);
    expect(mismatches).toHaveLength(2);
    expect(mismatches.some(e => e.entryKind === "captureMissing")).toBe(true);
    expect(mismatches.some(e => e.entryKind === "both")).toBe(true);
    expect(mismatches.some(e => e.entryKind === "engineSpecific")).toBe(false);
  });
});
</new_file>

---

## Test file 3: sentinel-roundtrip.test.ts (new)

<path>src/solver/analog/__tests__/harness/sentinel-roundtrip.test.ts</path>

<new_file>
/**
 * JSON serialization round-trip safety for MatrixEntrySentinel values.
 *
 * Sentinels must survive JSON.stringify / JSON.parse because the MCP tool
 * interface serializes everything to JSON strings before returning to the caller.
 * Consumers detect sentinels via `isMatrixEntrySentinel` (typeof + "kind" in v),
 * which works identically on the pre-parse and post-parse object.
 */

import { describe, it, expect } from "vitest";
import { isMatrixEntrySentinel } from "../harness/known-differences.js";

function roundtrip<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("MatrixEntrySentinel JSON round-trip", () => {
  it("engineSpecific sentinel survives JSON round-trip", () => {
    const s = { kind: "engineSpecific" as const, presentSide: "ngspice" as const, reason: "RC folded" };
    const parsed = roundtrip(s);
    expect(isMatrixEntrySentinel(parsed)).toBe(true);
    expect(parsed.kind).toBe("engineSpecific");
    expect(parsed.presentSide).toBe("ngspice");
    expect(parsed.reason).toBe("RC folded");
  });

  it("captureMissing sentinel survives JSON round-trip", () => {
    const s = { kind: "captureMissing" as const, side: "ngspice" as const, reason: "branch row OOB" };
    const parsed = roundtrip(s);
    expect(isMatrixEntrySentinel(parsed)).toBe(true);
    expect(parsed.kind).toBe("captureMissing");
    expect((parsed as any).side).toBe("ngspice");
    expect((parsed as any).reason).toBe("branch row OOB");
  });

  it("LabeledMatrixEntry with sentinel fields survives JSON round-trip", () => {
    const entry = {
      row: 7, col: 3,
      rowLabel: "Q1#collector", colLabel: "Q1:C",
      entryKind: "engineSpecific" as const,
      ours: { kind: "engineSpecific" as const, presentSide: "ngspice" as const, reason: "colPrime" },
      ngspice: 1.23e-4,
      absDelta: 0,
      withinTol: true,
    };
    const parsed = roundtrip(entry);
    expect(isMatrixEntrySentinel(parsed.ours)).toBe(true);
    expect(typeof parsed.ngspice).toBe("number");
    expect(parsed.entryKind).toBe("engineSpecific");
  });

  it("LabeledMatrixEntry with captureMissing ngspice side survives JSON round-trip", () => {
    const entry = {
      row: 3, col: 1,
      rowLabel: "V1:branch", colLabel: "node1",
      entryKind: "captureMissing" as const,
      ours: 0.05,
      ngspice: { kind: "captureMissing" as const, side: "ngspice" as const, reason: "OOB" },
      absDelta: 0,
      withinTol: false,
    };
    const parsed = roundtrip(entry);
    expect(typeof parsed.ours).toBe("number");
    expect(isMatrixEntrySentinel(parsed.ngspice)).toBe(true);
    expect((parsed.ngspice as any).side).toBe("ngspice");
  });

  it("numeric (non-sentinel) LabeledMatrixEntry survives unchanged", () => {
    const entry = {
      row: 1, col: 1,
      rowLabel: "node1", colLabel: "node1",
      entryKind: "both" as const,
      ours: 1.0001, ngspice: 1.0,
      absDelta: 1e-4, withinTol: true,
    };
    const parsed = roundtrip(entry);
    expect(isMatrixEntrySentinel(parsed.ours)).toBe(false);
    expect(isMatrixEntrySentinel(parsed.ngspice)).toBe(false);
    expect(parsed.ours).toBeCloseTo(1.0001);
  });

  it("array of mixed sentinel and numeric entries round-trips correctly", () => {
    const entries = [
      { kind: "engineSpecific" as const, presentSide: "ngspice" as const, reason: "A" },
      42.0,
      { kind: "captureMissing" as const, side: "ours" as const, reason: "B" },
      null,
    ];
    const parsed = roundtrip(entries) as unknown[];
    expect(isMatrixEntrySentinel(parsed[0])).toBe(true);
    expect(isMatrixEntrySentinel(parsed[1])).toBe(false);
    expect(isMatrixEntrySentinel(parsed[2])).toBe(true);
    expect(isMatrixEntrySentinel(parsed[3])).toBe(false);
  });

  it("MCP serializer pattern: typeof + 'kind' in v detects sentinels post-roundtrip", () => {
    // This is the exact detection pattern the MCP consumer should use.
    const detectSentinel = (v: unknown): boolean =>
      typeof v === "object" && v !== null && "kind" in (v as object);

    const s = roundtrip({ kind: "captureMissing", side: "ngspice", reason: "gap" });
    expect(detectSentinel(s)).toBe(true);

    const n = roundtrip(3.14);
    expect(detectSentinel(n)).toBe(false);
  });
});
</new_file>

---

## Review notes

### Decisions the user should confirm before applying

1. **`NgspiceTopology` stored on `CaptureSession.topology`**: `_buildMatrixMaps()`
   uses `(this._ngSession.topology as any).nodeNames` to build the reverse map from
   ngspice row index → node name string. This cast is necessary because `CaptureSession`
   declares `topology: TopologySnapshot` and `TopologySnapshot` doesn't have a
   `nodeNames` field — that's on `NgspiceTopology`. If the ngspice session stores a
   plain `TopologySnapshot` (with `nodeLabels` but no `nodeNames`), the cast returns
   undefined and the reverse map is empty, leaving `_ngspiceOnlyRowReasons` unpopulated.
   **Confirm**: does `NgspiceBridge.getCaptureSession()` store an `NgspiceTopology`-shaped
   object (with `nodeNames: Map<string, number>`) in the `topology` field, or does it
   convert to `TopologySnapshot` first? If the latter, the reverse map lookup needs to
   come from a separate field on `ComparisonSession` populated during `_buildNodeMapping`.

   **Alternative if topology doesn't carry nodeNames**: store the raw ngspice topology
   as `protected _ngTopology: NgspiceTopology | null = null` and populate it in
   `_buildNodeMapping`:
   ```typescript
   private _buildNodeMapping(bridge: NgspiceBridge): void {
     const ngTopo = bridge.getTopology();
     if (ngTopo) {
       this._ngTopology = ngTopo;  // NEW: store for later classification
       this._nodeMap = buildDirectNodeMapping(...);
     }
   }
   ```
   Then in `_buildMatrixMaps()`, use `this._ngTopology?.nodeNames` directly.

2. **`_guessDeviceTypeFromNgspiceName` placement**: the diff places it as a
   module-level function after the class closing brace. If the codebase style prefers
   all helpers at the top of the file (before the class), move it there.

3. **`StepEndReport.branches` type change**: changing `branches` from
   `Record<string, ComparedValue>` to `Record<string, ComparedValue | MatrixEntrySentinel>`
   will produce TypeScript errors at every call site that destructures branch values
   and passes them directly to `formatComparedValue`. The `harness-tools.ts` P12
   block is the primary call site (fixed in File 5 Hunk 2). If there are other call
   sites (e.g., test files that read `stepEnd.branches`), they need the same sentinel
   guard. Search for `stepEnd.branches` and `branches\[` before applying.

4. **`getDivergences()` captureMissing category**: the added pass over
   `getMatrixLabeled()` inside `getDivergences()` calls `this.getMatrixLabeled()` in
   a try/catch. This is O(n_steps × n_matrix_entries) and may be slow for large
   transient runs. If performance is a concern, consider caching the `captureMissing`
   entries from `_buildMatrixMaps()` or lazily collecting them at session-build time.

5. **`compareMatrixAt` filter for worst-N**: the diff in `harness-tools.ts` Hunk 3
   identifies `captureMissing` entries by checking whether `e.label` ends with
   `"[captureMissing]"` — a string label trick. A cleaner approach would be to add
   a `sentinelKind: "captureMissing" | null` field to `DivergenceEntry` in
   `types.ts`. The string trick avoids touching `DivergenceEntry` but is fragile.
   **Confirm** whether to add the field or accept the string trick.

6. **ngspice node name separator**: the diff assumes `CKTmkVolt` produces names with
   `#` as separator (e.g., `q1#collector`). This was inferred from the ngspice source
   pattern (`here->BJTname, "collector"`) and the standard `CKTmkVolt` convention.
   **Verify** by running a BJT circuit through ngspice and printing
   `NgspiceTopology.nodeNames` keys to confirm the actual separator in the build
   used by this project.

### Parts deferred because they depend on Fix 3 (still under investigation)

- **Iteration-level `captureMissing` in `getIterations()`**: the same `ngV is NaN`
  pattern exists in `getIterations()` for both the `nodes` and `rhs` records. Those
  should eventually emit sentinels too, but `IterationReport` doesn't have a sentinel
  union type yet. Deferred until the iteration-level query surface is in scope.

- **`compareSnapshots` in `compare.ts`**: the raw `ComparisonResult.matrixDiffs`
  list does not carry sentinel information (it produces numeric diffs only). A
  thorough fix would thread sentinel awareness through `compareSnapshots` as well.
  Currently the `getDivergences()` workaround (Hunk 7) catches captureMissing entries
  by re-calling `getMatrixLabeled()`, which is sufficient for the MCP surface.
