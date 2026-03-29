# Review Report: Wave 10 — .SUBCKT parser + subcircuit-to-Circuit builder

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 3 (W10.1, W10.2, W10.3) |
| Violations | 5 |
| Gaps | 2 |
| Weak tests | 14 |
| Legacy references | 1 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — Historical-provenance comment (major)

**File**: `src/solver/analog/model-parser.ts`, line 15
**Rule**: rules.md — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
**Evidence**:
```typescript
// DeviceType is defined in core/analog-types.ts. Imported for local use and
// re-exported for backward compatibility with existing consumers.
```
This comment explicitly states why a shim exists — it describes the historical context ("existing consumers") and the reason for the re-export. Per the rules, a justification comment next to a rule violation makes it worse, not better. The comment is proof the agent knowingly added a backwards-compat shim.
**Severity**: major

---

### V2 — Backwards-compatibility re-export shim (major)

**File**: `src/solver/analog/model-parser.ts`, line 17
**Rule**: rules.md — "No fallbacks. No backwards compatibility shims. No safety wrappers. All replaced or edited code is removed entirely. Scorched earth."
**Evidence**:
```typescript
export type { DeviceType } from "../../core/analog-types.js";
```
`DeviceType` is defined in `src/core/analog-types.ts`. This line re-exports it from `model-parser.ts` to preserve existing consumers who imported it from this module. This is a textbook backwards-compatibility shim. Any consumer that imports `DeviceType` from `model-parser.ts` should be updated to import from `core/analog-types.ts` directly. The shim must not exist.
**Severity**: major

---

### V3 — Banned word "fallback" in comment (minor)

**File**: `src/solver/analog/model-parser.ts`, line 121
**Rule**: rules.md — banned comment words include "fallback"
**Evidence**:
```typescript
  if (!numericMatch) {
    // Try plain parse as fallback
    return parseFloat(s);
  }
```
The word "fallback" is in the banned list per the reviewer posture rules. The comment describes a secondary code path triggered when the primary path fails — which is a design smell regardless. Either the comment should be removed or the code should be restructured so the label does not apply.
**Severity**: minor

---

### V4 — Historical-provenance comment referencing another file (minor)

**File**: `src/io/spice-model-builder.ts`, line 31
**Rule**: rules.md — "No historical-provenance comments. Any comment describing … where it came from is banned."
**Evidence**:
```typescript
// ---------------------------------------------------------------------------
// Internal element counter (global, same approach as cmos-gates.ts)
// ---------------------------------------------------------------------------
```
The parenthetical `"same approach as cmos-gates.ts"` describes the provenance of the implementation pattern — where it came from. This is a historical-provenance comment. Comments exist only to explain complicated code to future developers; they must not describe where the code came from or what it parallels in another file.
**Severity**: minor

---

### V5 — `/* no-op */` comment describing non-behavior (minor)

**File**: `src/io/spice-model-builder.ts`, line 81
**Rule**: rules.md — "No commented-out code. No `# previously this was...` comments." (by extension: comments must explain complicated code, not describe trivial non-behavior)
**Evidence**:
```typescript
    draw(_ctx: RenderContext) { /* no-op */ },
```
The `/* no-op */` label is a commentary on what the function does (nothing), not an explanation of why complex logic exists. The comment is unnecessary — an empty function body communicates the same thing. This is a minor code hygiene issue.
**Severity**: minor

---

## Gaps

### G1 — Missing MCP surface test for Wave 10

**Spec requirement**: `spec/model-unification.md`, lines 951–953:
> **MCP:** `circuit_patch` to set `_spiceModelOverrides` from parsed `.MODEL` → `circuit_compile` → verify different simulation results.

**What was found**: No MCP test file covering `parseSubcircuit()` or `buildSpiceSubcircuit()` was created. The existing `src/headless/__tests__/spice-model-overrides-mcp.test.ts` (from earlier waves) contains no references to `parseSubcircuit` or `buildSpiceSubcircuit`. The progress.md entry for W10.3 describes only "Integration tests covering the full pipeline" via `src/io/__tests__/spice-pipeline-integration.test.ts` — there is no mention of an MCP-surface test.

**CLAUDE.md states**: "Every user-facing feature MUST be tested across all three surfaces." The MCP surface is non-negotiable.
**File**: `src/headless/__tests__/` — no file covering SUBCKT builder via MCP tool handlers

---

### G2 — Missing E2E surface test for Wave 10

**Spec requirement**: `spec/model-unification.md`, lines 953–954:
> **E2E:** Import `.MODEL` dialog → paste text → verify parse preview → apply → verify SPICE panel shows values. Import `.SUBCKT` → apply → verify compilation succeeds.

**What was found**: The existing `e2e/gui/spice-model-panel.spec.ts` contains no references to `.SUBCKT`, `parseSubcircuit`, or `buildSpiceSubcircuit`. No new E2E spec file was created for the SUBCKT import path. The progress.md entry for W10.3 does not mention E2E tests.

**CLAUDE.md states**: "A feature can work headless but break in MCP serialization, or work in MCP but fail in the browser. All three surfaces are non-negotiable."
**File**: `e2e/` — no file covering SUBCKT import

---

## Weak Tests

### WT1

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — circuit structure::returns a Circuit object (has elements array)`
**Problem**: `toBeDefined()` with `Array.isArray()` — verifies structural existence without checking any content. A returned empty array or a stub would pass.
**Evidence**:
```typescript
expect(circuit.elements).toBeDefined();
expect(Array.isArray(circuit.elements)).toBe(true);
```

---

### WT2

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — circuit structure::adds wires to the circuit`
**Problem**: `toBeGreaterThan(0)` on wire count — passes for any single wire regardless of correctness. Does not verify wire endpoints, net connectivity, or wire count relative to element count.
**Evidence**:
```typescript
expect(circuit.wires.length).toBeGreaterThan(0);
```

---

### WT3

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — R element mapping::maps R to Resistor`
**Problem**: Bare `toBeDefined()` on a `.find()` result — passes as long as any Resistor exists. Does not verify pin assignments, net coordinates, or property values in this test.
**Evidence**:
```typescript
const el = circuit.elements.find((e) => e.typeId === "Resistor");
expect(el).toBeDefined();
```

---

### WT4

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — C element mapping::maps C to Capacitor`
**Problem**: Bare `toBeDefined()` — same as WT3.
**Evidence**:
```typescript
expect(circuit.elements.find((e) => e.typeId === "Capacitor")).toBeDefined();
```

---

### WT5

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — L element mapping::maps L to Inductor`
**Problem**: Bare `toBeDefined()` — same as WT3.
**Evidence**:
```typescript
expect(circuit.elements.find((e) => e.typeId === "Inductor")).toBeDefined();
```

---

### WT6

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — D element mapping::maps D to Diode`
**Problem**: Bare `toBeDefined()` — same as WT3.
**Evidence**:
```typescript
expect(circuit.elements.find((e) => e.typeId === "Diode")).toBeDefined();
```

---

### WT7

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — Q element mapping, NPN::maps Q with NPN model to NpnBJT`
**Problem**: Bare `toBeDefined()` — same as WT3.
**Evidence**:
```typescript
expect(circuit.elements.find((e) => e.typeId === "NpnBJT")).toBeDefined();
```

---

### WT8

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — Q element mapping, NPN::NpnBJT has _spiceModelOverrides with IS and BF`
**Problem**: `overridesRaw` is asserted `toBeDefined()` before being parsed — a trivially true guard that passes even if the string is empty or malformed. The meaningful assertion that follows (checking `IS` and `BF` values) is the actual test; the `toBeDefined()` guard is redundant noise that masks failures if `getAttribute` returns an empty string.
**Evidence**:
```typescript
const overridesRaw = el!.getAttribute("_spiceModelOverrides") as string;
expect(overridesRaw).toBeDefined();
const overrides = JSON.parse(overridesRaw);
```

---

### WT9

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — Q element mapping, PNP::maps Q with PNP model to PnpBJT`
**Problem**: Bare `toBeDefined()` only — no pin or overrides verification for the PNP case. The NPN case has full coverage; PNP has only existence check.
**Evidence**:
```typescript
expect(circuit.elements.find((e) => e.typeId === "PnpBJT")).toBeDefined();
```

---

### WT10

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — M element mapping, NMOS::maps M with NMOS model to NMOS`
**Problem**: Bare `toBeDefined()` — same as WT3.
**Evidence**:
```typescript
expect(circuit.elements.find((e) => e.typeId === "NMOS")).toBeDefined();
```

---

### WT11

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — M element mapping, PMOS::maps M with PMOS model to PMOS`
**Problem**: Bare `toBeDefined()` only — no pin or overrides verification for the PMOS case.
**Evidence**:
```typescript
expect(circuit.elements.find((e) => e.typeId === "PMOS")).toBeDefined();
```

---

### WT12

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — J element mapping, NJFET::maps J with NJFET model to NJFET`
**Problem**: Bare `toBeDefined()` — same as WT3.
**Evidence**:
```typescript
expect(circuit.elements.find((e) => e.typeId === "NJFET")).toBeDefined();
```

---

### WT13

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — J element mapping, PJFET::maps J with PJFET model to PJFET`
**Problem**: Bare `toBeDefined()` only — no pin or overrides verification for the PJFET case.
**Evidence**:
```typescript
expect(circuit.elements.find((e) => e.typeId === "PJFET")).toBeDefined();
```

---

### WT14

**Path**: `src/io/__tests__/spice-model-builder.test.ts::buildSpiceSubcircuit — wires::adds wires for a two-resistor subcircuit`
**Problem**: `toBeGreaterThan(0)` on wire count — same as WT2. A single degenerate wire would pass.
**Evidence**:
```typescript
expect(circuit.wires.length).toBeGreaterThan(0);
```

---

### WT15

**Path**: `src/io/__tests__/spice-pipeline-integration.test.ts::SPICE pipeline — register in TransistorModelRegistry::registers a simple resistor subcircuit without throwing`
**Problem**: `not.toThrow()` only — verifies no exception but does not verify that the circuit was actually stored or is retrievable. The subsequent test ("retrieves registered circuit by name") provides coverage, making this test redundant and weak on its own.
**Evidence**:
```typescript
expect(() => registry.register("rdiv", circuit)).not.toThrow();
```

---

### WT16

**Path**: `src/io/__tests__/spice-pipeline-integration.test.ts::SPICE pipeline — all element types round-trip::parses without throwing`
**Problem**: `not.toThrow()` only — verifies no crash but makes no assertion about what was parsed (no count, name, port list, or element list checked).
**Evidence**:
```typescript
expect(() => parseSubcircuit(FULL_SUBCKT.trim())).not.toThrow();
```

---

### WT17

**Path**: `src/io/__tests__/spice-pipeline-integration.test.ts::SPICE pipeline — all element types round-trip::builds without throwing`
**Problem**: `not.toThrow()` only — same as WT16.
**Evidence**:
```typescript
expect(() => buildSpiceSubcircuit(sc)).not.toThrow();
```

---

### WT18

**Path**: `src/io/__tests__/spice-pipeline-integration.test.ts::SPICE pipeline — _spiceModelOverrides round-trip::BJT overrides survive parse → build round-trip`
**Problem**: `bjt` and `raw` are each asserted `toBeDefined()` before their values are checked — trivially true guards before the meaningful value assertions.
**Evidence**:
```typescript
expect(bjt).toBeDefined();
const raw = bjt!.getAttribute("_spiceModelOverrides") as string;
expect(raw).toBeDefined();
```

---

### WT19

**Path**: `src/io/__tests__/spice-pipeline-integration.test.ts::SPICE pipeline — _spiceModelOverrides round-trip::MOSFET W/L params survive parse → build round-trip`
**Problem**: `mos` is asserted `toBeDefined()` before its value is checked — trivially true guard.
**Evidence**:
```typescript
expect(mos).toBeDefined();
```

---

### WT20

**Path**: `src/io/__tests__/spice-pipeline-integration.test.ts::SPICE pipeline — _spiceModelOverrides round-trip::Diode with inline model has _spiceModelOverrides`
**Problem**: `raw` is asserted `toBeDefined()` before being parsed — same as WT8.
**Evidence**:
```typescript
const raw = diode!.getAttribute("_spiceModelOverrides") as string;
expect(raw).toBeDefined();
```

---

### WT21

**Path**: `src/io/__tests__/spice-pipeline-integration.test.ts::SPICE pipeline — wire connectivity::a voltage divider has wires connecting to the mid-node net`
**Problem**: `toBeGreaterThan(0)` on total wire count — same pattern as WT2 and WT14.
**Evidence**:
```typescript
expect(circuit.wires.length).toBeGreaterThan(0);
```

---

## Legacy References

### LR1 — Re-export of removed type acting as backward-compat shim

**File**: `src/solver/analog/model-parser.ts`, line 17
**Evidence**:
```typescript
export type { DeviceType } from "../../core/analog-types.js";
```
`DeviceType` is canonical in `src/core/analog-types.ts`. Its re-export from `model-parser.ts` is a stale reference pattern — it exists to preserve old import paths. Any consumer importing `DeviceType` from `model-parser.ts` is using a stale path that should be updated to `core/analog-types.ts`.

---

## Notes on Scope

The progress.md Wave 10 summary claims 3/3 tasks complete. This is accurate for the headless unit test surface. The gaps (G1, G2) are not agent errors in the tracked task scope — W10.1, W10.2, and W10.3 as defined in the wave are a parser, a builder, and integration tests respectively. The three-surface requirement from CLAUDE.md and the phase spec applies to the full wave, and the MCP and E2E surfaces were not addressed. This may be intentional deferral to Wave 11 (SPICE import UI), but as written the spec's three-surface requirement for Waves 10-12 is not satisfied by Wave 10 alone.
