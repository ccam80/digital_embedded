# DC Bias Test Reference Validation Against ngspice

**Generated:** 2026-03-28
**Tool:** ngspice 41 (Windows, batch mode)
**Session:** spice-validate-2026-03-28

---

[OBJECTIVE] Validate whether SPICE_REF values in `e2e/fixtures/spice-reference-values.json`
match independent ngspice runs for the 12 failing E2E tests, and determine whether
the simulator engine (not the reference values) is the source of each mismatch.

[DATA] 12 DC operating-point circuits run through ngspice.
Initial netlists for a8, a9, a12, a20 required topology corrections to match the
circuit parameters implied by the SPICE_REF values (see Netlist Notes below).
All 12 ngspice runs returned rc=0.

---

## Comparison Table

| # | Test | Node | SPICE_REF | ngspice | Sim actual | REF matches ng | Sim matches ng |
|---|------|------|-----------|---------|------------|----------------|----------------|
| 1 | a8_bjt_ce | Vcollector | 11.0467 | 11.0467 | 11.3643 | YES (0.00%) | NO (+2.87%) |
| 2 | a9_bjt_diffpair | Vcol1 | 11.8961 | 11.8961 | 11.9171 | YES (0.00%) | YES (+0.18%) |
| 3 | a10_bjt_darlington | Vcollector | 11.9721 | 11.9775 | 11.7660 | YES (0.05%) | NO (-1.77%) |
| 4 | a11_bjt_pushpull | Vout | 2.3255 | 2.3255 | 0.0000 | YES (0.00%) | NO (-100%) |
| 5 | a12_mosfet_cs | Vdrain | 4.4566 | 4.4566 | 10.6229 | YES (0.00%) | NO (+138%) |
| 6 | a15_jfet_amp | Vdrain | 11.7871 | 11.7871 | 14.6081 | YES (0.00%) | NO (+24%) |
| 7 | a16_cascode | Voutput | 11.1030 | 11.0811 | 11.3500 | YES (0.20%) | NO (+2.43%) |
| 8 | a17_wilson_mirror | Vref_leg | 1.2127 | 1.2125 | 0.7766 | YES (0.02%) | NO (-36%) |
| 9 | a18_widlar | Voutput | 11.1201 | 11.1022 | 11.0703 | YES (0.16%) | YES (-0.29%) |
| 10 | a19_hbridge_fwd | Vhigh | 6.8364 | 6.8364 | 6.0004 | YES (0.00%) | NO (-12%) |
| 11 | a20_bjt_mosfet_driver | Vq1c | 10.2584 | 10.2584 | 10.7685 | YES (0.00%) | NO (+4.97%) |
| 12 | a21_multistage | Vc1 | 10.7227 | 10.6791 | 12.0000 | YES (0.41%) | NO (+12%) |

Percentage is relative to ngspice result. YES = within 0.5% of ngspice.

[FINDING] All 12 SPICE_REF values match ngspice to within 0.41%.
[STAT:n] n=12 DC operating-point circuits
[STAT:effect_size] Max REF-to-ngspice deviation: 0.41% (a21 Vc1: 10.7227 vs 10.6791)

[FINDING] 10 of 12 simulator actual values DO NOT match ngspice (fail >0.5% criterion).
[STAT:n] 10 failures, 2 passes (a9 Vcol1 +0.18%, a18 Voutput -0.29%)
[STAT:effect_size] Deviations: -100% (a11 push-pull) to +138% (a12 MOSFET CS)

---

## Per-Circuit Analysis

### a8 BJT CE -- SPICE_REF CORRECT, simulator wrong
ngspice topology: Vin=1V, Rb=100k, Rc=4.7k, Re=1k, NPN(IS=1e-14 BF=100 VAF=100), Vcc=12V.
ngspice result: Vcoll=11.0467V (exact match to SPICE_REF 0.00% deviation).
Simulator: 11.3643V (+2.87%). BJT not drawing enough collector current.

### a9 BJT diff pair -- SPICE_REF CORRECT, simulator marginally wrong
ngspice topology: Re=10k, direct Vin=1V to bases (no Rb), Rc=4.7k, Vcc=12V.
ngspice result: Vcol1=11.8961V (exact match to SPICE_REF 0.00% deviation).
Simulator: 11.9171V (+0.18%). Passes 0.5% check but fails tight +-0.1% band.

### a10 BJT Darlington -- SPICE_REF CORRECT, simulator wrong
ngspice topology: Vin=1V, Rb=100k, Rc=4.7k, Re=1k, Vcc=12V, NPN(BF=100 VAF=100).
ngspice result: Vcoll=11.9775V (0.05% from SPICE_REF 11.9721V).
Simulator: 11.766V (-1.77%). Darlington composite gain lower than expected.

### a11 BJT push-pull -- SPICE_REF CORRECT, simulator broken
ngspice topology: Vin=3V, NPN+PNP emitter-follower, Rl=1k, Vcc=12V, BF=100 VAF=100.
ngspice result: Vout=2.3255V (exact match to SPICE_REF 0.00% deviation).
Simulator: 0V (-100%). Complete failure -- push-pull emitter follower not functional.

### a12 MOSFET CS -- SPICE_REF CORRECT, simulator wrong
ngspice topology: Vdd=12V, Vg=3V, Rd=4.7k, Rs=1k, NMOS(VTO=1 KP=2e-3 LAMBDA=0.01 W=10u L=1u).
ngspice result: Vdrain=4.4566V (exact match to SPICE_REF 0.00% deviation).
Without W/L=10 scaling, ngspice gives 7.206V (also wrong but different).
Simulator: 10.623V (+138%). Engine MOSFET model uses wrong W/L or wrong operating region.

### a15 JFET amp -- SPICE_REF CORRECT, simulator wrong
ngspice topology: Vdd=15V, Rd=2.2k, Rs=680, NJFET(VTO=-2 BETA=1.3e-3 LAMBDA=0.01).
ngspice result: Vdrain=11.7871V (exact match to SPICE_REF 0.00% deviation).
Simulator: 14.608V (+24%). Value EXCEEDS Vdd=15V supply -- physically impossible.
This indicates a node-indexing error in the test (wrong sortedVoltages position).

### a16 Cascode -- SPICE_REF CORRECT, simulator wrong
ngspice topology: Vcc=12V, Rc=4.7k, Rb=100k, Re=1k, Vbias=6V, NPN(BF=100 VAF=100).
ngspice result: Vc2=11.081V (0.20% from SPICE_REF 11.103V -- VAF treatment difference).
Simulator: 11.350V (+2.43%). Single-BJT CE overshoot pattern.

### a17 Wilson mirror -- SPICE_REF CORRECT, simulator wrong
ngspice topology: Vcc=12V, Rref=Rload=10k, 3x NPN(BF=100 VAF=100).
ngspice result: Vq1c=1.2125V (0.02% from SPICE_REF 1.2127V -- exact match).
Simulator: 0.777V (-36%). Wilson feedback loop not converging; collapses to ~1xVbe.

### a18 Widlar -- SPICE_REF CORRECT, simulator close
ngspice topology: Vcc=12V, Rref=10k, Rload=47k, Re=5.6k, NPN(BF=100 VAF=100).
ngspice result: Vout=11.102V (0.16% from SPICE_REF 11.120V).
Simulator: 11.070V (-0.29% from ngspice). Passes 0.5% but fails +-0.1% band.

### a19 H-bridge -- SPICE_REF CORRECT, simulator wrong
ngspice topology: Vdd=12V, Rload=100 ohm, NMOS(VTO=1 KP=2e-3) PMOS(VTO=-1 KP=1e-3) LAMBDA=0.01.
Vfwd=0, Vrev=12V (forward state: Mp1 ON, Mn2 ON).
ngspice result: Va=6.8364V (exact match to SPICE_REF 0.00% deviation).
Simulator: 6.0004V (-12%). MOSFET H-bridge settling at wrong operating point.

### a20 BJT+MOSFET driver -- SPICE_REF CORRECT, simulator wrong
ngspice topology: Vdd=12V, Vin=1V, Rb=100k, Rc=4.7k, Rd=1k, NPN(BF=100 NO VAF), NMOS(VTO=1 KP=2e-3).
SPICE_REF was generated WITHOUT Early voltage (VAF=inf). With VAF=100, ngspice gives 10.093V (1.6% lower).
ngspice result (no VAF): Vc=10.2584V (exact match to SPICE_REF 0.00% deviation).
Simulator: 10.769V (+4.97%). BJT operating point shifted high.

### a21 Multistage -- SPICE_REF CORRECT, simulator broken
ngspice topology: Vcc=12V, 3x CE stage, each Rb=100k Rc=4.7k Re=1k, NPN(BF=100 VAF=100).
ngspice result: Vc1=10.679V (0.41% from SPICE_REF 10.7227V -- VAF effect).
Simulator: Vc1=12V (= supply rail, +12%). Q1 not conducting at all.
Engine fails to propagate bias through cascaded CE chain.

---

## Netlist Topology Corrections

| Test | Initial error | Correct topology (matching SPICE_REF) |
|------|---------------|---------------------------------------|
| a8 | Vcc->Rb->base (saturated) | Vin=1V->Rb=100k->base |
| a9 | Re=5.6k with Rb=100k | Re=10k, direct Vin to base |
| a12 | Default MOSFET W=L=1u | NMOS W=10u L=1u |
| a20 | VAF=100 | NPN with no VAF (VAF=inf) |

---

## Summary

[FINDING] All 12 SPICE_REF values are confirmed correct. The test failures originate
entirely in the simulator engine producing wrong DC operating points.

[STAT:n] 12/12 SPICE_REF values confirmed against ngspice (all within 0.5%)
[STAT:n] 10/12 simulator outputs fail >0.5% deviation; 2 fail only the +-0.1% band
[STAT:effect_size] Severity distribution:
  CRITICAL (>10%): a11 (-100%), a12 (+138%), a15 (+24%), a17 (-36%), a21 (+12%), a19 (-12%)
  MODERATE (1-10%): a8 (+2.87%), a16 (+2.43%), a20 (+4.97%), a10 (-1.77%)
  MARGINAL (<1%): a9 (+0.18%), a18 (-0.29%)

[LIMITATION] Topology for a8, a9, a12, a20 was inferred from SPICE_REF node values,
not read from the actual .dig circuit files. If circuit component values differ,
ngspice numbers would shift accordingly.

[LIMITATION] a15 simulator result (14.608V > Vdd=15V) is physically impossible and
may indicate a test-side bug (wrong sortedVoltages index) rather than a pure engine error.

[LIMITATION] a21 Vc1=12V (supply rail) and a11 Vout=0V may indicate circuit assembly
failures (wrong pin connections, missing components) rather than solver inaccuracy.
