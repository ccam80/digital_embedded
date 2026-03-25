# allNodeIds Audit — Missing Fields Across Mocks, Factories, and Production Code

## Context

`AnalogElement` has two required fields: `pinNodeIds` (pin nodes in pinLayout order) and `allNodeIds` (pins + internal nodes). The compiler sets both at `src/analog/compiler.ts` ~line 906. But many test files and factory helpers create AnalogElement objects that bypass the compiler, and these don't set `allNodeIds`.

Currently, three defensive fallbacks exist:
- `src/analog/dc-operating-point.ts:339` — `el.allNodeIds ?? []`
- `src/analog/newton-raphson.ts:232` — `el.pinNodeIds ?? []`
- `src/analog/analog-engine.ts:347` — `el.pinNodeIds?.length ?? 0`

All three must be removed after every mock/factory provides the required fields.

---

## Section 1: test-elements.ts (`src/analog/test-elements.ts`)

All 7 factory functions already have both `pinNodeIds` and `allNodeIds`. **No fixes needed.**

| Factory | Line | `pinNodeIds` | `allNodeIds` | Status |
|---------|------|:---:|:---:|--------|
| `makeResistor` | 74 | Yes | Yes | OK |
| `makeVoltageSource` | 130 | Yes | Yes | OK |
| `makeCurrentSource` | 188 | Yes | Yes | OK |
| `makeDiode` | 251 | Yes | Yes | OK |
| `makeCapacitor` | 363 | Yes | Yes | OK |
| `makeInductor` | 456 | Yes | Yes | OK |
| `makeAcVoltageSource` | 546 | Yes | Yes | OK |

---

## Section 2: Inline Test Mocks Missing `allNodeIds`

| File | Line(s) | How created | Fix |
|------|---------|-------------|-----|
| `src/analog/__tests__/compiler.test.ts` | 87, 97, 107 | `makeTestResistorElement`, `makeTestVsElement`, `makeTestInductorElement` | Add `allNodeIds: [nodeA, nodeB]` |
| `src/analog/__tests__/analog-compiler.test.ts` | 83 | `makeStubElement` | Add `allNodeIds: nodeIds` |
| `src/analog/__tests__/timestep.test.ts` | 41, 57 | `makeReactiveElement`, `makeNonReactiveElement` | Add `allNodeIds: [1, 0]` |
| `src/analog/__tests__/bridge-diagnostics.test.ts` | 294 | inline analog factory lambda | Add `allNodeIds: [...pinNodes.values()]` |
| `src/analog/__tests__/bridge-compiler.test.ts` | 106 | inline analog factory lambda | Add `allNodeIds: [...pinNodes.values()]` |
| `src/analog/__tests__/digital-bridge-path.test.ts` | 62, 92 | `makeStubAnalogElement` + inline | Add `allNodeIds` matching `pinNodeIds` |
| `src/analog/__tests__/model-binding.test.ts` | 213 | inline stub element | Add `allNodeIds: [...pinNodes.values()]` |
| `src/analog/__tests__/transistor-expansion.test.ts` | 95 | `makeMosfetAnalogElement` | Add `allNodeIds: [...nodeIds]` |
| `src/analog/__tests__/behavioral-gate.test.ts` | 416, 435, 482, 494, 506 | `Object.assign(element, { pinNodeIds })` | Add `allNodeIds` to each `Object.assign` |
| `src/analog/__tests__/behavioral-flipflop.test.ts` | 344 | `Object.assign(element, { pinNodeIds: [1,2,3,4] })` | Add `allNodeIds: [1,2,3,4]` |
| `src/analog/__tests__/behavioral-sequential.test.ts` | 417, 437 | `Object.assign(element, { pinNodeIds })` | Add matching `allNodeIds` |
| `src/analog/__tests__/controlled-source-base.test.ts` | 29 | class field `readonly pinNodeIds = [1, 0]` | Add `readonly allNodeIds: readonly number[] = [1, 0]` |
| `src/components/semiconductors/__tests__/bjt.test.ts` | 336, 440, 449 | `Object.assign(element, { pinNodeIds })` | Add matching `allNodeIds` |
| `src/components/semiconductors/__tests__/mosfet.test.ts` | 84, 271 | `Object.assign(element, { pinNodeIds })` | Add `allNodeIds` |
| `src/components/semiconductors/__tests__/triode.test.ts` | 337 | `Object.assign(elem, { pinNodeIds })` | Add `allNodeIds` |
| `src/components/semiconductors/__tests__/tunnel-diode.test.ts` | 243, 257 | inline element literals | Add `allNodeIds` |
| `src/components/semiconductors/__tests__/diode.test.ts` | 236 | inline helper | Add `allNodeIds` |
| `src/components/semiconductors/__tests__/zener.test.ts` | 60 | inline helper | Add `allNodeIds` |
| `src/components/semiconductors/__tests__/scr.test.ts` | 52 | inline helper | Add `allNodeIds` |
| `src/components/semiconductors/__tests__/jfet.test.ts` | 118 | inline helper | Add `allNodeIds` |
| `src/components/passives/__tests__/capacitor.test.ts` | 61 | `Object.assign(el, { pinNodeIds })` | Add `allNodeIds` |
| `src/components/passives/__tests__/inductor.test.ts` | 62 | `Object.assign(el, { pinNodeIds })` | Add `allNodeIds` |
| `src/components/passives/__tests__/memristor.test.ts` | 44 | `Object.assign(el, { pinNodeIds: [1,2] })` | Add `allNodeIds: [1,2]` |
| `src/components/passives/__tests__/resistor.test.ts` | 103 | inline element | Add `allNodeIds` |
| `src/components/passives/__tests__/polarized-cap.test.ts` | 64 | inline element | Add `allNodeIds` |
| `src/components/passives/__tests__/crystal.test.ts` | 240 | inline element | Add `allNodeIds` |
| `src/components/passives/__tests__/analog-fuse.test.ts` | 315 | inline element | Add `allNodeIds` |
| `src/components/passives/__tests__/transformer.test.ts` | 130, 184, 258, 331, 408, 480, 532 | inline/factory elements | Add `allNodeIds` |
| `src/components/passives/__tests__/tapped-transformer.test.ts` | 46, 98, 186, 273 | inline/factory elements | Add `allNodeIds` |
| `src/components/active/__tests__/real-opamp.test.ts` | 59 | `Object.assign` | Add `allNodeIds` (lines 69, 91 already have it) |
| `src/components/io/__tests__/led.test.ts` | 719 | `makeResistorElementForLed` | Add `allNodeIds` |
| `src/components/io/__tests__/probe.test.ts` | 377, 393, 430 | `Object.assign(el, { pinNodeIds: [N] })` | Add `allNodeIds: [N]` |
| `src/components/sources/__tests__/ground.test.ts` | 96 | `Object.assign(element, { pinNodeIds: [5] })` | Add `allNodeIds: [5]` |
| `src/components/sources/__tests__/variable-rail.test.ts` | 21 | inline element | Add `allNodeIds` |
| `src/components/sensors/__tests__/ldr.test.ts` | 34 | `Object.assign(el, { pinNodeIds: [1,2] })` | Add `allNodeIds: [1,2]` |
| `src/components/sensors/__tests__/ntc-thermistor.test.ts` | 50 | `Object.assign(el, { pinNodeIds: [1,2] })` | Add `allNodeIds: [1,2]` |
| `src/components/sensors/__tests__/spark-gap.test.ts` | 35 | `Object.assign(el, { pinNodeIds: [1,2] })` | Add `allNodeIds: [1,2]` |
| `src/editor/__tests__/wire-current-resolver.test.ts` | 38 | `makeMockElement` factory | Add `allNodeIds: pinNodeIds` (see Section 4) |
| `src/editor/__tests__/analog-tooltip.test.ts` | 85 | inline `{ pinNodeIds: [...] }` | Add `allNodeIds` |
| `src/editor/__tests__/slider-panel.test.ts` | 288 | inline mock element | Add `allNodeIds: [1, 0]` |

---

## Section 3: ControlledSourceElement Structural Gap

**File:** `src/analog/controlled-source-base.ts`

**What it is:** An abstract base class implementing `AnalogElementCore` (which by definition omits `pinNodeIds` and `allNodeIds`). The compiler adds both fields via `Object.assign` after factory construction.

**Current state:**
- Line 83: `export abstract class ControlledSourceElement implements AnalogElementCore`
- Line 84: `pinNodeIds!: readonly number[];` — declared with `!` (definite assignment assertion), set by compiler
- `allNodeIds` is **not declared**

**Concrete subclasses** (all extend `ControlledSourceElement`):
1. `VCVSAnalogElement` — `src/components/active/vcvs.ts:108`
2. `VCCSAnalogElement` — `src/components/active/vccs.ts:110`
3. `CCVSAnalogElement` — `src/components/active/ccvs.ts:119`
4. `CCCSAnalogElement` — `src/components/active/cccs.ts:121`

**Fix:** Add `allNodeIds!: readonly number[];` at line ~85, parallel to the existing `pinNodeIds!` declaration. The compiler already sets it at runtime via `Object.assign`. The test subclass in `controlled-source-base.test.ts` line 29 also needs `readonly allNodeIds: readonly number[] = [1, 0]`.

---

## Section 4: wire-current-resolver.test.ts Cast

**File:** `src/editor/__tests__/wire-current-resolver.test.ts`

**The cast (lines 36–44):**
```typescript
function makeMockElement(pinNodeIds: number[], branchIndex = -1): AnalogElement {
  return {
    pinNodeIds,
    branchIndex,
    stamp() {},
    isNonlinear: false,
    isReactive: false,
  } as unknown as AnalogElement;
}
```

**Missing fields:** `allNodeIds`, `getPinCurrents`

**Fix:** Add `allNodeIds: pinNodeIds` and `getPinCurrents() { return pinNodeIds.map(() => 0); }`, then remove the `as unknown` escape hatch.

---

## Section 5: Production Code Missing `allNodeIds`

| File | Line | Class/Function | Severity |
|------|------|----------------|----------|
| `src/analog/bridge-adapter.ts` | 41 | `BridgeOutputAdapter implements AnalogElement` | **CRITICAL** |
| `src/analog/bridge-adapter.ts` | 193 | `BridgeInputAdapter implements AnalogElement` | **CRITICAL** |
| `src/analog/controlled-source-base.ts` | 83 | `ControlledSourceElement` (abstract) | Medium (compiler adds it) |
| `src/analog/transistor-expansion.ts` | 232 | `Object.assign(core, { pinNodeIds: remappedNodes })` | **CRITICAL** |
| `src/components/passives/analog-fuse.ts` | 76 | `AnalogFuseElement implements AnalogElement` | **CRITICAL** |
| `src/components/passives/polarized-cap.ts` | 218 | `AnalogPolarizedCapElement implements AnalogElement` | **CRITICAL** |
| `src/components/passives/potentiometer.ts` | 214 | `AnalogPotentiometerElement implements AnalogElement` | **CRITICAL** |
| `src/components/passives/crystal.ts` | 208 | `AnalogCrystalElement implements AnalogElement` | **CRITICAL** |
| `src/components/passives/tapped-transformer.ts` | 186 | `AnalogTappedTransformerElement implements AnalogElement` | **CRITICAL** |
| `src/components/passives/transformer.ts` | 179 | `AnalogTransformerElement implements AnalogElement` | **CRITICAL** |

**Note:** Classes implementing `AnalogElementCore` (capacitor, inductor, resistor, memristor, behavioral elements, FET base, etc.) are fine — the compiler adds both fields via `Object.assign`. The `Omit` design is intentional. But classes implementing `AnalogElement` directly must provide `allNodeIds` themselves.

---

## Section 6: Summary

**Total locations needing fixes: ~55** (across 40+ files)

| Fix Type | Count | Description |
|----------|:-----:|-------------|
| Production `implements AnalogElement` classes missing `allNodeIds` | **8** | Bridge adapters (2), analog-fuse, polarized-cap, potentiometer, crystal, tapped-transformer, transformer |
| Production `Object.assign` missing `allNodeIds` | **1** | `transistor-expansion.ts:232` |
| Abstract base class missing `allNodeIds!` declaration | **1** | `ControlledSourceElement` |
| Test inline factories/helpers missing `allNodeIds` | **~12** | Standalone factory functions in test files |
| Test `Object.assign` calls missing `allNodeIds` | **~25** | `Object.assign(el, { pinNodeIds })` without `allNodeIds` |
| Test inline element literals missing `allNodeIds` | **~8** | Direct `{ pinNodeIds: [...] }` literals |

### Recommended fix order

1. **Production classes first** (8 `implements AnalogElement` classes + 1 `Object.assign` in transistor-expansion). These are real runtime bugs waiting to surface.
2. **`ControlledSourceElement`** — add `allNodeIds!` declaration for type safety.
3. **Test files** — bulk fix all ~45 locations. For simple 2-terminal elements, `allNodeIds` equals `pinNodeIds`. For elements with internal nodes, `allNodeIds` must include them.
4. **Remove defensive fallbacks** in the 3 production files.
5. **Remove `as unknown as AnalogElement` cast** in wire-current-resolver.test.ts.

### Defensive fallbacks to remove (after all fixes)

| File | Line | Current | After |
|------|------|---------|-------|
| `src/analog/dc-operating-point.ts` | 339 | `el.allNodeIds ?? []` | `el.allNodeIds` |
| `src/analog/newton-raphson.ts` | 232 | `el.pinNodeIds ?? []` | `el.pinNodeIds` |
| `src/analog/analog-engine.ts` | 347 | `el.pinNodeIds?.length ?? 0` | `el.pinNodeIds.length` |
