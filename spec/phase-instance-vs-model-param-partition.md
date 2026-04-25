# Phase: Instance vs Model Param Partition

## Overview

Today the netlist harness drops every key from `props.getModelParamKeys()` onto the
`.model` card unless it appears in a hardcoded `NON_MODEL_KEYS` blacklist in
`src/solver/analog/__tests__/harness/netlist-generator.ts`. Because each
semiconductor declares `OFF`, `TEMP`, `IC*`, `AREA`, `SUBS`, multiplicity `M`,
and (for MOSFET) `W` / `L` as model params, those keys flow onto the
`.model` card. ngspice treats them as instance-only and either parses them
incorrectly or hangs the test runner.

The fix is structural, not cosmetic:

1. Each semiconductor component declares which of its params are instance
   parameters and which are model parameters via a new `instance` bucket in
   `defineModelParams`. Param values are still stored and read through the
   same `getModelParam(key)` API; only the **schema classification** changes.
2. The netlist generator partitions a component's params using
   `ParamDef.partition` (read from the active model in the
   `ComponentRegistry`). Instance params are emitted on the element line.
   Model params are emitted on the `.model` card. The `NON_MODEL_KEYS`
   hardcoded blacklist is deleted.
3. Per-device ngspice translation rules (param renames such as our `ISW` ↔
   ngspice `JSW`, the `LEVEL=3` model-card prefix triggered by tunnel
   parameters, and the "drop-if-zero" rule for MOSFET `NSUB` / `NSS`) live
   in a single `DEVICE_NETLIST_RULES` table inside `netlist-generator.ts`.
   Components do not know how ngspice spells things.

After this phase no semiconductor parity test should hang on the
ngspice-side parser. The schema accurately reports which partition each
parameter belongs to, so non-default `OFF` / `TEMP` / `IC*` / `AREA` /
`SUBS` values can be driven through the harness for parity comparisons.

## Concrete reference patterns

These patterns are referenced by name from individual tasks below.
**Implementers must use these exact snippets — do not invent variants.**

### REF-A: Registry plumbing

`generateSpiceNetlist` gains a required `registry: ComponentRegistry`
parameter (added as the **second** positional argument; existing
arguments shift right):

```ts
export function generateSpiceNetlist(
  compiled: ConcreteCompiledAnalogCircuit,
  registry: ComponentRegistry,
  elementLabels: Map<number, string>,
  title?: string,
): string
```

Import: `import { ComponentRegistry } from "../../../../core/registry.js";`

The single production call site `src/solver/analog/__tests__/harness/comparison-session.ts:503` already has a `ComponentRegistry` in scope at line 446 (`const registry = createDefaultRegistry();`). Plumb it through to the call. The signature change is additive at every existing call site (insert `registry` as the second argument). All test call sites must be updated to pass `createDefaultRegistry()` (imported from `src/components/register-all.js`).

### REF-B: Per-element registry lookup (inside `generateSpiceNetlist`)

For each compiled element with a `modelType` (i.e. a semiconductor
prefix `D` / `Q` / `M` / `J`):

```ts
const def = registry.get(typeId);
if (!def) {
  throw new Error(`netlist-generator: typeId "${typeId}" not registered`);
}
const modelKey = props.has("model")
  ? props.get<string>("model")
  : (def.defaultModel ?? "");
const modelEntry = def.modelRegistry?.[modelKey];
if (!modelEntry) {
  throw new Error(`netlist-generator: typeId "${typeId}" has no modelRegistry["${modelKey}"]`);
}
const paramDefs: ParamDef[] = modelEntry.paramDefs;
```

`ParamDef` and `ComponentRegistry` are imported from
`../../../../core/registry.js`.

### REF-C: Partition rule

A param key is **instance** if its `ParamDef.partition === "instance"`.
Any other value (including `undefined` and `"model"`) means **model**.

Routing:
- Instance: appended to the element line as ` KEY=value` (one space, no
  parentheses) **only when `Number.isFinite(value)`**.
- Model: emitted inside the `.model` card's parenthesised block as
  `KEY=value` (space-separated) **only when `Number.isFinite(value)`**.

### REF-D: Emission order

Both element-line and model-card emission walk `paramDefs[]` in order
and emit only the keys whose `props.hasModelParam(key)` returns true and
whose value is finite. `paramDefs[]` order is fixed by
`defineModelParams`: primary, then secondary, then instance.

### REF-E: Walker scope

The partition walker runs **only** in the four semiconductor branches
(`spec.prefix === "D"`, `"Q"`, `"M"`, `"J"`). The Resistor, Capacitor,
Inductor, DcVoltageSource, AcVoltageSource, DcCurrentSource, and
AcCurrentSource branches are unchanged byte-for-byte.

### REF-F: `defineModelParams` call-site shape

The `instance:` block goes textually **after** the `secondary:` block
inside the same `defineModelParams({ ... })` call. The same call still
returns one `paramDefs[]` and one merged `defaults` record; no other
call-site shape change.

### REF-G: Test scaffolding

Existing tests in
`src/solver/analog/__tests__/harness/netlist-generator.test.ts` use
`makeCompiled(elements, ce)` and call `generateSpiceNetlist(compiled, …)`.
After REF-A, those call sites must pass a registry. Update
`makeCompiled` to accept and store a registry, and replace every
`generateSpiceNetlist(compiled, …)` call with
`generateSpiceNetlist(compiled, testRegistry, …)` where `testRegistry`
is built once at the top of the file:

```ts
import { createDefaultRegistry } from "../../../../components/register-all.js";
const testRegistry = createDefaultRegistry();
```

Tests that currently use synthetic typeIds (`"Resistor"`, `"NpnBJT"`,
etc.) all map to real `ComponentDefinition` entries in
`createDefaultRegistry()`, so no test fixture invention is required.

## Wave 1: Schema Infrastructure

### Task 1.1: Add `partition` field to `ParamDef`

- **Description**: Extend the `ParamDef` interface (`src/core/registry.ts:33-43`) with an optional `partition` field. Storage in `PropertyBag._mparams` is unchanged; this is schema metadata only.
- **Files to modify**:
  - `src/core/registry.ts` — replace the existing `ParamDef` interface block at lines 33–43 with:
    ```ts
    export interface ParamDef {
      key: string;
      type: PropertyType;
      label: string;
      unit?: string;
      description?: string;
      rank: "primary" | "secondary";
      /**
       * SPICE-emission partition. "instance" means the param is emitted on the
       * element line (e.g. `D1 a k MOD AREA=2 OFF=1`) and is NOT a `.model` card
       * parameter. Anything else (including `undefined`) is treated as "model"
       * and emitted on the `.model` card. Defaulting to undefined preserves
       * compatibility with hand-authored ParamDef literals outside
       * defineModelParams().
       */
      partition?: "instance" | "model";
      min?: number;
      max?: number;
      default?: number;
    }
    ```
- **Tests** (extend the existing file `src/core/__tests__/registry.test.ts`; do NOT create a new file):
  - `describe("ParamDef.partition")::it("accepts omitted partition (defaults to undefined)")` — write `const d: ParamDef = { key: "X", type: PropertyType.FLOAT, label: "X", rank: "primary" }; expect(d.partition).toBeUndefined();`
  - `describe("ParamDef.partition")::it("accepts partition: 'instance'")` — write `const d: ParamDef = { key: "OFF", type: PropertyType.FLOAT, label: "OFF", rank: "secondary", partition: "instance" }; expect(d.partition).toBe("instance");`
  - `describe("ParamDef.partition")::it("accepts partition: 'model'")` — write `const d: ParamDef = { key: "IS", type: PropertyType.FLOAT, label: "IS", rank: "primary", partition: "model" }; expect(d.partition).toBe("model");`
- **Acceptance criteria**:
  - `ParamDef.partition` is optional, type `"instance" | "model" | undefined`.
  - No runtime behavior change in this task.
  - `npx tsc --noEmit` passes.
  - The three new tests pass; all existing `registry.test.ts` tests still pass without modification.

### Task 1.2: Add `instance` bucket to `defineModelParams`

- **Description**: Extend `defineModelParams` (`src/core/model-params.ts:19-49`) so the spec object accepts a third group `instance: Record<string, ParamSpec>`. Every emitted `ParamDef` carries an explicit `partition` tag (primary/secondary → `"model"`; instance → `"instance"`). Instance entries get `rank: "secondary"`. Defaults from all three buckets are merged into the single returned `defaults` record.
- **Files to modify**:
  - `src/core/model-params.ts` — replace the function body with this exact shape:
    ```ts
    export function defineModelParams(spec: {
      primary: Record<string, ParamSpec>;
      secondary?: Record<string, ParamSpec>;
      instance?: Record<string, ParamSpec>;
    }): { paramDefs: ParamDef[]; defaults: Record<string, number> } {
      const paramDefs: ParamDef[] = [];
      const defaults: Record<string, number> = {};

      const emit = (
        bucket: Record<string, ParamSpec>,
        rank: "primary" | "secondary",
        partition: "instance" | "model",
      ): void => {
        for (const [key, s] of Object.entries(bucket)) {
          const pDef: ParamDef = { key, type: PropertyType.FLOAT, label: key, rank, partition, default: s.default };
          if (s.unit !== undefined) pDef.unit = s.unit;
          if (s.description !== undefined) pDef.description = s.description;
          if (s.min !== undefined) pDef.min = s.min;
          if (s.max !== undefined) pDef.max = s.max;
          paramDefs.push(pDef);
          defaults[key] = s.default;
        }
      };

      emit(spec.primary,        "primary",   "model");
      if (spec.secondary) emit(spec.secondary, "secondary", "model");
      if (spec.instance)  emit(spec.instance,  "secondary", "instance");

      return { paramDefs, defaults };
    }
    ```
  - The exported helpers `paramDefDefaults` and `deviceParams` lower in the file are unchanged.
- **Tests** (extend the existing file `src/core/__tests__/model-params.test.ts`; do NOT create a new file):
  - `describe("defineModelParams partition tagging")::it("primary params get partition='model'")` — call `defineModelParams({ primary: { IS: { default: 1e-14 } } })` and assert `result.paramDefs[0].partition === "model"`.
  - `describe("defineModelParams partition tagging")::it("secondary params get partition='model'")` — call with `{ primary: { IS: { default: 1 } }, secondary: { N: { default: 1 } } }` and assert the `N` entry has `partition === "model"`.
  - `describe("defineModelParams partition tagging")::it("instance params get partition='instance' and rank='secondary'")` — call with `{ primary: { IS: { default: 1 } }, instance: { OFF: { default: 0 } } }` and assert the `OFF` entry has `partition === "instance"` and `rank === "secondary"`.
  - `describe("defineModelParams partition tagging")::it("instance defaults merge into the same defaults record")` — same call as above; assert `result.defaults.OFF === 0` and `result.defaults.IS === 1`.
  - `describe("defineModelParams partition tagging")::it("emission order is primary then secondary then instance")` — call with `{ primary: { A: { default: 1 } }, secondary: { B: { default: 2 } }, instance: { C: { default: 3 } } }`; assert `result.paramDefs.map(d => d.key) === ["A", "B", "C"]` (deep-equals).
  - `describe("defineModelParams partition tagging")::it("omitting instance does not change paramDefs[]")` — assert `defineModelParams({ primary: { IS: { default: 1 } } }).paramDefs.length === 1` and the single entry has `partition === "model"`.
- **Acceptance criteria**:
  - The new bucket works; existing call sites (no `instance:`) are unchanged in output.
  - `paramDefDefaults(defs)` and `deviceParams(defs, params)` work without modification.
  - `npx tsc --noEmit` passes.
  - The six new tests pass; all existing `model-params.test.ts` tests still pass without modification.

## Wave 2: Component Schema Updates

Wave 2 tasks may be executed in parallel — they only edit their own
component file. Each task lifts named keys out of the existing
`primary` / `secondary` blocks into a new `instance` block under
`defineModelParams` (see REF-F for the call-site shape). The values,
defaults, units, and descriptions are preserved verbatim — copy the key
declaration line by line; do not edit them. No `load()` body, `setParam`
body, or `defaults` constant changes; the storage path through
`props.getModelParam(key)` is partition-agnostic.

For each task, the **lift-order list** below is the order the keys
must appear inside the new `instance: { ... }` object literal —
preserve exactly because element-line emission order is paramDefs order
(REF-D), and downstream Wave 3 tests assert that order. Each lift order
matches the relative order in which the keys currently appear in the
existing primary/secondary blocks (primary keys first, then secondary
keys, in source order).

### Task 2.1: Diode schema partition

- **Description**: Move the listed keys from the secondary block of
  `DIODE_PARAM_DEFS` into a new `instance` block. Diode's `M` is the
  *grading coefficient* (model param) — it stays in secondary.
- **Lift order** (source-order; this is the order the keys must appear inside the new `instance: { ... }` block): `AREA`, `OFF`, `IC`, `TEMP`.
- **Files to modify**:
  - `src/components/semiconductors/diode.ts` — locate the single `defineModelParams` call assigned to `DIODE_PARAM_DEFS / DIODE_PARAM_DEFAULTS` (currently around lines 104–138). Remove the four keys from the `secondary:` block and add an `instance:` block immediately after `secondary:` containing those four keys in lift order. Each lifted key keeps its existing `default`, `unit`, and `description` verbatim.
- **Tests**:
  - `src/components/semiconductors/__tests__/diode.test.ts::"DIODE_PARAM_DEFS partition layout"` — assert the `ParamDef` for each of `AREA`, `TEMP`, `OFF`, `IC` has `partition === "instance"`; assert `IS`, `N`, `RS`, `CJO`, `VJ`, `M`, `TT`, `FC`, `BV`, `IBV`, `NBV`, `IKF`, `IKR`, `EG`, `XTI`, `KF`, `AF`, `TNOM`, `ISW`, `NSW`, `IBEQ`, `IBSW`, `NB` have `partition === "model"`.
  - `src/components/semiconductors/__tests__/diode.test.ts::"DIODE_PARAM_DEFAULTS unchanged"` — assert each existing default value (`AREA === 1`, `OFF === 0`, etc.) is preserved.
- **Acceptance criteria**:
  - Lifted keys carry `partition: "instance"`; remaining keys carry
    `partition: "model"`.
  - All existing diode tests continue to pass without modification.
  - `props.getModelParam<number>("OFF")` still returns 0 for a fresh
    diode (no API or storage change).

### Task 2.2: BJT schema partition (four `defineModelParams` calls)

- **Description**: `bjt.ts` contains four `defineModelParams` calls. Identify each by the export-const name on its left-hand side (line numbers may have shifted; the LHS names are stable):
  - **Call A** — `BJT_PARAM_DEFS / BJT_NPN_DEFAULTS` (the simple-NPN variant; LHS reads `export const { paramDefs: BJT_PARAM_DEFS, defaults: BJT_NPN_DEFAULTS } = defineModelParams({…})`).
  - **Call B** — `BJT_PNP_DEFAULTS` only (the simple-PNP variant; LHS reads `export const { defaults: BJT_PNP_DEFAULTS } = defineModelParams({…})`).
  - **Call C** — `BJT_SPICE_L1_PARAM_DEFS / BJT_SPICE_L1_NPN_DEFAULTS` (the L1-NPN variant).
  - **Call D** — `BJT_SPICE_L1_PNP_DEFAULTS` only (the L1-PNP variant).
- **Lift order**:
  - Call A and Call B: `AREA`, `M`, `TEMP`, `OFF`, `ICVBE`, `ICVCE`.
  - Call C and Call D: `AREA`, `AREAB`, `AREAC`, `M`, `TEMP`, `OFF`, `ICVBE`, `ICVCE`, `SUBS`.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts` — perform the lift in all four calls. Each lifted key keeps its existing `default`, `unit`, and `description` verbatim. The `instance:` block goes textually after `secondary:`.
- **Tests**:
  - `src/components/semiconductors/__tests__/bjt.test.ts::"BJT_PARAM_DEFS partition layout"` — assert `AREA`, `M`, `TEMP`, `OFF`, `ICVBE`, `ICVCE` have `partition === "instance"`; assert `BF`, `BR`, `IS`, `NF`, `NR`, `VAF`, `VAR`, `IKF`, `IKR`, `ISE`, `ISC`, `NE`, `NC`, `TNOM` have `partition === "model"`.
  - `src/components/semiconductors/__tests__/bjt.test.ts::"BJT_SPICE_L1_PARAM_DEFS partition layout"` — assert `AREA`, `AREAB`, `AREAC`, `M`, `TEMP`, `OFF`, `ICVBE`, `ICVCE`, `SUBS` have `partition === "instance"`; assert all SPICE_L1 model parameters retain `partition === "model"`.
  - `src/components/semiconductors/__tests__/bjt.test.ts::"NPN/PNP defaults preserved"` — assert each lifted key's default value matches the pre-change value for both polarities (`SUBS === 1`, `M === 1`, `AREAB === 1`, etc.).
- **Acceptance criteria**:
  - All three BJT param-def declarations partition correctly.
  - All existing BJT tests pass without modification.

### Task 2.3: MOSFET schema partition

- **Description**: Lift the listed keys for both NMOS and PMOS. Includes `W` and `L`, which are currently emitted on the element line via a hardcoded branch — the schema now declares them as instance params so the generic instance-param walker handles them in Wave 3.
- **Lift order** (same for both NMOS and PMOS): `W`, `L`, `M`, `OFF`, `ICVDS`, `ICVGS`, `ICVBS`, `TEMP`.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts` — perform the lift in both `defineModelParams` calls (LHS `MOSFET_NMOS_PARAM_DEFS / MOSFET_NMOS_DEFAULTS` and `MOSFET_PMOS_PARAM_DEFS / MOSFET_PMOS_DEFAULTS`). All eight lifted keys are currently declared in the existing primary/secondary blocks (`W` and `L` in primary; `M`, `OFF`, `ICVDS`, `ICVGS`, `ICVBS`, `TEMP` in secondary). Move the declaration line for each lifted key verbatim — same `default`, `unit`, `description` — into the new `instance:` block in lift order. The `instance:` block goes textually after `secondary:`. **Note** (UX consequence, accepted scope): moving `W` and `L` out of `primary` demotes their rank from `"primary"` to `"secondary"` (the `instance:` bucket forces `rank: "secondary"`; see Wave 1 Task 1.2). The property editor groups by rank, so W and L will move out of the "primary" section of the MOSFET property panel into the "secondary" section. This is the correct schema shape (W and L are instance-class) and is in scope for this phase.
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::"NMOS partition layout"` — assert `W`, `L`, `M`, `OFF`, `ICVDS`, `ICVGS`, `ICVBS`, `TEMP` have `partition === "instance"`; assert `VTO`, `KP`, `GAMMA`, `PHI`, `LAMBDA`, `RD`, `RS`, `CBD`, `CBS`, `IS`, `PB`, `CGSO`, `CGDO`, `CGBO`, `RSH`, `CJ`, `MJ`, `CJSW`, `MJSW`, `JS`, `TOX`, `NSUB`, `NSS`, `NFS`, `TPG`, `XJ`, `LD`, `UO`, `KF`, `AF`, `FC`, `TNOM` have `partition === "model"`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::"PMOS partition layout"` — same assertions for the PMOS defs.
- **Acceptance criteria**:
  - W, L are now instance partition (their `default` value is preserved).
  - NSUB, NSS remain model partition (their drop-if-zero behavior moves
    into the generator's per-device rule table in Wave 3).
  - All existing MOSFET tests pass without modification.

### Task 2.4: NJFET schema partition

- **Lift order**: `AREA`, `M`, `TEMP`, `OFF`.
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts` — locate the `defineModelParams` call assigned to `NJFET_PARAM_DEFS / NJFET_PARAM_DEFAULTS`. Move the four key declarations verbatim from `secondary:` into a new `instance:` block in lift order. The `instance:` block goes textually after `secondary:`.
- **Tests**:
  - `src/components/semiconductors/__tests__/jfet.test.ts::"NJFET_PARAM_DEFS partition layout"` — assert `AREA`, `M`, `TEMP`, `OFF` have `partition === "instance"`; assert `VTO`, `BETA`, `LAMBDA`, `IS`, `N`, `CGS`, `CGD`, `PB`, `FC`, `RD`, `RS`, `B`, `TCV`, `BEX`, `KF`, `AF`, `TNOM` have `partition === "model"`.
- **Acceptance criteria**:
  - Lifted keys carry `partition: "instance"`.
  - All existing NJFET tests pass without modification.

### Task 2.5: PJFET schema partition

- **Lift order**: `AREA`, `M`, `TEMP`, `OFF`.
- **Files to modify**:
  - `src/components/semiconductors/pjfet.ts` — locate the `defineModelParams` call assigned to `PJFET_PARAM_DEFS / PJFET_PARAM_DEFAULTS`. Move the four key declarations verbatim from `secondary:` into a new `instance:` block in lift order. The `instance:` block goes textually after `secondary:`.
- **Tests**:
  - `src/components/semiconductors/__tests__/jfet.test.ts::"PJFET_PARAM_DEFS partition layout"` — assert the same instance/model layout as NJFET.
- **Acceptance criteria**:
  - Lifted keys carry `partition: "instance"`.
  - All existing PJFET tests pass without modification.

### Task 2.6: Zener schema partition

- **Description**: Two `defineModelParams` calls in `zener.ts`. Only the first carries instance-class keys.
  - **Call A** — LHS `ZENER_PARAM_DEFS / ZENER_PARAM_DEFAULTS`. Modify.
  - **Call B** — LHS `ZENER_SPICE_L1_PARAM_DEFS / ZENER_SPICE_L1_DEFAULTS`. Do not modify.
- **Lift order** (Call A only): `TEMP`.
- **Files to modify**:
  - `src/components/semiconductors/zener.ts` — in Call A, move the `TEMP` declaration verbatim from `secondary:` into a new `instance:` block. The `instance:` block goes textually after `secondary:`.
- **Tests**:
  - `src/components/semiconductors/__tests__/zener.test.ts::"ZENER_PARAM_DEFS partition layout"` — assert `TEMP` has `partition === "instance"`; assert `IS`, `N`, `BV`, `NBV`, `IBV`, `TCV`, `TNOM` have `partition === "model"`.
  - `src/components/semiconductors/__tests__/zener.test.ts::"ZENER_SPICE_L1_PARAM_DEFS unchanged"` — assert every SPICE_L1 def has `partition === "model"`.
- **Acceptance criteria**:
  - `TEMP` is instance partition; all other keys are model.
  - All existing zener tests pass without modification.

### Task 2.7: Tunnel-diode schema partition

- **Description**: One `defineModelParams` call (LHS `TUNNEL_DIODE_PARAM_DEFS / TUNNEL_DIODE_PARAM_DEFAULTS`). No `OFF` / `IC` / `AREA` / `SUBS` are declared today; only `TEMP` lifts.
- **Lift order**: `TEMP`.
- **Files to modify**:
  - `src/components/semiconductors/tunnel-diode.ts` — move the `TEMP` declaration verbatim from `secondary:` into a new `instance:` block. The `instance:` block goes textually after `secondary:`.
- **Tests**:
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts::"TUNNEL_DIODE_PARAM_DEFS partition layout"` — assert `TEMP` has `partition === "instance"`; assert `IP`, `VP`, `IV`, `VV`, `IS`, `N`, `CJO`, `VJ`, `M`, `TT`, `FC` have `partition === "model"`.
- **Acceptance criteria**:
  - `TEMP` is instance partition.
  - All existing tunnel-diode tests pass without modification.

### Task 2.8: Varactor schema partition

- **Description**: One `defineModelParams` call (LHS `VARACTOR_PARAM_DEFS / VARACTOR_PARAM_DEFAULTS`). `TNOM` stays model; `AREA`, `OFF`, `IC` lift. Pre-existing absence of a declared `TEMP` in varactor is out of scope.
- **Lift order**: `AREA`, `OFF`, `IC`.
- **Files to modify**:
  - `src/components/semiconductors/varactor.ts` — move the three key declarations verbatim from `secondary:` into a new `instance:` block in lift order. The `instance:` block goes textually after `secondary:`.
- **Tests**:
  - `src/components/semiconductors/__tests__/varactor.test.ts::"VARACTOR_PARAM_DEFS partition layout"` — assert `AREA`, `OFF`, `IC` have `partition === "instance"`; assert `CJO`, `VJ`, `M`, `IS`, `FC`, `TT`, `N`, `RS`, `BV`, `IBV`, `NBV`, `IKF`, `IKR`, `EG`, `XTI`, `KF`, `AF`, `TNOM` have `partition === "model"`.
- **Acceptance criteria**:
  - Lifted keys carry `partition: "instance"`.
  - All existing varactor tests pass without modification.

### Task 2.9: SCR schema partition

- **Description**: One `defineModelParams` call (LHS `SCR_PARAM_DEFS / SCR_PARAM_DEFAULTS`). SCR has no ngspice equivalent in the netlist generator; this update is for schema consistency.
- **Lift order**: `TEMP`, `OFF`.
- **Files to modify**:
  - `src/components/semiconductors/scr.ts` — move the two key declarations verbatim from `secondary:` into a new `instance:` block in lift order. The `instance:` block goes textually after `secondary:`.
- **Tests**:
  - `src/components/semiconductors/__tests__/scr.test.ts::"SCR_PARAM_DEFS partition layout"` — assert `TEMP`, `OFF` have `partition === "instance"`; assert `vOn`, `iH`, `rOn`, `vBreakover`, `iS`, `alpha1`, `alpha2_0`, `i_ref`, `n` have `partition === "model"`.
- **Acceptance criteria**:
  - Lifted keys carry `partition: "instance"`.
  - All existing SCR tests pass without modification.

## Wave 3: Netlist Generator Routing

### Task 3.1: Schema-driven instance / model partitioning

- **Description**: Replace the hardcoded `NON_MODEL_KEYS` blacklist and the hardcoded MOSFET `W=…` / `L=…` element-line emission with a generic partition walker driven by `ParamDef.partition`, scoped to the four semiconductor branches per REF-E.
- **Files to modify**:
  - `src/solver/analog/__tests__/harness/netlist-generator.ts`:
    1. **Add imports** at the top of the file:
       ```ts
       import { ComponentRegistry, type ParamDef } from "../../../../core/registry.js";
       ```
    2. **Add the registry parameter** to `generateSpiceNetlist` per REF-A. The new signature is:
       ```ts
       export function generateSpiceNetlist(
         compiled: ConcreteCompiledAnalogCircuit,
         registry: ComponentRegistry,
         elementLabels: Map<number, string>,
         title?: string,
       ): string
       ```
    3. **Inside the per-element loop**, immediately after the existing `const props = circuitEl.getProperties();` line, gate the registry lookup on having a semiconductor `modelType`:
       ```ts
       let paramDefs: ParamDef[] = [];
       if (spec.modelType !== undefined) {
         // REF-B
         const def = registry.get(typeId);
         if (!def) {
           throw new Error(`netlist-generator: typeId "${typeId}" not registered`);
         }
         const modelKey = props.has("model")
           ? props.get<string>("model")
           : (def.defaultModel ?? "");
         const modelEntry = def.modelRegistry?.[modelKey];
         if (!modelEntry) {
           throw new Error(`netlist-generator: typeId "${typeId}" has no modelRegistry["${modelKey}"]`);
         }
         paramDefs = modelEntry.paramDefs;
       }
       ```
    4. **Replace the four semiconductor branches** (`spec.prefix === "D"` / `"Q"` / `"M"` / `"J"`) with calls into two new helpers `instanceParamSuffix(paramDefs, props, typeId)` and `modelCardSuffix(modelName, modelType, paramDefs, props, typeId)`. The MOSFET-specific `W=${W} L=${L}` literal is deleted; the suffix helper emits W and L from `paramDefs`. Replacement code (drop-in for the existing four branches):
       ```ts
       } else if (spec.prefix === "D") {
         const modelName = `${label}_${spec.modelType}`;
         line = `${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${modelName}${instanceParamSuffix(paramDefs, props, typeId)}`;
         if (!modelCards.has(modelName)) {
           modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, typeId));
         }
       } else if (spec.prefix === "Q") {
         const modelName = `${label}_${spec.modelType}`;
         line = `${label} ${nodes[1] ?? 0} ${nodes[0] ?? 0} ${nodes[2] ?? 0} ${modelName}${instanceParamSuffix(paramDefs, props, typeId)}`;
         if (!modelCards.has(modelName)) {
           modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, typeId));
         }
       } else if (spec.prefix === "M") {
         const modelName = `${label}_${spec.modelType}`;
         let d: number, g: number, s: number, b: number;
         if (typeId === "NMOS") {
           d = nodes[2] ?? 0; g = nodes[0] ?? 0; s = nodes[1] ?? 0; b = nodes[1] ?? 0;
         } else if (typeId === "PMOS") {
           d = nodes[1] ?? 0; g = nodes[0] ?? 0; s = nodes[2] ?? 0; b = nodes[2] ?? 0;
         } else {
           throw new Error(`netlist-generator: unknown MOSFET typeId '${typeId}' — add an explicit pin-order branch`);
         }
         line = `${label} ${d} ${g} ${s} ${b} ${modelName}${instanceParamSuffix(paramDefs, props, typeId)}`;
         if (!modelCards.has(modelName)) {
           modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, typeId));
         }
       } else if (spec.prefix === "J") {
         const modelName = `${label}_${spec.modelType}`;
         line = `${label} ${nodes[2] ?? 0} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${modelName}${instanceParamSuffix(paramDefs, props, typeId)}`;
         if (!modelCards.has(modelName)) {
           modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, typeId));
         }
       }
       ```
    5. **Delete** the `NON_MODEL_KEYS` set, the `isSpiceModelParam` helper, and the existing `buildModelCard` function. Replace with `instanceParamSuffix` and `modelCardSuffix`:
       ```ts
       function instanceParamSuffix(
         paramDefs: readonly ParamDef[],
         props: PropertyBag,
         _typeId: string,
       ): string {
         const parts: string[] = [];
         for (const def of paramDefs) {
           if (def.partition !== "instance") continue;
           if (!props.hasModelParam(def.key)) continue;
           const v = props.getModelParam<number>(def.key);
           if (typeof v !== "number" || !Number.isFinite(v)) continue;
           parts.push(`${def.key}=${v}`);
         }
         return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
       }

       function modelCardSuffix(
         modelName: string,
         spiceModelType: string,
         paramDefs: readonly ParamDef[],
         props: PropertyBag,
         typeId: string,
       ): string {
         // Body: emit model-partition keys in paramDefs order with REF-C semantics.
         // Per-device rules (renames, prefix tokens, drop-if-zero) are applied here
         // and specified in Tasks 3.2 / 3.3. Until those tasks land, this emits
         // bare `KEY=value` tokens for every model-partition key.
         const parts: string[] = [];
         for (const def of paramDefs) {
           if (def.partition === "instance") continue;
           if (!props.hasModelParam(def.key)) continue;
           const v = props.getModelParam<number>(def.key);
           if (typeof v !== "number" || !Number.isFinite(v)) continue;
           parts.push(`${def.key}=${v}`);
         }
         if (parts.length === 0) {
           return `.model ${modelName} ${spiceModelType}`;
         }
         return `.model ${modelName} ${spiceModelType} (${parts.join(" ")})`;
       }
       ```
    6. **Walker scope** (REF-E): the Resistor / Capacitor / Inductor / DcVoltageSource / AcVoltageSource / DcCurrentSource / AcCurrentSource branches are unchanged. The `paramDefs` lookup at step 3 is gated on `spec.modelType !== undefined`, so non-semiconductor branches never call the registry.
  - `src/solver/analog/__tests__/harness/comparison-session.ts`:
    - The call site at line 503 is inside the `_initWithCircuit` method. The two callers `init()` (line 435) and `initSelfCompare()` (line 445) each construct a local `registry` via `createDefaultRegistry()`. Promote it to a private member field so `_initWithCircuit` can pass it to the generator. Specifically:
      1. Add a private member field declaration in the class (location: alongside other `private _xxx:` declarations near the top of the class):
         ```ts
         private _registry!: ComponentRegistry;
         ```
      2. In both `init()` (line 436) and `initSelfCompare()` (line 446), replace `const registry = createDefaultRegistry();` with `this._registry = createDefaultRegistry();` and update the immediately-following `new DefaultSimulatorFacade(registry)` to `new DefaultSimulatorFacade(this._registry)`. In `initSelfCompare`, also update the `buildCircuit(registry)` call on line 450 to `buildCircuit(this._registry)`.
      3. At line 503, change the call to:
         ```ts
         this._cirClean = generateSpiceNetlist(compiled, this._registry, this._elementLabels);
         ```
    - The existing `import { ComponentRegistry } from "../../../../core/registry.js";` on line 17 is sufficient; no new imports needed in this file.
- **Tests** (in `src/solver/analog/__tests__/harness/netlist-generator.test.ts`):
  - **First**, update test scaffolding per REF-G:
    1. Add `import { createDefaultRegistry } from "../../../../components/register-all.js";` at the top.
    2. Add `const testRegistry = createDefaultRegistry();` at module top-level (after imports, before `describe`).
    3. Update **every existing** call to `generateSpiceNetlist(compiled, …)` to insert `testRegistry` as the second argument: `generateSpiceNetlist(compiled, testRegistry, …)`. There are 25 such call sites in the file (verify via `grep -c "generateSpiceNetlist(" src/solver/analog/__tests__/harness/netlist-generator.test.ts` after the edit; the count should remain 25).
  - **New tests** (added to the existing `describe("generateSpiceNetlist", …)` block):
    - `it("diode: instance params emit on element line in paramDefs order, NaN dropped")` — build a Diode with `props.setModelParam("AREA", 2); props.setModelParam("OFF", 1); props.setModelParam("TEMP", 325);` and `IC` left at default NaN. Assert the netlist contains the substring `D1 1 2 D1_D AREA=2 OFF=1 TEMP=325` and does NOT contain `IC=`.
    - `it("diode: model card excludes instance keys")` — same circuit; assert the netlist does NOT contain any of `OFF=`, `AREA=`, `TEMP=`, `IC=` on a `.model` line, and DOES contain `IS=` on the `.model D1_D D` line.
    - `it("MOSFET NMOS: element line emits W L M OFF ICVDS ICVGS ICVBS TEMP in paramDefs order")` — build an NMOS without setting `props.set("model", …)` (default `"spice-l1"` is used) and call `setModelParam` for all eight instance keys with non-default finite values (e.g. `W=2e-6`, `L=1e-6`, `M=1`, `OFF=0`, `ICVDS=0`, `ICVGS=0`, `ICVBS=0`, `TEMP=300.15`). Assert the M1 line contains `W=` followed by `L=` followed by `M=` followed by `OFF=` followed by `ICVDS=` followed by `ICVGS=` followed by `ICVBS=` followed by `TEMP=`, in that order.
    - `it("MOSFET NMOS: model card excludes W L M ICV* OFF TEMP")` — same circuit; assert the `.model M1_NMOS NMOS (...)` card has none of `W=`, `L=`, `M=`, `OFF=`, `ICVDS=`, `ICVGS=`, `ICVBS=`, `TEMP=` tokens, and DOES have `VTO=`.
    - `it("BJT NPN spice variant: element line emits AREA AREAB AREAC M OFF ICVBE ICVCE TEMP SUBS")` — build an `NpnBJT` without setting `props.set("model", …)` (default `"spice"` resolves to `BJT_SPICE_L1_PARAM_DEFS`). Call `setModelParam` for all nine instance keys with finite values (e.g. `AREA=1`, `AREAB=1`, `AREAC=1`, `M=1`, `OFF=0`, `ICVBE=0.7`, `ICVCE=5`, `TEMP=300.15`, `SUBS=1`). Assert the Q1 line contains the nine `KEY=value` tokens in lift order (`AREA`, `AREAB`, `AREAC`, `M`, `TEMP`, `OFF`, `ICVBE`, `ICVCE`, `SUBS`); assert the `.model Q1_NPN NPN (...)` card contains NONE of those nine keys.
    - `it("non-semiconductor branches are unchanged")` — build a Resistor circuit (the existing first-block resistor test) and assert the existing `R1 1 2 4700` byte-for-byte output is unchanged (no element-line suffix added). This is enforced by the registry-lookup gate `spec.modelType !== undefined`.
- **Acceptance criteria**:
  - Generator produces correct partitioned ngspice netlists for all nine semiconductor types.
  - `NON_MODEL_KEYS` and `isSpiceModelParam` are deleted; `grep -n NON_MODEL_KEYS src/solver/analog/__tests__/harness/netlist-generator.ts` returns nothing.
  - All existing `netlist-generator.test.ts` tests pass with their two-arg → three-arg signature update.
  - The new tests above pass.
  - `npx tsc --noEmit` passes.

### Task 3.2: Per-device rename table (`ISW` → `JSW`)

- **Description**: Add `DEVICE_NETLIST_RULES` to `netlist-generator.ts` and apply renames inside `modelCardSuffix`. Components stay unaware of ngspice spelling.
- **Files to modify**:
  - `src/solver/analog/__tests__/harness/netlist-generator.ts`:
    1. Add the table at module-top after imports:
       ```ts
       interface DeviceNetlistRules {
         renames?: Record<string, string>;
         // modelCardPrefix and modelCardDropIfZero added in Task 3.3.
       }

       const DEVICE_NETLIST_RULES: Record<string, DeviceNetlistRules> = {
         Diode:       { renames: { ISW: "JSW" } },
         Zener:       { renames: { ISW: "JSW" } },
         Varactor:    { renames: { ISW: "JSW" } },
         TunnelDiode: { renames: { ISW: "JSW" } },
       };
       ```
    2. Modify `modelCardSuffix` (added in Task 3.1). Replace the `parts.push(\`${def.key}=${v}\`)` line with rename-aware emission:
       ```ts
       const rules = DEVICE_NETLIST_RULES[typeId];
       const emittedKey = rules?.renames?.[def.key] ?? def.key;
       parts.push(`${emittedKey}=${v}`);
       ```
       Move the `const rules = DEVICE_NETLIST_RULES[typeId];` lookup outside the loop (compute once per element).
- **Tests** (added to `src/solver/analog/__tests__/harness/netlist-generator.test.ts`, inside the existing `describe("generateSpiceNetlist", …)`):
  - `it("Diode: ISW renames to JSW on model card")` — build a Diode with `props.setModelParam("ISW", 1e-15)`. Assert the netlist contains `JSW=1e-15` and does NOT contain the substring `ISW=`.
  - `it("Zener: ISW renames to JSW on model card")` — same for `Zener` (use the default zener model). Assert `JSW=1e-15` is present and `ISW=` is absent.
  - `it("Varactor: ISW renames to JSW on model card")` — same for `Varactor`.
  - `it("TunnelDiode: ISW renames to JSW on model card")` — same for `TunnelDiode`.
  - `it("non-renamed model params emit unchanged")` — Diode with `IS=2e-14` and `ISW=1e-15`. Assert the model card contains `IS=2e-14` (unchanged) and `JSW=1e-15` (renamed).
  - `it("BJT model card emits all keys verbatim (no rename leakage)")` — build an `NpnBJT` (default model `"spice"`) with `props.setModelParam("IS", 1e-14)`. Capture the netlist; locate the line beginning with `.model Q1_NPN NPN`. Assert that line contains `IS=1e-14` (or `IS=` followed by JS's string form of `1e-14`) and does NOT contain `JS=`. This is a behavioral check that confirms BJT is not in the rename table without exporting the table.
- **Acceptance criteria**:
  - All four diode-family `ISW` keys emit as `JSW` on the model card.
  - No cross-device rename leakage; non-table entries emit verbatim.
  - All new and existing tests pass.

### Task 3.3: Model-card prefix rules (`LEVEL=3` for tunnel diode params; drop-if-zero for MOSFET `NSUB`/`NSS`)

- **Description**: Extend `DEVICE_NETLIST_RULES` with two more hooks. **The `LEVEL=3` trigger condition is `IBEQ > 0 || IBSW > 0`** — `NB` alone does not trigger (`NB`'s default is 1, which would always trigger; a non-default `NB` is only meaningful when at least one of the saturation currents is non-zero).
- **Files to modify**:
  - `src/solver/analog/__tests__/harness/netlist-generator.ts`:
    1. Extend the `DeviceNetlistRules` interface from Task 3.2:
       ```ts
       interface DeviceNetlistRules {
         renames?: Record<string, string>;
         modelCardPrefix?: (props: PropertyBag) => string[];
         modelCardDropIfZero?: string[];
       }
       ```
    2. Add the helper and update `DEVICE_NETLIST_RULES`:
       ```ts
       function tunnelLevel(props: PropertyBag): string[] {
         const ibeq = props.hasModelParam("IBEQ") ? props.getModelParam<number>("IBEQ") : 0;
         const ibsw = props.hasModelParam("IBSW") ? props.getModelParam<number>("IBSW") : 0;
         return (ibeq > 0 || ibsw > 0) ? ["LEVEL=3"] : [];
       }

       const DEVICE_NETLIST_RULES: Record<string, DeviceNetlistRules> = {
         Diode:       { renames: { ISW: "JSW" }, modelCardPrefix: tunnelLevel },
         Zener:       { renames: { ISW: "JSW" } },
         Varactor:    { renames: { ISW: "JSW" } },
         TunnelDiode: { renames: { ISW: "JSW" }, modelCardPrefix: tunnelLevel },
         NMOS:        { modelCardDropIfZero: ["NSUB", "NSS"] },
         PMOS:        { modelCardDropIfZero: ["NSUB", "NSS"] },
       };
       ```
    3. Modify `modelCardSuffix` to apply the two new hooks. Final body (replace the body added in Tasks 3.1 / 3.2 with this exact body):
       ```ts
       function modelCardSuffix(
         modelName: string,
         spiceModelType: string,
         paramDefs: readonly ParamDef[],
         props: PropertyBag,
         typeId: string,
       ): string {
         const rules = DEVICE_NETLIST_RULES[typeId];
         const dropIfZero = new Set(rules?.modelCardDropIfZero ?? []);
         const parts: string[] = [];

         // Prefix tokens (e.g. LEVEL=3) come first.
         if (rules?.modelCardPrefix) {
           parts.push(...rules.modelCardPrefix(props));
         }

         for (const def of paramDefs) {
           if (def.partition === "instance") continue;
           if (!props.hasModelParam(def.key)) continue;
           const v = props.getModelParam<number>(def.key);
           if (typeof v !== "number" || !Number.isFinite(v)) continue;
           if (dropIfZero.has(def.key) && v === 0) continue;
           const emittedKey = rules?.renames?.[def.key] ?? def.key;
           parts.push(`${emittedKey}=${v}`);
         }

         if (parts.length === 0) {
           return `.model ${modelName} ${spiceModelType}`;
         }
         return `.model ${modelName} ${spiceModelType} (${parts.join(" ")})`;
       }
       ```
- **Tests** (added to `src/solver/analog/__tests__/harness/netlist-generator.test.ts` inside the existing `describe("generateSpiceNetlist", …)`):
  - `it("Diode: emits LEVEL=3 when IBEQ > 0")` — Diode with `props.setModelParam("IBEQ", 1e-12);`. Assert the netlist contains the substring `(LEVEL=3 ` (note the open-paren and trailing space) on the `.model D1_D D` line.
  - `it("Diode: emits LEVEL=3 when IBSW > 0")` — Diode with `props.setModelParam("IBSW", 1e-12);` and IBEQ left at default 0. Assert `(LEVEL=3 ` is present.
  - `it("Diode: does NOT emit LEVEL=3 when IBEQ=0 and IBSW=0")` — vanilla Diode (no IBEQ/IBSW set). Assert the netlist does NOT contain `LEVEL=3`.
  - `it("Diode: does NOT emit LEVEL=3 for non-default NB alone")` — Diode with `props.setModelParam("NB", 2);` and IBEQ=0, IBSW=0. Assert the netlist does NOT contain `LEVEL=3`. This pins the trigger condition.
  - `it("TunnelDiode: emits LEVEL=3 when IBEQ > 0")` — TunnelDiode with `props.setModelParam("IBEQ", 1e-12);`. Assert `(LEVEL=3 ` is present.
  - `it("Zener: never emits LEVEL=3")` — Zener with no special params. Assert `LEVEL=3` is absent.
  - `it("NMOS: NSUB=0 dropped from model card")` — NMOS with default NSUB (0). Assert the `.model M1_NMOS NMOS (...)` card does NOT contain `NSUB=`.
  - `it("NMOS: NSUB=1e16 emitted on model card")` — NMOS with `props.setModelParam("NSUB", 1e16);`. Assert the model card contains `NSUB=10000000000000000` (or whatever JS `String(1e16)` yields — write the test as `expect(netlist).toContain("NSUB=" + String(1e16));`).
  - `it("NMOS: NSS=0 dropped from model card")` — assert no `NSS=` token.
  - `it("NMOS: NSS=2e10 emitted on model card")` — assert `NSS=` + `String(2e10)` token is present.
  - `it("PMOS: NSUB=0 and NSS=0 dropped from model card")` — same as NMOS.
- **Acceptance criteria**:
  - The `tunnelLevel` trigger fires only when `IBEQ > 0 || IBSW > 0`; `NB` alone does not trigger.
  - MOSFET `NSUB=0` and `NSS=0` are dropped from the `.model` card; non-zero values are emitted.
  - `DEVICE_NETLIST_RULES` is the single source of truth for ngspice quirks; no per-device branch logic in the partition walker outside the table.
  - All new and existing tests pass.

## Wave 4: Regression Coverage

### Task 4.1: Currently-hanging tests run to completion

- **Description**: A small set of ngspice-parity tests that hang today
  with the blacklist-based generator must run end-to-end after Wave 3.
  This task captures that as explicit regression coverage. The previously
  hanging tests are inferable from the `.hang-a-*.log` files in the repo
  root; the user has identified the parser-choke root cause as
  instance-class keys being routed onto the `.model` card.
- **Files to modify**:
  - None — this task is verification, not code authoring.
- **Tests** (these are existing tests; they must now run to completion
  rather than hang — measured by Vitest's `--reporter=default` exit
  status):
  - `src/solver/analog/__tests__/ngspice-parity/_diag-rc-transient.test.ts` — runs to completion.
  - `src/solver/analog/__tests__/ngspice-parity/mosfet-inverter.test.ts` — runs to completion.
  - The full `src/solver/analog/__tests__/ngspice-parity/*.test.ts` suite — `npx vitest run src/solver/analog/__tests__/ngspice-parity/ --reporter=default` exits without test-runner-level timeout.
- **Acceptance criteria**:
  - Every parity test completes (passes or fails on numerical content,
    but does not hang on the ngspice parser).
  - No `.hang-a-*.log` accumulates from a fresh run of the parity suite.
  - The pre-existing numerical bar of the parity suite is not regressed:
    tests that passed before this phase still pass after it.

### Task 4.2: Schema partition is honored end-to-end (instance param drives ngspice)

- **Description**: A targeted parity test that drives a non-default instance param through the harness and verifies ngspice receives it correctly. Two tests, each with a fully-specified circuit topology — implementer copies the circuit shape verbatim.
- **Files to create**:
  - `src/solver/analog/__tests__/ngspice-parity/instance-param-routing.test.ts`. Use existing parity-test patterns in `src/solver/analog/__tests__/ngspice-parity/_diag-rc-transient.test.ts` and `mosfet-inverter.test.ts` as the structural template (imports, `harness_start`/`harness_run`, `compareDcOp` etc.). Two tests:

    - **Test A — `diode OFF=1 routes to ngspice element line`**:
      - Circuit (programmatic build via `DefaultSimulatorFacade`):
        - Node names: `n_anode`, `gnd`.
        - One `DcVoltageSource` `V1` from `gnd` to `n_anode`, voltage=`0.7`V.
        - One `Diode` `D1` from `n_anode` (anode) to `gnd` (cathode).
        - On `D1`: `props.setModelParam("OFF", 1)`. Leave all other diode model params at default.
      - Run a DC operating-point analysis on both engines.
      - Read the diode current `I(D1)` from each engine.
      - Assert: `Math.abs(digitsCurrent) < 1e-12 && Math.abs(ngspiceCurrent) < 1e-12`. Justification: ngspice with `OFF=1` on the element line zero-seeds the diode at MODEINITFIX (`dioload.c:137-138`); digiTS does the same (`diode.ts:519-521`). Both engines must report essentially zero forward current. If `OFF=1` lands on the `.model` card instead, ngspice silently ignores it, the diode conducts at 0.7V, and `ngspiceCurrent ≈ 1e-3`A — failing the assertion.

    - **Test B — `BJT TEMP=400 routes to ngspice element line`**:
      - Circuit (programmatic build via `DefaultSimulatorFacade`):
        - Node names: `n_b`, `n_c`, `gnd`.
        - One `DcVoltageSource` `VBE` from `gnd` to `n_b`, voltage=`0.65`V.
        - One `DcVoltageSource` `VCE` from `gnd` to `n_c`, voltage=`5`V.
        - One `NpnBJT` `Q1` with collector `n_c`, base `n_b`, emitter `gnd`. Use the default model (whatever `defaultModel` resolves to in the registry — confirm via registry lookup; the test does not assume a specific model key).
        - On `Q1`: `props.setModelParam("TEMP", 400)`. Leave other params at default.
      - Run a DC operating-point analysis on both engines.
      - Read collector current `I(Q1.C)` from each engine.
      - Assert two things:
        1. `Math.abs(digitsCurrent - ngspiceCurrent) / Math.max(Math.abs(digitsCurrent), 1e-12) < 0.05` — currents agree within 5% relative tolerance. Justification: both engines compute `Vt = k*T/q` at T=400K, both compute the same Shockley collector current at VBE=0.65V; agreement to within parity tolerance proves both saw `TEMP=400`.
        2. `Math.abs(digitsCurrent - referenceCurrentAt300K) > 0.5 * Math.abs(referenceCurrentAt300K)` where `referenceCurrentAt300K` is computed by re-running the same circuit with `TEMP=300.15` (the default) and reading the digiTS collector current. Justification: a 100K temperature shift moves the BJT collector current by more than 50%; this proves the test is sensitive to TEMP. If TEMP were dropped onto the `.model` card and silently ignored, the ngspice run would use 300.15K and the assertion (1) would fail.
- **Acceptance criteria**:
  - Both tests pass.
  - The tests are load-bearing: temporarily moving `TEMP` and `OFF` back into the `secondary` (model) bucket of the diode/BJT schema and re-running this test file results in at least one of the two assertions failing.
  - `npx vitest run src/solver/analog/__tests__/ngspice-parity/instance-param-routing.test.ts --reporter=default` runs to completion in under 30 seconds.

## Cross-cutting acceptance criteria

- The string `NON_MODEL_KEYS` does not appear in
  `src/solver/analog/__tests__/harness/netlist-generator.ts`.
- The string `getModelParamKeys()` is called only in code paths that
  partition (or in property-bag serialization). No direct
  `getModelParamKeys()` walk emits onto a `.model` card without first
  partitioning.
- `npx tsc --noEmit` passes.
- `npx vitest run src/solver/analog/__tests__/ngspice-parity/ src/components/semiconductors/__tests__/ src/solver/analog/__tests__/harness/ src/core/__tests__/ --reporter=default` runs to completion with no test-runner-level hangs.
