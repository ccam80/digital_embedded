# SPICE Reference Test Tightening — Inventory & Action Plan

**Date:** 2026-03-31
**Goal:** All semiconductor unit/integration tests must assert against ngspice reference values at 0.1% relative tolerance. No exceptions.

---

## 1. Integration DC Operating Point Tests

These tests build a small circuit, run `solveDcOperatingPoint()`, and check node voltages/currents.

### 1A. Diode + Resistor DC OP

- **File:** `src/components/semiconductors/__tests__/diode.test.ts:264–320`
- **Test:** `Integration > diode_resistor_dc_op`
- **Circuit:** 5V → 1kΩ → Diode(A=node1, K=GND) → GND
- **Model params:** IS=1e-14, N=1, CJO=0, VJ=0.7, M=0.5, TT=0, FC=0.5
- **Current assertions:**
  - `0.682 < Vd < 0.703` (±1.5% — close but not 0.1%)
  - `0.00420 < Id < 0.00440` (±2.3%)
- **Status:** NEEDS TIGHTENING to 0.1%
- **ngspice netlist needed:**
  ```spice
  Diode Resistor DC OP
  .model dmod d (IS=1e-14 N=1)
  Vs 2 0 5
  R1 1 2 1k
  D1 1 0 dmod
  .op
  .print dc v(1) v(2) i(Vs)
  .end
  ```
- **Replace with:** `expect(vDiode).toBeCloseTo(SPICE_REF, 4)` and `expect(iDiode).toBeCloseTo(SPICE_REF, 6)`

### 1B. BJT Common-Emitter Amplifier

- **File:** `src/components/semiconductors/__tests__/bjt.test.ts:542–620`
- **Test:** `Integration > common_emitter_amplifier`
- **Circuit:** Vcc=5V → Rc=1kΩ → NPN(C), Vbb=5V → Rb=100kΩ → NPN(B), NPN(E)=GND
- **Model params:** IS=1e-14, BF=100, NF=1, BR=1, VAF=Inf, IKF=Inf, IKR=Inf, ISE=0, ISC=0, NR=1, VAR=Inf
- **Current assertions:**
  - `0.1 < Vc < 5.0` — **±96% of Vcc, rubber stamp**
  - `0.5 < Vb < 1.5` — ±50%
  - `Ic ≈ 0.004307509615241744` (toBeCloseTo 8 digits) — **self-referential, backfilled from simulator output**
  - `Ib ≈ 0.00004307509614279056` (toBeCloseTo 12 digits) — **same, backfilled**
  - `1 < beta < 105`
- **Status:** RUBBER STAMP — the range assertions catch nothing; the precise assertions are backfilled, not independently verified
- **ngspice netlist needed:**
  ```spice
  BJT Common Emitter
  .model qmod npn (IS=1e-14 BF=100 NF=1 BR=1 VAF=1e30 IKF=1e30 IKR=1e30 ISE=0 ISC=0 NR=1 VAR=1e30)
  Vcc 4 0 5
  Vbb 3 0 5
  Rc 4 1 1k
  Rb 3 2 100k
  Q1 1 2 0 qmod
  .op
  .print dc v(1) v(2) v(3) v(4)
  .end
  ```
- **Replace with:** Exact `toBeCloseTo(SPICE_REF, precision)` for Vc, Vb, Ic, Ib — all at 0.1% relative tolerance

### 1C. MOSFET Common-Source NMOS

- **File:** `src/components/semiconductors/__tests__/mosfet.test.ts:509–576`
- **Test:** `Integration > common_source_nmos`
- **Circuit:** Vdd=5V → Rd=1kΩ → NMOS(D), Vgate=3V → NMOS(G), NMOS(S)=GND
- **Model params:** VTO=0.7, KP=120e-6, LAMBDA=0.02, PHI=0.6, GAMMA=0.37, CBD=0, CBS=0, CGDO=0, CGSO=0, W=1e-6, L=1e-6
- **Current assertions:**
  - `1.0 < Vd < 5.0` — **±80%, rubber stamp**
  - `0.5mA < Id < 5mA` — **±100%, rubber stamp**
  - `1.5 < Vd < 3.5` — **±40%, still rubber stamp**
- **Status:** RUBBER STAMP — comments claim "±5% SPICE reference" but assertions are 10-20x wider
- **ngspice netlist needed:**
  ```spice
  NMOS Common Source
  .model nmod nmos (VTO=0.7 KP=120u LAMBDA=0.02 PHI=0.6 GAMMA=0.37)
  Vdd 2 0 5
  Vg 3 0 3
  Rd 2 1 1k
  M1 1 3 0 0 nmod W=1u L=1u
  .op
  .print dc v(1) v(2) v(3)
  .end
  ```
- **Replace with:** Exact Vd and Id at 0.1%

### 1D. Zener Voltage Regulator

- **File:** `src/components/semiconductors/__tests__/zener.test.ts:169–221`
- **Test:** `Integration > zener_regulator`
- **Circuit:** 12V → 1kΩ → Zener(K=node1, A=GND, BV=5.1) → GND
- **Model params:** IS=1e-14, N=1, BV=5.1, IBV=1e-3
- **Current assertions:**
  - `Vs ≈ 12` (toBeCloseTo 3 digits) — OK
  - `5.05 < Vz < 5.15` — ±1%, decent but not 0.1%
- **Status:** NEEDS TIGHTENING from ±1% to 0.1%
- **ngspice netlist needed:**
  ```spice
  Zener Regulator
  .model zmod d (IS=1e-14 N=1 BV=5.1 IBV=1e-3)
  Vs 2 0 12
  R1 1 2 1k
  D1 0 1 zmod
  .op
  .print dc v(1) v(2) i(Vs)
  .end
  ```
- **Replace with:** Exact Vz at 0.1%

---

## 2. setParam / Hot-Load Tests

These tests call `setParam()` to change a model parameter at runtime, re-converge, and check that stamps changed. **None of them compare against SPICE reference values — they only assert "something changed."**

Every one needs to be rewritten as: build circuit → DC OP solve → assert vs SPICE ref (before) → `setParam()` → DC OP solve again → assert vs SPICE ref (after).

### 2A. Diode setParam('IS', 1e-14 → 1e-11)

- **File:** `src/components/semiconductors/__tests__/diode.test.ts:328–362`
- **Test:** `setParam mutates params object > setParam('IS', newValue) changes conductance stamps`
- **Current assertion:** `anyDiffers > 1e-15` — **just "something changed"**
- **Action:** Full DC OP solve before (IS=1e-14) and after (IS=1e-11) with same circuit as 1A. Assert Vd, Id against SPICE for both.
- **ngspice:** Same netlist as 1A, run twice with IS=1e-14 and IS=1e-11.

### 2B. Diode setParam('N', 1 → 2)

- **File:** `src/components/semiconductors/__tests__/diode.test.ts:364–395`
- **Test:** `setParam mutates params object > setParam('N', newValue) changes RHS Norton current`
- **Current assertion:** `anyDiffers > 1e-15` — **just "something changed"**
- **Action:** Full DC OP solve before (N=1) and after (N=2). Assert Vd, Id against SPICE for both.
- **ngspice:** Same netlist as 1A, run twice with N=1 and N=2.

### 2C. BJT setParam('BF', 200 → 50)

- **File:** `src/components/semiconductors/__tests__/bjt.test.ts:664–703`
- **Test:** `setParam mutates params object > setParam('BF', newValue) changes RHS Norton current`
- **Current assertion:** `anyDiffers > 1e-12` — **just "something changed"**
- **Action:** Full DC OP solve before (BF=100 defaults) and after (BF=50). Assert Vc, Vb, Ic, Ib against SPICE for both.
- **ngspice:** Same netlist as 1B, run twice with BF=100 and BF=50.

### 2D. BJT setParam('IS', ×100)

- **File:** `src/components/semiconductors/__tests__/bjt.test.ts:705–741`
- **Test:** `setParam mutates params object > setParam('IS', newValue) changes conductance stamps`
- **Current assertion:** `anyDiffers > 1e-15` — **just "something changed"**
- **Action:** Full DC OP solve before (IS=1e-14) and after (IS=1e-12). Assert against SPICE for both.
- **ngspice:** Same netlist as 1B, run twice with IS=1e-14 and IS=1e-12.

### 2E. MOSFET setParam('VTO', 0.7 → 2.5)

- **File:** `src/components/semiconductors/__tests__/mosfet.test.ts:584–629`
- **Test:** `setParam mutates params object > setParam('VTO', newValue) changes conductance stamps`
- **Current assertion:** `stampsDiffer || rhsDiffer > 1e-15` — **just "something changed"**
- **Action:** Full DC OP solve before (VTO=0.7) and after (VTO=2.5). Assert Vd, Id against SPICE for both.
- **ngspice:** Same netlist as 1C, run twice with VTO=0.7 and VTO=2.5.

### 2F. MOSFET setParam('KP', ×2)

- **File:** `src/components/semiconductors/__tests__/mosfet.test.ts:631–665`
- **Test:** `setParam mutates params object > setParam('KP', newValue) changes drain current Norton stamps`
- **Current assertion:** `anyDiffers > 1e-15` — **just "something changed"**
- **Action:** Full DC OP solve before (KP=120µ) and after (KP=240µ). Assert Vd, Id against SPICE for both.
- **ngspice:** Same netlist as 1C, run twice with KP=120u and KP=240u.

---

## 3. Summary Table

| ID | Test | File:Line | Tolerance Claimed | Tolerance Actual | Verdict | Action |
|----|------|-----------|-------------------|------------------|---------|--------|
| 1A | Diode DC OP | diode.test.ts:264 | ±0.01V | ±1.5% | Close | Tighten to 0.1% |
| 1B | BJT CE amp | bjt.test.ts:542 | ±5% | ±96% / backfilled | **Rubber stamp** | Replace all assertions |
| 1C | MOSFET CS | mosfet.test.ts:509 | ±5% | ±40–80% | **Rubber stamp** | Replace all assertions |
| 1D | Zener regulator | zener.test.ts:169 | ±0.05V | ±1% | Decent | Tighten to 0.1% |
| 2A | Diode setParam IS | diode.test.ts:328 | — | "anyDiffers" | **No reference** | Add before/after SPICE |
| 2B | Diode setParam N | diode.test.ts:364 | — | "anyDiffers" | **No reference** | Add before/after SPICE |
| 2C | BJT setParam BF | bjt.test.ts:664 | — | "anyDiffers" | **No reference** | Add before/after SPICE |
| 2D | BJT setParam IS | bjt.test.ts:705 | — | "anyDiffers" | **No reference** | Add before/after SPICE |
| 2E | MOSFET setParam VTO | mosfet.test.ts:584 | — | "anyDiffers" | **No reference** | Add before/after SPICE |
| 2F | MOSFET setParam KP | mosfet.test.ts:631 | — | "anyDiffers" | **No reference** | Add before/after SPICE |

---

## 4. Implementation Plan

### Phase 1: Get ngspice reference values
Run each netlist in ngspice batch mode (4 base circuits × param variations = ~12 simulations).
Record all node voltages and branch currents to 6+ significant figures.
Add results to this file under a new "Reference Values" section.

### Phase 2: Rewrite integration tests (1A–1D)
- Replace range checks (`toBeGreaterThan`/`toBeLessThan`) with relative tolerance assertions
- Add or use a helper: `expectRelative(actual, expected, tolerance=0.001)`
- Assert every measurable quantity (Vnode, Ibranch) not just the "main" one

### Phase 3: Rewrite setParam tests (2A–2F)
- Convert from stamp-spy tests to full DC OP solve tests
- Each test: build same circuit as parent integration test → solve → assert vs SPICE (before) → setParam → solve again → assert vs SPICE (after)
- This validates that setParam correctly propagates through the full solver, not just that "a stamp value changed"

### Phase 4: Run & verify
- All 10 tests must pass at 0.1% tolerance
- Any failures indicate real simulator bugs to fix (not tolerance to widen)

---

## 5. Model Parameter Reference

### Diode (test default)
| Param | Value |
|-------|-------|
| IS | 1e-14 A |
| N | 1 |
| CJO | 0 |
| VJ | 0.7 V |
| M | 0.5 |
| TT | 0 |
| FC | 0.5 |

### BJT NPN (from bjt.ts BJT_NPN_DEFAULTS)
| Param | Value |
|-------|-------|
| IS | 1e-14 A |
| BF | 100 |
| NF | 1 |
| BR | 1 |
| VAF | Infinity |
| IKF | Infinity |
| IKR | Infinity |
| ISE | 0 |
| ISC | 0 |
| NR | 1 |
| VAR | Infinity |

### NMOS (test default)
| Param | Value |
|-------|-------|
| VTO | 0.7 V |
| KP | 120e-6 A/V^2 |
| LAMBDA | 0.02 /V |
| PHI | 0.6 V |
| GAMMA | 0.37 V^0.5 |
| W | 1e-6 m |
| L | 1e-6 m |
| CBD/CBS/CGDO/CGSO | 0 |

### Zener (test default)
| Param | Value |
|-------|-------|
| IS | 1e-14 A |
| N | 1 |
| BV | 5.1 V |
| IBV | 1e-3 A |

---

## 6. ngspice Reference Values (Verified 2026-03-31)

All values from ngspice_con.exe batch mode, TEMP=27C, TNOM=27C.

### Diode + Resistor (5V → 1kΩ → D → GND)

| Case | IS | N | V(diode) | Id |
|------|-----|---|----------|-----|
| Base | 1e-14 | 1 | 6.928910e-01 | 4.307675e-03 |
| IS=1e-11 | 1e-11 | 1 | 5.152668e-01 | 4.485160e-03 |
| N=2 | 1e-14 | 2 | 1.376835e+00 | 3.623504e-03 |

### BJT Common Emitter (Vcc=5V, Rc=1kΩ, Vbb=5V, Rb=100kΩ)

| Case | BF | IS | V(collector) | V(base) | Ic | Ib |
|------|-----|------|-------------|---------|-----|-----|
| Base | 100 | 1e-14 | 6.928910e-01 | 6.928910e-01 | 4.307675e-03 | 4.307675e-05 |
| BF=50 | 50 | 1e-14 | 2.837533e+00 | 6.750668e-01 | 2.162520e-03 | 4.325039e-05 |
| IS=1e-12 | 100 | 1e-12 | 5.744795e-01 | 5.744795e-01 | 4.425990e-03 | 4.425990e-05 |

Note: BF=100 base case is in deep saturation (Vc ≈ Vbe ≈ 0.693V). BF=50 halves Ic, pulling BJT out of saturation (Vc=2.84V).

### NMOS Common Source (Vdd=5V, Rd=1kΩ, Vg=3V, W=10µ, L=1µ)

| Case | VTO | KP | V(drain) | Id |
|------|------|------|----------|-----|
| Base | 0.7 | 120µ | 1.840508e+00 | 3.159492e-03 |
| VTO=2.5 | 2.5 | 120µ | 4.835494e+00 | 1.645065e-04 |
| KP=240µ | 0.7 | 240µ | 9.071396e-01 | 4.092860e-03 |

Note: Previous test comments claimed "SPICE gives Vds≈2.5V" — actual ngspice gives 1.84V. The comments were wrong.

### Zener Regulator (12V → 1kΩ → Zener(BV=5.1) → GND)

| Case | V(zener cathode) | Iz |
|------|-----------------|-----|
| Base | 5.149965e+00 | -6.901580e-03 |

Note: Vz=5.15V, not exactly 5.1V — breakdown is an exponential knee, not a hard clamp.
