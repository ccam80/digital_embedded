# A5 follow-up — pin-aware factories for direct-construction MNA classes

## Problem

Four MNA element classes are constructed via direct `new` constructors that take physical parameters only and rely on the compiler to inject pin topology after construction:

- `src/components/sensors/ldr.ts` — `new LDRElement(rDark, lux, gamma, luxRef)`
- `src/components/sensors/ntc-thermistor.ts` — `new NTCThermistorElement(R0, B, T0, ...)`
- `src/components/sensors/spark-gap.ts` — `new SparkGapElement(rOff, vBreakdown, rOn, hyst)`
- `src/components/passives/analog-fuse.ts` — `new AnalogFuseElement([posId, negId], rCold, rBlown, i2t)` (takes `pinNodeIds` array but the `_pinNodes: Map` is patched separately by the compiler — dual source of truth)

Because `_pinNodes` is populated post-construction by the compiler in production, unit tests that drive `MNAEngine._setup()` directly must inject `_pinNodes` via `el._pinNodes = new Map([...])` after `new`. That bypass is observable in `src/solver/analog/__tests__/setup-stamp-order.test.ts` at the FUSE / LDR / NTC / SPARK rows. It is not a test softening that can be removed without an architectural change.

## Goal

Align these four classes with the existing factory pattern used by diode, BJT, capacitor, CCCS, etc.:

```ts
// Existing pattern (diode):
const el = createDiodeElement(new Map([["A", 1], ["K", 2]]), props);

// Target pattern after this task:
const el = createLDRElement(new Map([["pos", 1], ["neg", 2]]), props);
const el = createNTCThermistorElement(new Map([["pos", 1], ["neg", 2]]), props);
const el = createSparkGapElement(new Map([["pos", 1], ["neg", 2]]), props);
const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 2]]), props);
```

The factory:

1. Accepts `(pinNodes: Map<string, number>, props: PropertyBag)` as canonical signature (third arg `getTime?: () => number` if other factories in the codebase expect it — match the existing 3-param shape from spec/setup-load-split/plan.md A6.3).
2. Constructs the element instance.
3. Populates `el._pinNodes` and `el.pinNodeIds` from the supplied map — i.e. moves what the compiler does post-construction *into* the factory.
4. Reads physical params (`rDark`, `lux`, `R0`, `B`, etc.) from the `PropertyBag` rather than from positional args.
5. Returns the element typed as `AnalogElementCore`.

## Affected files

Production:
- `src/components/sensors/ldr.ts` — add `createLDRElement(...)`; update `LDRDefinition.modelRegistry` factory entry to use it
- `src/components/sensors/ntc-thermistor.ts` — same
- `src/components/sensors/spark-gap.ts` — same
- `src/components/passives/analog-fuse.ts` — same; remove the `pinNodeIds` array from the constructor (now redundant with the `_pinNodes` Map populated by the factory)

Tests (mechanical update of construction sites):
- `src/solver/analog/__tests__/setup-stamp-order.test.ts` — replace post-construction `_pinNodes`/`pinNodeIds` patches at the FUSE, LDR, NTC, SPARK rows with factory calls
- `src/components/sensors/__tests__/ldr.test.ts`, `ntc-thermistor.test.ts`, `spark-gap.test.ts`, `src/components/passives/__tests__/analog-fuse.test.ts` — same construction-site update where applicable
- `src/components/switching/__tests__/fuse.test.ts` — verify which fuse class it uses (PB-FUSE owner is `src/components/switching/fuse.ts`, distinct from `analog-fuse.ts`)

Compiler:
- `src/solver/analog/compiler.ts` — find any site that does `new LDRElement(...)` / `new NTCThermistorElement(...)` / etc. directly, and route through the new factories. The model-registry entry change in step 1 should make this naturally fall out, but search to confirm.

## Out of scope

- Do NOT change the constructor signatures of other classes (diode, BJT, etc.) — they are already pin-aware via their factories.
- Do NOT touch CCCS / CCVS / VCCS / VCVS classes — they have factory wrappers already and the `_pinNodes` patches in setup-stamp-order.test.ts at the CCCS/CCVS rows use the bare `new Xxx()` constructor for unrelated mechanical reasons (e.g., they're built before `senseSourceLabel` is set). Those stay as-is for this task.
- Do NOT alter PB-LDR / PB-NTC / PB-SPARK / PB-AFUSE / PB-FUSE specs — the spec already says factories use `(pinNodes, props, getTime)`. This task brings the implementation in line.

## Verification

1. `npx tsc --noEmit --skipLibCheck` — clean.
2. `setup-stamp-order.test.ts` FUSE/LDR/NTC/SPARK rows pass without `el._pinNodes = new Map(...)` patches.
3. Existing component tests in `__tests__/ldr.test.ts`, `ntc-thermistor.test.ts`, `spark-gap.test.ts`, `analog-fuse.test.ts` still pass.
4. No banned closing verdicts in any commit message.

## Why this isn't urgent

The post-construction `_pinNodes` patch works correctly at runtime — it produces the same element state the compiler would produce. The argument for this task is hygiene: tests should not duplicate compiler responsibilities, and the existing factory pattern is the established convention for the rest of the codebase.
