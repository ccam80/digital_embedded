# ngspice Netlist Generator — Architectural Cleanup Proposal

**Status:** Architectural design, not yet implemented.
**Date:** 2026-04-26
**Predecessor:** `spec/ngspice-netlist-generator-cleanup.md` (handoff describing the hacks this proposal replaces)
**Scope:** Replace the per-typeId `DEVICE_NETLIST_RULES` table in `src/solver/analog/__tests__/harness/netlist-generator.ts` with a fully declarative model-param schema. Migrate every component definition to the new schema shape. No feature change visible to ngspice.

---

## 1. Diagnosis of the Current Shape

`src/solver/analog/__tests__/harness/netlist-generator.ts:46-152` defines `DEVICE_NETLIST_RULES`, a `Record<typeId, DeviceNetlistRules>` with **seven** distinct mechanisms keyed by string typeId. Every one of these is an out-of-band override on top of the schema declared in the component itself:

| # | Field on `DeviceNetlistRules` | Used for | Per-typeId entries today |
|---|---|---|---|
| 1 | `renames: Record<string,string>` | `ISW` → `JSW` (Diode/Zener/Varactor/TunnelDiode model card) | 4 |
| 2 | `instanceFlags: string[]` | `OFF` emits as bare keyword, not `OFF=0` | 9 |
| 3 | `instanceDropIfDefault: Record<string,number>` | Silence `M=1`, `TEMP=300.15`, etc. | 9 |
| 4 | `instanceCombineIC: [string,string,string]` | `ICVDS,ICVGS,ICVBS` → `IC=v1,v2,v3` (MOS only) | 2 |
| 5 | `modelCardDropUnlessTunnel: string[]` | Suppress `IBEQ/IBSW/NB` on plain Diode model card | 2 |
| 6 | `instanceDropAlways: string[]` | `SUBS` (BJT vertical/lateral topology — not a parameter, a model variant) | 2 |
| 7 | `modelCardDropIfZero: string[]` | `NSUB=0`, `NSS=0` (pre-existing) | 2 |
| 7a | `modelCardPrefix: (props) => string[]` | `LEVEL=3` derived for tunnel mode | 2 |

Architectural smell: **the netlist generator knows about specific component identities**. Every time a new analog device lands, somebody has to remember to edit a string-keyed table in a `__tests__/` file with no static cross-check that the keys exist on the corresponding `paramDefs`. None of the seven mechanisms are inherently per-typeId facts — every one is a per-**param** fact (this param emits as a flag; this param has a SPICE alias; this param belongs to a combined group; this param is internal-only). The table form is a coincidence of the implementation, not the domain.

The fix is: **push every emission rule onto `ParamDef`**, plus a tiny ModelEntry-level emission spec for the genuinely non-per-param facts (the LEVEL=3 derivation). The netlist generator then iterates `paramDefs` once, with no typeId switching at all.

---

## 2. The Target Architecture

### 2.1 Extended `ParamDef`

Augment `src/core/registry.ts:33-52` to carry SPICE-emission semantics alongside the existing schema fields. Every new field is **optional** — components that do not declare it get default `key-value` emission, and the schema is unchanged for non-semiconductor components.

```ts
// src/core/registry.ts
export interface ParamDef {
  // Existing fields ↓
  key: string;
  type: PropertyType;
  label: string;
  unit?: string;
  description?: string;
  rank: "primary" | "secondary";
  /**
   * Where the param lives in SPICE output.
   *   "model"    — emitted on the .model card  (default for primary/secondary)
   *   "instance" — emitted on the element line (e.g. AREA=2 OFF on a diode)
   *
   * There is intentionally no "internal" / "no-emit" partition. A knob that
   * affects simulation but has no ngspice counterpart is not a parameter —
   * it is a model variant, and belongs in `modelRegistry` as a separate
   * ModelEntry whose factory closes over the topology constant. See §3.5
   * for the BJT SUBS migration.
   */
  partition?: "instance" | "model";
  min?: number;
  max?: number;
  default?: number;

  // NEW fields ↓

  /**
   * SPICE keyword on emission. Defaults to `key`. Use when ngspice's parser
   * accepts a different identifier for the same parameter. Example: digiTS
   * uses `ISW` (sidewall saturation current); ngspice's diode parser names
   * the same parameter `JSW`. Storage and `getModelParam("ISW")` still use
   * the digiTS key — the rename only applies at the netlist boundary.
   */
  spiceName?: string;

  /**
   * Emission style.
   *   "key-value" (default) — `KEY=value`
   *   "flag"                — bare uppercase keyword when value is truthy,
   *                           omitted when zero/false. ngspice rejects
   *                           `OFF=0` as a parse error; this is how OFF and
   *                           any other future bare-keyword param emit.
   */
  emit?: "key-value" | "flag";

  /**
   * Combined-emission group. When set, the generator collects every ParamDef
   * with the same `emitGroup.name` and emits them as a single comma-joined
   * token: `<NAME>=v1,v2,v3` (in ascending `index` order).
   *
   * Currently used for the MOS initial-condition triplet (ICVDS/ICVGS/ICVBS
   * → `IC=vds,vgs,vbs`).
   *
   * The group is emitted only when at least one member has a non-default
   * value. (For MOS IC this matches ngspice's MOS1 behaviour — IC=0,0,0 is
   * never useful and would be rejected as `unknown parameter (0)` were any
   * member emitted in key-value form.)
   */
  emitGroup?: { name: string; index: number };
}
```

Notes:

- `spiceName` shadows but does not replace `key`. Storage uses `key` so `setParam("ISW", …)` and `getModelParam("ISW")` keep working — the rename is applied only by the netlist generator at emit time.
- `emit: "flag"` is intentionally a different field from `partition`. The two are orthogonal: flags can in principle live on either side. Today only instance-side flags exist (OFF), but the architecture does not foreclose a hypothetical model-card flag.
- `emitGroup` is keyed by a **structured name+index**, not a positional array. This keeps the per-param declaration self-contained and makes order explicit at the param-definition site, where it is locally checkable.

### 2.2 Extended `ModelEntry`

The one rule that genuinely cannot live on a `ParamDef` is the `LEVEL=3` prefix for the tunnel-extended diode model: the LEVEL token is not derived from any single param's value (it is a *function* of `IBEQ>0 || IBSW>0`), and conceptually it belongs to the model card as a whole. After we split the Diode and TunnelDiode schemas (Section 3.4), this rule applies to TunnelDiode only and is constant: TunnelDiode's model card always emits `LEVEL=3`.

Augment `src/core/registry.ts:58-75`:

```ts
// src/core/registry.ts
export interface ModelEmissionSpec {
  /**
   * Constant tokens prepended to the .model card body, in order, ahead of
   * any paramDefs-derived params. Use for static SPICE attributes that
   * are not exposed as digiTS model params.
   *
   * Example: TunnelDiode emits `LEVEL=3` so ngspice's diode parser
   * activates the tunnel-extension code path (dioload.c:267-285).
   */
  modelCardPrefix?: readonly string[];

  /**
   * SPICE element-prefix letter. When omitted, the netlist generator falls
   * back to its built-in ELEMENT_SPECS table. Specifying this on the
   * ModelEntry lets a model dictate its own SPICE syntax — a future
   * BSIM4 model could ship `prefix: "M"` here without touching the
   * generator.
   *
   * (Out of scope for this cleanup, but the field is part of the same
   * contract: the model owns its SPICE emission, not the generator.)
   */
  prefix?: string;

  /**
   * SPICE model-type token (the second word on the .model line, e.g.
   * "NPN", "NMOS", "D"). Same fall-back rule as `prefix`.
   */
  modelType?: string;
}

export type ModelEntry =
  | {
      kind: "inline";
      factory: AnalogFactory;
      paramDefs: ParamDef[];
      params: Record<string, number>;
      branchCount?: number | ((props: PropertyBag) => number);
      getInternalNodeCount?: (props: PropertyBag) => number;
      getInternalNodeLabels?: (props: PropertyBag) => readonly string[];
      /** SPICE-emission overrides for this model. */
      spice?: ModelEmissionSpec;            // ← NEW
    }
  | {
      kind: "netlist";
      netlist: MnaSubcircuitNetlist;
      paramDefs: ParamDef[];
      params: Record<string, number>;
      spice?: ModelEmissionSpec;            // ← NEW (for symmetry; not used in this cleanup)
    };
```

The minimal version of this cleanup only uses `spice.modelCardPrefix`. The other two fields are sketched here so we do not paint ourselves into a corner, but Section 4 only mandates `modelCardPrefix`.

### 2.3 Generator after the rewrite

The generator becomes a single declarative reduction over `paramDefs`. There is no `DeviceNetlistRules` table; there is no `if (typeId === ...)` branch; there is no string-keyed lookup for emission rules. There is exactly one typeId-based decision left in the generator: the SPICE element-prefix letter (`R`/`C`/`L`/`V`/`I`/`D`/`Q`/`M`/`J`) and corresponding pin-order convention, which is genuinely a property of the SPICE language for primitive devices and not a per-component fact.

Pseudocode for the new emission core:

```ts
// netlist-generator.ts (after cleanup)

function instanceParamSuffix(paramDefs: readonly ParamDef[], props: PropertyBag): string {
  const parts: string[] = [];
  const groups = new Map<string, Array<{ index: number; value: number }>>();

  for (const def of paramDefs) {
    if (def.partition !== "instance") continue;        // ← model partition skipped
    if (!props.hasModelParam(def.key)) continue;
    const v = props.getModelParam<number>(def.key);
    if (typeof v !== "number" || !Number.isFinite(v)) continue;

    if (def.emitGroup) {
      let arr = groups.get(def.emitGroup.name);
      if (!arr) { arr = []; groups.set(def.emitGroup.name, arr); }
      arr.push({ index: def.emitGroup.index, value: v });
      continue;
    }

    if (def.emit === "flag") {
      if (v !== 0) parts.push(def.spiceName ?? def.key);
      continue;
    }

    parts.push(`${def.spiceName ?? def.key}=${v}`);
  }

  for (const [name, members] of groups) {
    members.sort((a, b) => a.index - b.index);
    if (members.some(m => m.value !== 0)) {            // emit only if any member non-zero
      parts.push(`${name}=${members.map(m => m.value).join(",")}`);
    }
  }

  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function modelCardSuffix(
  modelName: string,
  spiceModelType: string,
  paramDefs: readonly ParamDef[],
  props: PropertyBag,
  emission: ModelEmissionSpec | undefined,
): string {
  const parts: string[] = [];

  // (a) model-level prefix tokens (e.g. LEVEL=3 from TunnelDiode)
  if (emission?.modelCardPrefix) parts.push(...emission.modelCardPrefix);

  // (b) paramDefs-driven emission, in declared order
  for (const def of paramDefs) {
    if (def.partition === "instance") continue;
    if (def.emitGroup || def.emit === "flag") {
      throw new Error(
        `netlist-generator: model-card param ${def.key} declares emit/group; ` +
        `only instance partition supports flag/group emission today`,
      );
    }
    if (!props.hasModelParam(def.key)) continue;
    const v = props.getModelParam<number>(def.key);
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    parts.push(`${def.spiceName ?? def.key}=${v}`);
  }

  if (parts.length === 0) return `.model ${modelName} ${spiceModelType}`;
  return `.model ${modelName} ${spiceModelType} (${parts.join(" ")})`;
}
```

Two things are worth highlighting:

1. **The flag/group handling is uniform with no typeId branching.** The generator never asks "is this an NMOS?" — it asks `def.emitGroup`, `def.emit === "flag"`, `def.partition`. Every answer is local to the param definition.

2. **The `instanceDropIfDefault` mechanism is gone, full stop.** It is not "configurable" or "deferred" — it is deleted as a concept (per the spec author's own recommendation in `spec/ngspice-netlist-generator-cleanup.md` §A and the user's confirmation). Emitting `M=1` or `TEMP=300.15` is harmless; ngspice accepts the redundant token without warning. The unit tests at `netlist-generator.test.ts:457-498, 529-575` already use non-default values, so they keep passing without change. (Section 3.7 elaborates.)

---

## 3. Per-mechanism Resolution

For each of the seven hardcoded rules, the section below gives current state, the new declarative form, the migration steps, and the test impact.

### 3.1 Renames (`ISW` → `JSW`)

**Current state.** `netlist-generator.ts:99,106,111,116` declares `renames: { ISW: "JSW" }` for Diode, ZenerDiode, VaractorDiode, TunnelDiode. The generator at line 396 does `rules?.renames?.[def.key] ?? def.key` per param.

**Proposed declarative form.** `ParamDef.spiceName?: string` (Section 2.1).

```ts
// src/components/semiconductors/diode.ts — new shape inside DIODE_PARAM_DEFS secondary
ISW: { default: 0, unit: "A", spiceName: "JSW",
       description: "Sidewall saturation current (DIOsatSWCur, ngspice JSW)" },
```

But — `defineModelParams` (`src/core/model-params.ts:4-49`) does not currently forward arbitrary ParamDef fields; it understands only `default/unit/description/min/max`. So the migration also requires extending `ParamSpec` and the `emit()` closure.

**Migration steps.**

1. Edit `src/core/model-params.ts:4-10`. Add to `ParamSpec`:
   ```ts
   interface ParamSpec {
     default: number;
     unit?: string;
     description?: string;
     min?: number;
     max?: number;
     // new:
     spiceName?: string;
     emit?: "key-value" | "flag";
     emitGroup?: { name: string; index: number };
   }
   ```
   Note: there is no `partition` field on `ParamSpec`. Partition is determined entirely by which bucket (`primary` / `secondary` / `instance`) a key appears in. Per-key overrides are not needed because every remaining knob lives squarely in one bucket — topology choices that previously needed an override (BJT SUBS) are now expressed as separate ModelEntry rows (§3.5), not as parameters.
2. Edit the `emit()` closure at `src/core/model-params.ts:28-42`. After building `pDef`, copy the new optional fields (`spiceName`, `emit`, `emitGroup`). Pseudocode:
   ```ts
   const pDef: ParamDef = { key, type: PropertyType.FLOAT, label: key, rank,
                            partition, default: s.default };
   if (s.spiceName !== undefined)  pDef.spiceName = s.spiceName;
   if (s.emit !== undefined)       pDef.emit = s.emit;
   if (s.emitGroup !== undefined)  pDef.emitGroup = s.emitGroup;
   /* unit, description, min, max as before */
   ```
3. Edit `src/components/semiconductors/diode.ts:127-128` — annotate `ISW` with `spiceName: "JSW"`.
4. Edit `src/components/semiconductors/tunnel-diode.ts:84-92` — same treatment if/when `ISW` is added (after the schema split in §3.4 it is not in TunnelDiode at all, so this step may evaporate).
5. Edit `src/components/semiconductors/varactor.ts` and the Zener equivalent (search for `DIODE_PARAM_DEFAULTS` consumers; these reuse the diode schema). Confirm they inherit the spiceName via shared paramDefs — they should not duplicate the field.
6. Delete `renames` from `DeviceNetlistRules` in the generator. Delete the lookup at `netlist-generator.ts:396`. The replacement is `def.spiceName ?? def.key` (already shown in §2.3).

**Test impact.**

- `netlist-generator.test.ts:592-630` (`Diode: ISW renames to JSW`) — keeps passing without modification.
- `diode.test.ts:1485-1513` (`DIODE_PARAM_DEFAULTS unchanged`) — keeps passing (defaults are unchanged).
- A new unit test under `src/core/__tests__/model-params.test.ts` should assert that `defineModelParams` forwards `spiceName` to the resulting `ParamDef`.

### 3.2 Bare-keyword flags (`OFF`)

**Current state.** `netlist-generator.ts:101,107,112,118,123,128,134,140,145,149` declares `instanceFlags: ["OFF"]` for nine devices. The generator at lines 350-353 emits `def.key` as a bare keyword when `v !== 0`, drops it otherwise.

**Proposed declarative form.** `ParamDef.emit?: "flag"` (Section 2.1).

```ts
// e.g. src/components/semiconductors/diode.ts
instance: {
  // ...
  OFF: { default: 0, emit: "flag",
         description: "Initial condition: device off (0=false, 1=true)" },
}
```

**Migration steps.** For each component that currently has `OFF` in its `instance` group, add `emit: "flag"` to the spec. The set of files is exactly the nine entries with `instanceFlags: ["OFF"]`:

1. `src/components/semiconductors/diode.ts:136` — Diode/Zener/Varactor (shared paramDefs).
2. `src/components/semiconductors/tunnel-diode.ts:93-95` — TunnelDiode (no OFF today; if added, mark it).
3. `src/components/semiconductors/bjt.ts:78` and :107 (BJT simple), :172 and :234 (BJT spice L1 NPN/PNP).
4. `src/components/semiconductors/mosfet.ts:173` (NMOS), :278 (PMOS).
5. `src/components/semiconductors/jfet.ts` — find OFF declaration, mark as flag.
6. Delete `instanceFlags` from `DeviceNetlistRules`, delete the `flagSet` collection at `netlist-generator.ts:324, 350-353`. The replacement is `if (def.emit === "flag") { if (v !== 0) parts.push(def.spiceName ?? def.key); continue; }` (already in §2.3).

**Test impact.**

- `netlist-generator.test.ts:417-456` (`diode: instance params emit on element line`) — passes unchanged (asserts bare `OFF`, not `OFF=`).
- `netlist-generator.test.ts:457-498` (NMOS), :529-575 (BJT) — pass unchanged.
- A schema-side unit test under each component's `__tests__/` should assert `paramDefs.find(d => d.key === "OFF")?.emit === "flag"`.

### 3.3 Combined IC triplet (MOSFET)

**Current state.** `netlist-generator.ts:136,141` declares `instanceCombineIC: ["ICVDS", "ICVGS", "ICVBS"]`. The generator at lines 327-347 collects the three values, and at line 361-362 emits them as `IC=vds,vgs,vbs` if any is non-zero.

**Proposed declarative form.** `ParamDef.emitGroup?: { name: string; index: number }` (Section 2.1).

```ts
// src/components/semiconductors/mosfet.ts — NMOS (mirror for PMOS)
instance: {
  // ...
  ICVDS: { default: 0, unit: "V", emitGroup: { name: "IC", index: 0 },
           description: "Initial condition for Vds (MODEUIC)" },
  ICVGS: { default: 0, unit: "V", emitGroup: { name: "IC", index: 1 },
           description: "Initial condition for Vgs (MODEUIC)" },
  ICVBS: { default: 0, unit: "V", emitGroup: { name: "IC", index: 2 },
           description: "Initial condition for Vbs (MODEUIC)" },
}
```

**Migration steps.**

1. `src/components/semiconductors/mosfet.ts:174-176` (NMOS) and :279-281 (PMOS) — add `emitGroup: { name: "IC", index: <0|1|2> }` to each of the three keys.
2. Delete `instanceCombineIC` from `DeviceNetlistRules`. Delete the special-case collection in the generator at lines 327-347 + 361-362. The replacement is the generic `groups: Map<string, …>` in §2.3.
3. Optional but recommended: add a runtime validator on registry-load that checks every `emitGroup` member of a given group has a unique `index` (otherwise the emitted IC tuple is silently scrambled).

**Test impact.**

- `netlist-generator.test.ts:457-498` (`MOSFET NMOS: non-default instance params emit ...`) — passes unchanged. The test asserts `IC=1.5,0.7,-0.2` and the absence of `ICVDS=`/`ICVGS=`/`ICVBS=`, both of which remain true under the new rules.
- New unit test: a MOSFET with all three IC values at default 0 must NOT emit any `IC=` token. (This is the case the current code handles via `if (icAny)`; the new code handles via `if (members.some(m => m.value !== 0))`.)

### 3.4 Tunnel-gated params (`IBEQ`/`IBSW`/`NB`)

**Current state.** `diode.ts:127-132` declares `IBEQ`, `IBSW`, `NB` in the *Diode* schema (and these are inherited by Zener, Varactor, and indirectly by TunnelDiode). The generator at `netlist-generator.ts:103,120` declares `modelCardDropUnlessTunnel: ["IBEQ","IBSW","NB"]` for plain Diode and TunnelDiode. The model-card prefix function `tunnelLevel` at line 91 reads `IBEQ`/`IBSW` and decides whether to emit `LEVEL=3`.

There are two latent design errors here:

1. Plain Diode carries tunnel-only params it cannot use. ngspice silently ignores them at LEVEL=1, but they pollute the netlist and the property panel.
2. The check "should I emit LEVEL=3?" is computed from param values rather than the model identity, which is the wrong dependency direction — TunnelDiode is *defined* as `LEVEL=3`; that is a property of the model, not of any param.

**Proposed declarative form.** Split the schemas, attach a constant `LEVEL=3` prefix to TunnelDiode's ModelEntry.

The recommendation in the predecessor doc (`spec/ngspice-netlist-generator-cleanup.md` §C) is correct. A `condition: (props) => boolean` predicate on `ParamDef` would also work mechanically, but it has worse properties:

| Option | Pros | Cons |
|---|---|---|
| **A. Split schemas** (recommended) | Plain-Diode property panel only shows what plain Diode can do. Tunnel-gated keys cannot be set on plain Diode and so cannot be wrong. ModelEntry-level `LEVEL=3` is constant on TunnelDiode and never has to be derived. Mirrors ngspice's separation: dioload.c:267-285 only runs when the model is built with the tunnel parser path. | Schema duplication. Existing optocoupler/polarized-cap code that imports `DIODE_PARAM_DEFAULTS` is unaffected (those use plain-Diode keys), but if a future tunnel-using consumer of `DIODE_PARAM_DEFAULTS` lands it would have to import the tunnel schema. |
| B. Predicate `condition: (props) => boolean` on ParamDef | One paramDef list, no duplication. | The plain-Diode property panel now has to filter out tunnel keys at render time, OR shows them but the user setting them does nothing. The "this param is/isn't real for this model" question becomes runtime, not schema. The netlist generator has to evaluate predicates per emission. The tunnel-vs-non-tunnel distinction is now spread across the ParamDef list with a hidden decision rule, instead of being two separate models. |

Option A is the cleaner answer. The cost (schema duplication) is real but small — TunnelDiode is the only consumer of the tunnel keys, and we already have separate `ModelEntry` records for the two component types in `register-all.ts:374`.

**Migration steps.**

1. **Edit `src/components/semiconductors/diode.ts:104-140`.** Remove `ISW`, `NSW`, `IBEQ`, `IBSW`, `NB` from `DIODE_PARAM_DEFS.secondary`. (Keep `ISW`/`NSW` in the Diode schema **only if** the code at `diode.ts:412-414` actually uses them at runtime for plain diodes; from the listing at lines 127-132, the comments say `D-W3-6: sidewall saturation current params — dioload.c:209-243` and `D-W3-7: tunnel current params — dioload.c:267-285`. Sidewall is not tunnel-gated; tunnel is. Move only `IBEQ`/`IBSW`/`NB`. Keep `ISW`/`NSW` on plain Diode.)
2. **Edit `src/components/semiconductors/diode.ts:411-414` (the `params` initialization in `createDiodeElement`).** Delete the three tunnel reads. Update load() at lines 619-635 to early-return / skip the tunnel block (the body of `if (params.IBSW > 0)` / `if (params.IBEQ > 0)` simply never runs, so the simplest change is `if (false && params.IBSW > 0)` — but that is dead code. Cleanest: hoist the tunnel block into a separate function and only call it from TunnelDiode's load path. Phase 1 of execution can leave this as a no-op guard `if (false)` and Phase 2 can extract.
3. **Edit `src/components/semiconductors/tunnel-diode.ts:77-96`.** Expand `TUNNEL_DIODE_PARAM_DEFS` to include the missing diode-secondary params that TunnelDiode actually consumes (currently it imports `computeJunctionCapacitance`/`computeJunctionCharge` from diode.ts and uses `CJO/VJ/M/TT/FC` — these are already declared. Add `IBEQ`, `IBSW`, `NB` here. Decide whether `ISW`/`NSW` belong here too — TunnelDiode does not currently read them per `tunnel-diode.ts:199-212`, so leave them out.).
4. **Edit `src/components/semiconductors/tunnel-diode.ts:524-532` (TunnelDiodeDefinition.modelRegistry).** Add `spice: { modelCardPrefix: ["LEVEL=3"] }` to the `behavioral` model entry. Whether the netlist generator should attach `LEVEL=3` to a model that simulates internally as the `behavioral` curve (not Shockley-with-tunnel-extension) is an interesting question — the answer is **yes**: the netlist generator's job is to make ngspice produce comparable output, and ngspice's tunnel diode is exactly LEVEL=3. The internal digiTS model can be whatever; the SPICE emission must say LEVEL=3 because that is what ngspice understands.
5. **Delete from `netlist-generator.ts`:** `modelCardDropUnlessTunnel` field on `DeviceNetlistRules`; the `tunnelLevel(props)` helper at lines 91-95; the `tunnelMode` derivation at line 387; the `dropUnlessTunnel` Set at line 381; the `if (!tunnelMode && dropUnlessTunnel.has(def.key)) continue` at line 395; the `modelCardPrefix` field on `DeviceNetlistRules` (replaced by `ModelEntry.spice.modelCardPrefix` plumbed in §3.7a).
6. **Audit the blast radius for `DIODE_PARAM_DEFAULTS` consumers** (Grep already confirms three: `optocoupler.ts:134`, `polarized-cap.ts:250`, `varactor.ts:56-72`). None of them reference `IBEQ`/`IBSW`/`NB` after the schema split, so they need no change. Confirm with `Grep` for `IBEQ|IBSW|NB` in those files before merging. (`varactor.ts` reuses `DIODE_PARAM_DEFAULTS.*` for individual keys — none of those keys are the tunnel-gated ones.)

**Test impact.**

- `netlist-generator.test.ts:636-687` — three `Diode: emits LEVEL=3 when IBEQ > 0` / `IBSW > 0` / `does NOT emit LEVEL=3 when IBEQ=0 and IBSW=0` / `does NOT emit LEVEL=3 for non-default NB alone` / `Zener: never emits LEVEL=3`. After the migration, all five tests must change:
  - The `IBEQ > 0`/`IBSW > 0`/`NB` plain-Diode tests become **expected-throw** tests asserting that `props.setModelParam("IBEQ", …)` on a plain Diode throws (because the schema no longer includes that key) or are **moved** to a new TunnelDiode test file.
  - A new TunnelDiode test asserts that any TunnelDiode emits `(LEVEL=3 …)` unconditionally on its model card.
  - The `Zener: never emits LEVEL=3` test stays as-is (Zener is plain-Diode-derived and never has LEVEL=3).
- `diode.test.ts:1509-1513` — five lines assert `DIODE_PARAM_DEFAULTS.ISW/NSW/IBEQ/IBSW/NB` exist with specific defaults. Three of those (`IBEQ`/`IBSW`/`NB`) must be deleted from `DIODE_PARAM_DEFAULTS` and re-asserted on `TUNNEL_DIODE_PARAM_DEFAULTS`.
- `tunnel-diode.test.ts` — `TUNNEL_DIODE_PARAM_DEFS partition layout` at line 615 needs to gain assertions for the new `IBEQ`/`IBSW`/`NB` keys.

### 3.5 BJT topology — model variants, not a parameter

**Current state.** `bjt.ts:175,237` declares `SUBS` in the `instance` group of NPN-spice and PNP-spice variants. `netlist-generator.ts:125,130` declares `instanceDropAlways: ["SUBS"]`. `bjt.ts:1046,1142` reads `SUBS` at simulation time (`isLateral = params.SUBS === 0`) to switch the c4 leakage current scaling between `AREAB` (vertical) and `AREAC` (lateral) per `bjtload.c:184-187`. SUBS is set in exactly one place outside its declaration: `netlist-generator.test.ts:542`. It is never set via UI or by any production circuit.

**The deeper problem.** `SUBS` is not a parameter. Parameters are numerical knobs that participate in Norton-pair stamps, temperature scaling, area scaling, charge integration. `SUBS` is a binary topology selector — it picks between two structurally different devices, both electrically valid, that stamp on different nodes. Hot-loading `SUBS` mid-simulation would silently re-target a stamp from `colPrime` to `basePrime`; that is not a parameter sweep, it is a different device.

We already have a mechanism for "two structurally distinct devices that share most of their behaviour": `modelRegistry`. NPN vs PNP is a separate component typeId. Vertical NPN vs lateral NPN should be a separate `modelRegistry` entry on the same component, picked via the `model` property — same machinery used for `behavioral` vs `spice-l1` vs device presets (`2N3904`, `BC547B`, …).

**Proposed declarative form.** Delete `SUBS` from the schema entirely. Add lateral variants to BJT's `modelRegistry`. The factory captures `isLateral` as a closure constant.

The current BJT L1 factory in `bjt.ts` is **a single top-level function** (named along the lines of `createBjtL1Element`) matching the `AnalogFactory` signature `(pinNodes, internalNodeIds, branchIdx, props) => element`. It builds a `params` object from `props.getModelParam(...)` calls (lines ~1010-1047), derives temperature-scaled working values (`tp = makeTp()`), wires internal nodes, and returns the element object whose `load(ctx)` method does the actual stamps. The factory is **not** currently curried — it is a plain function reference passed directly into `modelRegistry["spice-l1"].factory`.

The migration converts it to a **factory factory**: the outer function takes `isLateral`, the inner function matches the existing `AnalogFactory` signature, and the `isLateral` constant lives in the closure of the inner function (so every element of a given ModelEntry shares the same topology, set once at registry-load time and never rebound).

```ts
// src/components/semiconductors/bjt.ts — sketch
function createBjtL1Element(isLateral: boolean): AnalogFactory {
  return (pinNodes, internalNodeIds, branchIdx, props) => {
    // ...existing factory body verbatim, EXCEPT:
    //   - `SUBS: props.getModelParam<number>("SUBS")` deleted from the params init
    //   - `const isLateral = params.SUBS === 0` at line 1142 deleted
    //   - all reads of `isLateral` resolve to the closure-captured boolean
    // Returns the element object exactly as before.
  };
}

// inside NpnBJTDefinition.modelRegistry
"spice-l1": {
  kind: "inline",
  factory: createBjtL1Element(false),                    // vertical
  paramDefs: BJT_SPICE_L1_PARAM_DEFS,                    // SUBS removed
  params: BJT_SPICE_L1_NPN_DEFAULTS,
},
"spice-l1-lateral": {
  kind: "inline",
  factory: createBjtL1Element(true),                     // lateral
  paramDefs: BJT_SPICE_L1_PARAM_DEFS,                    // shared defs
  params: BJT_SPICE_L1_NPN_DEFAULTS,
},
```

The same shape applies to PNP. Both variants share `BJT_SPICE_L1_PARAM_DEFS`; only the closure-captured topology constant differs. **`defaultModel` MUST remain `"spice-l1"` (vertical)** on both NpnBJTDefinition and PnpBJTDefinition — the lateral variant is strictly opt-in, and any change to `defaultModel` would silently re-target every existing BJT in saved circuits.

**Why this is correct.**

- It mirrors ngspice's actual structure: vertical and lateral are separate model parser paths in ngspice, and the ngspice .model card uses `subs=1` / `subs=-1` as a model parameter only on certain BJT levels (BJT4/VBIC), not the SPICE Level-1 BJT — which is exactly why ngspice rejected our `SUBS=1` instance token in the first place. The `unknown parameter (subs)` error was correct: SUBS does not belong on a Level-1 BJT instance line, full stop.
- It eliminates the "no-emit / internal" partition concept from `ParamDef`. Every remaining param is either an instance param ngspice accepts or a model-card param ngspice accepts. There is no third bucket for "things ngspice has no slot for", because such things are not parameters.
- It removes the runtime `if (params.SUBS === 0)` branch entirely — `isLateral` is a constant per-instance, set once at element construction, and the V8 JIT can specialize on it.
- It is hot-loadable in the only sense that matters: changing the `model` property re-runs the model factory, allocating a fresh element with the new topology. The user already has this mechanism for switching between `spice-l1` and `2N3904`.

**Migration steps.**

1. **Edit `src/components/semiconductors/bjt.ts:175`** (NPN_L1 instance group) and **`:237`** (PNP_L1 instance group): delete the `SUBS: { default: 1, … }` line.
2. **Edit `bjt.ts:1046`**: delete `SUBS: props.getModelParam<number>("SUBS")` from the params object initialization.
3. **Edit `bjt.ts` factory signature**: convert the existing top-level BJT L1 factory function (the `AnalogFactory`-shaped function consumed by `modelRegistry["spice-l1"].factory`) into the `createBjtL1Element(isLateral: boolean): AnalogFactory` factory-of-factory pattern shown in the sketch above. Replace `const isLateral = params.SUBS === 0` at line 1142 with the closure-captured boolean. The inner function body is otherwise unchanged.
4. **Edit `bjt.ts` BJT definitions**: locate `NpnBJTDefinition.modelRegistry` and `PnpBJTDefinition.modelRegistry`. For each existing `spice-l1` entry, change `factory: createBjtL1Element` (or whatever it was) to `factory: createBjtL1Element(false)` — the vertical default. Add a parallel `"spice-l1-lateral"` entry built with `createBjtL1Element(true)`. Both entries share the same `paramDefs` and `params`. **`defaultModel` MUST stay `"spice-l1"`** on both polarities — verify the existing value in each Definition is unchanged after the edit.
5. **Verify the model-swap path before declaring the migration complete.** When a BJT element's `model` property is changed from `"spice-l1"` to `"spice-l1-lateral"`, the simulator MUST re-run the new ModelEntry's factory and replace the element instance — otherwise the topology constant remains the old closure value and the stamp stays wrong. Trace the path `props.set("model", …)` → component recompile / element re-factory in the analog engine before committing this stage. If the existing path does not rebuild on `model` change, that is a pre-existing gap that this stage MUST land a fix for; the lateral variant is unusable without it. Do not assume CLAUDE.md's "model is the source of truth post-placement" guarantee implies a working hot-swap — read the code path and confirm.
6. **Edit `netlist-generator.ts`**: delete `instanceDropAlways` from `DeviceNetlistRules`; delete the `dropAlways` Set at line 325; delete `if (dropAlways.has(def.key)) continue` at line 336; delete the two `instanceDropAlways: ["SUBS"]` entries at lines 125 and 130. The mechanism is now unused.
7. **No `partition: "internal"`.** §2.1 above already removed this from `ParamDef`. The migration is complete with zero new partition values.

**Test impact.**

- `bjt.test.ts:1986` (`expect(propsObj.getModelParam<number>("SUBS")).toBe(1)`) — **must be deleted.** SUBS is no longer in the schema; reading it would throw or return undefined.
- `bjt.test.ts:3017, 3026` (`expect(BJT_SPICE_L1_NPN_DEFAULTS.SUBS).toBe(1)`) — **must be deleted.** Same reason.
- `netlist-generator.test.ts:542` (`props.setModelParam("SUBS", 1)`) — **must be deleted.** The test still passes (SUBS will not appear in output) but for the wrong reason; remove it and assert the lateral variant test instead (see below).
- **Default-model preservation test (new).** Under `bjt.test.ts`, assert `NpnBJTDefinition.defaultModel === "spice-l1"` and `PnpBJTDefinition.defaultModel === "spice-l1"` so future edits cannot silently move the vertical-default invariant. Confirm no fixture or test relied on `SUBS=0` to flip a default-vertical BJT into lateral — grep shows only one such test, which is the harness one being deleted.
- **Lateral-variant existence test (new).** Under `bjt.test.ts`, assert `NpnBJTDefinition.modelRegistry["spice-l1-lateral"] !== undefined` and same for PnpBJTDefinition. Assert both lateral entries share `paramDefs` reference-equality with their vertical siblings.
- **Lateral-vs-vertical c4 stamp test (new), concrete pattern.** This is the load-time verification that the closure swap actually changed simulation behaviour. Build two BJT instances side-by-side with `AREAB ≠ AREAC` (e.g. `AREAB=1`, `AREAC=2`), identical params otherwise, identical pin nets, one using model `"spice-l1"` and one using `"spice-l1-lateral"`. Run a single `load()` call on each (a DC-OP context is sufficient — no transient needed). Capture the c4 leakage current via the existing convergence-log / state-pool inspection helpers. Assert `c4_lateral / c4_vertical === AREAC / AREAB` (i.e. ratio 2 in this fixture). The test fails if the closure-captured `isLateral` did not reach the `tBCleakCur * (isLateral ? AREAC : AREAB)` site at `bjt.ts:1148`. Same test for PNP.
- **Model-swap test (new).** Build a single BJT instance with `model = "spice-l1"` and identical AREAB/AREAC asymmetry as above. Capture c4. Then `props.set("model", "spice-l1-lateral")`, force a recompile of the analog engine, and capture c4 again. Assert the second c4 matches the lateral closure path. This test is the regression gate for migration step 5 — if model-swap silently retains the old factory, this test fails and the implementation must be fixed before merge.

**Optional follow-up (not required for this cleanup):** rename the model-registry keys to express topology more crisply, e.g. `spice-l1-vertical` and `spice-l1-lateral`, leaving `spice-l1` as an alias for `spice-l1-vertical` so existing circuits keep loading.

### 3.6 Renames are unified with §3.1

Already covered above — listed here only for completeness in the seven-mechanism table.

### 3.7 `instanceDropIfDefault` — DELETED as a concept

**Current state.** `netlist-generator.ts:102,108,113,119,124,129,135,141,146,150` declares per-device default-equality maps such as `{ TEMP: REFTEMP, AREA: 1, M: 1 }`. The generator at line 356 silently omits any param whose value equals the listed default.

**Proposed declarative form.** None. Delete the field, delete the call site, delete every per-device entry. Per the user's confirmation and the predecessor doc §A:

- `M=1`, `TEMP=300.15`, `AD=0`, `AS=0`, `PD=0`, `PS=0`, `AREA=1`, `AREAB=1`, `AREAC=1` are all *valid* ngspice instance defaults. Emitting them is at most one extra token per element line; ngspice does not warn.
- Earlier hypothesis "every byte we emit may be relevant to the worker crash" was wrong (the predecessor doc §A acknowledges this).
- Keeping `instanceDropIfDefault` adds a third level of indirection between schema and netlist (declared default, emitted default, ngspice default) that has to stay in sync.

**Migration steps.**

1. Delete `instanceDropIfDefault` from `DeviceNetlistRules` interface in `netlist-generator.ts`.
2. Delete `dropDefaults` and `if (def.key in dropDefaults && v === dropDefaults[def.key]) continue` from the generator (lines 326, 356).
3. Delete every `instanceDropIfDefault: { … }` entry from the per-device rules block (lines 102, 108, 113, 119, 124, 129, 135, 141, 146, 150).

**Test impact.**

- `netlist-generator.test.ts:457-498` (NMOS test) — the test deliberately uses non-default values for every param so each token survives. Therefore the assertion `expect(elementLine).toContain("W=2e-6")`, `M=2`, `OFF` (bare), etc. all pass identically.
- `netlist-generator.test.ts:529-575` (BJT test) — same: `AREA=2`, `AREAB=1.5`, `AREAC=1.7`, `M=2`, `ICVBE=0.7`, `ICVCE=5`, `TEMP=350` are all non-default and survive.
- The diode test at line 417-433 already uses `AREA=2` (non-default), `OFF=1` (non-default), `TEMP=325` (non-default). Passes unchanged.

If the generator output for some ngspice-parity test now includes redundant tokens like `M=1`, that is acceptable and noise-only — the predecessor doc §A confirms ngspice does not warn.

### 3.7a Tunnel `LEVEL=3` prefix

**Current state.** `netlist-generator.ts:91-95, 100, 117, 385-387` — a per-device `modelCardPrefix: tunnelLevel` function reads `IBEQ`/`IBSW` from props at emit time.

**Proposed declarative form.** `ModelEntry.spice.modelCardPrefix: readonly string[]` (Section 2.2), set on TunnelDiode's `behavioral` ModelEntry only:

```ts
// src/components/semiconductors/tunnel-diode.ts — TunnelDiodeDefinition.modelRegistry
modelRegistry: {
  "behavioral": {
    kind: "inline",
    factory: createTunnelDiodeElement,
    paramDefs: TUNNEL_DIODE_PARAM_DEFS,
    params: TUNNEL_DIODE_PARAM_DEFAULTS,
    spice: { modelCardPrefix: ["LEVEL=3"] },          // ← new
  },
},
```

Plain Diode's ModelEntry has no `spice.modelCardPrefix` (or has `spice: {}` — same effect).

**Migration steps.**

1. Plumb `ModelEntry.spice` through to `modelCardSuffix()` in the generator. The generator currently only receives `paramDefs` from the ModelEntry — it needs the whole `spice` object too. Edit `netlist-generator.ts:200` to capture `modelEntry.spice` and pass to `modelCardSuffix`.
2. Add `spice: { modelCardPrefix: ["LEVEL=3"] }` to `tunnel-diode.ts:524-532`.
3. Delete `tunnelLevel` and `modelCardPrefix` per-device entries from `netlist-generator.ts`.

**Test impact.**

- `netlist-generator.test.ts:636-687` — the five LEVEL=3 tests change as described in §3.4.
- A new TunnelDiode-only test asserts `expect(netlist).toContain(".model TD1_D D (LEVEL=3 ...")` regardless of param values.

### 3.7b Pre-existing `modelCardDropIfZero: ["NSUB","NSS"]`

**Current state.** `netlist-generator.ts:133,138`. Same flavour as §3.7 (`instanceDropIfDefault`) but on the model-card side, and pre-existing rather than added in this session.

**Proposed declarative form.** None — delete the field as a concept (same reasoning as §3.7).

The predecessor doc §D flagged this as out of scope but suggested the cleaner answer is to "not declare NSUB/NSS in paramDefs at all unless the model genuinely uses them". That is a follow-up question, not a blocker for this cleanup. **For this cleanup, simply delete `modelCardDropIfZero` and let `NSUB=0`/`NSS=0` emit on the model card.** ngspice ignores them at LEVEL=1 (predecessor doc §D explicitly says this) and emits no warning.

If the user later wants to remove `NSUB`/`NSS` from the MOS Level-1 schema entirely, that is its own architectural call (Level-1 versus Level-2/3 schema split, mirroring the Diode/TunnelDiode split). Keep this cleanup focused; flag it for follow-up.

**Migration steps.**

1. Delete `modelCardDropIfZero` from `DeviceNetlistRules`.
2. Delete `dropIfZero` Set and the `if (dropIfZero.has(def.key) && v === 0) continue` line from `modelCardSuffix`.
3. Delete the two `modelCardDropIfZero: ["NSUB", "NSS"]` entries (`netlist-generator.ts:133, 138`).

**Test impact.**

- `netlist-generator.test.ts:689-748` — six tests covering `NMOS: NSUB=0 dropped from model card`, `NMOS: NSUB=1e16 emitted`, `NMOS: NSS=0 dropped`, etc. Three of these (the "dropped" ones) **must change** to assert the param IS emitted at default zero. Mechanically:
  - `NMOS: NSUB=0 dropped from model card` → `NMOS: NSUB=0 emitted on model card` (`expect(modelLine).toContain("NSUB=0")`).
  - `NMOS: NSS=0 dropped from model card` → `NMOS: NSS=0 emitted on model card`.
  - `PMOS: NSUB=0 and NSS=0 dropped from model card` → `PMOS: NSUB=0 and NSS=0 emitted on model card`.
  - The "non-zero emitted" tests (NSUB=1e16, NSS=2e10) pass unchanged.

If at execution time the user changes their mind and wants the silence preserved, fine — but the spec author's stated preference (§D) is "not declare them in paramDefs unless they're used", and dropping them at emit time is a half-measure compared to schema cleanup. Half-measures are forbidden by `No Pragmatic Patches`. So: delete `modelCardDropIfZero`. Schema cleanup of NSUB/NSS for MOS L1 is a separate follow-up the user can prioritize independently.

---

## 4. Summary of File-level Changes

For executor convenience, here is every file that must change, with the reason:

| File | Reason | Sections |
|---|---|---|
| `src/core/registry.ts` | Add `spiceName`, `emit`, `emitGroup` to `ParamDef`; add `spice: ModelEmissionSpec` to `ModelEntry`. | 2.1, 2.2 |
| `src/core/model-params.ts` | Extend `ParamSpec` with `spiceName`, `emit`, `emitGroup`; forward new fields in `emit()`. (No `partition` override needed — every param's partition is determined by its bucket.) | 3.1 step 1-2 |
| `src/components/semiconductors/diode.ts` | Remove `IBEQ`/`IBSW`/`NB` from secondary; mark `OFF` as `emit: "flag"`; add `spiceName: "JSW"` to `ISW`; remove `IBEQ`/`IBSW`/`NB` reads from `createDiodeElement`. | 3.1, 3.2, 3.4 |
| `src/components/semiconductors/tunnel-diode.ts` | Add `IBEQ`/`IBSW`/`NB` to TUNNEL_DIODE_PARAM_DEFS secondary (or: a richer split that matches what TunnelDiode actually models); add `spice: { modelCardPrefix: ["LEVEL=3"] }` to ModelEntry; mark `OFF` as `emit: "flag"` if/when added. | 3.4, 3.7a |
| `src/components/semiconductors/zener.ts`, `varactor.ts` | Inherit changes via shared paramDefs (no edit needed) OR mark `OFF` as flag if their schemas are independent — verify by grep. | 3.2 |
| `src/components/semiconductors/bjt.ts` | Delete `SUBS` from BJT_SPICE_L1 instance group (NPN :175, PNP :237) and from params init (:1046); convert L1 factory to take closure-captured `isLateral`; replace `params.SUBS === 0` at :1142 with the closure constant; add `spice-l1-lateral` ModelEntry to NpnBJTDefinition and PnpBJTDefinition modelRegistry; mark `OFF` as `emit: "flag"` (4 sites: :78, :107, :172, :234). | 3.2, 3.5 |
| `src/components/semiconductors/mosfet.ts` | Mark `OFF` as `emit: "flag"` (NMOS :173, PMOS :278); add `emitGroup: { name: "IC", index: 0\|1\|2 }` to ICVDS/ICVGS/ICVBS (NMOS :174-176, PMOS :279-281). | 3.2, 3.3 |
| `src/components/semiconductors/jfet.ts` (or wherever NJFET/PJFET live) | Mark `OFF` as `emit: "flag"`. | 3.2 |
| `src/solver/analog/__tests__/harness/netlist-generator.ts` | Delete `DEVICE_NETLIST_RULES` table, `tunnelLevel` helper, `REFTEMP` constant, every special-case branch in `instanceParamSuffix` and `modelCardSuffix`. Replace with the schema-driven version in §2.3. Plumb `ModelEntry.spice` to `modelCardSuffix`. | 2.3, 3.1-3.7b |
| `src/solver/analog/__tests__/harness/netlist-generator.test.ts` | Update three NSUB/NSS "dropped" tests to assert "emitted"; update three IBEQ/IBSW/NB plain-Diode LEVEL=3 tests (move to TunnelDiode). | 3.4, 3.7b |
| `src/components/semiconductors/__tests__/diode.test.ts` | Remove `expect(DIODE_PARAM_DEFAULTS.IBEQ/IBSW/NB).toBe(...)` assertions at :1511-1513; add equivalents to tunnel-diode.test.ts. | 3.4 |
| `src/components/semiconductors/__tests__/tunnel-diode.test.ts` | Add IBEQ/IBSW/NB partition assertions; assert ModelEntry.spice.modelCardPrefix === ["LEVEL=3"]. | 3.4, 3.7a |
| `src/components/semiconductors/__tests__/bjt.test.ts` | Delete `SUBS` getModelParam / defaults assertions (:1986, :3017, :3026); add `spice-l1-lateral` ModelEntry existence + lateral-vs-vertical c4 stamp assertions. | 3.5 |
| `src/core/__tests__/model-params.test.ts` (new or extend existing) | Add forwarding tests for `spiceName`, `emit`, `emitGroup`. | 3.1 |

Schema and generator files: ~10. Tests: ~5. The blast radius is contained and the changes are mechanical.

---

## 5. Why This is the Cleanest Final Architecture

Three properties to verify:

1. **No typeId branching in the generator.** After the rewrite, `netlist-generator.ts` contains zero `if (typeId === ...)` and zero string-keyed lookups indexed by component name. The pin-order convention per element-prefix (R, C, L, V, I, D, Q, M, J) is unavoidable because it is part of SPICE itself — but the *parameter emission* logic is fully schema-driven. The generator becomes the kind of code you can read top-to-bottom without a per-device cheat sheet.

2. **Every emission rule is declared once, at the param it governs.** No two-place truth (declaration in `paramDefs`, override in `DeviceNetlistRules`) for any single parameter. The TypeScript interface enforces this at compile time: `ParamDef` has named optional fields; `DeviceNetlistRules` ceases to exist.

3. **Hot-loadable params are unaffected.** `setParam(key, value)` remains a property-bag operation independent of emission spec. Every remaining param is a real numerical knob ngspice accepts on either the instance line or the model card; emission rules (`spiceName`, `emit`, `emitGroup`) only affect how the value is rendered, never whether the value is stored or readable. Topology choices (BJT vertical/lateral) are not parameters at all — they are model-registry entries, switched by changing the `model` property, which already triggers a fresh element factory call.

Two concessions:

- **Schema duplication for Diode/TunnelDiode (§3.4).** The alternative ("predicate per param") replaces a clean schema-based split with a runtime decision sprinkled across a single overloaded list, and pollutes the plain-Diode property panel with keys that do nothing. Schema duplication is local, debuggable, and matches ngspice's own model-parser separation.
- **ModelRegistry duplication for BJT vertical/lateral (§3.5).** The lateral entry shares paramDefs and defaults with the vertical entry — only the closure-captured `isLateral` constant differs. This mirrors how NPN vs PNP is already structured (separate component types with shared infrastructure) and how device presets like `2N3904` already piggyback on the L1 schema.

---

## 6. Trade-offs

| Decision | Pros | Cons |
|---|---|---|
| Split Diode/TunnelDiode schemas (§3.4) | Plain Diode UI cleaner; LEVEL=3 becomes constant on TunnelDiode | Some duplication in secondary param lists; `dropIfZero` follow-up for NSUB/NSS analogously suggested but deferred. |
| BJT topology as model variants (§3.5) | Eliminates `instanceDropAlways` and the `internal`/no-emit partition concept entirely; mirrors ngspice's actual model-parser separation; runtime branch becomes a closure constant | Two ModelEntry rows per BJT polarity (vertical + lateral) instead of one with a flag. Net code reduction since SUBS reads, defaults, and tests all go away. |
| `emitGroup` keyed by name+index (§3.3) | Order is locally readable at the param site; supports >3-element groups in future | Slightly more verbose than a positional `[a,b,c]` list at the rules table — but the rules table is going away, so the comparison favours `emitGroup`. |
| Delete `instanceDropIfDefault` (§3.7) | Removes a layer of indirection; ngspice accepts redundant defaults silently | Netlists become a few tokens longer (cosmetic). |
| Delete `modelCardDropIfZero` (§3.7b) | Same | Three test assertions flip from "dropped" to "emitted"; long-term schema cleanup of NSUB/NSS deferred to a separate task. |

There is no "predicate-per-param" trade-off offered because Section 3.4 already analysed and rejected it.

---

## 7. Execution Order

Do the work in this sequence. Each step lands cleanly and the suite stays green between steps; do not collapse them into a single mega-PR.

**Step 1 — Extend the type system.** Edit `src/core/registry.ts` (`ParamDef` new fields `spiceName`/`emit`/`emitGroup`, `ModelEntry.spice`) and `src/core/model-params.ts` (ParamSpec extensions and field forwarding). Add `src/core/__tests__/model-params.test.ts` assertions that the new fields round-trip from `defineModelParams` to `paramDefs`. Run `npm run test:q -- model-params`. No component yet sets the new fields, so existing tests pass without change.

**Step 2 — Migrate per-param fields on every component schema.** Edit each component file in §4 to add `emit: "flag"` on every OFF; `spiceName: "JSW"` on Diode's ISW; `emitGroup` on the three MOS IC keys. Do this WITHOUT touching the netlist generator yet — the schema is now correct in declaration but the generator is still consulting its own table. Run the existing test suite; all tests pass because the generator is unchanged.

**Step 3a — Split Diode / TunnelDiode schemas (§3.4).** Move IBEQ/IBSW/NB out of DIODE_PARAM_DEFS into TUNNEL_DIODE_PARAM_DEFS. Update `createDiodeElement` to stop reading them. Add `spice: { modelCardPrefix: ["LEVEL=3"] }` to TunnelDiode's ModelEntry. Update `diode.test.ts:1511-1513` and `tunnel-diode.test.ts` accordingly. Run `npm run test:q -- diode tunnel-diode`. (The netlist generator is still consulting its rule table at this point, which still includes `modelCardDropUnlessTunnel: ["IBEQ","IBSW","NB"]` — those keys simply will not appear on plain-Diode props anymore, so the rule becomes a no-op. The harness tests still pass.)

**Step 3b — BJT topology as model variants (§3.5).** Delete `SUBS` from BJT_SPICE_L1 NPN/PNP instance groups; delete from params init; convert the L1 factory to take a closure-captured `isLateral` boolean; replace `params.SUBS === 0` at `bjt.ts:1142` with the closure constant. Add `spice-l1-lateral` ModelEntry to NpnBJTDefinition and PnpBJTDefinition (sharing paramDefs and defaults with the vertical entry). Delete the three SUBS assertions from `bjt.test.ts` and the SUBS setModelParam from `netlist-generator.test.ts:542`. Add a lateral-vs-vertical c4 stamp test. Run `npm run test:q -- bjt`. The harness still passes (the rule-table entry for `SUBS` becomes a no-op once the schema no longer carries the key).

**Step 4 — Rewrite the generator (§2.3).** Delete `DEVICE_NETLIST_RULES`, `tunnelLevel`, `REFTEMP`, every per-device branch (including `instanceDropAlways`, which is unused after Step 3b deletes SUBS from the schema). Implement the schema-driven `instanceParamSuffix` and `modelCardSuffix` as written. Plumb `ModelEntry.spice` through `generateSpiceNetlist`. Update `netlist-generator.test.ts`: flip three NSUB/NSS dropped→emitted; rewrite the LEVEL=3 tests to TunnelDiode-only; everything else passes unchanged. Run `npm run test:q -- harness`.

**Step 5 — Verify ngspice parity.** Run the full harness/parity suite with `NGSPICE_LOG=1` (per `spec/ngspice-netlist-generator-cleanup.md` §2). Confirm zero `Error on` / `unknown parameter` / `unrecognized parameter` lines from ngspice. If any appear, the schema migration in Step 2 missed a flag/group; do not re-introduce a generator special case — fix the schema.

**Step 6 — Mark the predecessor doc resolved.** Update `spec/ngspice-netlist-generator-cleanup.md` "Cleanup needed" sections A, B, C, D to reference this proposal as their resolution and the relevant commit IDs. The "Open question" worker-crash section is unrelated to this cleanup and stays open.

After Step 6, `netlist-generator.ts` is a generator, not a translator. The hard-coded device knowledge is gone, and adding a new analog component requires only declaring its `paramDefs` correctly — no edits to `__tests__/` infrastructure.

---

## References

- `src/solver/analog/__tests__/harness/netlist-generator.ts:46-152` — the rule table being deleted
- `src/solver/analog/__tests__/harness/netlist-generator.ts:91-95` — `tunnelLevel` helper being deleted
- `src/solver/analog/__tests__/harness/netlist-generator.ts:318-366` — `instanceParamSuffix` to be replaced
- `src/solver/analog/__tests__/harness/netlist-generator.ts:372-404` — `modelCardSuffix` to be replaced
- `src/core/registry.ts:33-52` — `ParamDef` interface to extend
- `src/core/registry.ts:58-75` — `ModelEntry` discriminated union to extend
- `src/core/model-params.ts:4-49` — `defineModelParams` to extend
- `src/components/semiconductors/diode.ts:104-140` — DIODE_PARAM_DEFS, source of the schema split
- `src/components/semiconductors/diode.ts:411-414` — runtime reads of IBEQ/IBSW/NB to remove
- `src/components/semiconductors/tunnel-diode.ts:77-96` — TUNNEL_DIODE_PARAM_DEFS to grow
- `src/components/semiconductors/tunnel-diode.ts:524-532` — TunnelDiodeDefinition.modelRegistry, target of the new `spice` field
- `src/components/semiconductors/bjt.ts:175,237` — SUBS declarations to delete from BJT_SPICE_L1 instance groups
- `src/components/semiconductors/bjt.ts:1046,1142` — runtime SUBS reads to replace with closure-captured `isLateral`
- `src/components/semiconductors/bjt.ts` `NpnBJTDefinition.modelRegistry` / `PnpBJTDefinition.modelRegistry` — target for new `spice-l1-lateral` ModelEntry rows
- `src/components/semiconductors/mosfet.ts:174-176, 279-281` — ICVDS/ICVGS/ICVBS, target of `emitGroup`
- `src/solver/analog/__tests__/harness/netlist-generator.test.ts:417-748` — test file with the assertions to update
- `spec/ngspice-netlist-generator-cleanup.md` — predecessor handoff document
- `CLAUDE.md` "No Pragmatic Patches" — rule that mandates the schema split over a runtime-predicate halfway answer
- `CLAUDE.md` Hot-loadable params — invariant preserved by construction (partition is emission-only, never gates `setParam`)
