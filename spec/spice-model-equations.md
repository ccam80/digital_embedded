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