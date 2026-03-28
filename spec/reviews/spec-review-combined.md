# Spec Review: Combined Report — trace-persistence.md

## Overall Verdict: needs-revision

## Dimension Summary

| Dimension | Issues |
|-----------|--------|
| Consistency | 3 |
| Completeness | 6 |
| Concreteness | 5 |
| Implementability | 6 |

## Codebase Verification

Claims in the spec were verified against the actual codebase:

| Claim | Status |
|-------|--------|
| `viewer-controller.ts:97` — WatchedSignal array | **Accurate** |
| `viewer-controller.ts:541-552` — resolveWatchedSignalAddresses | **Accurate** |
| `viewer-controller.ts:215` — addWireToViewer | **Wrong** — function starts at line 191, line 215 is closing brace |
| `viewer-controller.ts:224` — removeSignalFromViewer | **Wrong** — function starts at line 217, line 224 is closing brace |
| `viewer-controller.ts:522` — attachScopeContextMenu channel-remove | **Accurate** (splice is at 522, block is 510-529) |
| `circuit.ts:101` — CircuitMetadata interface | **Accurate** |
| `dts-schema.ts` — DtsCircuit type | **Accurate** |
| `dts-serializer.ts` / `dts-deserializer.ts` | **Accurate** — both exist |
| `save-schema.ts` — SavedMetadata type | **Accurate** |
| `save.ts` / `load.ts` | **Accurate** — both exist |
| `app-init.ts:371` — rebuildViewersIfOpen | **Misleading** — it's a callback property, not a standalone function |
| `labelSignalMap` usage | **Accurate** — defined in compile/types.ts, used in viewer-controller.ts |

## Blocking Issues (must fix before implementation)

### B1. `SavedTrace` interface has no declared home file
**Location:** Schema Additions section
**Problem:** All three schemas reference `traces?: SavedTrace[]` but no file is designated for the interface declaration. Importing from the wrong location risks circular dependencies.
**Suggestion:** Declare `SavedTrace` in `src/core/circuit.ts` alongside `CircuitMetadata`, or in a new `src/core/trace-types.ts` if layering prevents importing `SignalGroup` into `circuit.ts`.

### B2. `removeSignalFromViewer` only handles digital signals
**Location:** Save Path section, line reference to line 224
**Problem:** The function removes by `netId: number` (digital only). Analog signal removal goes through `attachScopeContextMenu` (lines 510-529). The spec lists three sync points but conflates digital and analog removal — an implementer following the spec will miss the analog path.
**Suggestion:** Add a fourth sync point for analog removal in `attachScopeContextMenu`, or restructure so `_syncTracesToMetadata()` is called from a common exit point that both paths share.

### B3. E2E test is unwritable — no postMessage message for querying viewer state
**Location:** Testing section, E2E bullet
**Problem:** The postMessage protocol has no message for reading which scope channels are open. The spec doesn't add one and doesn't mention DOM inspection as an alternative.
**Suggestion:** Either (a) add a `sim-read-traces` postMessage response, or (b) specify that the E2E test uses DOM selectors to verify viewer panel content, or (c) use the `sim-read-all-signals` response and infer viewer state from it.

### B4. `_syncTracesToMetadata()` is named but never specified
**Location:** Save Path section
**Problem:** Signature, closure vs. method, export status, and the exact WatchedSignal→SavedTrace mapping are all absent. This is the central write-path function.
**Suggestion:** Add a concrete specification: method on ViewerController (private), takes no args (reads closure `watchedSignals`), maps each entry to `{ name: sig.name, domain: sig.addr.domain, panelIndex: sig.panelIndex, group: sig.group }`.

### B5. Hydration flag location unspecified
**Location:** Restore Path pseudocode
**Problem:** "Mark hydrated" without specifying where. If on `CircuitMetadata` (persisted), restore won't fire on second page load. If on `ViewerController` (transient), it correctly re-restores after reload.
**Suggestion:** Specify as transient state on ViewerController: `let tracesHydrated = false;` inside the `initViewerController` closure.

## Quality Issues (should fix for better implementation)

### Q1. `SavedTrace.group` typed as `string` instead of `SignalGroup`
**Location:** SavedTrace interface definition
**Problem:** `WatchedSignal.group` is `SignalGroup` (`"input" | "output" | "probe"` from `data-table.ts:23`). Using `string` loses type safety on round-trip.
**Suggestion:** Use `group: SignalGroup` and note the import.

### Q2. Line numbers are wrong for two of three mutation sites
**Location:** Save Path section
**Problem:** `addWireToViewer` is at line 191 (not 215), `removeSignalFromViewer` is at line 217 (not 224). An implementer starting today will look at the wrong lines.
**Suggestion:** Use function names as anchors instead of line numbers, or fix the numbers.

### Q3. Restore entry point misdescribed
**Location:** Restore Path section
**Problem:** `rebuildViewersIfOpen` is described as being "at `app-init.ts:371`" as if it's a standalone function. It's actually a callback property inside `initApp` passed to `initSimulationController`.
**Suggestion:** Describe it as "the `rebuildViewersIfOpen` callback property at `app-init.ts:371`, inside the object passed to `initSimulationController`."

### Q4. All three test descriptions lack file paths and exact assertions
**Location:** Testing section
**Problem:** No test file paths, no fixture data descriptions, no exact assertion signatures. An implementer must guess for all three surfaces.
**Suggestion:** Specify target test files (e.g., `src/io/__tests__/trace-persistence.test.ts`, `e2e/parity/trace-persistence.spec.ts`) and at least one concrete assertion per surface.

### Q5. DTS and legacy JSON serializer changes are completely unspecified
**Location:** Files to Modify table
**Problem:** Just says "Serialize traces" / "Deserialize traces" with no detail on which functions to modify, where in the structure traces appear, or how to handle undefined.
**Suggestion:** Add one-line descriptions: e.g., "In `serializeCircuit()`, add `traces: circuit.metadata.traces ?? []` to the output object."

### Q6. Viewer auto-open behavior on restore is ambiguous
**Location:** Restore pseudocode ("open viewer panel, rebuild viewers")
**Problem:** Should the viewer be force-opened if the user had it closed? `openViewer(tabName)` requires a tab name not specified in the spec.
**Suggestion:** Specify: only call `rebuildViewers()` if the viewer is already open; do not force-open. If the viewer is closed, traces are still in metadata and will appear when the user opens the viewer.

## Informational

- The `SavedTrace.domain` field maps directly from `WatchedSignal.addr.domain` — spec could make this explicit to remove guesswork.
- The `watchedSignals` array is closure-local in `initViewerController`. The restore function must live inside the same closure, or the `ViewerController` interface must expose a mutation method. The spec should acknowledge this.
- The `.dig XML` skip is reasonable — no Digital equivalent exists.
