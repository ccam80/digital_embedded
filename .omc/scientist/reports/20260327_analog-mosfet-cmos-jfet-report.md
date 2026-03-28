# Analog Test Assertions Report: Tests 12-15 (MOSFET/CMOS/JFET)

**Generated**: 2026-03-27
**Batch**: e2e/gui/analog-circuit-assembly.spec.ts lines 605-783

## Methodology

Netlists run through ngspice_con.exe (ngspice 41). Model params from generate-spice-references.sh.
The script model differs from engine model-defaults.ts:
  NMOS: VTO=1, KP=2m, LAMBDA=0.01, W=10u, L=1u  (engine: VTO=0.7, KP=120u)
  PMOS: VTO=-1, KP=1m, LAMBDA=0.01, W=10u, L=1u (engine: VTO=-0.7, KP=60u)
  NJFET: VTO=-2, BETA=1.3m, LAMBDA=0.01          (engine: BETA=0.1m, LAMBDA=0)
All ngspice results reproduced SPICE_REF to full floating-point precision.

---

## Test 12: MOSFET common-source (line 605)

**Status**: WEAK

**Current assertions**: simTime>0 + expectVoltage(volts[0], v_drain)
Only volts[0] (Vdrain) is asserted. v_source and v_gate are unused.

**SPICE verification** (VTO=1, KP=2m, LAMBDA=0.01, W=10u, L=1u):
  v(drain)  = 4.456636e+00  matches SPICE_REF.a12_mosfet_cs.v_drain  (exact)
  v(gate)   = 3.000000e+00  matches SPICE_REF.a12_mosfet_cs.v_gate   (exact)
  v(source) = 1.604971e+00  matches SPICE_REF.a12_mosfet_cs.v_source (exact)
DC: Id=1.605mA; Vs=1.605V; Vgs=1.395V; Vov=0.395V; Vds=2.852V >> Vov -> saturation

[STAT:n] n=1 DC operating point
[STAT:effect_size] deviation from SPICE_REF: 0.000 (exact match)

**Proposed assertion code**:
```typescript
const state = await stepAndRead(builder, 300);
expect(state).not.toBeNull();
expect(state!.simTime).toBeGreaterThan(0);
const volts = sortedVoltages(state!);
// volts[0] = Vdrain ~4.46V (mid-rail bias, Rd drops 7.54V)
expectVoltage(volts[0], SPICE_REF.a12_mosfet_cs.v_drain, "Vdrain");
// volts[1] = Vsource ~1.60V (self-bias: Id*Rs)
expectVoltage(volts[1], SPICE_REF.a12_mosfet_cs.v_source, "Vsource");
// volts[2] = Vgate = 3.0V (fixed by Vg source through Rg)
expectVoltage(volts[2], SPICE_REF.a12_mosfet_cs.v_gate, "Vgate");
```

---

## Test 13: CMOS inverter (line 650)

**Status**: WEAK

**Current assertions**: simTime>0 + expectVoltage(volts[0], a13_cmos_inverter_low.v_output)
Vin=Vdd state (a13_cmos_inverter_high) is in SPICE_REF but has no test.

**SPICE verification** (NMOS VTO=1 KP=2m, PMOS VTO=-1 KP=1m, LAMBDA=0.01, W=10u L=1u):
  Vin=0V: v(outnode) = 5.000000e+00  matches a13_cmos_inverter_low.v_output  (exact)
  Vin=5V: v(outnode) = 6.262500e-11  matches a13_cmos_inverter_high.v_output (exact)

[STAT:n] n=2 DC states
[STAT:effect_size] PMOS-on output: 5.000V (full rail). NMOS-on output: <1e-10V (full rail).

**Proposed assertion code** (Vin=0, strengthen existing):
```typescript
const state = await stepAndRead(builder, 200);
expect(state).not.toBeNull();
expect(state!.simTime).toBeGreaterThan(0);
const volts = sortedVoltages(state!);
// PMOS on (Vgs_p=-5V < Vtp=-1V), NMOS off (Vgs_n=0 < Vtn=1V) -> output=Vdd
expectVoltage(volts[0], SPICE_REF.a13_cmos_inverter_low.v_output, "Vout(Vin=0)");
```

**Proposed Vin=Vdd assertion** (new test or same test after re-driving Vin to 5V):
```typescript
// IMPORTANT: do NOT use expectVoltage for the low-output state.
// a13_cmos_inverter_high.v_output = 6.26e-11V is a SPICE solver artifact.
// expectVoltage at 0.1% tolerance -> band +/-6.26e-14V, unreachable by any MNA solver.
// Use digital_threshold rule from SPICE_REF _tolerance_guidance instead.
const stateHigh = await stepAndRead(builder, 200);
expect(stateHigh).not.toBeNull();
expect(stateHigh!.simTime).toBeGreaterThan(0);
const voltsHigh = sortedVoltages(stateHigh!);
// NMOS on, PMOS off -> output pulls to GND
expect(voltsHigh[voltsHigh.length - 1]).toBeLessThan(0.1);
```

---

## Test 14: CMOS NAND (line 690)

**Status**: WEAK

**Current assertions**: simTime>0 + expectVoltage(volts[0], a14_cmos_nand_00.v_output)
A=1,B=1 state (a14_cmos_nand_11) is in SPICE_REF but has no test.

**SPICE verification** (same models as inverter, W=10u L=1u):
  A=0,B=0: v(outnode) = 5.000000e+00  matches a14_cmos_nand_00.v_output (exact)
  A=5,B=5: v(outnode) = 2.505000e-10  matches a14_cmos_nand_11.v_output (exact)

[STAT:n] n=2 DC states (NAND truth table corners 00 and 11)
[STAT:effect_size] High: 5.000V (rail). Low: <1e-9V (rail).

**Proposed assertion code** (A=0,B=0, strengthen existing):
```typescript
const state = await stepAndRead(builder, 200);
expect(state).not.toBeNull();
expect(state!.simTime).toBeGreaterThan(0);
const volts = sortedVoltages(state!);
// Both PMOS on -> output at Vdd (NAND: 0 NAND 0 = 1)
expectVoltage(volts[0], SPICE_REF.a14_cmos_nand_00.v_output, "Vout(A=0,B=0)");
```

**Proposed A=1,B=1 assertion** (add after re-driving Va/Vb to 5V):
```typescript
await builder.setComponentProperty("Va", "voltage", 5);
await builder.setComponentProperty("Vb", "voltage", 5);
const state11 = await stepAndRead(builder, 200);
expect(state11).not.toBeNull();
expect(state11!.simTime).toBeGreaterThan(0);
const volts11 = sortedVoltages(state11!);
// Both PMOS off, NMOS series path -> output LOW (NAND: 1 NAND 1 = 0)
// a14_cmos_nand_11.v_output=2.5e-10V is a solver artifact -> use digital_threshold.
expect(volts11[volts11.length - 1]).toBeLessThan(0.1);
```

---

## Test 15: JFET amplifier (line 745)

**Status**: WEAK

**Current assertions**: simTime>0 + expectVoltage(volts[0], a15_jfet_amp.v_drain)
Only v_drain checked. v_source (self-bias point) is not asserted.

**SPICE verification** (VTO=-2, BETA=1.3m, LAMBDA=0.01):
  v(drain)  = 1.178713e+01  matches a15_jfet_amp.v_drain  (exact)
  v(gate)   = 1.280017e-05  matches a15_jfet_amp.v_gate   (exact)
  v(source) = 9.930688e-01  matches a15_jfet_amp.v_source (exact)
DC (pinch-off): Id=1.460mA; Vs=0.993V; Vgs=-0.993V; VTO=-2V -> Vgs>VTO -> channel open;
Vds=10.794V >> |Vgs-VTO|=1.007V -> saturation confirmed.

[STAT:n] n=1 DC operating point
[STAT:effect_size] deviation from SPICE_REF: 0.000 (exact match)

**Proposed assertion code**:
```typescript
const state = await stepAndRead(builder, 300);
expect(state).not.toBeNull();
expect(state!.simTime).toBeGreaterThan(0);
const volts = sortedVoltages(state!);
// volts[0] = Vdrain ~11.79V (high -- JFET draws ~1.46mA, Rd drops only 3.21V)
expectVoltage(volts[0], SPICE_REF.a15_jfet_amp.v_drain, "Vdrain");
// volts[1] = Vsource ~0.99V (Rs self-bias sets Vgs = -0.993V)
expectVoltage(volts[1], SPICE_REF.a15_jfet_amp.v_source, "Vsource");
```

---

## Summary

| Test              | Line | Status | SPICE_REF verified              | Key additions                          |
|-------------------|------|--------|---------------------------------|----------------------------------------|
| T12 MOSFET CS     | 605  | WEAK   | v_drain, v_gate, v_source exact | Add v_source + v_gate assertions       |
| T13 CMOS inverter | 650  | WEAK   | both states exact               | Add Vin=Vdd -> toBeLessThan(0.1)       |
| T14 CMOS NAND     | 690  | WEAK   | both states exact               | Add A=1,B=1 -> toBeLessThan(0.1)      |
| T15 JFET amp      | 745  | WEAK   | v_drain, v_source exact         | Add v_source assertion                 |

[FINDING] All four tests assert only simTime>0 plus one voltage. Each has at least
one additional physically meaningful node already present in SPICE_REF.
[STAT:n] 7 DC operating-point nodes verified across four circuits.
[STAT:effect_size] All ngspice results match SPICE_REF to full double precision.

[FINDING] CMOS/NAND low-output SPICE_REF values (~1e-11 to 1e-10V) are numerical
solver artifacts. expectVoltage at 0.1% tolerance on these imposes +/-1e-13V band,
physically unreachable by any MNA solver.
[STAT:effect_size] a13_cmos_inverter_high.v_output=6.26e-11V; 0.1% band=+/-6.26e-14V.

[LIMITATION] expectVoltage is inappropriate for near-zero CMOS output nodes.
toBeLessThan(0.1) matches SPICE_REF _tolerance_guidance.digital_threshold and
is the correct form for all logic-LOW CMOS output assertions.
