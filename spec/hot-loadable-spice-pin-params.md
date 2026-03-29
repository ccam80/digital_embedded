# Spec: Hot-Loadable SPICE Model & Pin Electrical Parameters

## Status: Approved design, ready to implement

## Problem

SPICE model overrides (`_spiceModelOverrides`) and pin electrical overrides (`_pinElectricalOverrides`) are stored as JSON strings in PropertyBag, parsed once at compile time, then frozen into `const` locals or `readonly` fields on compiled elements. This means:

1. Changes don't take effect until stop/recompile/start
2. The JSON string type prevents individual parameters from flowing through `setParam(key, value)`
3. The property panel's per-field numeric inputs commit by re-serializing the entire JSON blob — an impedance mismatch with the rest of the property system

## Design Decisions

- **Add `Record<string, number>` to `PropertyValue`** — covers SPICE params directly as a native bag type
- **Pin electrical uses flattened keys** — `"pinLabel.field"` (e.g., `"A.rOut"`, `"B.vIH"`) stored in a single `Record<string, number>`
- **JSON string storage is eliminated** — both override types become `Record<string, number>` values in PropertyBag
- **Serialization already works** — `JSON.stringify` handles nested objects; `JSON.parse` restores them; `serializePropertyValue()` and `restorePropertyValue()` pass non-bigint values through unchanged
- **Hot-load via `setParam()`** — same path as resistance/voltage: popup fires `onPropertyChange(key, old, new)` → coordinator calls `el.setParam(key, value)` → engine re-stamps
- **Backward compatibility** — deserializer must accept both old JSON string format and new object format during migration

## Changes Required

### 1. Core: Widen PropertyValue

**File:** `src/core/properties.ts`

```typescript
// Before
export type PropertyValue = number | string | boolean | bigint | number[];

// After
export type PropertyValue = number | string | boolean | bigint | number[] | Record<string, number>;
```

### 2. Deserializer: Accept both formats

**File:** `src/io/dts-deserializer.ts` — `restorePropertyValue()`

When restoring a property value that is a string AND the key is `_spiceModelOverrides` or `_pinElectricalOverrides`, attempt `JSON.parse` to convert legacy JSON strings to objects. New-format files will already have the object inline.

### 3. SPICE Model Overrides — Remove JSON wrapping

#### 3a. Property panel: fire per-param callbacks

**File:** `src/editor/property-panel.ts` — `showSpiceModelParameters()` (lines ~530-565)

Current `commitOverride()`:
- Reads full `_spiceModelOverrides` JSON string from bag
- Parses, updates one key, re-serializes, writes back
- Fires `cb("_spiceModelOverrides", oldJson, newJson)`

New `commitOverride()`:
- Reads `_spiceModelOverrides` as `Record<string, number>` from bag (or `{}` if absent)
- Updates the single key on the object, writes object back to bag
- Fires `cb(paramKey, oldNumericValue, newNumericValue)` — individual param key like `"IS"`, `"BF"`, `"VTO"`
- This flows through `onPropertyChange` → `coordinator.setComponentProperty()` → `el.setParam()`

#### 3b. Compiler: read Record instead of JSON string

**File:** `src/solver/analog/compiler.ts` (lines ~1353-1368)

Current:
```typescript
const overrides = JSON.parse(props.get("_spiceModelOverrides") as string) as Record<string, number>;
```

New:
```typescript
const overrides = props.get<Record<string, number>>("_spiceModelOverrides");
```

No JSON.parse needed — the value is already a `Record<string, number>`.

#### 3c. SPICE import dialog: store object, not JSON string

**File:** `src/app/spice-model-apply.ts` — `applySpiceImportResult()`

Current:
```typescript
element.getProperties().set('_spiceModelOverrides', result.overridesJson);
```

New: store the parsed object directly. The `SpiceImportResult` type changes `overridesJson: string` to `overrides: Record<string, number>`.

**File:** `src/io/spice-model-builder.ts` — `buildModelOverrides()`

Same: produce `Record<string, number>` instead of `JSON.stringify`'d string.

#### 3d. Semiconductor element factories: mutable params + setParam

**Files:** All semiconductor element factories:
- `src/components/semiconductors/diode.ts`
- `src/components/semiconductors/bjt.ts`
- `src/components/semiconductors/mosfet.ts`
- `src/components/semiconductors/njfet.ts`
- `src/components/semiconductors/pjfet.ts`
- `src/components/semiconductors/zener.ts`
- `src/components/semiconductors/schottky.ts`
- `src/components/semiconductors/tunnel-diode.ts`
- `src/components/semiconductors/diac.ts`
- `src/components/semiconductors/scr.ts`
- `src/components/semiconductors/triac.ts`

Pattern for each factory:

```typescript
// Before: const locals frozen at construction
const IS = mp["IS"] ?? defaults.IS;
const N  = mp["N"]  ?? defaults.N;
// ... used directly in stampNonlinear

// After: mutable params object, read in stamp methods
const params = { IS: mp["IS"] ?? defaults.IS, N: mp["N"] ?? defaults.N, ... };

return {
  setParam(key: string, value: number): void {
    if (key in params) (params as Record<string, number>)[key] = value;
  },

  stampNonlinear(solver) {
    // reads params.IS, params.N instead of captured const IS, N
  },
  ...
};
```

Nonlinear elements (diode, BJT, MOSFET, JFET) already recompute their operating point from parameters every NR iteration in `stampNonlinear()`, so changing the params object is sufficient — the next stamp picks up the new values automatically.

#### 3e. Property definitions: change type from STRING to hidden

**Files:** All semiconductor component definitions (same list as 3d)

Each has:
```typescript
{ key: "_spiceModelOverrides", type: PropertyType.STRING, label: "SPICE Model Overrides", defaultValue: "", hidden: true }
```

Change `defaultValue` from `""` to `{}` (empty Record). The `hidden: true` already keeps it out of the standard property panel rows — the SPICE params section renders its own UI.

### 4. Pin Electrical Overrides — Flatten and remove JSON wrapping

#### 4a. Flatten to `Record<string, number>` with composite keys

Current storage: `{ "A": { "rOut": 50, "vOH": 4.5 }, "B": { "rIn": 10000 } }` as JSON string.

New storage: `{ "A.rOut": 50, "A.vOH": 4.5, "B.rIn": 10000 }` as `Record<string, number>`.

Key format: `"pinLabel.fieldName"` where fieldName is one of: `rOut`, `rIn`, `vOH`, `vOL`, `vIH`, `vIL`.

#### 4b. Property panel: fire per-pin-param callbacks

**File:** `src/editor/property-panel.ts` — `showPinElectricalOverrides()` (lines ~402-434)

Current `commitOverride()`:
- Reads full `_pinElectricalOverrides` JSON, updates one field, re-serializes
- Fires `cb("_pinElectricalOverrides", oldJson, newJson)`

New `commitOverride()`:
- Reads `_pinElectricalOverrides` as `Record<string, number>` from bag
- Updates the single composite key (e.g., `"A.rOut"`)
- Fires `cb("A.rOut", oldValue, newValue)` — individual numeric param

#### 4c. Compiler: read Record with composite keys

**File:** `src/solver/analog/compiler.ts` (lines ~1202-1210, ~1309-1332)

Current: `JSON.parse(props.get("_pinElectricalOverrides") as string)` → nested object
New: `props.get<Record<string, number>>("_pinElectricalOverrides")` → flat object with composite keys

Split composite keys when building per-pin specs:
```typescript
const overrides = props.getOrDefault<Record<string, number>>("_pinElectricalOverrides", {});
// For pin "A", extract { rOut: overrides["A.rOut"], vOH: overrides["A.vOH"], ... }
```

#### 4d. Pin models: mutable spec + setParam

**File:** `src/solver/analog/digital-pin-model.ts`

`DigitalOutputPinModel`:
- Change `private readonly _spec` to `private _spec`
- Add `setParam(key, value)` — e.g., `setParam("rOut", 50)` → `this._spec.rOut = value`
- `stamp()` already reads `this._spec` each call — picks up changes automatically

`DigitalInputPinModel`:
- Same pattern for `rIn`, `vIH`, `vIL`

#### 4e. Bridge adapters: expose setParam passthrough

**File:** `src/solver/analog/bridge-adapter.ts`

Bridge adapters wrap pin models. Add `setParam(key, value)` that routes to the inner model:
```typescript
setParam(key: string, value: number): void {
  this._pinModel.setParam(key, value);
}
```

#### 4f. Coordinator: route pin params to bridge adapters

**File:** `src/solver/coordinator.ts` — `setComponentProperty()`

Current: only routes to `el.setParam()` on the `AnalogElement`.

For composite pin-param keys (containing `.`), route to the bridge adapter for that pin instead. This requires the compiled circuit to track which bridge adapters belong to which CircuitElement — either via a new map on `ConcreteCompiledAnalogCircuit` or by having the coordinator resolve it from the resolver context.

**File:** `src/solver/analog/compiled-analog-circuit.ts` (or equivalent)

Add: `elementBridgeAdapters: Map<number, BridgeAdapter[]>` — populated during compilation, maps element index to its bridge adapters.

### 5. Backward Compatibility

**Deserializer migration** (`src/io/dts-deserializer.ts`):

In `restorePropertyValue()`, when the raw value is a string that looks like JSON object (starts with `{`), and the property key is `_spiceModelOverrides` or `_pinElectricalOverrides`:
- Parse the JSON string into an object
- For `_pinElectricalOverrides`: flatten the nested structure to composite keys

This handles loading old `.dts` files with JSON-string format. New saves will write the native object.

**Serializer**: No changes needed — `JSON.stringify` handles `Record<string, number>` natively.

### 6. _valuesEqual update

**File:** `src/editor/property-panel.ts` — `_valuesEqual()`

Currently handles arrays. Add shallow `Record<string, number>` comparison:
```typescript
if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
  const keysA = Object.keys(a); const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) if ((a as any)[k] !== (b as any)[k]) return false;
  return true;
}
```

## Implementation Order

1. Widen `PropertyValue` (enables everything else)
2. SPICE model params on semiconductor factories (`setParam` + mutable params)
3. SPICE property panel → per-param callbacks
4. SPICE compiler/import: read Record instead of JSON string
5. Backward compat in deserializer
6. Pin electrical: flatten keys, mutable pin model specs, `setParam`
7. Pin electrical: bridge adapter routing from coordinator
8. Pin electrical: property panel per-pin-param callbacks

## Files Changed (complete list)

| File | Change |
|------|--------|
| `src/core/properties.ts` | Widen `PropertyValue` |
| `src/core/analog-types.ts` | Already done — `setParam?` on `AnalogElementCore` |
| `src/solver/analog/element.ts` | Already done — `setParam?` on `AnalogElement` |
| `src/solver/coordinator.ts` | Route composite pin keys to bridge adapters |
| `src/solver/analog/compiler.ts` | Read Record instead of JSON.parse |
| `src/solver/analog/digital-pin-model.ts` | Mutable `_spec`, add `setParam` |
| `src/solver/analog/bridge-adapter.ts` | `setParam` passthrough to pin model |
| `src/solver/analog/compiled-analog-circuit.ts` | `elementBridgeAdapters` map |
| `src/editor/property-panel.ts` | Per-param callbacks in SPICE and pin sections; `_valuesEqual` for Records |
| `src/io/dts-deserializer.ts` | Backward compat: JSON string → object migration |
| `src/app/spice-model-apply.ts` | Store object, not JSON string |
| `src/io/spice-model-builder.ts` | Produce object, not JSON string |
| `src/components/semiconductors/diode.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/bjt.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/mosfet.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/njfet.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/pjfet.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/zener.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/schottky.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/tunnel-diode.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/diac.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/scr.ts` | Mutable params + `setParam` |
| `src/components/semiconductors/triac.ts` | Mutable params + `setParam` |
