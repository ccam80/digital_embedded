# Review Report: Waves 1, 3, 4 — SPICE Model Parameters Panel & Test Parameter Alignment

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 8 (P0.1, P0.2, P0.3, P0.4, P2.1, P3.1, P3.2, P3.3) |
| Violations — critical | 1 |
| Violations — major | 3 |
| Violations — minor | 1 |
| Gaps | 3 |
| Weak tests | 4 |
| Legacy references | 2 |

**Verdict: has-violations**

---

## Violations

### V1 — Critical: Historical-provenance / workaround comment

**File:** `src/headless/__tests__/spice-model-overrides-mcp.test.ts` — lines 210–211 and 246–247

**Rule violated:** rules.md — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned." Also covers fallback and workaround descriptions.

**Quoted evidence (lines 210–211):**
```
// Serialize BEFORE compiling — compile injects _modelParams (an object)
// into PropertyBag which the serializer cannot handle (expects scalar values).
```

**Quoted evidence (lines 246–247):**
```
// Serialize BEFORE compiling — compile injects _modelParams (an object) into
// PropertyBag which the serializer cannot handle (it expects scalar PropertyValues).
```

These comments describe a known production defect (the serializer cannot handle object-typed PropertyValues injected by the compiler) and explain why the test routes around it. Routing around a broken code path is a workaround. The comment documents the workaround, which is explicitly banned. A comment explaining why a rule was bent is not mitigating — it is proof the agent knowingly chose the shortcut.

**Severity: critical**

---

### V2 — Major: Tunnel diode IS and N parameters ignored despite being in _modelParams

**File:** `src/components/semiconductors/tunnel-diode.ts` — lines 51, 96–100, 121–125

**Rule violated:** Spec Part 0 acceptance criterion: "Compiling a circuit with a tunnel diode injects _modelParams with the tunnel defaults." The migration goal is that all parameters come from _modelParams. TUNNEL_DIODE_DEFAULTS defines 6 parameters: IP, VP, IV, VV, IS, N. The factory reads only IP, VP, IV, VV.

**Quoted evidence:**
```typescript
/** Standard diode saturation current for thermal component. */
const IS_THERMAL = 1e-14;   // line 51 — hardcoded, not read from _modelParams
```
```typescript
const modelParams = (props as Record<string, unknown>)["_modelParams"] as Record<string, number> | undefined;
const ip = modelParams?.IP ?? 5e-3;
const vp = modelParams?.VP ?? 0.08;
const iv = modelParams?.IV ?? 0.5e-3;
const vv = modelParams?.VV ?? 0.5;
// IS and N are never read from modelParams
```
```typescript
const iThermal = IS_THERMAL * (expTh - 1);    // uses hardcoded constant
const dIThermal = (IS_THERMAL * expTh) / VT;  // N=1 implicit, not from modelParams
```

A user setting _spiceModelOverrides: {"IS": 1e-13} on a tunnel diode has no effect on the thermal current. The tunnelDiodeIV function signature does not accept IS or N. The migration is incomplete for two of the six defined parameters.

**Severity: major**

---

### V3 — Major: MCP test 1 asserts on compile-time constants, not simulation output

**File:** `src/headless/__tests__/spice-model-overrides-mcp.test.ts` — lines 153–155

**Rule violated:** rules.md — "Tests ALWAYS assert desired behaviour." Spec P3.2 test 1 requires: "Verify the override affects simulation results."

**Quoted evidence:**
```typescript
// Confirm the override IS differs from the NPN default
expect(1e-14).not.toBe(BJT_NPN_DEFAULTS["IS"]);
expect(BJT_NPN_DEFAULTS["IS"]).toBe(1e-16);
```

expect(1e-14).not.toBe(BJT_NPN_DEFAULTS["IS"]) compares two compile-time constants — it does not exercise the code under test. expect(BJT_NPN_DEFAULTS["IS"]).toBe(1e-16) checks a static export value. Neither reads DC node voltages before and after applying the override and compares them. The spec explicitly requires verifying the override affects simulation results.

**Severity: major**

---

### V4 — Major: E2E test 4 verifies IS persistence with trivially-true non-empty checks

**File:** `e2e/gui/spice-model-panel.spec.ts` — lines 155–161

**Rule violated:** rules.md — "Test the specific: exact values, exact types, exact error messages where applicable." Spec P3.3 test 4 requires: "Reopen popup, verify IS field shows the entered value."

**Quoted evidence:**
```typescript
const displayedValue = await isInputAfter.inputValue();
// The value is formatted with formatSI — 1e-14 formats as "10f" or "10.0f"
// Accept any non-empty value that encodes 1e-14 (the field shows formatSI output)
expect(displayedValue).not.toBe("");
// We just verify the field is non-empty (content was stored)
expect(displayedValue.length).toBeGreaterThan(0);
```

The comment "We just verify the field is non-empty (content was stored)" is the agent explicitly acknowledging the test is weaker than required. The assertions pass for any non-empty string. The test would pass if the IS field displayed "garbage" or any other non-empty value.

**Severity: major**

---

### V5 — Minor: Progress.md Wave summary tables contradict per-task detail sections

**File:** `spec/progress.md` — lines 9–11, 32

**Rule violated:** Progress.md is the source of truth for implementation status. Stale entries make it unreliable.

**Quoted evidence (lines 9–11):**
```
| P0.2 | Add TUNNEL to DeviceType union | pending |
| P0.3 | Register TUNNEL in model library | pending |
| P0.4 | Update tunnel-diode.ts to read _modelParams | pending |
```
**Quoted evidence (line 32):**
```
| P3.3 | E2E tests (spice-model-panel.spec.ts) | pending |
```

All four tasks are fully implemented. src/core/analog-types.ts line 147 has "TUNNEL" in the DeviceType union. src/solver/analog/model-library.ts registers TUNNEL in BUILT_IN_DEFAULTS and KNOWN_PARAMS. tunnel-diode.ts reads _modelParams for IP/VP/IV/VV. e2e/gui/spice-model-panel.spec.ts has 5 tests. The per-task detail sections correctly record these as "complete" but the Wave 1 and Wave 4 summary tables were never updated.

**Severity: minor**

---

## Gaps

### G1 — Part 2 spec mandates setComponentProperty injection; implementation uses setSpiceOverrides UI method

**Spec requirement** (spec/spice-model-panel.md, Part 2 Injection Pattern):
```typescript
// Example: a9_bjt_diffpair
await builder.setComponentProperty("Q1", "_spiceModelOverrides", BJT_NPN_OVERRIDES);
await builder.setComponentProperty("Q2", "_spiceModelOverrides", BJT_NPN_OVERRIDES);
```
The spec defines override constants as pre-stringified JSON:
```typescript
const BJT_NPN_OVERRIDES = JSON.stringify({ IS: 1e-14, BF: 100, VAF: 100 });
```

**What was actually found:** e2e/gui/analog-circuit-assembly.spec.ts lines 29–33 define overrides as Record<string, number> objects (not stringified JSON), and injection uses builder.setSpiceOverrides(label, overrides) — a UI method that opens the property popup, expands the SPICE section, and fills each field via Playwright interactions (lines 450, 515–516, 571–572, 622–623, 676, 820, 879–880, 930–932, 984–985, 1038–1041, 1103–1104, 1180–1182, 1521).

setSpiceOverrides exercises the SPICE panel UI, which is correct for P3.3 UI tests. Using it in 13 P2.1 parameter-alignment tests conflates the test surfaces. The spec explicitly prescribes setComponentProperty — the direct property-setter path — which is faster, less brittle, and does not depend on the SPICE panel UI being correctly implemented.

**File:** `e2e/gui/analog-circuit-assembly.spec.ts` lines 29–33 and all injection sites listed above.

---

### G2 — Tunnel diode IS and N parameters in TUNNEL_DIODE_DEFAULTS not consumed by element factory

**Spec requirement** (Part 0): createTunnelDiodeElement should read all parameters from _modelParams. TUNNEL_DIODE_DEFAULTS has 6 parameters: IP, VP, IV, VV, IS, N.

**What was actually found:** src/components/semiconductors/tunnel-diode.ts factory (lines 121–125) reads IP, VP, IV, VV only. IS and N are never extracted from modelParams. The thermal component uses module-level constant IS_THERMAL = 1e-14 (line 51). The tunnelDiodeIV function accepts only (v, ip, vp, iv, vv). Setting _spiceModelOverrides: {"IS": 1e-13, "N": 1.2} on a tunnel diode has no simulation effect.

**File:** `src/components/semiconductors/tunnel-diode.ts` lines 51, 71–76, 96–100, 121–125

---

### G3 — P3.1 test 5 does not verify IS and N pass-through from TUNNEL_DIODE_DEFAULTS

**Spec requirement** (Part 3, Headless Tests, test 5): "Verify _modelParams contains IP, VP, IV, VV from TUNNEL_DIODE_DEFAULTS." TUNNEL_DIODE_DEFAULTS has six parameters (IS and N also defined). A complete migration test should verify all six reach _modelParams.

**What was actually found:** src/solver/analog/__tests__/spice-model-overrides.test.ts lines 306–309 check only IP, VP, IV, VV. IS and N are not asserted. This means Gap G2 (IS and N not consumed by the factory) is not caught by the test suite.

**File:** `src/solver/analog/__tests__/spice-model-overrides.test.ts` lines 305–310

---

## Weak Tests

### WT1 — MCP test 1: simulation effect never asserted

**Test path:** `src/headless/__tests__/spice-model-overrides-mcp.test.ts::spice-model-overrides MCP surface — override via patch::patch with _spiceModelOverrides changes IS used by compiler vs default`

**What is wrong:** The test title promises to verify IS override "changes IS used by compiler vs default." The only relevant assertions compare two static constants. No DC operating-point voltages are read or compared before and after override application. The spec requires "Verify the override affects simulation results."

**Quoted evidence (lines 153–155):**
```typescript
// Confirm the override IS differs from the NPN default
expect(1e-14).not.toBe(BJT_NPN_DEFAULTS["IS"]);
expect(BJT_NPN_DEFAULTS["IS"]).toBe(1e-16);
```

---

### WT2 — E2E test 4: IS persistence verified by non-empty string check only

**Test path:** `e2e/gui/spice-model-panel.spec.ts::SPICE Model Parameters panel::edited IS value persists after closing and reopening popup`

**What is wrong:** expect(displayedValue).not.toBe("") and expect(displayedValue.length).toBeGreaterThan(0) both pass for any non-empty string. The spec requires verifying the IS field shows the entered value encoding 1e-14. The agent comment confirms the weakness: "We just verify the field is non-empty."

**Quoted evidence (lines 157–161):**
```typescript
expect(displayedValue).not.toBe("");
// We just verify the field is non-empty (content was stored)
expect(displayedValue.length).toBeGreaterThan(0);
```

---

### WT3 — MCP round-trip test: json.length > 0 is a trivially-true assertion

**Test path:** `src/headless/__tests__/spice-model-overrides-mcp.test.ts::spice-model-overrides MCP surface — round-trip serialization::overrides survive serialize → deserialize → recompile`

**What is wrong:** expect(json.length).toBeGreaterThan(0) (line 214) is trivially true for any non-empty serialization. It adds no meaningful coverage alongside expect(json).toContain("_spiceModelOverrides").

**Quoted evidence (lines 213–214):**
```typescript
expect(typeof json).toBe("string");
expect(json.length).toBeGreaterThan(0);
```

---

### WT4 — MCP test 1: bare not.toBeNull() guards without content verification

**Test path:** `src/headless/__tests__/spice-model-overrides-mcp.test.ts::spice-model-overrides MCP surface — override via patch::patch with _spiceModelOverrides changes IS used by compiler vs default`

**What is wrong:** Four not.toBeNull() guards on compiled result objects establish that compilation returned something but verify nothing about the compiled output. In combination with WT1, the test contains no assertion that the override changed any observable simulation property.

**Quoted evidence (lines 123–124, 146–147):**
```typescript
expect(compiledDefault).not.toBeNull();
expect(compiledDefault!.analog).not.toBeNull();
// ...
expect(compiledOverridden).not.toBeNull();
expect(compiledOverridden!.analog).not.toBeNull();
```

---

## Legacy References

### LR1 — Workaround comment describing serializer defect (occurrence 1)

**File:** `src/headless/__tests__/spice-model-overrides-mcp.test.ts` — lines 210–211

**Quoted evidence:**
```
// Serialize BEFORE compiling — compile injects _modelParams (an object)
// into PropertyBag which the serializer cannot handle (expects scalar values).
```

The test routes around a production defect (the serializer cannot handle object-typed PropertyValues). This comment names the defect and explains the workaround. The rules ban any comment describing why a path is avoided or what the code cannot handle.

---

### LR2 — Workaround comment describing serializer defect (occurrence 2)

**File:** `src/headless/__tests__/spice-model-overrides-mcp.test.ts` — lines 246–247

**Quoted evidence:**
```
// Serialize BEFORE compiling — compile injects _modelParams (an object) into
// PropertyBag which the serializer cannot handle (it expects scalar PropertyValues).
```

Same violation as LR1 in a different test method within the same file.
