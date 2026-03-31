# Task 4.4 — sim-get-circuit Delta Export: Findings & Implementation Status

## Investigation Summary

### Problem

`sim-get-circuit` exported circuits in dig XML format (`format: 'dig-xml-base64'`). The dig XML serializer has no support for `modelParamDeltas`, so any per-element model parameter overrides were silently dropped on export. The round-trip `sim-get-circuit` → `sim-load-data` lost all SPICE model param customizations.

### Root Cause

In `postmessage-adapter.ts`, `_handleGetCircuit()` called `this._hooks.serializeCircuit()` which was wired in `app-init.ts` to `serializeCircuitToDig(circuit, registry)`. The dig XML format carries no model param delta information.

In `_handleLoadData()`, the decoded base64 string was always passed to `_loadCircuit(xml)` — so DTS JSON payloads would have failed XML parsing.

### Full Export Path (before fix)

```
sim-get-circuit
  → _handleGetCircuit()
  → hooks.serializeCircuit()               ← serializeCircuitToDig() in app-init
  → dig XML string → btoa()
  → { type: 'sim-circuit-data', data: b64, format: 'dig-xml-base64' }
```

### Full Import Path (before fix)

```
sim-load-data { data: b64 }
  → _handleLoadData()
  → atob(b64) → decoded string
  → _loadCircuit(decoded)                  ← always XML path, DTS would fail
```

---

## Implementation

### Changes Made

**`src/io/postmessage-adapter.ts`**
- Added `serializeDts?(): string` hook to `PostMessageHooks` — called by `sim-get-circuit` for DTS export.
- Added `loadCircuitDts?(circuit: Circuit): Promise<void> | void` hook — receives the deserialized Circuit object directly, preserving PropertyBag model param state.
- Updated `_handleGetCircuit()`: prefers `serializeDts` hook (produces `dts-json-base64`), falls back to `serializeCircuit` (`dig-xml-base64`).
- Updated `_handleLoadData()`: detects DTS JSON by `{` prefix. Routes to `loadCircuitDts` → `loadCircuitXml` (fallback via dig) → headless compile.
- Added import for `serializeDtsCircuit` from `dts-serializer.js`.

**`src/app/app-init.ts`**
- Added import for `serializeCircuit as serializeDts` from `dts-serializer.js`.
- Added `serializeDts: () => serializeDts(circuit)` hook.
- Added `loadCircuitDts: (loaded) => { fileIOController.applyLoadedCircuit(loaded); facade.compile(ctx.getCircuit()); }` hook — loads Circuit directly without XML conversion, preserving modelParamDeltas on PropertyBags.

**`src/app/tutorial/types.ts`**
- Updated `TutorialIframeMessage` format union: `'dig-xml-base64' | 'dts-json-base64'`.

### Why `loadCircuitDts` Is Required

The naive approach (deserialize DTS → convert to dig XML → load) loses deltas:
1. `deserializeDts()` → Circuit with deltas on PropertyBag
2. `serializeCircuitToDig()` → dig XML has no model param fields
3. `loadCircuitXml()` → reconstructed Circuit has no deltas

The `loadCircuitDts` hook bypasses XML conversion: calls `applyLoadedCircuit(loaded)` which copies the loaded Circuit elements (with PropertyBags intact) into the live editor circuit, then recompiles.

---

## Tests

### Headless (PostMessageAdapter unit tests)
File: `src/io/__tests__/postmessage-adapter.test.ts`

New tests:
- `getCircuit — serializeDts hook preferred: produces dts-json-base64 format`
- `getCircuit — falls back to dig-xml-base64 when serializeDts not provided`
- `getCircuit — no hooks at all sends sim-error`
- `load-data with DTS JSON base64 calls loadCircuitXml (via dig fallback)`
- `load-data with XML base64 still routes to loadCircuitXml as XML`

Result: **48/48 passing**

### MCP Surface (facade round-trip)
File: `src/headless/__tests__/dts-delta-mcp.test.ts`

Pre-existing 5 tests cover `facade.serialize()` / `facade.deserialize()` round-trips.
Result: **7/7 passing**

### E2E / UI (browser postMessage)
File: `e2e/parity/load-and-simulate.spec.ts`

New tests:
- `get-circuit round-trip — export produces dts-json-base64 format`
- `get-circuit round-trip — export then reimport preserves circuit`
- `sim-get-circuit / sim-load-data — modelParamDeltas survive round-trip`

Result: **7/7 passing**

---

## Pre-existing Failures (not introduced by this task)

All 14 failures seen in the broader `src/io/ src/headless/` run are documented in `spec/test-baseline.md` and `spec/progress.md`:
- `spice-import-roundtrip-mcp.test.ts` — DC convergence failures (pre-existing solver issue, documented in progress.md lines 311-320)
- `spice-model-overrides-mcp.test.ts` — failures (in baseline)
- Various analog solver / compiler / RC transient failures (all in baseline)

---

## Round-trip Contract

After this fix:
- `sim-get-circuit` produces `format: 'dts-json-base64'` when the GUI `serializeDts` hook is wired.
- `sim-load-data` auto-detects DTS JSON and uses `loadCircuitDts` to preserve modelParamDeltas.
- Full round-trip `sim-load-data(dts-with-delta)` → `sim-get-circuit` → `sim-load-data(exported)` preserves `modelParamDeltas` end-to-end.
- Backward compat: hosts providing only `serializeCircuit` still get `dig-xml-base64`.
