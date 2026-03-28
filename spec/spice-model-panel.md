# SPICE Model Parameters Panel & Test Parameter Alignment

## Overview

Add a collapsible SPICE Model Parameters panel to the property popup for analog components, migrate the tunnel diode to the standard model-defaults pattern, and align test circuit model parameters with ngspice references.

## Part 0: Tunnel Diode Model-Defaults Migration

### Problem

The tunnel diode reads its parameters (`ip`, `vp`, `iv`, `vv`) directly from PropertyBag via `getOrDefault()` in its factory function (`tunnel-diode.ts:120-124`). Every other semiconductor reads from `_modelParams` injected by the compiler. This means the tunnel diode won't work with the SPICE panel or `_spiceModelOverrides`.

### Changes

1. **Add `TUNNEL_DIODE_DEFAULTS` to `src/solver/analog/model-defaults.ts`:**
   ```typescript
   export const TUNNEL_DIODE_DEFAULTS: Record<string, number> = {
     /** IP: peak tunnel current (A) */
     IP: 5e-3,
     /** VP: peak voltage (V) */
     VP: 0.08,
     /** IV: valley current (A) */
     IV: 0.5e-3,
     /** VV: valley voltage (V) */
     VV: 0.5,
     /** IS: thermal saturation current (A) */
     IS: 1e-14,
     /** N: emission coefficient */
     N: 1,
   };
   ```

2. **Update `createTunnelDiodeElement` in `tunnel-diode.ts`** to read from `_modelParams` instead of individual props:
   ```typescript
   const modelParams = (props as Record<string, unknown>)["_modelParams"] as Record<string, number> | undefined;
   const ip = modelParams?.IP ?? 5e-3;
   const vp = modelParams?.VP ?? 0.08;
   const iv = modelParams?.IV ?? 0.5e-3;
   const vv = modelParams?.VV ?? 0.5;
   ```

3. **Add `"TUNNEL"` to the `DeviceType` union** in `src/core/analog-types.ts:147` — currently the union is `"NPN" | "PNP" | "NMOS" | "PMOS" | "NJFET" | "PJFET" | "D"` and `"TUNNEL"` is assigned without being a member.

4. **Register `TUNNEL` in the model library** so `modelLibrary.getDefault("TUNNEL")` resolves. Follow the same pattern used for `D`, `NPN`, etc.

5. **Remove the individual `ip`, `vp`, `iv`, `vv` property definitions** from `TUNNEL_DIODE_PROPERTY_DEFS` and the corresponding attribute mappings — these are now SPICE model parameters, not top-level properties.

### Files to Modify

| File | Change |
|------|--------|
| `src/core/analog-types.ts:147` | Add `"TUNNEL"` to `DeviceType` union |
| `src/solver/analog/model-defaults.ts` | Add `TUNNEL_DIODE_DEFAULTS` |
| `src/components/semiconductors/tunnel-diode.ts` | Read from `_modelParams`, remove individual prop defs |
| Model library registration site | Register `TUNNEL` → `TUNNEL_DIODE_DEFAULTS` |

### Acceptance Criteria

- `modelLibrary.getDefault("TUNNEL")` returns the tunnel diode defaults
- Compiling a circuit with a tunnel diode injects `_modelParams` with the tunnel defaults
- Tunnel diode simulation produces identical results before and after migration (existing tests pass)

## Part 1: SPICE Model Parameters Collapsible Panel

### Architecture

Replicate the Pin Electrical pattern (`property-panel.ts:311-443`):
- Collapsible `▶ SPICE Model Parameters` section
- Same inline styling as existing Pin Electrical section
- Appears when the component's active model is analog AND has a `deviceType` AND a matching defaults entry exists in `model-defaults.ts`

### Visibility Guard

Pin Electrical and SPICE Model Parameters are **mutually exclusive**:
- `logical` or `analog-pins` mode → show Pin Electrical, hide SPICE
- `analog` mode with `deviceType` → show SPICE, hide Pin Electrical

Replace the existing Pin Electrical block in `canvas-popup.ts` (lines 84-91) with unified logic:

```typescript
const simModel = elementHit.getProperties().has("simulationModel")
  ? elementHit.getProperties().get("simulationModel") as string
  : (def.defaultModel ?? "logical");

if (simModel === "logical" || simModel === "analog-pins") {
  if (hasDigitalModel(def)) {
    const family = ctx.circuit.metadata.logicFamily ?? defaultLogicFamily();
    propertyPopup.showPinElectricalOverrides(elementHit, def, family);
  }
} else if (def.models?.analog?.deviceType !== undefined) {
  propertyPopup.showSpiceModelParameters(elementHit, def);
}
```

No hardcoded device type list — if a `deviceType` has defaults registered, it gets a panel.

### `showSpiceModelParameters()` Method

Add to `PropertyPanel` class in `property-panel.ts` (~130 lines):

```typescript
showSpiceModelParameters(
  element: CircuitElement,
  def: ComponentDefinition,
): void
```

**Behavior:**
- Look up `def.models!.analog!.deviceType` to determine which defaults to load
- Import the defaults lookup from `model-defaults.ts` (or `model-param-meta.ts`)
- Read stored overrides from `_spiceModelOverrides` in the element's PropertyBag
- For each parameter in the defaults: show an input with `parseSI` for parsing (consistent with Pin Electrical) and `formatSI` for display
- Empty input → placeholder shows the default value
- Clearing an input → delete that key from the overrides object
- On commit (blur or Enter): update `_spiceModelOverrides` JSON string in PropertyBag, fire change callbacks

### Storage

- `_spiceModelOverrides`: JSON string in PropertyBag, format `Record<string, number>` — stores only user-changed params
- Declared as a `PropertyDef` on each semiconductor component (hidden from the main property list, used by the panel and `setComponentProperty`)
- Clearing a field = delete that key (reset to default for that parameter)
- Persists through file serialization; survives analog↔digital model toggling

### Compiler Merge

At **both** compiler sites where `_modelParams` is injected, replace the existing `props.set("_modelParams", ...)` line:

**Site 1 — `compiler.ts:1633`** (standalone analog compilation):
**Site 2 — `compiler.ts:2322`** (mixed-signal compilation):

Replace:
```typescript
props.set("_modelParams", resolvedModel.params as unknown as import("../../core/properties.js").PropertyValue);
```

With:
```typescript
let finalParams = resolvedModel.params;
if (props.has("_spiceModelOverrides")) {
  try {
    const overrides = JSON.parse(props.get("_spiceModelOverrides") as string) as Record<string, number>;
    finalParams = { ...resolvedModel.params, ...overrides };
  } catch {
    diagnostics.push({
      code: "INVALID_SPICE_OVERRIDES",
      severity: "warning",
      message: `Malformed _spiceModelOverrides JSON on component "${label}"`,
    });
  }
}
props.set("_modelParams", finalParams as unknown as import("../../core/properties.js").PropertyValue);
```

Both sites receive identical changes.

### New File: `src/solver/analog/model-param-meta.ts`

Metadata registry keyed by `deviceType` string. Used by the panel for labels, units, and tooltips.

```typescript
export interface SpiceParamMeta {
  key: string;        // e.g. "IS"
  label: string;      // e.g. "Saturation Current"
  unit: string;       // e.g. "A"
  description: string; // tooltip text
}

export function getParamMeta(deviceType: string): SpiceParamMeta[];
```

`getParamMeta` returns metadata for all parameters of the given device type. Extract labels and descriptions from JSDoc comments in `model-defaults.ts`. The function returns `[]` for unrecognized device types (panel won't render).

Actual parameter counts per device type (from `model-defaults.ts`):

| Device Type | Defaults Export | Param Count |
|-------------|----------------|-------------|
| D | `DIODE_DEFAULTS` | 14 |
| NPN | `BJT_NPN_DEFAULTS` | 26 |
| PNP | `BJT_PNP_DEFAULTS` | 26 |
| NMOS | `MOSFET_NMOS_DEFAULTS` | 25 |
| PMOS | `MOSFET_PMOS_DEFAULTS` | 25 |
| NJFET | `JFET_N_DEFAULTS` | 12 |
| PJFET | `JFET_P_DEFAULTS` | 12 |
| TUNNEL | `TUNNEL_DIODE_DEFAULTS` | 6 |

### Files to Modify

| File | Change |
|------|--------|
| `src/solver/analog/model-param-meta.ts` | **New** — metadata registry + `getParamMeta()` |
| `src/editor/property-panel.ts` | Add `showSpiceModelParameters()` method (~130 lines) |
| `src/app/canvas-popup.ts:93` | Add visibility guard after Pin Electrical block |
| `src/solver/analog/compiler.ts:1633` | Replace `props.set` with override-merge + try/catch |
| `src/solver/analog/compiler.ts:2322` | Same replacement (both sites identical) |
| Semiconductor component files | Add `_spiceModelOverrides` to `propertyDefs` (hidden) |

### Acceptance Criteria

- Opening the property popup for an NPN BJT in analog mode shows a collapsible "SPICE Model Parameters" section with 26 fields
- Entering `1e-14` in the IS field and closing the popup stores `{"IS":1e-14}` in `_spiceModelOverrides`
- Recompiling applies the override — `_modelParams.IS` equals `1e-14`, not the default `1e-16`
- The panel does not appear for components without a `deviceType` (e.g., resistor, capacitor)
- The panel does not appear when the component's active model is `logical`
- Malformed `_spiceModelOverrides` JSON emits a `INVALID_SPICE_OVERRIDES` warning diagnostic and falls back to unmodified defaults

## Part 2: Test Parameter Alignment Sweep

### Problem

The SPICE reference values in `e2e/fixtures/spice-reference-values.json` were generated with specific ngspice models that differ from the engine's built-in defaults:

| Parameter | ngspice Reference | Engine Default | Impact |
|-----------|-------------------|----------------|--------|
| BJT IS | 1e-14 | 1e-16 | 100x less current |
| BJT VAF | 100 | Infinity | No Early effect |
| MOSFET KP | 2e-3 | 120e-6 | 16.7x less current |
| MOSFET VTO | 1 | 0.7 | Different threshold |
| MOSFET W | 10e-6 | 1e-6 | 10x less W/L |
| JFET BETA | 1.3e-3 | 1e-4 | 13x less current |
| JFET VTO | -2 | -2 | Match |

### Fix Approach

Each test that builds a semiconductor circuit must set `_spiceModelOverrides` on each component via `setComponentProperty` to match the ngspice models used in `scripts/generate-spice-references.sh`.

**Only use `_spiceModelOverrides`** — never set `_modelParams` directly. Direct `_modelParams` bypasses the compiler merge and would not test the override path.

### Parameter Sets

```typescript
// BJT (NPN) — match ngspice: .model QNPN NPN(BF=100 IS=1e-14 VAF=100)
const BJT_NPN_OVERRIDES = JSON.stringify({ IS: 1e-14, BF: 100, VAF: 100 });

// BJT (PNP) — match ngspice: .model QPNP PNP(BF=100 IS=1e-14 VAF=100)
const BJT_PNP_OVERRIDES = JSON.stringify({ IS: 1e-14, BF: 100, VAF: 100 });

// MOSFET (NMOS) — match ngspice: .model MNMOS NMOS(VTO=1 KP=2m LAMBDA=0.01) W=10u L=1u
const MOSFET_NMOS_OVERRIDES = JSON.stringify({ VTO: 1, KP: 2e-3, LAMBDA: 0.01, W: 10e-6, L: 1e-6 });

// MOSFET (PMOS) — match ngspice: .model MPMOS PMOS(VTO=-1 KP=1m LAMBDA=0.01) W=10u L=1u
const MOSFET_PMOS_OVERRIDES = JSON.stringify({ VTO: -1, KP: 1e-3, LAMBDA: 0.01, W: 10e-6, L: 1e-6 });

// JFET (NJFET) — match ngspice: .model JN NJF(VTO=-2 BETA=1.3m LAMBDA=0.01)
const JFET_NJFET_OVERRIDES = JSON.stringify({ VTO: -2, BETA: 1.3e-3, LAMBDA: 0.01 });
```

### Tests Requiring Parameter Injection

| SPICE_REF Key | Test Name | Components | Overrides |
|---------------|-----------|------------|-----------|
| `a8_bjt_ce` | BJT common-emitter: single NPN stage | Q1 (NPN) | `BJT_NPN_OVERRIDES` |
| `a9_bjt_diffpair` | BJT differential pair | Q1 (NPN), Q2 (NPN) | `BJT_NPN_OVERRIDES` on both |
| `a10_bjt_darlington` | BJT Darlington pair | Q1 (NPN), Q2 (NPN) | `BJT_NPN_OVERRIDES` on both |
| `a11_bjt_pushpull` | BJT push-pull | Q1 (NPN), Q2 (PNP) | `BJT_NPN_OVERRIDES` on Q1, `BJT_PNP_OVERRIDES` on Q2 |
| `a12_mosfet_cs` | MOSFET common-source | M1 (NMOS) | `MOSFET_NMOS_OVERRIDES` |
| `a15_jfet_amp` | JFET amplifier | J1 (NJFET) | `JFET_NJFET_OVERRIDES` |
| `a16_cascode` | Cascode amplifier | Q1 (NPN), Q2 (NPN) | `BJT_NPN_OVERRIDES` on both |
| `a17_wilson_mirror` | Wilson current mirror | Q1 (NPN), Q2 (NPN), Q3 (NPN) | `BJT_NPN_OVERRIDES` on all three |
| `a18_widlar` | Widlar current source | Q1 (NPN), Q2 (NPN) | `BJT_NPN_OVERRIDES` on both |
| `a19_hbridge_fwd` | MOSFET H-bridge | Mp1 (PMOS), Mp2 (PMOS), Mn1 (NMOS), Mn2 (NMOS) | `MOSFET_PMOS_OVERRIDES` on Mp1/Mp2, `MOSFET_NMOS_OVERRIDES` on Mn1/Mn2 |
| `a20_bjt_mosfet_driver` | BJT+MOSFET mixed driver | Q1 (NPN), M1 (NMOS) | `BJT_NPN_OVERRIDES` on Q1, `MOSFET_NMOS_OVERRIDES` on M1 |
| `a21_multistage` | Multi-stage amplifier | Q1 (NPN), Q2 (NPN), Q3 (NPN) | `BJT_NPN_OVERRIDES` on all three |
| (test 28) | MOSFET PWM into RLC | M1 (NMOS) | `MOSFET_NMOS_OVERRIDES` |

### Injection Pattern

For each test, add `setComponentProperty` calls after component placement, before compilation:

```typescript
// Example: a9_bjt_diffpair
await builder.setComponentProperty('Q1', '_spiceModelOverrides', BJT_NPN_OVERRIDES);
await builder.setComponentProperty('Q2', '_spiceModelOverrides', BJT_NPN_OVERRIDES);
```

### Files to Modify

| File | Change |
|------|--------|
| `e2e/gui/analog-circuit-assembly.spec.ts` | Add `_spiceModelOverrides` injection to 13 tests |

### Acceptance Criteria

- All 13 listed tests pass against their ngspice reference values within the tolerances specified in `spice-reference-values.json._tolerance_guidance`
- No test sets `_modelParams` directly — all use `_spiceModelOverrides`

## Part 3: Three-Surface Tests

### Headless Tests (`src/solver/analog/__tests__/spice-model-overrides.test.ts`)

**New file.** Tests:

1. **Override merge:** Build a circuit with an NPN BJT, set `_spiceModelOverrides` to `{"IS": 1e-14}`, compile via `DefaultSimulatorFacade`. Verify `_modelParams.IS === 1e-14` and other params equal NPN defaults.
2. **Empty overrides:** Set `_spiceModelOverrides` to `"{}"`. Verify `_modelParams` equals raw defaults.
3. **No overrides property:** Don't set `_spiceModelOverrides`. Verify `_modelParams` equals raw defaults.
4. **Malformed JSON:** Set `_spiceModelOverrides` to `"not json"`. Verify compilation produces `INVALID_SPICE_OVERRIDES` diagnostic and `_modelParams` equals raw defaults.
5. **Tunnel diode migration:** Build a tunnel diode circuit, compile. Verify `_modelParams` contains `IP`, `VP`, `IV`, `VV` from `TUNNEL_DIODE_DEFAULTS`.

### MCP Tool Tests (`src/headless/__tests__/spice-model-overrides-mcp.test.ts`)

**New file.** Tests:

1. **Override via MCP:** `circuit_build` a BJT circuit, `circuit_patch` to set `_spiceModelOverrides`, `circuit_compile`, `circuit_read_output`. Verify the override affects simulation results.
2. **Round-trip serialization:** Set overrides, save circuit, reload, verify overrides persist.

### E2E Tests (`e2e/gui/spice-model-panel.spec.ts`)

**New file.** Tests:

1. **Panel visibility:** Place an NPN BJT in analog mode, open property popup. Verify "SPICE Model Parameters" section exists and is collapsed.
2. **Panel hidden for resistor:** Place a resistor, open popup. Verify no SPICE section.
3. **Panel hidden in logical mode:** Place a BJT in logical mode, open popup. Verify no SPICE section.
4. **Edit and persist:** Expand SPICE section, enter `1e-14` in IS field, close popup. Reopen popup, verify IS field shows the entered value.
5. **Override affects simulation:** Set IS override on BJT, run simulation, verify collector current differs from default-parameter simulation.

## Implementation Order

1. Part 0 — Tunnel diode migration (prerequisite for Part 1)
2. Part 1 — SPICE panel + compiler merge + `_spiceModelOverrides` PropertyDef
3. Part 2 — Test parameter injection (depends on Part 1: compiler merge must be in place)
4. Part 3 — Three-surface tests (depends on Parts 0, 1, 2)
