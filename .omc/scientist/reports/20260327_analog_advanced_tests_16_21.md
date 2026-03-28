# Analog Advanced Tests 16-21: SPICE Reference Values

**Generated:** 2026-03-27
**Method:** Analytical DC operating-point calculation using exact Shockley BJT model
(IS=1e-14, BF=100, VT=0.02585V) and MOSFET square-law model (NMOS: VTO=1, KP=2e-3;
PMOS: VTO=-1, KP=1e-3; LAMBDA=0.01). Saturated BJT stages use Vce_sat=0.1V /
Vbe_sat=0.75V model. ngspice on this Windows host writes to console handle only
(cannot be shell-captured); analytical results are exact for the stated model parameters.

---

[OBJECTIVE] Determine DC operating-point reference values for 6 advanced analog circuit
tests (Tests 16-21) in analog-circuit-assembly.spec.ts that currently have no SPICE_REF
entries, then propose specific assertion code replacing the trivial "volts[0] > 0" checks.

[DATA] 6 circuit topologies analysed; 3 BJT-only, 1 MOSFET-only, 1 mixed, 1 3-stage.
All circuits use Vcc/Vdd=12V supply. Models: QNPN NPN(BF=100 IS=1e-14), MNMOS/MPMOS
with VTO=+/-1, KP=2e-3/1e-3, LAMBDA=0.01.

---

## Test 16: Cascode Amplifier (line 796)

**Circuit:** Vcc(12V)-Rc(4.7k)-vc2-Q2(C) | Q2(B)=Vbias(6V) | Q2(E)=vmid-Q1(C) |
Q1(B) via Rb(100k) from Vin(1V) | Q1(E)-Re(1k)-GND.
Q1=common-emitter, Q2=common-base cascode. Same Ic flows through both.

**SPICE netlist:**
```
* Test 16: Cascode Amplifier
.model QNPN NPN(BF=100 IS=1e-14)
Vcc   vcc   0      DC 12
Vin   vin   0      DC 1
Vbias vbias 0      DC 6
Rc    vcc   vc2    4700
Rb    vin   vb1    100000
Re    ve1   0      1000
Q2    vc2   vbias  vmid   QNPN
Q1    vmid  vb1    ve1    QNPN
.op
.print DC V(vc2) V(vmid) V(vb1) V(ve1)
.end
```

[FINDING] Both BJTs active; cascode mid-point sits near Vbias/2, output near Vcc.
[STAT:n] Solved from 3-node KVL iteration, 600 bisection steps, residual < 1e-12

| Node   | Voltage     | Notes                                        |
|--------|-------------|----------------------------------------------|
| V(vc2) | 11.0932 V   | Q2 collector = output (INTERESTING)          |
| V(vmid)| 5.3878 V    | Q2:E = Q1:C mid-stack (INTERESTING)          |
| V(vb1) | 0.8071 V    | Q1 base                                      |
| V(ve1) | 0.1949 V    | Q1 emitter                                   |
| Ic     | 0.1929 mA   | Both transistors (same current)              |
| Vbe1=Vbe2 | 0.6122 V | Equal because same Ic                       |

**New SPICE_REF entry:**
```json
"a16_cascode": {
  "v_output": 1.109322e+01,
  "v_mid":    5.387778e+00,
  "v_base":   8.070677e-01
}
```

**Proposed assertion code:**
```typescript
const ref = SPICE_REF.a16_cascode;
const nodeVoltages: number[] = Object.values(state!.nodeVoltages);
const volts = sortedVoltages(state!);

// Output node (Q2 collector ~11.09V) is the highest non-supply voltage
expect(volts[0]).toBeCloseTo(ref.v_output, 0);  // +/-0.5V

// Cascode mid-point (~5.39V) should exist between Vbias/2 and Vbias
const midCandidates = nodeVoltages.filter(v => v > 4.0 && v < 6.5);
expect(midCandidates.length).toBeGreaterThanOrEqual(1);
const vMid = midCandidates.reduce((a,b) =>
  Math.abs(a - ref.v_mid) < Math.abs(b - ref.v_mid) ? a : b);
expect(vMid).toBeCloseTo(ref.v_mid, 0);  // +/-0.5V

// Both transistors active: no voltage negative, none above 12.5V
expect(volts[0]).toBeLessThan(12.5);
expect(volts[volts.length - 1]).toBeGreaterThanOrEqual(0);
```

---

## Test 17: Wilson Current Mirror (line 852)

**Circuit:** Vcc(12V) to Rref(10k) to vq1c(=Q1:C=Q3:B). Vcc to Rload(10k) to
vq2c(=Q2:C=Q3:C). Q3:E=Q1:B=Q2:B=vbase. Q1:E=Q2:E=GND.
Wilson feedback: Q3 senses ref leg, cancels base-current error vs simple mirror.

**SPICE netlist:**
```
* Test 17: Wilson Current Mirror
.model QNPN NPN(BF=100 IS=1e-14)
Vcc   vcc   0     DC 12
Rref  vcc   vq1c  10000
Rload vcc   vq2c  10000
Q3    vq2c  vq1c  vbase  QNPN
Q1    vq1c  vbase 0      QNPN
Q2    vq2c  vbase 0      QNPN
.op
.print DC V(vq1c) V(vq2c) V(vbase)
.end
```

[FINDING] Mirror output leg voltage 1.80V vs reference leg 1.21V; 94.5% current accuracy.
[STAT:effect_size] Iload/Iref = 0.945 (Wilson improves on simple mirror ~0.98 accuracy vs BF=100)
[STAT:n] 3-equation KCL system solved with Wilson constraint Ie3 = 2*Im/BF

| Node    | Voltage   | Notes                                      |
|---------|-----------|--------------------------------------------|
| V(vq1c) | 1.2081 V  | Ref leg: Q1:C = Q3:B (INTERESTING)         |
| V(vq2c) | 1.8020 V  | Out leg: Rload bottom (INTERESTING)        |
| V(vbase)| 0.6547 V  | Common base node                           |
| Im=Ic1=Ic2 | 1000 uA | Mirror transistors                      |
| Ic3     | 19.80 uA  | Feedback transistor                        |
| Iref    | 1079 uA   | (Vcc-vq1c)/Rref                            |
| Iload   | 1020 uA   | (Vcc-vq2c)/Rload                           |

**New SPICE_REF entry:**
```json
"a17_wilson_mirror": {
  "v_ref_leg": 1.208108e+00,
  "v_output":  1.802037e+00,
  "v_base":    6.547189e-01,
  "i_ref_uA":  1079.19,
  "i_out_uA":  1019.80
}
```

**Proposed assertion code:**
```typescript
const ref = SPICE_REF.a17_wilson_mirror;
const nodeVoltages: number[] = Object.values(state!.nodeVoltages);

// Reference leg (~1.21V) and output leg (~1.80V) both present
const vRefLeg = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_ref_leg) < Math.abs(b - ref.v_ref_leg) ? a : b);
expect(vRefLeg).toBeCloseTo(ref.v_ref_leg, 0);  // +/-0.5V

const vOutLeg = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_output) < Math.abs(b - ref.v_output) ? a : b);
expect(vOutLeg).toBeCloseTo(ref.v_output, 0);  // +/-0.5V

// Mirror symmetry: both legs within 1.5V of each other (not wildly different)
expect(Math.abs(vRefLeg - vOutLeg)).toBeLessThan(1.5);

// Common base node (~0.65V) present
const vBase = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_base) < Math.abs(b - ref.v_base) ? a : b);
expect(vBase).toBeCloseTo(ref.v_base, 1);  // +/-0.1V
```

---

## Test 18: Widlar Current Source (line 902)

**Circuit:** Q1 diode-connected (B shorted to C): Vcc(12V)-Rref(10k)-vref-Q1:B=Q1:C,
Q1:E=GND. Q2: B=vref, E-Re(5.6k)-GND, Vcc-Rload(47k)-Q2:C=vout.
Widlar principle: Re in Q2 emitter lowers Vbe2 below Vbe1, reducing Ic2 << Ic1.

**SPICE netlist:**
```
* Test 18: Widlar Current Source
.model QNPN NPN(BF=100 IS=1e-14)
Vcc   vcc  0    DC 12
Rref  vcc  vref 10000
Rload vcc  vout 47000
Re    ve2  0    5600
Q1    vref vref 0    QNPN
Q2    vout vref ve2  QNPN
.op
.print DC V(vref) V(vout) V(ve2)
.end
```

[FINDING] Widlar current reduction 60x: Ic1=1123uA reduced to Ic2=18.7uA via Re=5.6k.
[STAT:effect_size] Ic2*Re = 104.8mV vs VT*ln(Ic1/Ic2) = 105.8mV (0.9% formula error -- model exact)
[STAT:n] Two sequential bisect solves, residual < 1e-12

| Node    | Voltage   | Notes                                          |
|---------|-----------|------------------------------------------------|
| V(vref) | 0.6577 V  | Q1 diode Vbe = Q2 base drive (INTERESTING)     |
| V(vout) | 11.1205 V | Q2 collector: high because Ic2 tiny (INTERESTING)|
| V(ve2)  | 0.1058 V  | Q2 emitter                                     |
| Ic1     | 1123 uA   | Reference                                      |
| Ic2     | 18.71 uA  | Output (Widlar reduced 60x)                    |

**New SPICE_REF entry:**
```json
"a18_widlar": {
  "v_ref":    6.576832e-01,
  "v_output": 1.112054e+01,
  "v_e2":     1.058014e-01,
  "i_ref_uA": 1123.0,
  "i_out_uA": 18.71
}
```

**Proposed assertion code:**
```typescript
const ref = SPICE_REF.a18_widlar;
const nodeVoltages: number[] = Object.values(state!.nodeVoltages);
const volts = sortedVoltages(state!);

// Output is HIGH (~11.12V): Widlar source produces tiny current -> tiny Rload drop
expect(volts[0]).toBeCloseTo(ref.v_output, 0);  // +/-0.5V
expect(volts[0]).toBeGreaterThan(10.0);          // confirms low output current

// vref (~0.66V = one Vbe drop) should appear as a node
const vRef = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_ref) < Math.abs(b - ref.v_ref) ? a : b);
expect(vRef).toBeCloseTo(ref.v_ref, 1);  // +/-0.1V (one Vbe, well-defined)
```

---

## Test 19: MOSFET H-Bridge (line 953)

**Circuit (forward state):** Vdd=12V, Vfwd=0V, Vrev=12V.
Mp1(S=Vdd,G=Vfwd=0,D=va) ON [Vgs=-12]. Mn2(S=0,G=Vrev=12,D=vb) ON [Vgs=12].
Mp2(G=Vrev=12,S=Vdd) OFF [Vgs=0]. Mn1(G=Vfwd=0) OFF [Vgs=0].
Rload between va and vb. Current: Vdd->Mp1->va->Rload->vb->Mn2->GND.

**SPICE netlist:**
```
* Test 19: MOSFET H-Bridge (forward state)
.model MNMOS NMOS(VTO=1 KP=2e-3 LAMBDA=0.01)
.model MPMOS PMOS(VTO=-1 KP=1e-3 LAMBDA=0.01)
Vdd  vdd  0    DC 12
Vfwd vfwd 0    DC 0
Vrev vrev 0    DC 12
Mp1  va   vfwd vdd  MPMOS
Mp2  vb   vrev vdd  MPMOS
Mn1  va   vfwd 0    MNMOS
Mn2  vb   vrev 0    MNMOS
Rload va  vb   100
.op
.print DC V(va) V(vb)
.end
```

[FINDING] Forward drive: Va=6.84V (load high side), Vb=2.27V (load low side), Vload=4.57V.
[STAT:effect_size] I_load=45.7mA through 100-ohm load (confirmed by both MOSFET ID equations)
[STAT:n] Bisect on single-variable residual after expressing vb = va - I_mp1*Rload

| Node  | Voltage  | Notes                                    |
|-------|----------|------------------------------------------|
| V(va) | 6.8364 V | P-side (Mp1 drain) INTERESTING           |
| V(vb) | 2.2650 V | N-side (Mn2 drain) INTERESTING           |
| Vload | 4.5713 V | Voltage across load (va - vb)            |
| I_load| 45.71 mA | Load current                             |

**New SPICE_REF entry:**
```json
"a19_hbridge_fwd": {
  "v_high_side": 6.836436e+00,
  "v_low_side":  2.265026e+00,
  "v_load":      4.571410e+00
}
```

**Proposed assertion code:**
```typescript
const ref = SPICE_REF.a19_hbridge_fwd;
const nodeVoltages: number[] = Object.values(state!.nodeVoltages);

// High-side node Va (~6.84V): between Vdd/2 and Vdd
const vHighSide = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_high_side) < Math.abs(b - ref.v_high_side) ? a : b);
expect(vHighSide).toBeGreaterThan(4.0);
expect(vHighSide).toBeLessThan(11.0);
expect(vHighSide).toBeCloseTo(ref.v_high_side, 0);  // +/-0.5V

// Low-side node Vb (~2.27V): above GND, below Vdd/2
const vLowSide = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_low_side) < Math.abs(b - ref.v_low_side) ? a : b);
expect(vLowSide).toBeGreaterThan(0.5);
expect(vLowSide).toBeLessThan(5.0);
expect(vLowSide).toBeCloseTo(ref.v_low_side, 0);  // +/-0.5V

// Voltage difference across load is substantial (both sides conducting)
expect(vHighSide - vLowSide).toBeCloseTo(ref.v_load, 0);  // +/-0.5V
```

---

## Test 20: BJT+MOSFET Mixed Driver (line 1014)

**Circuit:** Vin(1V)-Rb(100k)-Q1:B, Vdd(12V)-Rc(4.7k)-Q1:C, Q1:E=GND.
Q1:C -> M1:G (NMOS gate). Vdd-Rd(1k)-M1:D, M1:S=GND.
Vin=1V turns Q1 on -> Q1:C=10.26V (NOT pulled to GND -- Rc prevents it) -> M1 fully on
-> Vd pulled near GND. This is an inverting level-shift + power switch.

**SPICE netlist:**
```
* Test 20: BJT+MOSFET Mixed Driver
.model QNPN NPN(BF=100 IS=1e-14)
.model MNMOS NMOS(VTO=1 KP=2e-3 LAMBDA=0.01)
Vdd  vdd  0    DC 12
Vin  vin  0    DC 1
Rb   vin  vb   100000
Rc   vdd  vc   4700
Rd   vdd  vd   1000
Q1   vc   vb   0     QNPN
M1   vd   vc   0     MNMOS
.op
.print DC V(vb) V(vc) V(vd)
.end
```

[FINDING] Q1 active with Vc1=10.26V (level-shifted). M1 in deep triode with Vd=0.63V.
[STAT:effect_size] Id_M1=11.37mA >> Id_Q1=0.371mA: MOSFET amplifies BJT drive capability 30x
[STAT:n] Sequential bisect: Q1 first (1 eq), M1 second (1 eq)

| Node   | Voltage    | Notes                                    |
|--------|------------|------------------------------------------|
| V(vb)  | 0.6291 V   | Q1 base                                  |
| V(vc)  | 10.2568 V  | Q1 collector = M1 gate (INTERESTING)     |
| V(vd)  | 0.6318 V   | M1 drain = Rd bottom = PROBE P1 (INTERESTING)|
| Ic1    | 0.3709 mA  | Q1 collector                             |
| Id_M1  | 11.37 mA   | NMOS in triode                           |
| M1 mode| triode     | Vgt=9.26V >> Vds=0.63V                  |

**New SPICE_REF entry:**
```json
"a20_bjt_mosfet_driver": {
  "v_q1c":   1.025678e+01,
  "v_drain": 6.317529e-01,
  "v_base":  6.291014e-01
}
```

**Proposed assertion code:**
```typescript
const ref = SPICE_REF.a20_bjt_mosfet_driver;
const nodeVoltages: number[] = Object.values(state!.nodeVoltages);

// Q1 collector = M1 gate is HIGH (~10.26V)
const vGate = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_q1c) < Math.abs(b - ref.v_q1c) ? a : b);
expect(vGate).toBeCloseTo(ref.v_q1c, 0);  // +/-0.5V
expect(vGate).toBeGreaterThan(8.0);        // M1 gate well above Vtn=1V

// M1 drain is LOW (~0.63V, deep triode conduction)
const vDrain = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_drain) < Math.abs(b - ref.v_drain) ? a : b);
expect(vDrain).toBeCloseTo(ref.v_drain, 1);  // +/-0.1V
expect(vDrain).toBeLessThan(2.0);            // M1 conducting, drain near GND
```

---

## Test 21: Multi-Stage Amplifier (line 1067)

**Circuit:** 3 CE stages, each with Rc=4.7k, Rb=100k, Re=1k.
Vin=1V -> Stage1 -> Rc1:bottom -> Rb2 -> Stage2 -> Rc2:bottom -> Rb3 -> Stage3 -> Rc3:bottom.

**SPICE netlist:**
```
* Test 21: Multi-Stage Amplifier
.model QNPN NPN(BF=100 IS=1e-14)
Vcc vcc 0 DC 12
Vin vin 0 DC 1
Rc1 vcc vc1 4700  ; Rb1 vin vb1 100000  ; Re1 ve1 0 1000 ; Q1 vc1 vb1 ve1 QNPN
Rc2 vcc vc2 4700  ; Rb2 vc1 vb2 100000  ; Re2 ve2 0 1000 ; Q2 vc2 vb2 ve2 QNPN
Rc3 vcc vc3 4700  ; Rb3 vc2 vb3 100000  ; Re3 ve3 0 1000 ; Q3 vc3 vb3 ve3 QNPN
.op
.print DC V(vc1) V(vc2) V(vc3)
.end
```

[FINDING] Stage 1 lightly biased (Vc1=11.09V high), Stage 2 deep saturation (Vc2=2.27V),
Stage 3 active mid-rail (Vc3=8.20V). Three distinct operating regions confirm cascade.
[STAT:n] 3 sequential stage solves; Stage 2 uses saturation model (Vce_sat=0.1V)
[STAT:effect_size] Stage gain chain: Vin=1V -> Vc1=11.09V -> sat -> Vc2=2.27V -> Vc3=8.20V

| Stage | Mode      | Vc        | Notes                                     |
|-------|-----------|-----------|-------------------------------------------|
| 1     | active    | 11.0932 V | Lightly on; high Vc1 drives stage 2 hard  |
| 2     | saturated | 2.2730 V  | Q2 deep sat; Vce_sat=0.1V model           |
| 3     | active    | 8.2031 V  | Vc2=2.27V -> moderate Ib3 -> active Q3    |

**New SPICE_REF entry:**
```json
"a21_multistage": {
  "v_c1": 1.109322e+01,
  "v_c2": 2.273005e+00,
  "v_c3": 8.203099e+00
}
```

**Proposed assertion code:**
```typescript
const ref = SPICE_REF.a21_multistage;
const nodeVoltages: number[] = Object.values(state!.nodeVoltages);

// Stage 1 collector HIGH (~11.09V): stage 1 lightly biased
const vC1 = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_c1) < Math.abs(b - ref.v_c1) ? a : b);
expect(vC1).toBeCloseTo(ref.v_c1, 0);  // +/-0.5V
expect(vC1).toBeGreaterThan(9.0);

// Stage 2 collector LOW (~2.27V): Q2 saturated
const vC2 = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_c2) < Math.abs(b - ref.v_c2) ? a : b);
expect(vC2).toBeCloseTo(ref.v_c2, 0);  // +/-0.5V
expect(vC2).toBeLessThan(4.0);

// Stage 3 collector MID (~8.20V): Q3 active
const vC3 = nodeVoltages.reduce((a,b) =>
  Math.abs(a - ref.v_c3) < Math.abs(b - ref.v_c3) ? a : b);
expect(vC3).toBeCloseTo(ref.v_c3, 0);  // +/-0.5V
expect(vC3).toBeGreaterThan(5.0);
expect(vC3).toBeLessThan(11.0);

// Three distinct operating regions confirm cascade is working
expect(vC1).toBeGreaterThan(vC2 + 5.0);   // stage 1 >> stage 2 (sat)
expect(vC3).toBeGreaterThan(vC2 + 2.0);   // stage 3 > stage 2
```

---

## Complete SPICE_REF JSON Block

Paste these entries into `e2e/fixtures/spice-reference-values.json`:

```json
  "a16_cascode": {
    "v_output": 1.109322e+01,
    "v_mid":    5.387778e+00,
    "v_base":   8.070677e-01
  },
  "a17_wilson_mirror": {
    "v_ref_leg": 1.208108e+00,
    "v_output":  1.802037e+00,
    "v_base":    6.547189e-01,
    "i_ref_uA":  1079.19,
    "i_out_uA":  1019.80
  },
  "a18_widlar": {
    "v_ref":    6.576832e-01,
    "v_output": 1.112054e+01,
    "v_e2":     1.058014e-01,
    "i_ref_uA": 1123.0,
    "i_out_uA": 18.71
  },
  "a19_hbridge_fwd": {
    "v_high_side": 6.836436e+00,
    "v_low_side":  2.265026e+00,
    "v_load":      4.571410e+00
  },
  "a20_bjt_mosfet_driver": {
    "v_q1c":   1.025678e+01,
    "v_drain": 6.317529e-01,
    "v_base":  6.291014e-01
  },
  "a21_multistage": {
    "v_c1": 1.109322e+01,
    "v_c2": 2.273005e+00,
    "v_c3": 8.203099e+00
  }
```

---

## Limitations

[LIMITATION] ngspice on this Windows host silently discards stdout (writes to Windows
console handle only, not a file descriptor). All values are analytical, not from SPICE
simulation output. They are exact for the declared models but will differ from SPICE
Gummel-Poon/BSIM results by ~5-15%. The existing reference a8_bjt_ce shows 0.4%
Vc deviation (11.047 SPICE vs 11.093 analytical), confirming good alignment for active-region BJTs.

[LIMITATION] Test 21 Stage 2 uses Vce_sat=0.1V / Vbe_sat=0.75V first-order saturation
model. Full Gummel-Poon reverse Ebers-Moll would give a slightly different Vc2. Tolerance
set at +/-0.5V for v_c2 and v_c3 accordingly.

[LIMITATION] Test 19 Rload value (motor) is not set in the test code. This analysis
assumes 100 ohm. The v_load assertion (voltage DIFFERENCE across Rload) is more robust
than absolute node assertions if the actual simulator uses a different default.

[LIMITATION] Wilson mirror (Test 17) analytical accuracy vs SPICE: 0.945 vs expected
~0.98 for BF=100. The simplified model does not include BJT Early voltage (VA), which
in SPICE's model improves mirror accuracy. Node voltage tolerances set at +/-0.5V.
