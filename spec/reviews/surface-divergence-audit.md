# Surface Divergence Audit: Headless vs PostMessage vs UI

## Executive Summary

The three surfaces (headless facade, postMessage adapter, UI/editor) are **better unified than expected** for core signal I/O. All three resolve labels through a single centralized mechanism: `coordinator.compiled.labelSignalMap`, built at compile time by the digital/analog compilers. Runtime signal methods (`setInput`, `readOutput`, `readAllSignals`) contain zero typeId checks.

However, significant **feature asymmetries** exist between surfaces, and typeId hardcoding in the compiler layer creates a single bottleneck for Port support.

---

## Architecture: How Label Resolution Actually Works

```
                    ┌──────────────────────────────────┐
                    │     compiler.ts (digital)         │
                    │  LABELED_TYPES = {In, Out, Probe, │
                    │    Measurement, Clock}             │
                    │     ↓ builds                      │
                    │  labelToNetId → labelSignalMap     │
                    └──────────────┬───────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
    ┌─────────▼─────────┐  ┌──────▼──────┐  ┌──────────▼──────────┐
    │  Headless Facade   │  │  PostMessage │  │   UI (EditorBinding) │
    │  runner.ts         │  │  adapter.ts  │  │   canvas-interaction │
    │  default-facade.ts │  │              │  │                      │
    │                    │  │  delegates   │  │  wireSignalMap +     │
    │  labelSignalMap    │  │  to facade   │  │  pinSignalMap        │
    │  .get(label)       │  │  .setInput() │  │  (pre-built by       │
    │                    │  │  .readOutput()│  │   compile.ts)        │
    └────────────────────┘  └──────────────┘  └──────────────────────┘
```

All three surfaces are thin wrappers over the same `labelSignalMap`. **Adding Port to `LABELED_TYPES` in the compiler is the single fix that enables Port across all surfaces.**

---

## TypeId Hardcoding: Complete Inventory

| Location | Line(s) | TypeIds | Purpose | Port Fix |
|----------|---------|---------|---------|----------|
| `solver/digital/compiler.ts` | 685 | `In, Out, Probe, Measurement, Clock` | Build `labelToNetId` (root of all digital label resolution) | Add `Port` |
| `solver/analog/compiler.ts` | 621, 1744 | `In, Out, Probe, in, out, probe` | Build `labelToNodeId` (root of all analog label resolution) | Add `Port` |
| `headless/test-runner.ts` | 76 | `In, Clock` | Infer `inputCount` when test data has no `\|` separator | Add `Port` |
| `headless/default-facade.ts` | 209 | `In, Clock` | Same `inputCount` inference (duplicated logic) | Add `Port` |
| `io/postmessage-adapter.ts` | 428–429 | `In, Clock, Out` (via `def.name`) | Tutorial test validation only | Add `Port` |
| `app/canvas-interaction.ts` | 550, 571 | `In, Clock` | Click-to-toggle signal driving | Add `Port` |
| `testing/comparison.ts` | 98, 106 | `In, Out` | Signal inventory for exhaustive equivalence comparison | Add `Port` |
| `testing/fixture-generator.ts` | 36, 57 | `In, Out` | Extract input/output names for test fixture generation | Add `Port` |

### Zero TypeId Checks (already Port-compatible)

| File | Methods | Resolution mechanism |
|------|---------|---------------------|
| `headless/runner.ts` | `setInput()`, `readOutput()`, `readAllSignals()` | `labelSignalMap.get(label)` |
| `testing/executor.ts` | `executeTests()` | Pre-split `inputNames`/`outputNames` arrays |
| `integration/editor-binding.ts` | `getWireSignal()`, `getPinValue()` | Pre-built `wireSignalMap`/`pinSignalMap` |
| `solver/digital/compiled-circuit.ts` | — | Pure data structure |
| `solver/digital/bus-resolution.ts` | `recalculate()`, `checkBurn()` | Purely numeric (net IDs) |

---

## Feature Asymmetries Between Surfaces

### PostMessage can do, Headless facade cannot

| Feature | PostMessage message | Facade equivalent | Gap |
|---------|-------------------|-------------------|-----|
| Load circuit from URL | `digital-load-url` | None (`loadDigXml` takes XML string only) | **Missing** |
| Export circuit as base64 | `digital-get-circuit` | `serialize()` exists but returns JSON, not base64 .dig XML | **Different format** |
| Load data into RAM/ROM | `digital-load-memory` | None | **Missing** |
| Set resolver base path | `digital-set-base` | None | **Missing** |
| Load DTS JSON format | `digital-load-json` | `deserialize()` exists | Equivalent |
| Run to stable | None | `runToStable(engine, maxIter?)` | **Inverse gap** |
| DC operating point | None | `dcOperatingPoint()` | **Inverse gap** |
| Lock/unlock editor | `digital-set-locked` | None (UI-only concept) | By design |
| Highlight components | `digital-highlight` | None (UI-only concept) | By design |
| Set palette filter | `digital-set-palette` | None (UI-only concept) | By design |
| Tutorial instructions | `digital-set-instructions` | None (UI-only concept) | By design |

### Return type inconsistency

| Method | `SimulationRunner` | `DefaultSimulatorFacade` | PostMessage wire |
|--------|-------------------|-------------------------|-----------------|
| `readAllSignals()` | `Map<string, number>` | `Record<string, number>` | `{ signals: {...} }` |

### Behavioral divergence

| Behavior | Headless | PostMessage | UI |
|----------|----------|-------------|-----|
| `setInput` on an "Out" label | Succeeds (no typeId check) | Succeeds (delegates to facade) | N/A (click handler gates on In/Clock) |
| `readOutput` on an "In" label | Succeeds (no typeId check) | Succeeds (delegates to facade) | N/A (renderer reads all signals) |
| Input/output direction enforcement | None | None | Click-to-toggle only for In/Clock |

---

## Divergence Score

| Dimension | Score | Notes |
|-----------|-------|-------|
| Signal I/O label resolution | **Unified** | All three surfaces use `labelSignalMap` |
| TypeId gating for label registration | **Single bottleneck** | Compiler's `LABELED_TYPES` is the one fix point |
| Feature coverage | **Divergent** | 5 postMessage features missing from facade |
| Return types | **Minor drift** | `Map` vs `Record` for `readAllSignals` |
| Direction enforcement | **Inconsistent** | Headless/postMessage allow any label for any operation; UI gates on typeId |

---

## Proposed Unification Work

### P0 — Required for Port (this spec)

1. Add `"Port"` to `LABELED_TYPES` in `solver/digital/compiler.ts:685`
2. Add `"Port"` to `labelTypes` in `solver/analog/compiler.ts:621,1744`
3. Add `"Port"` to `inputCount` inference in `test-runner.ts:76` and `default-facade.ts:209`
4. Add `"Port"` to tutorial validation in `postmessage-adapter.ts:428`
5. Add `"Port"` to click-to-toggle in `canvas-interaction.ts:550,571`
6. Add `"Port"` to comparison/fixture-generator in `testing/comparison.ts:98,106` and `testing/fixture-generator.ts:36,57`

**Estimated scope**: 8 files, ~1 line change each. All follow the pattern of adding `"Port"` to an existing typeId set or `||` chain.

### P1 — Unify `inputCount` inference (deduplicate)

The `inputCount` inference logic is duplicated between `test-runner.ts:76` and `default-facade.ts:209`. Extract to a shared helper:

```typescript
// src/testing/input-count.ts
export function inferInputCount(circuit: Circuit): number {
  const INPUT_TYPES = new Set(["In", "Clock", "Port"]);
  let count = 0;
  for (const el of circuit.elements) {
    if (INPUT_TYPES.has(el.typeId)) {
      const label = el.getProperties().getOrDefault<string>("label", "");
      if (label) count++;
    }
  }
  return count;
}
```

**Estimated scope**: 1 new file, 2 files updated.

### P2 — Add missing facade methods for postMessage feature parity

| Missing facade method | PostMessage equivalent | Effort |
|-----------------------|-----------------------|--------|
| `loadFromUrl(url)` | `digital-load-url` | Small — `fetch(url).then(text => loadDigXml(text))` |
| `loadMemory(label, data, format)` | `digital-load-memory` | Medium — needs compiled engine access |
| `exportDigXmlBase64(circuit)` | `digital-get-circuit` | Small — serialize + btoa |
| `runToStable` via postMessage | N/A | Small — add `digital-run-to-stable` message type |

### P3 — Normalize `readAllSignals` return type

Choose one: `Map<string, number>` or `Record<string, number>`. The facade and runner should agree. Recommend `Record` since it serializes naturally to JSON for postMessage/MCP.

### P4 — Extract `LABELED_TYPES` to shared constant

The typeId sets are defined independently in the digital compiler, analog compiler, test-runner, facade, postMessage adapter, canvas-interaction, comparison, and fixture-generator. Extract to a single shared constant so future interface element types (like Port) only need one addition:

```typescript
// src/core/interface-types.ts
export const INTERFACE_TYPES = new Set(["In", "Out", "Probe", "Measurement", "Clock", "Port"]);
export const INPUT_CAPABLE_TYPES = new Set(["In", "Clock", "Port"]);
```

**Estimated scope**: 1 new file, 8 files updated to import from it.
