# Migration: Unify on .dts JSON format, remove legacy save/load + ZIP export

## Goal

Eliminate the legacy `SavedCircuit` JSON format (`save.ts`, `load.ts`, `save-schema.ts`) and the ZIP export module (`export/zip.ts`). All native JSON serialization consolidates on the `.dts` format (`dts-serializer.ts`, `dts-deserializer.ts`, `dts-schema.ts`).

## Why

- Two JSON serializers doing nearly the same thing — maintenance burden, confusion
- Legacy format lacks subcircuit embedding, model definitions, SPICE params
- ZIP export exists only to bundle subcircuits as separate files — `.dts` embeds them inline, making ZIP redundant
- Legacy format has field-name divergence from `.dts` (`typeName` vs `type`, `instanceId` vs `id`, `p1`/`p2` vs `points[]`)

## Gaps in .dts that must be closed first

Before wiring `.dts` into all consumers, these missing features must be added:

### 1. `mirror` field (CRITICAL)

The legacy format serializes `element.mirror` (boolean). The `.dts` format **does not** — neither schema, serializer, nor deserializer handle it. Circuits with mirrored components will lose that state on round-trip.

**Fix:** Add optional `mirror?: boolean` to `DtsElement` in `dts-schema.ts`. Serialize in `dts-serializer.ts` (only when `true` to keep output compact). Deserialize in `dts-deserializer.ts` (default `false`). Add validation in `validateDtsElement`.

### 2. `measurementOrdering` (MODERATE)

Legacy format stores `metadata.measurementOrdering` (string array — probe ordering for the data table). The `.dts` format silently drops it.

**Fix:** Add optional `measurementOrdering?: string[]` to `DtsCircuit`. Serialize when non-empty. Deserialize into `circuit.metadata.measurementOrdering`.

### 3. `testData` serialization (LOW)

`DtsCircuit` already declares `testData?: string` in the schema, but the serializer never writes `circuit.metadata.testData` (if it exists on Circuit). Verify whether Circuit carries embedded test data and wire it through if so.

### 4. `instanceId` restoration

The `.dts` deserializer already restores `instanceId` from `savedEl.id` ✓. No gap here — just confirming parity.

## Migration plan

### Wave 1 — Close .dts gaps

1. Add `mirror` to `DtsElement` schema, serializer, deserializer, validator
2. Add `measurementOrdering` to `DtsCircuit` schema, serializer, deserializer
3. Wire `testData` through the serializer if Circuit carries it
4. Add round-trip tests for all three: mirror, measurementOrdering, testData

### Wave 2 — Swap consumers to .dts

Each consumer is a small, independent change:

| Consumer | File | Change |
|----------|------|--------|
| **Facade** | `src/headless/default-facade.ts` | `serialize()` → call `dts-serializer.serializeCircuit()` instead of `save.serializeCircuit()`. `deserialize()` → call `dts-deserializer.deserializeDts()` instead of `load.deserializeCircuit()`. Return type becomes `{ circuit, subcircuits }` — decide if facade should unwrap to just `Circuit` for API compat. |
| **Loader** | `src/headless/loader.ts` | `loadJson()` → call `deserializeDts()` instead of `deserializeCircuit()` |
| **File I/O** | `src/app/file-io-controller.ts` | Already uses `.dts` for save. Remove the `deserializeCircuit` (legacy) fallback path on load. Keep `deserializeDts` only. |
| **CLI** | `scripts/circuit-cli.ts` | Switch imports from `save`/`load` to `dts-serializer`/`dts-deserializer` |
| **Test helper** | `scripts/test-rtc-build.ts` | Same as CLI |

**Backward-compat on load:** The file-io-controller currently tries `.dts` parse first, then falls back to legacy `deserializeCircuit`. During this wave, keep a thin fallback that detects legacy format (has `version` + `metadata` + `elements` but no `format` field) and either rejects with a clear error or auto-upgrades. Recommend: reject with a message like _"Legacy .json format is no longer supported. Re-save as .dts."_ — simple, no silent conversion bugs.

### Wave 3 — Delete legacy files + ZIP export

Delete these files:

| File | Reason |
|------|--------|
| `src/io/save.ts` | Replaced by `dts-serializer.ts` |
| `src/io/save-schema.ts` | Replaced by `dts-schema.ts` |
| `src/io/load.ts` | Replaced by `dts-deserializer.ts` (keep `isCtzUrl()` — move it to `ctz-parser.ts`) |
| `src/io/__tests__/save.test.ts` | Dead |
| `src/io/__tests__/load.test.ts` | Dead (verify no unique test scenarios that need porting to dts tests) |
| `src/export/zip.ts` | Redundant — .dts embeds subcircuits inline |
| `src/export/__tests__/zip.test.ts` | Dead |

**`isCtzUrl()` relocation:** Currently lives in `load.ts`. Move to `ctz-parser.ts` where it logically belongs. Update the one import site (`file-io-controller.ts` or wherever it's called from).

### Wave 4 — Clean up menu/UI references

- Remove "Export as ZIP…" menu item from `file-io-controller.ts` (line ~549) and any toolbar button
- Remove the `saveFormat` toggle UI if `.dig` export is also being dropped (out of scope — `.dig` export stays for Digital interop)
- Remove `fflate` dependency from `package.json` if nothing else uses it

## Files touched summary

| Wave | Files modified | Files deleted |
|------|---------------|---------------|
| 1 | `dts-schema.ts`, `dts-serializer.ts`, `dts-deserializer.ts`, + new tests | 0 |
| 2 | `default-facade.ts`, `loader.ts`, `file-io-controller.ts`, `circuit-cli.ts`, `test-rtc-build.ts` | 0 |
| 3 | `ctz-parser.ts` (receives `isCtzUrl`) | `save.ts`, `save-schema.ts`, `load.ts`, `save.test.ts`, `load.test.ts`, `zip.ts`, `zip.test.ts` |
| 4 | `file-io-controller.ts`, `menu-toolbar.ts`, `package.json` | 0 |

## Risks

- **MCP server:** `circuit_save` currently saves as `.dig` XML (via `dig-serializer`). Not affected by this migration — `.dig` export stays.
- **postMessage adapter:** Uses `serializeCircuitToDig()` for `sim-get-circuit`. Not affected.
- **Existing .json files in the wild:** Anyone with saved `.json` files from the legacy format won't be able to load them. Mitigation: clear error message, or a one-time offline migration script.
- **`fflate` removal:** Verify no other module imports it before removing from `package.json`.

## Out of scope

- `.dig` import/export — stays for Digital compatibility
- CTZ import — unrelated
- CircuitSpec / patch API — unrelated (programmatic, not file format)
