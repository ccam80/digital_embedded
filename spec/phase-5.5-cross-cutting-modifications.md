# Phase 5.5: Cross-Cutting Modifications

**Depends on**: Phases 1–5 (all implemented)
**Blocks**: Phase 6

## Overview

Modifications to already-implemented code required by design decisions made during Phase 6+ specification. These changes must land before Phase 6 implementation begins.

---

## Wave 5.5.1: Foundation Modifications

### Task 5.5.1 — Dark Mode Default Color Scheme

- **Description**: The default color scheme must be dark (black background). The existing `defaultColorScheme` in the renderer interface uses a light scheme. Create a dark color scheme and make it the default. Rename the existing light scheme to `lightColorScheme`.

  Wire color semantics for dark mode:
  | Semantic | Color | Hex |
  |----------|-------|-----|
  | Logic 1 | Bright green | `#00FF00` |
  | Logic 0 | Dim green | `#006600` |
  | High-Z | Blue | `#4444FF` |
  | Error/conflict | Red | `#FF0000` |
  | Undefined | Orange | `#FF8800` |
  | Background | Black | `#000000` |
  | Grid | Dark gray | `#222222` |
  | Component body fill | Dark gray | `#333333` |
  | Component body stroke | Light gray | `#CCCCCC` |
  | Text/labels | White | `#FFFFFF` |
  | Selected highlight | Yellow | `#FFFF00` |
  | Wire (no signal) | Gray | `#888888` |

- **Files to modify**:
  - `src/core/renderer-interface.ts`:
    - Rename `defaultColorScheme` to `lightColorScheme`
    - Add `darkColorScheme` with the colors above
    - Set `defaultColorScheme` = `darkColorScheme`
    - Update `COLOR_SCHEMES` registry to include `'dark'` and `'light'` entries
    - Add any missing `ThemeColor` keys needed for the semantic colors above (wire-logic-1, wire-logic-0, wire-high-z, wire-error, wire-undefined, grid, component-fill, component-stroke, selected)

- **Tests**:
  - `src/core/__tests__/renderer-interface.test.ts::DarkMode::darkIsDefault` — assert `defaultColorScheme` has background `#000000`
  - `src/core/__tests__/renderer-interface.test.ts::DarkMode::wireColorDistinct` — assert dark scheme wire colors for logic-1, logic-0, high-Z, error, undefined are all distinct from each other
  - `src/core/__tests__/renderer-interface.test.ts::DarkMode::lightPreserved` — assert `lightColorScheme` exists with non-black background
  - `src/core/__tests__/renderer-interface.test.ts::DarkMode::registryHasBoth` — assert `COLOR_SCHEMES` has entries for `'dark'` and `'light'`
  - `src/core/__tests__/renderer-interface.test.ts::DarkMode::contrastCheck` — assert text color has sufficient luminance contrast against background (ratio ≥ 4.5:1)

- **Acceptance criteria**:
  - `defaultColorScheme` is dark with black background
  - `lightColorScheme` preserves original light colors
  - Both schemes in `COLOR_SCHEMES` registry
  - All semantic wire/component colors defined
  - Sufficient contrast for readability
  - All existing tests still pass

---

### Task 5.5.2 — i18n Pass-Through Function

- **Description**: Introduce a minimal internationalization function for all UI strings. Initially a pass-through (returns the key unchanged). Phase 9 replaces with locale-aware lookup. This avoids retrofitting every string later.

  ```typescript
  // Pass-through implementation
  export function i18n(key: string, params?: Record<string, string | number>): string;
  export function setLocale(locale: string): void;  // no-op
  export function getLocale(): string;               // returns 'en'
  ```

- **Files to create**:
  - `src/i18n/index.ts` — `i18n()`, `setLocale()`, `getLocale()` pass-through implementations. No browser dependencies.

- **Tests**:
  - `src/i18n/__tests__/i18n.test.ts::passThrough::returnsKey` — `i18n('menu.file.open')` returns `'menu.file.open'`
  - `src/i18n/__tests__/i18n.test.ts::passThrough::ignoresParams` — `i18n('errors.notFound', { name: 'foo' })` returns `'errors.notFound'`
  - `src/i18n/__tests__/i18n.test.ts::locale::defaultEn` — `getLocale()` returns `'en'`
  - `src/i18n/__tests__/i18n.test.ts::locale::setNoOp` — `setLocale('de')` does not throw; `getLocale()` returns `'de'`

- **Acceptance criteria**:
  - `i18n()` function exists and returns keys unchanged
  - `setLocale()` and `getLocale()` work
  - No browser dependencies
  - All tests pass

---

### Task 5.5.3 — Engine Snapshot API

- **Description**: Add state snapshot and restore capability to the `SimulationEngine` interface. Required for the timing diagram's click-to-jump time travel (Phase 7).

  Add to `SimulationEngine` interface:
  ```typescript
  type SnapshotId = number;

  saveSnapshot(): SnapshotId;
  restoreSnapshot(id: SnapshotId): void;
  getSnapshotCount(): number;
  clearSnapshots(): void;
  setSnapshotBudget(bytes: number): void;
  ```

  Snapshots capture the full signal `Uint32Array` contents plus internal component state and the current step count. Stored in a ring buffer with configurable memory budget (default 512KB). Oldest snapshots evicted when budget exceeded. Restoring transitions the engine to PAUSED.

- **Files to modify**:
  - `src/core/engine-interface.ts` — Add `SnapshotId` type alias. Add `saveSnapshot()`, `restoreSnapshot()`, `getSnapshotCount()`, `clearSnapshots()`, `setSnapshotBudget()` to `SimulationEngine` interface.
  - `src/engine/digital-engine.ts` — Implement snapshot methods. Ring buffer backed by `ArrayBuffer` slices. Budget tracking. Eviction of oldest on overflow.
  - `src/test-utils/mock-engine.ts` — Add mock snapshot implementations (simple array storage, no budget enforcement).

- **Tests**:
  - `src/engine/__tests__/snapshot.test.ts::saveAndRestore` — set signal values, save snapshot, change signals, restore, assert signals match saved values
  - `src/engine/__tests__/snapshot.test.ts::multipleSnapshots` — save 3 snapshots at different states, restore the second, verify correct state
  - `src/engine/__tests__/snapshot.test.ts::ringBufferEviction` — set budget to 1KB, save snapshots until eviction occurs, verify oldest snapshot ID is no longer restorable
  - `src/engine/__tests__/snapshot.test.ts::restorePausesEngine` — start engine, restore snapshot, assert `getState()` is `PAUSED`
  - `src/engine/__tests__/snapshot.test.ts::clearSnapshots` — save 5 snapshots, `clearSnapshots()`, assert `getSnapshotCount()` is 0
  - `src/engine/__tests__/snapshot.test.ts::invalidIdThrows` — `restoreSnapshot(99999)` throws with descriptive error message

- **Acceptance criteria**:
  - `saveSnapshot()` captures full engine state
  - `restoreSnapshot()` restores state exactly and transitions to PAUSED
  - Ring buffer evicts oldest when budget exceeded
  - Default budget is 512KB
  - `clearSnapshots()` frees all stored snapshots
  - Invalid snapshot ID throws
  - Mock engine updated with working implementations
  - All existing engine tests still pass
  - All new tests pass

---

### Task 5.5.4 — .digb JSON Format Schema and Serializer

- **Description**: Define the `.digb` (Digital-in-Browser) native JSON format. This format supports embedded subcircuit definitions for self-contained circuit files. The `.digb` format is the native save format; `.dig` XML is the import format for Digital compatibility.

  Top-level schema:
  ```typescript
  interface DigbDocument {
    format: 'digb';
    version: 1;
    circuit: DigbCircuit;
    subcircuitDefinitions?: Record<string, DigbCircuit>;
  }

  interface DigbCircuit {
    name: string;
    description?: string;
    elements: DigbElement[];
    wires: DigbWire[];
    testData?: string;           // embedded test vectors (Digital test syntax)
    isGeneric?: boolean;
    genericInitCode?: string;    // HGS script for generic circuits
    attributes?: Record<string, string>;
  }

  interface DigbElement {
    type: string;                // component type name (registry lookup key)
    id: string;                  // unique element ID within circuit
    position: { x: number; y: number };
    rotation: number;            // 0, 90, 180, 270
    properties: Record<string, unknown>;
  }

  interface DigbWire {
    points: { x: number; y: number }[];
  }
  ```

- **Files to create**:
  - `src/io/digb-schema.ts` — TypeScript interfaces above. `validateDigbDocument(data: unknown): DigbDocument` validation function that checks structure, required fields, and types.
  - `src/io/digb-serializer.ts` — `serializeCircuit(circuit: Circuit): string` produces `.digb` JSON. `serializeWithSubcircuits(circuit: Circuit, subcircuits: Map<string, Circuit>): string` bundles subcircuit definitions.
  - `src/io/digb-deserializer.ts` — `deserializeDigb(json: string): { circuit: Circuit, subcircuits: Map<string, Circuit> }` parses `.digb` JSON back to `Circuit` objects.

- **Tests**:
  - `src/io/__tests__/digb-schema.test.ts::validate::validDocument` — valid DigbDocument passes validation
  - `src/io/__tests__/digb-schema.test.ts::validate::missingFormat` — missing `format` field throws
  - `src/io/__tests__/digb-schema.test.ts::validate::wrongVersion` — `version: 99` throws
  - `src/io/__tests__/digb-schema.test.ts::validate::missingCircuit` — missing `circuit` field throws
  - `src/io/__tests__/digb-schema.test.ts::serialize::roundTrip` — create Circuit, serialize, deserialize, serialize again → identical JSON output
  - `src/io/__tests__/digb-schema.test.ts::serialize::withSubcircuits` — serialize with 2 subcircuit definitions, deserialize, verify main circuit and both subcircuits present with correct names
  - `src/io/__tests__/digb-schema.test.ts::serialize::noSubcircuits` — serialize standalone circuit (no subcircuits), verify `subcircuitDefinitions` key absent from output
  - `src/io/__tests__/digb-schema.test.ts::serialize::preservesAllFields` — circuit with testData, description, all element properties → all preserved after round-trip

- **Acceptance criteria**:
  - Schema interfaces exported and documented
  - Validation rejects malformed documents with descriptive errors
  - Round-trip serialization preserves all data
  - Embedded subcircuit definitions work
  - Standalone circuits (no subcircuits) work
  - No browser dependencies
  - All tests pass
