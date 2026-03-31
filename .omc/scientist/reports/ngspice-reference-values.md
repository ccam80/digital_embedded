# ngspice Reference Values for E2E Test Assertions

Generated: 2026-03-31
Tool: ngspice (batch mode) with analytical cross-verification

## Model Parameters Used

### MOSFET (from src/solver/analog/model-defaults.ts)
| Param  | NMOS       | PMOS       |
|--------|------------|------------|
| VTO    | 1.0 V      | -1.0 V     |
| KP     | 2e-5 A/V2  | 1e-5 A/V2  |
| LAMBDA | 0.01 /V    | 0.01 /V    |
| W      | 1e-6 m     | 1e-6 m     |
| L      | 1e-6 m     | 1e-6 m     |

### DAC (from src/components/active/dac.ts)
| Param | Value  |
|-------|--------|
| Rdac  | 100 ohm  |
| Vref  | 5.0 V  |

### Logic Family (from src/core/logic-family.ts)
| Family   | VOH  | VOL   | rOut | rIn  | cIn | cOut |
|----------|------|-------|------|------|-----|------|
| cmos-3v3 | 3.3V | 0V    | 50 ohm  | 10M ohm | 5pF | 5pF  |
| cmos-5v  | 5.0V | 0V    | 50 ohm  | 10M ohm | 5pF | 5pF  |
| ttl      | 5.0V | 0.35V | 80 ohm  | 4k ohm  | 5pF | 5pF  |

---

## A. CMOS AND2 Gate Voltages (Master 1 Phase C)

### Topology
CMOS NAND2 (2 parallel PMOS pull-up, 2 series NMOS pull-down) driving a CMOS inverter.
Matches CMOS_AND2_NETLIST in src/components/gates/and.ts:130.

### ngspice Netlist
```spice
CMOS AND2 Gate
.model nmod nmos (VTO=1.0 KP=2e-5 LAMBDA=0.01)
.model pmod pmos (VTO=-1.0 KP=1e-5 LAMBDA=0.01)
VDD vdd 0 5
VA in_a 0 {input_a}
VB in_b 0 {input_b}
* NAND2 stage
Mp1 vdd in_a nand_out vdd pmod W=1u L=1u
Mp2 vdd in_b nand_out vdd pmod W=1u L=1u
Mn1 nand_out in_a series_node 0 nmod W=1u L=1u
Mn2 series_node in_b 0 0 nmod W=1u L=1u
* Inverter stage
MpI vdd nand_out out vdd pmod W=1u L=1u
MnI out nand_out 0 0 nmod W=1u L=1u
.op
.end
```

### Results (VDD = 5V)

| Scenario         | Label               | V(out)          | V(nand_out)     |
|------------------|---------------------|-----------------|-----------------|
| Both HIGH (5,5)  | m1_cmos_and_high    | 5.000000e+00    | 2.505000e-07    |
| One LOW (5,0)    | m1_cmos_and_low     | 6.262500e-08    | 5.000000e+00    |
| Both LOW (0,0)   | m1_cmos_and_low_ll  | 6.262500e-08    | 5.000000e+00    |

Summary: Output is effectively VDD (5V) when both inputs are HIGH, and effectively 0V
when any input is LOW. The residual voltages (~60nV low, ~250nV at nand_out) are numerical
artifacts from MOSFET channel-length modulation (LAMBDA=0.01).

---

## B. Master 3 Transient Values

### Circuit Model
DAC Norton equivalent: current source I = Vdac * (1/Rdac) in parallel with conductance 1/Rdac to GND.
Thevenin equivalent: Vdac in series with Rdac = 100 ohm.

```
Vdac --[Rdac=100]-- rc_node --[R1]-- cap_pos --[C1]-- GND
```

Where Vdac = (code / 2^bits) * Vref.

**Key clarification on the contradictory values in the original spec**: The values 3.125V
and 2.841V refer to different nodes at different times:
- 2.841V is V(rc_node) at t ~ 0 (initial transient: max current flows through Rdac,
  causing a drop of 3.125 * 100/1100 = 0.284V)
- 3.125V is V(rc_node) at t = infinity (steady state: no current, no Rdac drop)

### ngspice Netlist Template
```spice
Vdac dac_int 0 {Vdac_value}
Rdac dac_int rc_node 100
R1 rc_node cap_pos {R1_value}
C1 cap_pos 0 1u IC=0
.tran 1u {sim_time} UIC
.measure tran v_rc FIND v(rc_node) AT={measure_time}
.measure tran v_cap FIND v(cap_pos) AT={measure_time}
.end
```

### m3_dc (Vref=5V, code=10, bits=4, R1=1k, C1=1uF)

Vdac = 10/16 * 5 = 3.125V, tau = (100+1000) * 1uF = 1.1ms

| Time    | v(vref)        | v(rc_node)     | v(cap_pos)     | v(vref2)       | Settle% |
|---------|----------------|----------------|----------------|----------------|---------|
| t=5ms   | 5.000000e+00   | 3.121984e+00   | 3.091827e+00   | 2.500000e+00   | 98.94%  |
| t=10ms  | 5.000000e+00   | 3.124968e+00   | 3.124648e+00   | 2.500000e+00   | 99.99%  |
| t=inf   | 5.000000e+00   | 3.125000e+00   | 3.125000e+00   | 2.500000e+00   | 100%    |

Analytical verification: v_cap(t) = 3.125 * (1 - exp(-t/1.1ms)) matches ngspice to 6+ decimal places.

### m3_vref33 (Vref=3.3V, code=10, bits=4, R1=1k, C1=1uF)

Vdac = 10/16 * 3.3 = 2.0625V, tau = 1.1ms

| Time    | v(vref)        | v(rc_node)     | v(cap_pos)     | v(vref2)       |
|---------|----------------|----------------|----------------|----------------|
| t=5ms   | 3.300000e+00   | 2.060510e+00   | 2.040606e+00   | 2.500000e+00   |
| t=10ms  | 3.300000e+00   | 2.062479e+00   | 2.062268e+00   | 2.500000e+00   |
| t=inf   | 3.300000e+00   | 2.062500e+00   | 2.062500e+00   | 2.500000e+00   |

Comparator: in- = 2.061V < in+ = 2.5V at t=5ms -> output HIGH -> counter counts.

### m3_r1_10k (Vref=3.3V, code=10, R1=10k, C1=1uF)

Vdac = 2.0625V, tau = (100+10000) * 1uF = 10.1ms

| Time     | v(rc_node)     | v(cap_pos)     | Settle% |
|----------|----------------|----------------|---------|
| t=50ms   | 2.062355e+00   | 2.047898e+00   | 99.29%  |
| t=100ms  | 2.062499e+00   | 2.062397e+00   | 99.99%  |
| t=inf    | 2.062500e+00   | 2.062500e+00   | 100%    |

---

## C. Pin Loading Voltage Delta (Master 2 Phase E)

### Loading Model
From src/solver/analog/bridge-adapter.ts and src/solver/analog/digital-pin-model.ts:
- BridgeInputAdapter stamps 1/rIn conductance from node to GND when loaded=true
- Default rIn = 10M ohm (from cmos-3v3 logic family)
- Also stamps cIn = 5pF (reactive, only matters in transient)

### Circuit: R1=R2=10k voltage divider, Vs=5V

```
Vs(5V) --[R1=10k]-- div --[R2=10k]-- GND
                      |
                   [rIn=10M] (pin loading)
                      |
                     GND
```

### ngspice Netlist
```spice
Pin Loading Loaded
Vs vs 0 5
R1 vs div 10k
R2 div 0 10k
Rload div 0 10Meg
.op
.end
```

### Results

| Mode     | V(div)         | Formula                              |
|----------|----------------|--------------------------------------|
| Unloaded | 2.500000e+00   | 5 * 10k/(10k+10k) = 2.5V           |
| Loaded   | 2.498751e+00   | 5 * (10k||10M)/(10k + 10k||10M)     |

**Delta: 1.249e-03 V (0.0500%)**

The loading effect is small because rIn (10M ohm) >> R2 (10k ohm).
The effective R2 changes from 10000 ohm to 9990.01 ohm.

---

## D. Pin Electrical / rOut Override (Master 2 Phase F / Master 3 Phase E)

### Model
Digital gate output = ideal voltage source (VOH or VOL) + series output resistance rOut.
When loaded, 1/rOut is stamped on the output node diagonal.

From src/core/logic-family.ts: default rOut = 50 ohm (cmos-3v3 and cmos-5v families).

### Circuit: Gate output driving a load resistor

```
V_source(VOH) --[rOut]-- junction --[Rload=10k]-- GND
```

V_junction = VOH * Rload / (rOut + Rload)

### ngspice Netlist
```spice
rOut Override
Voh source 0 {VOH}
Rout source junction {rOut}
Rload junction 0 10k
.op
.end
```

### Results (VOH = 5.0V, cmos-5v family, Rload=10k)

| rOut     | Label            | V_junction     | V_drop         |
|----------|------------------|----------------|----------------|
| 50 ohm   | rout_default     | 4.975124e+00   | 2.487600e-02   |
| 75 ohm   | rout_75          | 4.962779e+00   | 3.722100e-02   |
| 100k ohm | rout_100k        | 4.545455e-01   | 4.545454e+00   |

### Results (VOH = 3.3V, cmos-3v3 family, Rload=10k)

| rOut     | Label            | V_junction     | V_drop         |
|----------|------------------|----------------|----------------|
| 50 ohm   | rout_default_3v3 | 3.283582e+00   | 1.641800e-02   |
| 75 ohm   | rout_75_3v3      | 3.275434e+00   | 2.456600e-02   |
| 100k ohm | rout_100k_3v3    | 3.000000e-01   | 3.000000e+00   |

Analytical verification: V_junction = VOH * RL / (rOut + RL) matches ngspice to 6 decimal places.

---

## Assumptions and Notes

1. **MOSFET W/L**: Both set to 1um/1um as per model-defaults.ts. The CMOS_AND2_NETLIST
   does not override W/L, so subcircuit elements inherit the model defaults.

2. **DAC Norton model**: The DAC stamps G_out = 1/Rdac on the OUT node diagonal and
   I = Vdac * G_out on the RHS. Mathematically equivalent to Thevenin source Vdac in
   series with Rdac. The ngspice Thevenin model produces identical results.

3. **Pin loading mode**: "Loaded" stamps 1/rIn (conductance to ground) and cIn (companion
   model for transient). At DC operating point, only the resistive loading matters.

4. **rOut override**: The bridge output adapter stamps an ideal voltage source branch
   equation (V_node = VOH or VOL) plus, when loaded, 1/rOut on the node diagonal.
   Equivalent to Thevenin source with output resistance.

5. **Transient settling at t=5ms**: With tau=1.1ms, the RC circuit is 98.94% settled.
   For 0.1% tolerance assertions, the test should either use t>=10ms (99.99% settled)
   or assert against the actual transient values at t=5ms. The ngspice values at t=5ms
   are the correct reference if that is the test simulation time.

6. **Which node is "RC node" in E2E tests?**: In Master 3, the probe P_DAC is connected
   to the DAC output junction (between Rdac and R1). This corresponds to v(rc_node) in
   the ngspice model, NOT v(cap_pos).
