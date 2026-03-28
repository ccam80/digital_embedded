# Spec Review: Trace Persistence — Save/Restore Active Traces

## Verdict: needs-revision

## Plan Coverage

No plan.md exists for this spec. Plan coverage check skipped per assignment instructions.

## Internal Consistency Issues

**1. `removeSignalFromViewer` cannot serve as a sync point for analog signals.**

The spec lists `removeSignalFromViewer` (line 224) as one of the three mutation sites where `circuit.metadata.traces` must be kept current. The actual function signature is:

```ts
function removeSignalFromViewer(netId: number): void
```

It looks up the signal by `addr.domain === 'digital' && addr.netId === netId`. Analog signals are removed through the `attachScopeContextMenu` channel-remove path (lines 510-529), not through `removeSignalFromViewer`. The spec treats all three sites as parallel write points for `_syncTracesToMetadata()`, but analog signal removal is structurally separate from digital removal. An implementer who reads only the spec will write one sync call in `removeSignalFromViewer` and miss the analog removal code path — or may wire it incorrectly.

**2. `SavedTrace.group` declared as `string`, conflicts with the `SignalGroup` type already in the codebase.**

The spec defines:
```ts
interface SavedTrace {
  group: string;  // "probe" | "input" | "output"
}
```

`WatchedSignal.group` is typed `SignalGroup`, which is `"input" | "output" | "probe"` (defined in `src/runtime/data-table.ts:23`). The spec's `group: string` is looser than the existing type. If `SavedTrace` is declared separately with `group: string` rather than `group: SignalGroup`, the round-trip from `WatchedSignal` → `SavedTrace` → `WatchedSignal` loses type safety and opens a gap where an invalid group value could be deserialized without a compile-time error. The spec should either use `group: SignalGroup` or explain why widening to `string` is intentional.

**3. Hydration flag has no specified home, creating ambiguity between the save and restore paths.**

The restore pseudocode says "mark hydrated (no re-hydration on recompile)" but never says where this flag lives. `circuit.metadata` has no `tracesHydrated` field; `ViewerController` has no such state. Both the save path (`_syncTracesToMetadata()` called on every mutation) and the restore path (called from first compile) read and write `circuit.metadata.traces`. Without a clear hydration flag location the implementer must decide whether the flag belongs in `CircuitMetadata` (persisted) or in `ViewerController` local state (transient). These have different semantics: a persisted flag would prevent restore on second open of the same circuit object; a transient flag would re-restore after every page reload (desired). The spec does not resolve this.

## Completeness Gaps

**1. No file specified for the `SavedTrace` interface declaration.**

The spec introduces `SavedTrace` as a new interface but lists no file in the "Files to Modify" table where it will be declared. `circuit.ts`, `dts-schema.ts`, and `save-schema.ts` all reference `traces?: SavedTrace[]` but none of them is designated as the canonical home for the interface itself. An implementer must guess whether to declare it in `circuit.ts`, create a new `src/app/trace-types.ts`, or duplicate it across files.

**2. The headless test description is underspecified.**

The spec says:
> **Headless:** Round-trip serialize/deserialize with traces. Verify missing signals skipped.

This does not describe:
- Which headless file the test goes in (e.g., `src/headless/__tests__/loader.test.ts` or a new file).
- What the `SavedTrace` fixture data looks like.
- What exact assertion confirms "missing signals skipped" (e.g., `watchedSignals.length === 0`, a warning logged, or an error thrown).
- Whether the test exercises the DTS format, the legacy JSON format, or both.
- What state the `labelSignalMap` is in when the round-trip restore runs.

A conforming test author cannot write this test without making multiple unguided decisions.

**3. The MCP test description is underspecified.**

The spec says:
> **MCP:** `circuit_save`/`circuit_load` preserve trace metadata.

This does not describe:
- Which test file this goes in.
- The exact tool call sequence.
- What field in the `circuit_load` response is asserted (e.g., `result.metadata.traces[0].name === "sig1"`).
- Whether this exercises the DTS or legacy JSON path.

**4. The E2E test description is underspecified and the postMessage protocol gap is unaddressed.**

The spec says:
> **E2E:** Load circuit with traces via postMessage, compile, verify viewer opens with correct signals.

This does not describe:
- Which E2E fixture file the test goes in.
- How the test verifies "viewer opens with correct signals." There is no `sim-read-all-signals` equivalent for trace/viewer panel state. The postMessage protocol (documented in CLAUDE.md) has no message for querying which scope channels are open. The spec does not add one, and does not explain how an E2E test would observe viewer state without DOM inspection.
- Whether `SimulatorHarness` is used or direct `postMessage` calls.

**5. The `_syncTracesToMetadata` function is named but never fully specified.**

The spec names `_syncTracesToMetadata()` as the write-on-mutate helper but does not specify:
- Its full signature (does it take arguments or read closure state?).
- Whether it is a method on `ViewerController` or a local function.
- Whether it needs to be exported (for testing).
- What it writes — does it write `WatchedSignal[]` directly or map to `SavedTrace[]`?

**6. No acceptance criteria for the "Domain changed" edge case.**

The edge case table says "Use new domain's address, log mismatch" but does not say what constitutes a "domain mismatch" (the stored domain differs from the resolved address domain), what is logged, or where. An implementer cannot write a test for this without guessing the exact log call.

## Concreteness Issues

**1. Line numbers in the spec are wrong.**

The spec states:
- `addWireToViewer` — "line 215"
- `removeSignalFromViewer` — "line 224"
- `attachScopeContextMenu` channel-remove — "line 522"

Actual line numbers in `src/app/viewer-controller.ts`:
- `addWireToViewer` function body starts at **line 191**
- `removeSignalFromViewer` function body starts at **line 217**
- Channel-remove block in `attachScopeContextMenu` is at **lines 510-529** (the `watchedSignals.splice` is at line 522, which happens to match, but the surrounding block description "channel-remove (line 522)" implies the whole channel-remove handler is at 522, which is misleading)

Line numbers drift as code changes. However, their current inaccuracy means an implementer starting today will look at the wrong lines in `addWireToViewer` and `removeSignalFromViewer`.

**2. The "Restore Path" entry point is misdescribed.**

The spec says:
> **Timing:** After compilation (labelSignalMap required). Entry point: `rebuildViewersIfOpen` at `app-init.ts:371`.

`rebuildViewersIfOpen` is not a top-level function in `app-init.ts`. It is a local callback defined inline at line 371 inside `initApp`, which calls `viewerController.resolveWatchedSignalAddresses(...)`. There is no exported or named `rebuildViewersIfOpen` function — the spec names a closure property. An implementer looking for `function rebuildViewersIfOpen` will not find it. The correct description is that the restore call should be inserted into the lambda at `app-init.ts:371` (the `rebuildViewersIfOpen` callback passed to `initSimulationController`), before or after the existing `resolveWatchedSignalAddresses` call.

**3. The `SavedTrace.domain` field type is described as `"digital" | "analog"` but `SignalAddress.domain` in the codebase uses the same literal union.**

This is not wrong, but the spec does not explain whether `SavedTrace.domain` maps directly from `WatchedSignal.addr.domain` or whether it requires a lookup. For analog signals, `addr.domain === 'analog'`; for digital, `addr.domain === 'digital'`. Confirming the direct mapping explicitly would remove implementer guesswork.

**4. The `group` field in `SavedTrace` uses informal notation.**

The spec comments `"probe" | "input" | "output"` inline but this is not a TypeScript type reference. It will be read by the implementer as a suggestion rather than a binding constraint. Given that `SignalGroup` already exists with these exact values, referencing the existing type by name is both more concrete and eliminates the risk of a typo introducing a fourth value.

**5. The restore pseudocode says "open viewer panel, rebuild viewers" with no specificity.**

The actual `ViewerController` interface exposes `openViewer(tabName: string)` and `rebuildViewers()`. The spec does not say which tab name to use when auto-opening the viewer on restore, leaving the implementer to choose arbitrarily between `'timing'`, `'fft'`, or other values.

## Implementability Concerns

**1. The `SavedTrace` interface references `SignalGroup` from `src/runtime/data-table.ts`, but this import is not mentioned.**

If `SavedTrace` is declared in `src/core/circuit.ts` (the most natural location given `CircuitMetadata` lives there), the implementer needs to import `SignalGroup` from `src/runtime/data-table.ts`. `circuit.ts` is described as a core module; importing from `runtime` into `core` may violate an architectural layering constraint. The spec does not acknowledge this potential layering issue.

**2. The DTS serializer/deserializer changes are completely unspecified.**

The "Files to Modify" table lists `src/io/dts-serializer.ts` and `src/io/dts-deserializer.ts` with the change description "Serialize traces" and "Deserialize traces" respectively. There is no description of:
- Which existing serialization function in `dts-serializer.ts` to modify.
- Where in the serialized structure `traces` appears (top-level on `DtsCircuit` or on some wrapper).
- How to handle the case where `traces` is undefined (omit from output, or write empty array).
- Any validation on deserialization (e.g., check that each entry has the required fields).

An implementer must read the full serializer file to understand the pattern, then infer the required changes. This is not self-contained.

**3. The legacy JSON serializer/deserializer changes are similarly unspecified.**

`src/io/save.ts` and `src/io/load.ts` are listed with no further detail. The `SavedMetadata` interface is separate from `CircuitMetadata` and has a different field set (it lacks `isLocked`, `chipWidth`, `chipHeight`, `shapeType`, `customShape`, `logicFamily`). An implementer needs to understand both schemas to add `traces` correctly to each. The spec gives no guidance on whether `SavedCircuit.metadata.traces` or a top-level `SavedCircuit.traces` is the right location (the `SavedMetadata` addition implies `metadata.traces`, which is consistent with the DTS pattern, but this is left implicit).

**4. No test file paths are given for any of the three test surfaces.**

The Three-Surface Rule requires tests on all three surfaces, but none of the test entries in the spec say which file to add the test to. For headless tests, the likely home is `src/headless/__tests__/loader.test.ts` or `src/io/__tests__/`. For MCP tests, `src/headless/__tests__/port-mcp.test.ts`. For E2E, a new file or an existing parity spec. Without file paths, the implementer must guess — and placing a test in the wrong file may cause it to be skipped or miscategorized.

**5. There is no description of how the viewer is triggered to open during restore.**

The pseudocode says "open viewer panel, rebuild viewers" but the actual `ViewerController` exposes `openViewer(tabName: string)` which requires a tab name, and `rebuildViewers()` as separate calls. The restore path runs inside the first-compile callback, at which point the viewer may already be open (if the user opened it before compiling) or closed. The spec does not say what to do if the viewer is already open — rebuildViewers alone (no openViewer call) or both. This matters because calling `openViewer` unconditionally would forcibly open the viewer even if the user had explicitly closed it before compiling.

**6. The `watchedSignals` array is a closure-local variable in `initViewerController`.**

The spec says `restoreTracesFromMetadata` should "push to watchedSignals." This function must be a closure inside `initViewerController`, or the `watchedSignals` array must be exposed via the `ViewerController` interface. The interface currently exposes `readonly watchedSignals: WatchedSignal[]` (line 46), which would allow external pushing — but that would break encapsulation. The spec does not address this tension.
