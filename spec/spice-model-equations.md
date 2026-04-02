# SPICE Semiconductor Model Equations and Default Parameters

Reference: ngspice-41 (authoritative parameter dumps)
Generated: 2026-04-02

---

## 1. MOSFET (MOS Level 1) -- Shichman-Hodges Model

### 1.1 Default Parameters (ngspice-41)

NMOS and PMOS Level 1 share the same parameter set and defaults (except type).

| Parameter | Name | Default | Unit | Description |
|-----------|------|---------|------|-------------|
| VTO | Threshold voltage | 0 | V | Zero-bias threshold voltage |
| KP | Transconductance | 2e-5 | A/V^2 | Process transconductance parameter |
| GAMMA | Bulk threshold | 0 | V^0.5 | Body-effect parameter |
| PHI | Surface potential | 0.6 | V | Surface inversion potential |
| LAMBDA | Channel-length modulation | 0 | 1/V | Output conductance parameter |
| RD | Drain resistance | 0 | ohm | Ohmic drain resistance |
| RS | Source resistance | 0 | ohm | Ohmic source resistance |
| CBD | B-D capacitance | 0 | F | Zero-bias bulk-drain junction capacitance |
| CBS | B-S capacitance | 0 | F | Zero-bias bulk-source junction capacitance |
| IS | Bulk jct sat current | 1e-14 | A | Bulk junction saturation current |
| PB | Bulk jct potential | 0.8 | V | Bulk junction contact potential |
| CGSO | Gate-source overlap cap | 0 | F/m | Gate-source overlap capacitance per unit W |
| CGDO | Gate-drain overlap cap | 0 | F/m | Gate-drain overlap capacitance per unit W |
| CGBO | Gate-bulk overlap cap | 0 | F/m | Gate-bulk overlap capacitance per unit L |
| RSH | Sheet resistance | 0 | ohm/sq | Drain/source diffusion sheet resistance |
| CJ | Bottom jct cap | 0 | F/m^2 | Zero-bias bulk jct bottom cap per unit area |
| MJ | Bottom grading coeff | 0.5 | - | Bulk junction bottom grading coefficient |
| CJSW | Sidewall jct cap | 0 | F/m | Zero-bias bulk jct sidewall cap per unit perimeter |
| MJSW | Sidewall grading coeff | 0.5 | - | Bulk junction sidewall grading coefficient |
| JS | Bulk jct sat current dens | 0 | A/m^2 | Bulk junction saturation current density |
| TOX | Oxide thickness | 0 | m | Thin oxide thickness (0 = KP used directly) |
| LD | Lateral diffusion | 0 | m | Lateral diffusion length |
| U0 | Surface mobility | 0 | cm^2/V-s | Surface mobility (0 = not used, KP used directly) |
| FC | Fwd-bias cap coeff | 0.5 | - | Coefficient for forward-bias depletion capacitance |
| NSUB | Substrate doping | 0 | 1/cm^3 | Substrate doping concentration |
| TPG | Gate type | 0 | - | Gate material: +1 opposite, -1 same, 0 aluminum |
| NSS | Surface state density | 0 | 1/cm^2 | Surface state density |
| TNOM | Nominal temperature | 27 | degC | Parameter measurement temperature |
| KF | Flicker noise coeff | 0 | - | Flicker noise coefficient |
| AF | Flicker noise exp | 1 | - | Flicker noise exponent |

### 1.2 Level 1 Equations (Shichman-Hodges / Square Law)

The effective gate voltage and threshold with body effect:

    Vth = VTO + GAMMA * (sqrt(PHI - Vbs) - sqrt(PHI))   (body effect)
    Vov = Vgs - Vth                                      (overdrive voltage)

**Cutoff region** (Vgs < Vth):

    Ids = 0

**Linear (triode) region** (Vgs >= Vth, Vds < Vov):

    Ids = KP * (W/L) * [(Vgs - Vth) * Vds - 0.5 * Vds^2] * (1 + LAMBDA * Vds)

**Saturation region** (Vgs >= Vth, Vds >= Vov):

    Ids = 0.5 * KP * (W/L) * (Vgs - Vth)^2 * (1 + LAMBDA * Vds)

Effective channel length:

    Leff = L - 2 * LD

If TOX is specified and KP is not overridden:

    KP = U0 * epsilon_ox / TOX
    where epsilon_ox = 3.9 * 8.854e-12 F/m

**Meyer capacitance model** is used for gate capacitances (Cgs, Cgd, Cgb) as functions of operating region.

---

## 2. MOSFET (MOS Level 2) -- Grove-Frohman Model

### 2.1 Default Parameters (ngspice-41)

Level 2 includes all Level 1 parameters plus additional ones for short-channel effects.
Parameters that differ from Level 1 defaults are marked with (**).

| Parameter | Name | Default | Unit | Description |
|-----------|------|---------|------|-------------|
| VTO | Threshold voltage | 0 | V | Zero-bias threshold voltage |
| KP | Transconductance | 2.07189e-5 (**) | A/V^2 | Computed from U0 and TOX |
| GAMMA | Bulk threshold | 0 | V^0.5 | Body-effect parameter |
| PHI | Surface potential | 0.6 | V | Surface inversion potential |
| LAMBDA | Channel-length modulation | 0 | 1/V | Output conductance parameter |
| RD | Drain resistance | 0 | ohm | Ohmic drain resistance |
| RS | Source resistance | 0 | ohm | Ohmic source resistance |
| CBD | B-D capacitance | 0 | F | Zero-bias bulk-drain junction capacitance |
| CBS | B-S capacitance | 0 | F | Zero-bias bulk-source junction capacitance |
| IS | Bulk jct sat current | 1e-14 | A | Bulk junction saturation current |
| PB | Bulk jct potential | 0.8 | V | Bulk junction contact potential |
| CGSO | Gate-source overlap cap | 0 | F/m | Gate-source overlap capacitance per unit W |
| CGDO | Gate-drain overlap cap | 0 | F/m | Gate-drain overlap capacitance per unit W |
| CGBO | Gate-bulk overlap cap | 0 | F/m | Gate-bulk overlap capacitance per unit L |
| RSH | Sheet resistance | 0 | ohm/sq | Drain/source diffusion sheet resistance |
| CJ | Bottom jct cap | 0 | F/m^2 | Zero-bias bulk jct bottom cap per unit area |
| MJ | Bottom grading coeff | 0.5 | - | Bulk junction bottom grading coefficient |
| CJSW | Sidewall jct cap | 0 | F/m | Zero-bias bulk jct sidewall cap per unit perimeter |
| MJSW | Sidewall grading coeff | 0.33 (**) | - | Bulk junction sidewall grading coefficient |
| JS | Bulk jct sat current dens | 0 | A/m^2 | Bulk junction saturation current density |
| TOX | Oxide thickness | 1e-7 (**) | m | Thin oxide thickness (100nm default) |
| LD | Lateral diffusion | 0 | m | Lateral diffusion length |
| U0 | Surface mobility | 600 (**) | cm^2/V-s | Surface mobility |
| FC | Fwd-bias cap coeff | 0.5 | - | Coefficient for forward-bias depletion capacitance |
| NSUB | Substrate doping | 0 | 1/cm^3 | Substrate doping concentration |
| TPG | Gate type | 0 | - | Type of gate material |
| NSS | Surface state density | 0 | 1/cm^2 | Surface state density |
| **DELTA** | Narrow-width effect | 0 | - | Width effect on threshold voltage |
| **UEXP** | Mobility degradation exp | 0 | - | Critical field exponent for mobility degradation |
| **UCRIT** | Critical field | 10000 | V/cm | Critical electric field for mobility degradation |
| **VMAX** | Max carrier drift velocity | 0 | m/s | Maximum drift velocity (0 = not used) |
| **XJ** | Junction depth | 0 | m | Metallurgical junction depth |
| **NEFF** | Channel charge coeff | 1 | - | Total channel charge coefficient |
| **NFS** | Fast surface state density | 0 | 1/cm^2 | Fast surface state density |
| KF | Flicker noise coeff | 0 | - | Flicker noise coefficient |
| AF | Flicker noise exp | 1 | - | Flicker noise exponent |

### 2.2 Level 2 Equations (Key Differences from Level 1)

Level 2 replaces the simple square-law with a more physical model:

**Threshold voltage with narrow-width and short-channel effects:**

    Vth = VFB + PHI + GAMMA * sqrt(PHI - Vbs) - dVth_short - dVth_narrow

Where VFB is the flat-band voltage, and the short-channel correction uses XJ.

**Mobility degradation (velocity saturation):**

    If UEXP > 0:
      u_eff = U0 * (UCRIT / Eeff)^UEXP       (field-dependent mobility)

    If VMAX > 0:
      Ids = Ids_long / (1 + Vds / (VMAX * Leff))

**Subthreshold conduction** (weak inversion, when NFS > 0):

    Von = Vth + kT/q * (1 + q * NFS / Cox + Cd/Cox)
    For Vgs < Von:
      Ids = Ids(Von) * exp((Vgs - Von) / (n * Vt))
    where n = 1 + q * NFS / Cox + Cd/Cox

**Saturation voltage:**

    If VMAX = 0: Vdsat = Vgs - Vth  (same as L1)
    If VMAX > 0: Vdsat determined by velocity saturation

**Channel-length modulation** uses a physical drain depletion model
rather than the simple (1 + LAMBDA * Vds) factor.

**Drain current (linear region, Grove-Frohman):**

    Ids = (W/Leff) * u_eff * Cox * [(Vgs - Vth - Vds/2) * Vds
          - (2/3) * GAMMA * ((Vds - Vbs + PHI)^1.5 - (-Vbs + PHI)^1.5)]

This uses the exact charge-sheet integral rather than the linearized approximation of Level 1.

---

## 3. BJT -- Gummel-Poon Model

ngspice implements the standard Gummel-Poon (GP) model for BJTs.
The simplified Ebers-Moll model is a subset obtained when GP-specific
parameters are zero (VAF=0, VAR=0, IKF=0, IKR=0, ISE=0, ISC=0).

### 3.1 Default Parameters (ngspice-41)

NPN and PNP share the same defaults except type and quasi-saturation constants (CN, D).

#### Core DC Parameters

| Parameter | Name | Default | Unit | Description |
|-----------|------|---------|------|-------------|
| IS | Transport sat current | 1e-16 | A | Transport saturation current |
| IBE | B-E leakage | 0 | A | ngspice extension |
| IBC | B-C leakage | 0 | A | ngspice extension |
| BF | Forward current gain | 100 | - | Ideal maximum forward beta |
| NF | Forward emission coeff | 1 | - | Forward current emission coefficient |
| VAF | Forward Early voltage | 0 | V | Forward Early voltage (0 = infinity) |
| IKF | Forward knee current | 0 | A | Corner for BF high-current roll-off (0 = inf) |
| ISE | B-E leakage sat current | 0 | A | B-E leakage saturation current |
| NE | B-E leakage emission coeff | 1.5 | - | B-E leakage emission coefficient |
| BR | Reverse current gain | 1 | - | Ideal maximum reverse beta |
| NR | Reverse emission coeff | 1 | - | Reverse current emission coefficient |
| VAR | Reverse Early voltage | 0 | V | Reverse Early voltage (0 = infinity) |
| IKR | Reverse knee current | 0 | A | Corner for BR high-current roll-off (0 = inf) |
| ISC | B-C leakage sat current | 0 | A | B-C leakage saturation current |
| NC | B-C leakage emission coeff | 2 | - | B-C leakage emission coefficient |
| NKF | High-current BF rolloff | 0.5 | - | High-current beta rolloff exponent |

#### Parasitic Resistances

| Parameter | Name | Default | Unit | Description |
|-----------|------|---------|------|-------------|
| RB | Zero-bias base resistance | 0 | ohm | Zero-bias (maximum) base resistance |
| IRB | Base resistance knee current | 0 | A | Current where RB falls halfway to RBM |
| RBM | Minimum base resistance | 0 | ohm | Minimum base resistance at high currents |
| RE | Emitter resistance | 0 | ohm | Emitter ohmic resistance |
| RC | Collector resistance | 0 | ohm | Collector ohmic resistance |

#### Junction Capacitances

| Parameter | Name | Default | Unit | Description |
|-----------|------|---------|------|-------------|
| CJE | B-E zero-bias cap | 0 | F | B-E zero-bias depletion capacitance |
| VJE | B-E built-in potential | 0.75 | V | B-E built-in potential |
| MJE | B-E grading factor | 0.33 | - | B-E junction exponential factor |
| CJC | B-C zero-bias cap | 0 | F | B-C zero-bias depletion capacitance |
| VJC | B-C built-in potential | 0.75 | V | B-C built-in potential |
| MJC | B-C grading factor | 0.33 | - | B-C junction exponential factor |
| XCJC | CJC fraction to int base | 1 | - | Fraction of CJC to internal base node |
| CJS | Collector-substrate cap | 0 | F | Zero-bias collector-substrate capacitance |
| VJS | Substrate built-in potential | 0.75 | V | Substrate junction built-in potential |
| MJS | Substrate grading factor | 0 | - | Substrate junction exponential factor |

#### Transit Time

| Parameter | Name | Default | Unit | Description |
|-----------|------|---------|------|-------------|
| TF | Forward transit time | 0 | s | Ideal forward transit time |
| XTF | TF bias dependence coeff | 0 | - | Coefficient for bias dependence of TF |
| VTF | TF voltage dependence | 0 | V | Voltage describing VBC dependence of TF |
| ITF | TF high-current param | 0 | A | High-current parameter for TF dependence |
| PTF | Excess phase | 0 | deg | Excess phase at frequency 1/(2*pi*TF) |
| TR | Reverse transit time | 0 | s | Ideal reverse transit time |

#### Temperature and Noise

| Parameter | Name | Default | Unit | Description |
|-----------|------|---------|------|-------------|
| TNOM | Nominal temperature | 27 | degC | Parameter measurement temperature |
| XTB | Beta temp exponent | 0 | - | Forward and reverse beta temperature exponent |
| EG | Energy gap | 1.11 | eV | Energy gap for temperature effect on IS |
| XTI | IS temp exponent | 3 | - | Temperature exponent for IS |
| FC | Fwd-bias cap coeff | 0.5 | - | Coefficient for forward-bias depletion capacitance |
| KF | Flicker noise coeff | 0 | - | Flicker noise coefficient |
| AF | Flicker noise exp | 0 | - | Flicker noise exponent |

#### Substrate and Quasi-saturation (ngspice extensions)

| Parameter | Name | Default (NPN) | Default (PNP) | Unit | Description |
|-----------|------|---------------|---------------|------|-------------|
| ISS | Substrate sat current | 0 | 0 | A | Substrate p-n saturation current |
| NS | Substrate emission coeff | 1 | 1 | - | Substrate p-n emission coefficient |
| RCO | Epi-collector resistance | 0.01 | 0.01 | ohm | Epitaxial collector resistance |
| VO | Epi-collector voltage | 10 | 10 | V | Epi-collector carrier velocity scattering voltage |
| GAMMA | Epi-collector doping | 1e-11 | 1e-11 | - | Epitaxial region doping factor |
| QCO | Epi-collector charge | 0 | 0 | C | Epitaxial region charge factor |
| QUASIMOD | Quasi-saturation flag | 0 | 0 | - | Enable quasi-saturation model (0=off) |
| VG | Bandgap voltage | 1.206 | 1.206 | V | Bandgap voltage (quasi-sat model) |
| CN | Quasi-sat constant | 2.42 | 2.2 | - | Quasi-saturation temperature constant |
| D | Quasi-sat constant | 0.87 | 0.52 | - | Quasi-saturation temperature constant |

#### Temperature Coefficient Parameters (all default 0)

    TBF1, TBF2, TBR1, TBR2, TIKF1, TIKF2, TIKR1, TIKR2, TIRB1, TIRB2,
    TNC1, TNC2, TNE1, TNE2, TNF1, TNF2, TNR1, TNR2, TRB1, TRB2,
    TRC1, TRC2, TRE1, TRE2, TRM1, TRM2, TVAF1, TVAF2, TVAR1, TVAR2,
    CTC, CTE, CTS, TVJC, TVJE, TVJS, TITF1, TITF2, TTF1, TTF2,
    TTR1, TTR2, TMJE1, TMJE2, TMJC1, TMJC2, TMJS1, TMJS2, TNS1, TNS2,
    TIS1, TIS2, TISE1, TISE2, TISC1, TISC2, TISS1, TISS2

#### SOA Limits (all default 1e+99 except RTH0=0)

    VBE_MAX, VBC_MAX, VCE_MAX, PD_MAX, IC_MAX, IB_MAX, TE_MAX, RTH0

### 3.2 Ebers-Moll (Simplified) Equations

When VAF=0, VAR=0, IKF=0, IKR=0, ISE=0, ISC=0, the GP model reduces to Ebers-Moll.

**Terminal currents:**

    Vt = kT/q                                 (thermal voltage, ~26mV at 27C)

    Ibe = (IS/BF) * (exp(Vbe/(NF*Vt)) - 1)   (base-emitter diode)
    Ibc = (IS/BR) * (exp(Vbc/(NR*Vt)) - 1)   (base-collector diode)

    Ic = IS * (exp(Vbe/(NF*Vt)) - 1) - (IS/BR) * (exp(Vbc/(NR*Vt)) - 1)
    Ib = (IS/BF) * (exp(Vbe/(NF*Vt)) - 1) + (IS/BR) * (exp(Vbc/(NR*Vt)) - 1)
    Ie = -(Ic + Ib)

In the normal active region (Vbe > 0, Vbc < 0):

    Ic ~ IS * exp(Vbe/(NF*Vt))
    Ib ~ (IS/BF) * exp(Vbe/(NF*Vt))
    Ic/Ib ~ BF

### 3.3 Gummel-Poon (Full SPICE) Equations

The GP model adds base-width modulation (Early effect), high-current effects,
and non-ideal base current components.

**Normalized base charge factor (qb):**

    q1 = 1 / (1 - Vbc/VAF - Vbe/VAR)          (Early effect)

    q2 = IS * (exp(Vbe/(NF*Vt)) - 1) / IKF    (forward high-current)
       + IS * (exp(Vbc/(NR*Vt)) - 1) / IKR    (reverse high-current)

    qb = q1/2 * (1 + sqrt(1 + 4*q2))          (normalized base charge)

When VAF=0: that term is omitted (infinite Early voltage).
When IKF=0: that term is omitted (no high-current rolloff).

**Transport current:**

    Ic_transport = IS * (exp(Vbe/(NF*Vt)) - exp(Vbc/(NR*Vt))) / qb

**Base current (with non-ideal components):**

    Ib = IS/BF * (exp(Vbe/(NF*Vt)) - 1)       (ideal B-E)
       + ISE * (exp(Vbe/(NE*Vt)) - 1)         (non-ideal B-E leakage)
       + IS/BR * (exp(Vbc/(NR*Vt)) - 1)       (ideal B-C)
       + ISC * (exp(Vbc/(NC*Vt)) - 1)         (non-ideal B-C leakage)

**Collector current:**

    Ic = IS/qb * (exp(Vbe/(NF*Vt)) - exp(Vbc/(NR*Vt)))
         - 1/BR * (exp(Vbc/(NR*Vt)) - 1)

**Effective beta (forward active):**

    BF_eff = BF / qb

Beta decreases at high currents (IKF effect) and increases with Vce (Early effect).

**Base resistance modulation:**

    If IRB = 0:  Rb = RBM + (RB - RBM) / qb
    If IRB > 0:  Rb = RBM + 3*(RB-RBM)*(tan(z)-z) / (z*tan(z)^2)
                 where z depends on Ib/IRB

**Junction capacitances:**

    For Vbe < FC * VJE:
      Cbe = CJE / (1 - Vbe/VJE)^MJE + TF * gm
    For Vbe >= FC * VJE:
      Cbe = CJE/(1-FC)^(1+MJE) * (1 - FC*(1+MJE) + MJE*Vbe/VJE) + TF*gm

    (Same form for Cbc using CJC, VJC, MJC, TR)

**Forward transit time (bias-dependent):**

    TF_eff = TF * (1 + XTF * (Ic/(Ic + ITF))^2 * exp(Vbc/(1.44*VTF)))

---

## 4. Diode -- Standard SPICE Junction Diode Model

### 4.1 Default Parameters (ngspice-41)

| Parameter | Name | Default | Unit | Description |
|-----------|------|---------|------|-------------|
| LEVEL | Model level | 1 | - | Diode model level |
| IS | Saturation current | 1e-14 | A | Saturation current |
| JSW | Sidewall sat current | 0 | A/m | Sidewall saturation current density |
| RS | Series resistance | 0 | ohm | Ohmic series resistance |
| TRS | RS temp coeff (linear) | 0 | 1/degC | Linear temperature coefficient for RS |
| TRS2 | RS temp coeff (quad) | 0 | 1/degC^2 | Quadratic temperature coefficient for RS |
| N | Emission coefficient | 1 | - | Emission coefficient (ideality factor) |
| NS | Sidewall emission coeff | 1 | - | Sidewall emission coefficient |
| TT | Transit time | 0 | s | Transit time (charge storage) |
| TTT1 | TT linear temp coeff | 0 | 1/degC | Linear temperature coefficient for TT |
| TTT2 | TT quadratic temp coeff | 0 | 1/degC^2 | Quadratic temperature coefficient for TT |
| CJO | Zero-bias jct cap | 0 | F | Zero-bias junction capacitance |
| VJ | Junction potential | 1 | V | Junction built-in potential |
| M | Grading coefficient | 0.5 | - | Junction grading coefficient |
| TM1 | M linear temp coeff | 0 | 1/degC | Linear temperature coefficient for M |
| TM2 | M quadratic temp coeff | 0 | 1/degC^2 | Quadratic temperature coefficient for M |
| CJP | Sidewall zero-bias cap | 0 | F | Sidewall zero-bias junction capacitance |
| PHP | Sidewall jct potential | 1 | V | Sidewall junction built-in potential |
| MJSW | Sidewall grading coeff | 0.33 | - | Sidewall junction grading coefficient |
| IKF | Forward knee current | 0 | A | High-injection knee current (0 = disabled) |
| IKR | Reverse knee current | 0 | A | Reverse high-injection knee current |
| NBV | Rev breakdown emission | 1 | - | Reverse breakdown emission coefficient |
| AREA | Device area factor | 1 | - | Area multiplier |
| PJ | Device perimeter | 0 | m | Junction perimeter |
| EG | Energy gap | 1.11 | eV | Activation energy (bandgap) |
| XTI | IS temp exponent | 3 | - | Saturation current temperature exponent |
| CTA | CJO temp coeff | 0 | 1/degC | Area junction cap temperature coefficient |
| CTP | CJP temp coeff | 0 | 1/degC | Perimeter junction cap temperature coefficient |
| TPB | VJ temp coeff | 0 | V/degC | Junction potential temperature coefficient |
| TPHP | PHP temp coeff | 0 | V/degC | Sidewall junction potential temperature coefficient |
| FC | Fwd-bias cap coeff | 0.5 | - | Coefficient for forward-bias depletion capacitance |
| FCS | Sidewall fwd-bias cap coeff | 0.5 | - | Coefficient for forward-bias sidewall capacitance |
| BV | Rev breakdown voltage | 0 | V | Reverse breakdown voltage (0 = disabled) |
| IBV | Current at BV | 0.001 | A | Current at reverse breakdown voltage |
| TCV | BV temp coefficient | 0 | V/degC | Breakdown voltage temperature coefficient |
| ISR | Recombination current | 1e-14 | A | Recombination current parameter |
| NR | Recombination emission coeff | 2 | - | Emission coefficient for ISR |
| KF | Flicker noise coeff | 0 | - | Flicker noise coefficient |
| AF | Flicker noise exp | 1 | - | Flicker noise exponent |
| JTUN | Tunnel current density | 0 | A/m^2 | Band-to-band tunnel current density |
| JTUNSW | Sidewall tunnel current | 0 | A/m^2 | Sidewall tunnel current density |
| NTUN | Tunnel emission coeff | 30 | - | Tunnel current emission coefficient |
| XTITUN | Tunnel current temp exp | 3 | - | Tunnel current temperature exponent |
| KEG | EG correction factor | 1 | - | EG correction factor for tunnel current |

#### SOA and Thermal (all default 1e+99 except RTH0=0, CTH0=1e-5)

    FV_MAX, BV_MAX, ID_MAX, TE_MAX, PD_MAX, RTH0, CTH0

#### Geometry Parameters (all default 0 except XOM=1e-6, XOI=1e-6)

    LM, LP, WM, WP, XOM, XOI, XM, XP

### 4.2 Diode Equations

**DC current (Shockley equation with extensions):**

    Vt = kT/q                                     (thermal voltage)

    Id = AREA * IS * (exp(Vd/(N*Vt)) - 1)         (ideal diode current)
       + AREA * ISR * (exp(Vd/(NR*Vt)) - 1)       (recombination current)

With high-injection (IKF > 0):

    Id_hj = Id / sqrt(1 + Id/IKF)                 (high-injection correction)

**Terminal voltage:**

    V = Vd + Id * RS                               (includes series resistance)

**Reverse breakdown (when BV > 0):**

    For Vd < -BV:
      Id = -AREA * IS * exp(-(BV + Vd)/Vt)        (soft breakdown)

**Junction capacitance (depletion):**

    For Vd < FC * VJ:
      Cj = AREA * CJO / (1 - Vd/VJ)^M

    For Vd >= FC * VJ:
      Cj = AREA * CJO / (1-FC)^(1+M) * (1 - FC*(1+M) + M*Vd/VJ)

The same form applies for sidewall capacitance using CJP, PHP, MJSW, FCS.

**Diffusion capacitance (charge storage):**

    Cd = TT * dId/dVd = TT * gd                   (transit time charge storage)

where gd = AREA * IS / (N*Vt) * exp(Vd/(N*Vt)) is the junction conductance.

**Total capacitance:**

    C_total = Cj + Cd                              (depletion + diffusion)

**Temperature dependence:**

    IS(T) = IS * (T/TNOM)^(XTI/N) * exp(-EG/Vt * (1 - TNOM/T))
    VJ(T) = VJ * T/TNOM - 3*Vt*ln(T/TNOM) - EG(TNOM)*TNOM/T + EG(T)
    CJO(T) = CJO * (1 + M * (0.0004*(T-TNOM) + (1 - VJ(T)/VJ)))

---

## 5. Summary: Ebers-Moll vs Gummel-Poon

| Feature | Ebers-Moll (EM) | Gummel-Poon (GP) |
|---------|-----------------|-------------------|
| Base-width modulation (Early) | No (VAF=VAR=0) | Yes (VAF, VAR) |
| High-injection rolloff | No (IKF=IKR=0) | Yes (IKF, IKR, NKF) |
| Non-ideal base current | No (ISE=ISC=0) | Yes (ISE, NE, ISC, NC) |
| Base charge normalization | qb = 1 | qb = f(Early, injection) |
| Base resistance modulation | Constant RB | RB varies with qb or IRB |
| Transit time bias dependence | Constant TF | TF = f(Ic, Vbc) via XTF, VTF, ITF |
| Accuracy | Low-to-moderate current | Full operating range |

Setting all GP-specific parameters to zero/infinity in ngspice automatically
reduces the GP model to Ebers-Moll behavior. There is no separate "level"
flag for BJTs -- it is a single model with optional complexity.

## 6. Summary: MOSFET Level 1 vs Level 2

| Feature | Level 1 (Shichman-Hodges) | Level 2 (Grove-Frohman) |
|---------|---------------------------|-------------------------|
| Current equation | Square-law approximation | Exact charge-sheet integral |
| Mobility | Constant (KP) | Field-dependent (U0, UCRIT, UEXP) |
| Velocity saturation | No | Yes (VMAX) |
| Subthreshold | No | Yes (NFS) |
| Narrow-width effect | No | Yes (DELTA) |
| Short-channel Vth | No | Yes (XJ) |
| Channel-length modulation | Simple lambda*Vds | Physical drain depletion model |
| Default TOX | 0 (unused) | 1e-7 m (100nm) |
| Default U0 | 0 (unused) | 600 cm^2/V-s |
| KP default | 2e-5 exact | 2.07189e-5 (derived from U0/TOX) |
| Additional params | -- | DELTA, UEXP, UCRIT, VMAX, XJ, NEFF, NFS |