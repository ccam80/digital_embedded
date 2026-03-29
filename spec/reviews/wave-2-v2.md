# Review Report: Wave 2 — Pin System + Digital Compiler (v2)

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 3 (W2.1, W2.2, W2.3) |
| Violations — critical | 1 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 1 |
| Weak tests | 0 |
| Legacy references | 1 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — W2.1: 15 component files have PinDeclaration objects missing required `kind` field (CRITICAL)

**Rule violated:** Spec W2.1 and W0.2: `kind: "signal" | "power"` is a required field on `PinDeclaration`. The spec states "Every component file with `PinDeclaration` arrays: add `kind: "signal"` to each entry" and "Required on all declarations." No optional `kind?:` is allowed — it must be present on every declaration.

**Files affected (15 files with zero `kind:` occurrences despite containing PinDeclaration literals):**

| File | PinDeclaration refs |
|------|---------------------|
| `src/components/active/dac.ts` | 6 |
| `src/components/basic/function.ts` | 7 |
| `src/components/io/midi.ts` | 5 |
| `src/components/io/scope.ts` | 5 |
| `src/components/io/seven-seg.ts` | 3 |
| `src/components/memory/lookup-table.ts` | 3 |
| `src/components/subcircuit/pin-derivation.ts` | 7 |
| `src/components/switching/relay-dt.ts` | 3 |
| `src/components/switching/relay.ts` | 4 |
| `src/components/switching/switch-dt.ts` | 6 |
| `src/components/switching/switch.ts` | 6 |
| `src/components/wiring/decoder.ts` | 7 |
| `src/components/wiring/demux.ts` | 7 |
| `src/components/wiring/splitter.ts` | 6 |
| `src/io/dig-pin-scanner.ts` | 8 |

**Evidence from `src/components/basic/function.ts` lines 105-124:**
The `buildFunctionPinDeclarations` function builds PinDeclaration arrays for input and output pins. Neither the `inputs` map nor the `outputs` map includes a `kind:` field. The file contains zero occurrences of `kind:` despite having 7 PinDeclaration references.

**Evidence from `src/components/wiring/decoder.ts` lines 64-68:**
```
pins.push({ direction: PinDirection.OUTPUT, label: "out_0", defaultBitWidth: 1,
  position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false });
```
No `kind:` field on any pushed pin declaration.

**Evidence from `src/components/switching/relay.ts` lines 72-101:**
4 pin declarations with `isNegatable: false, isClockCapable: false` — none include `kind:`.

**Severity:** CRITICAL — `kind` is required per W0.2. These 15 files produce TypeScript type errors at compile time. Task W2.1 was marked complete but missed these 15 files.

---

### V2 — W2.2: Power pins added when `activeModel === "cmos"` — hardcoded key instead of spec-required `def.subcircuitRefs?.[activeModel]` check (MAJOR)

**Rule violated:** Spec W2.2 states power pins are added "when the active `simulationModel` resolves to an MNA model backed by a subcircuit". The spec pseudocode explicitly uses `def.subcircuitRefs?.[activeModel]` as the guard condition. The implementation hardcodes the literal string `"cmos"` instead.

**Spec pseudocode from `spec/model-unification-v2.md` (Model-dependent pin visibility section):**
```
if (activeModel && def.subcircuitRefs?.[activeModel]) {
  basePins.push(VDD pin, GND pin)
}
```

**Actual implementation in `src/components/gates/and.ts` lines 56-61:**
```
const activeModel = this._properties.getOrDefault("simulationModel", "");
if (activeModel === "cmos") {
  const w = compWidth(wideShape);
  decls = appendPowerPins(decls, w / 2, -1, inputCount);
}
```

The same hardcoded `activeModel === "cmos"` pattern appears identically in all 8 affected files: `and.ts`, `or.ts`, `nand.ts`, `nor.ts`, `xor.ts`, `xnor.ts`, `not.ts`, and `d.ts`.

**Severity:** MAJOR — Any component that gains a non-`"cmos"` subcircuit model key (via `subcircuitBindings`, user-imported `.SUBCKT`, or a future built-in model) will not get power pins in `getPins()`. The feature silently breaks for all model keys other than the literal string `"cmos"`. The spec was explicit about using `def.subcircuitRefs?.[activeModel]`.

---

### V3 — W2.2: `not.ts` does not use the `appendPowerPins` helper from `gate-shared.ts` (MAJOR)

**Rule violated:** Spec W2.2 states "Update `src/components/gates/gate-shared.ts` if shared helpers are useful." The `appendPowerPins` helper was added to `gate-shared.ts` and is imported and used by the 6 multi-input gates (and, or, nand, nor, xor, xnor). However, `not.ts` does not import `appendPowerPins` and inlines duplicate power pin object literals directly in `getPins()`.

**Evidence from `src/components/gates/not.ts` lines 75-102:**
`not.ts` has no import of `appendPowerPins` from `gate-shared.ts`. Instead, it constructs two raw PinDeclaration objects inline:
```
decls = [
  ...decls,
  { direction: PinDirection.INPUT, label: "VDD", defaultBitWidth: 1,
    position: { x: centerX, y: -1 }, isNegatable: false, isClockCapable: false, kind: "power" },
  { direction: PinDirection.INPUT, label: "GND", defaultBitWidth: 1,
    position: { x: centerX, y: 1 }, isNegatable: false, isClockCapable: false, kind: "power" },
];
```

**Severity:** MAJOR — The shared helper exists in `gate-shared.ts` for exactly this purpose. `not.ts` bypasses it with inlined duplicates. The spec created this helper for reuse across all 8 affected components. If the power pin structure changes, `not.ts` will diverge silently.

---

### V4 — `src/components/wiring/splitter.ts`: banned historical-provenance comment (MINOR)

**Rule violated:** `spec/.context/rules.md`: "No historical-provenance comments." The word `legacy` is explicitly listed as a banned term in `spec/.context/reviewer.md`.

**File:** `src/components/wiring/splitter.ts`

**Evidence:** `// Legacy accessors used by engine consumers`

**Severity:** MINOR — `splitter.ts` is in the W2.1 modified-files set (it has PinDeclarations missing `kind` — see V1), placing it in scope for this review.

---

## Gaps

### G1 — W2.2: NOT gate VDD/GND coordinate positions not validated against body geometry via helper

**Spec requirement:** "Each of the 9 affected components specifies its own VDD/GND coordinates based on its body geometry." The `not.ts` bypasses `appendPowerPins` (V3) and uses raw coordinates `y: -1` (VDD) and `y: 1` (GND). For a 1-input NOT gate, `gateBodyMetrics(1)` gives `bodyHeight ~= 1.0`. The GND pin at `y: 1` is at the body bottom edge. The multi-input gates pass `inputCount` as the `bottomY` argument to `appendPowerPins` (e.g. 2-input gate: GND at `y: 2`). For the NOT gate, using the same pattern would give GND at `y: 1`, matching the inlined value. The coordinates may be correct but cannot be verified because the helper is not used, and the spec instruction to use the helper is not followed.

---

## Weak Tests

None found.

The `powerPinsFilteredFromDigitalCompiler` test in `src/solver/digital/__tests__/compiler.test.ts` lines 1148-1195 asserts exact specific values: `expect(layoutB.inputCount(0)).toBe(2)` and `expect(layoutB.outputCount(0)).toBe(1)`. These test desired behaviour with exact counts rather than weak inequalities.

---

## Legacy References

### L1 — `src/components/wiring/splitter.ts`: "Legacy" in comment

**File:** `src/components/wiring/splitter.ts`
**Stale reference:** `// Legacy accessors used by engine consumers`

Same finding as V4. The word "legacy" in a source comment is banned per `spec/.context/rules.md`.
