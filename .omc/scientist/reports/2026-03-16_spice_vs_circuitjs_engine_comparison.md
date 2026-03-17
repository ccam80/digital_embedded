# SPICE Engine vs CircuitJS MNA Solver: Rigorous Technical Comparison

**Date:** 2026-03-16
**Objective:** Identify the exact algorithmic and architectural gaps between production SPICE engines (ngspice/HSPICE/LTspice) and CircuitJS's MNA solver, with severity ratings for educational, hobbyist, and production use.

---

## Executive Summary

CircuitJS implements approximately 10-15% of a production SPICE engine's algorithmic capability. Its limitations are not primarily about device models -- they are deep in the **engine itself**: the matrix solver, convergence infrastructure, timestep control, and integration methods. The table below summarizes every major gap.

| Gap Area | SPICE | CircuitJS | Educational | Hobbyist | Production |
|----------|-------|-----------|-------------|----------|------------|
| Analysis types | 9+ (DC/AC/TRAN/NOISE/SENS/TF/PZ/MONTE/WORST) | 1 (TRAN only) | IMPORTANT | CRITICAL | CRITICAL |
| Matrix solver | Sparse direct (KLU), O(n) for typical circuits | Dense LU, O(n^3) | minor | IMPORTANT | CRITICAL |
| Convergence aids | 6+ algorithms (Gmin, source, PTA, damped NR, pnjlim, fetlim) | Basic NR + halve timestep | IMPORTANT | CRITICAL | CRITICAL |
| Timestep control | LTE-based adaptive | Halve on failure, double after 3 good steps | IMPORTANT | CRITICAL | CRITICAL |
| Integration methods | Trapezoidal + Gear/BDF orders 1-6 + BE startup | Trapezoidal/BE only | minor | IMPORTANT | CRITICAL |
| Device model infra | .MODEL/.SUBCKT/binning/corners/Monte Carlo/temp | Fixed ideal models | minor | IMPORTANT | CRITICAL |
| Parasitic extraction | Post-layout RC/RLC back-annotation | None | N/A | N/A | CRITICAL |
| Numerical precision | pnjlim/fetlim, Vcrit, log-domain exponentials | Naive exp() evaluation | minor | IMPORTANT | CRITICAL |
| Matrix ordering | Markowitz/AMD/COLAMD fill-in minimization | None (dense) | N/A | IMPORTANT | CRITICAL |
| Condition monitoring | Pivot monitoring, singular matrix recovery | Fatal abort on singular | minor | IMPORTANT | CRITICAL |

---

## 1. Analysis Types

### What SPICE Provides

**`.DC` -- DC Operating Point & Sweep**
Solves the nonlinear algebraic system F(x) = 0 with all capacitors open-circuited and inductors short-circuited. Finds the quiescent operating point of every node. DC sweep repeats this over a parameter range. This is the foundation -- every other analysis starts from the DC operating point.

**`.AC` -- Small-Signal AC (Frequency Domain)**
Linearizes all nonlinear devices around the DC operating point, producing a linear system Y(s)*V = I. Sweeps frequency (s = jw) and solves the complex linear system at each frequency. Outputs magnitude/phase (Bode plots), group delay. Essential for amplifier design (gain, bandwidth, phase margin, stability).

**`.TRAN` -- Transient Analysis**
Time-domain integration of the full nonlinear DAE system. Uses numerical integration (trapezoidal/Gear) with adaptive timestep controlled by local truncation error. The only analysis CircuitJS implements.

**`.NOISE` -- Noise Analysis**
Computes device-generated noise (thermal, shot, flicker/1-f) for every device at every frequency point. Propagates noise through the linearized network to an output port. Reports equivalent input-referred noise, output noise spectral density, and per-device noise contributions. Critical for analog design (LNA, ADC, sensor interfaces).

**`.SENS` -- Sensitivity Analysis**
Computes partial derivatives of an output variable with respect to every circuit parameter and model parameter. DC sensitivity (dVout/dR1) and AC sensitivity (d|Vout|/dR1 at each frequency). Identifies which components most affect performance -- essential for tolerance analysis.

**`.TF` -- Small-Signal Transfer Function**
Computes DC small-signal transfer function (Vout/Vin), input resistance, and output resistance. A lightweight alternative to full AC analysis for DC gain calculations.

**`.PZ` -- Pole-Zero Analysis**
Computes the poles and zeros of the small-signal AC transfer function directly (not from frequency sweep). Uses the QZ algorithm on the linearized state-space system. Critical for stability analysis -- poles in the right half-plane mean oscillation.

**`.MONTE` -- Monte Carlo Statistical Analysis**
Runs hundreds/thousands of simulations with randomly varied device parameters (Gaussian or uniform distributions). Produces statistical distributions of circuit performance metrics. Used for yield estimation: "What percentage of manufactured circuits will meet spec?"

**`.WORST` -- Worst-Case Analysis**
Uses sensitivity data to find the combination of parameter variations that produces the worst possible performance. More efficient than Monte Carlo for finding guaranteed bounds, but can be overly pessimistic because it assumes all worst-case parameters coincide.

### What CircuitJS Has

Transient analysis only. No frequency-domain analysis, no operating point solver (it finds DC by running transient to steady-state), no noise, no sensitivity, no statistical analysis.

### Severity Ratings

| Rating | Justification |
|--------|--------------|
| **IMPORTANT for education** | Students need AC analysis to understand frequency response, Bode plots, and stability. Teaching these from transient waveforms alone is extremely awkward. DC operating point is also pedagogically important for biasing. |
| **CRITICAL for hobbyist** | Without AC analysis, you cannot design a filter, check amplifier stability, or verify loop gain. Without noise analysis, any low-signal design is guesswork. |
| **CRITICAL for production** | Monte Carlo and worst-case are non-negotiable for tape-out. |

---

## 2. Matrix Solver Quality

### SPICE: Sparse Direct Solvers

Production SPICE uses sparse direct LU factorization. ngspice uses **KLU** (Algorithm 907, ACM TOMS), which implements:

1. **Block Triangular Form (BTF) permutation**: Decomposes the circuit matrix into independent diagonal blocks via Duff's algorithm. Each block is factored independently -- blocks that haven't changed between iterations can be skipped entirely.

2. **Fill-in minimizing ordering**: Before factoring each block, KLU applies AMD (Approximate Minimum Degree) or COLAMD ordering to minimize fill-in (new nonzeros created during elimination). For a typical circuit with n nodes and O(n) nonzeros, this keeps the factor cost at O(n) rather than O(n^3).

3. **Gilbert-Peierls left-looking algorithm**: Computes each column of L on demand, using a sparse triangular solve. Only touches nonzero entries. Memory-efficient and cache-friendly for the irregular sparsity patterns of circuit matrices.

4. **Markowitz pivoting with numerical thresholds**: Chooses pivots that balance sparsity preservation (low Markowitz count = product of nonzeros in pivot row and column) against numerical stability (pivot must exceed a threshold fraction of the column maximum). The threshold parameter trades off fill-in against accuracy.

5. **Partial pivoting with stability monitoring**: Tracks growth factors during elimination. If the growth factor exceeds bounds, the matrix is refactored with tighter pivoting thresholds.

6. **Symbolic factorization reuse**: The sparsity pattern of the LU factors is determined once (symbolic phase) and reused across Newton iterations and timesteps. Only the numerical values change. This is a massive performance win since circuit topology doesn't change during simulation.

### CircuitJS: Dense LU

CircuitJS allocates `circuitMatrix = new double[matrixSize][matrixSize]` -- a fully dense 2D array. Its LU decomposition is textbook dense Gaussian elimination with partial pivoting:

- **Storage**: O(n^2) regardless of circuit sparsity. A 100-node circuit allocates 10,000 doubles; a 1,000-node circuit allocates 1,000,000.
- **Factorization cost**: O(n^3) per Newton iteration. No exploitation of sparsity.
- **No fill-in minimization**: Not applicable -- the matrix is already fully dense.
- **No symbolic reuse**: The entire factorization is recomputed from scratch every iteration.
- **Singular matrix handling**: A single boolean check after factorization; if it fails, the simulation stops with "Singular matrix!" No recovery.

### Practical Consequences

| Circuit size | SPICE (KLU) | CircuitJS (Dense) |
|-------------|-------------|-------------------|
| 10 nodes | ~microseconds | ~microseconds |
| 100 nodes | ~100 microseconds | ~1 millisecond |
| 1,000 nodes | ~1 millisecond | ~1 second |
| 10,000 nodes | ~10 milliseconds | ~15 minutes |
| 100,000 nodes | ~100 milliseconds | Infeasible |

The crossover where CircuitJS becomes painful is around 200-500 nodes, which corresponds to circuits with roughly 50-100 components depending on type.

### Severity Ratings

| Rating | Justification |
|--------|--------------|
| **Minor for education** | Educational circuits rarely exceed 50 components. Dense LU is fine. |
| **IMPORTANT for hobbyist** | A moderately complex audio amplifier or power supply with 100+ components will be sluggish. |
| **CRITICAL for production** | Post-layout netlists with parasitics have millions of nodes. |

---

## 3. Convergence Algorithms

### SPICE's Multi-Strategy Convergence Stack

SPICE must find the DC operating point before any analysis can begin. For circuits with multiple nonlinear devices (diodes, transistors, MOSFETs), the operating point is a root of a highly nonlinear system. Basic Newton-Raphson often diverges. SPICE uses a layered fallback strategy:

**Layer 1: Standard Newton-Raphson with Voltage Limiting**
Each device model implements `pnjlim` (PN junction limiting) and `fetlim` (FET limiting). These functions prevent the Newton update from changing a junction voltage by more than a critical threshold (`Vcrit = kT/q * ln(kT/(q*Is*sqrt(2)))`, typically ~0.6V). Without this, a single large Newton step can push the diode exponential `exp(V/Vt)` into overflow (V=2V gives exp(77) ~ 2.6e33; V=20V gives exp(770) = infinity).

The limiting works by clamping:
- If the new voltage exceeds Vcrit AND the change exceeds 2*Vt (~52mV), the update is logarithmically compressed
- Negative voltages are limited to 3*V_previous - 10V
- This is device-aware: each model type has its own limiter

**Layer 2: Gmin Stepping**
If Layer 1 fails to converge, SPICE adds a conductance `Gmin` (default 1e-12 mhos) from every node to ground. This regularizes the matrix (prevents floating nodes) and linearizes the problem. SPICE then gradually reduces Gmin from a large value (e.g., 1e-3) to the final value (1e-12) over ~40 steps, using the converged solution at each step as the initial guess for the next. This is a homotopy/continuation method.

**Layer 3: Source Stepping**
If Gmin stepping fails, SPICE scales all independent sources from 0 to their final values in steps. At 0V/0A, the operating point is trivial (everything off). As sources ramp up, devices turn on gradually, and each intermediate solution provides a good initial guess for the next step. This is particularly effective for circuits with multiple stable states (latches, oscillators).

**Layer 4: Pseudo-Transient Analysis (PTA)**
If all DC methods fail, SPICE adds capacitors (from nodes to ground) and inductors (in series with voltage sources), then runs a short transient simulation while ramping power supplies from 0 to final values. The reactive elements provide damping that prevents the abrupt switching that causes DC convergence failure. This simulates "turning on the power supply" -- physically the most natural way to reach the operating point.

**Layer 5: Damped Newton-Raphson**
The Newton update vector dx is scaled by a damping factor alpha (0 < alpha <= 1): x_new = x_old + alpha * dx. Alpha is chosen by line search to ensure the residual decreases monotonically. This prevents oscillation around the solution.

### CircuitJS's Convergence

CircuitJS has:
- Basic Newton-Raphson iteration (up to 5000 iterations per timestep)
- Element-level voltage limiting in `doStep()` (partial -- simpler than SPICE's pnjlim)
- Unconnected nodes get 1e-8 ohm resistors to ground (a crude Gmin, but fixed -- not stepped)
- On convergence failure: halve the timestep and retry
- On persistent failure: simulation stops

There is no source stepping, no Gmin stepping, no pseudo-transient continuation, no damped Newton with line search.

### Practical Consequences

Circuits that converge trivially in SPICE but fail in CircuitJS:
- **Schmitt triggers and comparators** (positive feedback creates bistability)
- **Oscillators** (no stable DC operating point exists)
- **Circuits with many diodes** (bridge rectifiers, voltage multipliers)
- **Power electronics** (switching regulators, class-D amplifiers)
- **Any circuit with hysteresis** (magnetic cores, ferroelectric devices)

### Severity Ratings

| Rating | Justification |
|--------|--------------|
| **IMPORTANT for education** | Students will encounter "simulation stopped" errors on legitimate circuits (e.g., an SR latch, a ring oscillator), creating confusion about whether the circuit or the tool is wrong. |
| **CRITICAL for hobbyist** | Power supply design, switching converters, oscillator design -- all core hobbyist activities -- will hit convergence walls. |
| **CRITICAL for production** | Non-negotiable. A simulator that can't find the operating point of a production circuit is useless. |

---

## 4. Timestep Control

### SPICE: Local Truncation Error (LTE) Estimation

SPICE chooses the timestep to bound the integration error, not just to achieve convergence. The process:

1. **Compute the solution at time t+h** using the chosen integration method (trapezoidal or Gear).

2. **Estimate the LTE** for every reactive element (capacitor, inductor). For trapezoidal integration, the LTE is proportional to h^3 * q'''(t), where q is the charge on a capacitor (or flux on an inductor) and q''' is its third derivative. SPICE estimates q''' using divided differences of previously computed values:
   ```
   LTE_trap ~ (h^3 / 12) * q'''(t)
   q'''(t) ~ (q''(t) - q''(t-h)) / h   (backward difference)
   q''(t) ~ (q'(t) - q'(t-h)) / h      (from current values)
   ```
   For Gear order k, the LTE is proportional to h^(k+1) * q^(k+1)(t).

3. **Compare LTE against tolerances**: For each reactive element, SPICE checks:
   ```
   |LTE| <= reltol * max(|q(t)|, |q(t+h)|) + abstol_charge
   ```
   where `reltol` (default 1e-3) and charge abstol are user-configurable.

4. **Choose the new timestep**: If the LTE is within tolerance, the timestep may be increased. If it exceeds tolerance, the step is rejected and retried with a smaller h. The new h is estimated by:
   ```
   h_new = h * (tolerance / |LTE|)^(1/(order+1))
   ```
   with safety factors (typically 0.5-0.9) to avoid oscillation.

5. **Per-element control**: The timestep is the minimum required by ANY reactive element. A fast-switching transistor gate capacitance will force small steps even if all other nodes are slowly varying.

### CircuitJS: Binary Halving

CircuitJS's timestep algorithm (from source analysis):
```
if (convergence_failed):
    timeStep /= 2
if (good_iterations >= 3):
    timeStep = min(timeStep * 2, maxTimeStep)
if (timeStep < minTimeStep):
    stop simulation
```

No error estimation. No per-element tracking. No awareness of HOW MUCH the solution is changing -- only WHETHER the Newton loop converged. This means:
- Timestep can be far too large for fast transients (wrong answers without any warning)
- Timestep can be unnecessarily small during slowly-varying phases (wasted computation)
- There is no mechanism to detect that the accuracy is degrading

### Practical Consequences

Consider a switching power supply: the switch transitions in ~10ns but the output filter has a 1ms time constant. SPICE uses 1ns steps during transitions and 100us steps during steady-state. CircuitJS uses a fixed step (or the last halved step) for everything, leading to either:
- 1000x too much computation during steady-state, OR
- Completely wrong switch transition waveforms (with no error indication)

### Severity Ratings

| Rating | Justification |
|--------|--------------|
| **IMPORTANT for education** | Students won't know their results are wrong. A waveform that "looks right" but has 10% amplitude error due to timestep-related inaccuracy teaches incorrect intuition. |
| **CRITICAL for hobbyist** | Any circuit with fast edges (digital logic, switching supplies, RF) will produce quantitatively wrong results. |
| **CRITICAL for production** | Non-negotiable. Timestep control IS accuracy control. |

---

## 5. Integration Methods

### SPICE: Trapezoidal + Gear/BDF Family

**Trapezoidal Rule** (default in most SPICE):
```
q(t+h) = q(t) + (h/2) * [i(t) + i(t+h)]
```
- Second-order accurate: LTE ~ O(h^3)
- A-stable: stable for any timestep (no stability-driven step limit)
- Zero numerical damping: preserves oscillatory behavior exactly
- **Fatal flaw: trap ringing**. At discontinuities (switch events, pulse edges), the trapezoidal rule produces parasitic oscillations that alternate sign each timestep. The amplitude is proportional to h. This is NOT a real circuit behavior -- it is a pure numerical artifact.

**Backward Euler** (first step and after discontinuities):
```
q(t+h) = q(t) + h * i(t+h)
```
- First-order accurate: LTE ~ O(h^2)
- L-stable: infinite damping of high-frequency components
- Used as "startup" method for the first 1-2 steps after any discontinuity to suppress trap ringing
- SPICE automatically switches from BE to trapezoidal after startup

**Gear/BDF Methods** (orders 1-6):
```
Order 2: q(t+h) = (4/3)*q(t) - (1/3)*q(t-h) + (2h/3)*i(t+h)
Order 3-6: progressively use more history points
```
- Order k is k-th order accurate: LTE ~ O(h^(k+1))
- A(alpha)-stable up to order 6 (increasingly narrow stability wedge)
- Strong numerical damping: naturally suppresses trap ringing
- **Trade-off**: numerical damping means Gear methods attenuate real oscillations. An LC tank circuit simulated with Gear-2 will show artificial decay. Higher orders have less damping but narrower stability regions.
- **When to use**: Stiff circuits (widely separated time constants), circuits with many discontinuities, power electronics

**Trap Ringing in Detail**:
After a step discontinuity, the trapezoidal rule produces an alternating error sequence:
```
t=0:  correct
t=h:  +error
t=2h: -error
t=3h: +error (slightly smaller)
```
The error is undamped -- it persists forever at the current timestep. Only reducing h (which reduces the error amplitude) or switching to BE (which critically damps it) fixes the problem. LTspice uses a "modified trap" method where XMU=0.5 gives pure trapezoidal and XMU=0 gives Gear-1; the default XMU=0.5 with automatic damping near discontinuities is a key differentiator.

### CircuitJS

Implicit integration (effectively trapezoidal/backward Euler based on element stamp methods) with no method selection, no automatic BE startup after discontinuities, no Gear option, and no trap ringing detection or mitigation.

### Severity Ratings

| Rating | Justification |
|--------|--------------|
| **Minor for education** | For slow, smooth circuits (RC, RL), trapezoidal alone is adequate. Students won't notice. |
| **IMPORTANT for hobbyist** | Digital circuits and switching supplies produce step discontinuities that trigger trap ringing. Results look "noisy" with no explanation. |
| **CRITICAL for production** | Stiff mixed-signal circuits absolutely require Gear methods or intelligent method switching. |

---

## 6. Device Model Infrastructure

### SPICE: Full Parameterization Framework

**`.MODEL` Cards**: Associate a named model with a device type and override specific parameters. Example: `.MODEL 2N2222 NPN (BF=200 IS=1e-14 VAF=100 TF=0.3n)`. Parameters have physical meaning (BF=forward beta, IS=saturation current, etc.) and interact through the model equations.

**Model Levels**: MOSFET alone has 14+ model levels in ngspice:
- Level 1: Shichman-Hodges (1968) -- 8 parameters, educational
- Level 2: Grove-Frohman (1973) -- 30 parameters, short-channel
- Level 3: Semi-empirical -- 30 parameters, better short-channel
- Level 14/54: BSIM4 -- 300+ parameters, sub-100nm, used by every foundry
- Level 73: BSIM-CMG -- FinFET, 3D transistor modeling

BSIM4 models real physical effects: mobility degradation (3 sub-models), velocity saturation, channel-length modulation, DIBL, gate tunneling current, substrate current, self-heating, process variation, stress effects. Each effect has 3-10 parameters calibrated to silicon measurements.

**`.SUBCKT` Hierarchy**: Any circuit fragment can be encapsulated as a subcircuit with named ports. Subcircuits can nest. A foundry PDK for a 28nm process contains thousands of subcircuits for standard cells, I/O pads, ESD structures, and analog IP blocks.

**Binning**: For MOSFETs, model parameters vary with device geometry (W, L). Foundries provide "binned models" where the parameter space is divided into W/L bins, each with calibrated parameters. SPICE automatically selects the correct bin based on the instance geometry. A single PDK may have 500+ bins.

**Corner Models**: Foundries provide model sets for process corners:
- TT (typical-typical): nominal process
- FF (fast-fast): best-case speed, worst-case power
- SS (slow-slow): worst-case speed, best-case power
- FS/SF: skewed NMOS/PMOS combinations
- These represent 3-sigma process variation boundaries

**Monte Carlo / Statistical Models**: Parameters are expressed as:
```
.param vth0 = agauss(0.4, 0.02, 3)   // Gaussian: mean=0.4V, sigma=20mV, 3-sigma
```
Each Monte Carlo run samples new parameter values. Correlations between parameters are captured in correlation matrices. Both inter-die (lot-to-lot) and intra-die (mismatch) variation are modeled separately.

**Temperature**: Every model parameter has a temperature coefficient. SPICE evaluates models at the specified temperature, adjusting saturation currents (double per ~10C for diodes), threshold voltages (~-2mV/C for MOSFETs), resistances, etc.

### CircuitJS

Fixed ideal models. A diode is `I = Is*(exp(V/Vt)-1)` with hardcoded Is and Vt. No .MODEL cards, no parameter variation, no temperature, no corners, no subcircuit hierarchy (the GWT version has basic subcircuit support, but no parameterized models within them).

### Severity Ratings

| Rating | Justification |
|--------|--------------|
| **Minor for education** | Ideal models are fine for teaching circuit topology and qualitative behavior. Students don't need BSIM4. |
| **IMPORTANT for hobbyist** | Hobbyists want to simulate with real component models (2N2222, LM741 SPICE models). Without .MODEL/.SUBCKT, they can't use manufacturer-provided models. |
| **CRITICAL for production** | Foundry PDKs are the entire basis of IC design. No PDK support = no IC design. |

---

## 7. Parasitic Extraction

### What Production Simulators Handle

After physical layout, extraction tools (StarRC, Quantus QRC, Calibre xRC) compute parasitic R, C, and L from the geometric shapes:

- **Interconnect resistance**: Wire segments become distributed RC networks
- **Coupling capacitance**: Adjacent wires have mutual capacitance that causes crosstalk
- **Via resistance**: Each layer transition adds resistance
- **Substrate coupling**: Signals couple through the silicon substrate
- **Self/mutual inductance**: At high frequencies, current loops create inductive effects

The extracted parasitic netlist is back-annotated to the schematic netlist, producing a "post-layout netlist" that may be 10-100x larger than the schematic netlist. SPICE must simulate this expanded netlist.

**Hierarchical extraction**: For large designs, flat extraction is infeasible. Hierarchical extraction factors out repeated structures (standard cells) and handles them once, reducing memory and runtime by 10-100x.

### CircuitJS

No concept of layout, no parasitic extraction, no back-annotation. This is expected -- CircuitJS is a schematic-level simulator.

### Severity Rating

| Rating | Justification |
|--------|--------------|
| **N/A for education** | Not relevant to circuit fundamentals. |
| **N/A for hobbyist** | PCB-level parasitics are handled differently (board-level EM tools). |
| **CRITICAL for production** | Post-layout simulation is required for tape-out signoff. |

---

## 8. Numerical Precision

### SPICE: Careful Numerical Engineering

**PN Junction Voltage Limiting (`pnjlim`)**:
The Shockley diode equation `I = Is * (exp(V/(n*Vt)) - 1)` has the exp() function which overflows IEEE 754 double precision at V ~ 710*Vt ~ 18.4V. SPICE's `pnjlim` function:
1. Computes `Vcrit = n*Vt * ln(n*Vt / (sqrt(2) * Is))` -- the voltage where exp() starts to become numerically dangerous (~0.6V for typical diodes)
2. If the Newton update would push V above Vcrit with a change > 2*Vt, it compresses the update logarithmically: `V_new = V_old + n*Vt * (1 + ln((V_new_raw - V_old)/(n*Vt)))` -- i.e. replaces the linear Newton step with a log-scaled step
3. Separately limits negative voltages to prevent issues with reverse-biased junctions
4. `fetlim` does the same for MOSFET gate voltages relative to threshold

This is NOT just "voltage clamping" -- it is a mathematically motivated transformation that preserves the Newton convergence direction while preventing overflow. The limiting is tight enough that exp() never overflows, yet loose enough that Newton-Raphson still converges quadratically near the solution.

**Charge Conservation**:
SPICE computes capacitor charge directly from the voltage (Q = C*V for linear, Q = f(V) for nonlinear), NOT by integrating current. This avoids accumulated integration drift. The current is then derived as dQ/dt via the integration formula. This "charge-oriented" approach guarantees that charge is conserved exactly (to machine precision) at every timestep.

**Careful Difference Computation**:
When computing `exp(V1/Vt) - exp(V2/Vt)`, naive evaluation loses precision when V1 ~ V2 (catastrophic cancellation). SPICE implementations factor this as `exp(V2/Vt) * (exp((V1-V2)/Vt) - 1)` and use the `expm1()` function for the inner term, which is accurate even when V1-V2 is tiny.

**Convergence Tolerances**:
SPICE uses both absolute and relative tolerances:
- Voltage: converged when |V_new - V_old| < reltol * max(|V_new|, |V_old|) + vntol (default: reltol=1e-3, vntol=1e-6 V)
- Current: similarly with abstol (default: 1e-12 A)

This dual-tolerance scheme handles both large signals (where relative error matters) and small signals (where absolute error matters).

### CircuitJS

Naive `Math.exp()` evaluation. Per-element limiting in `doStep()` but without the mathematical rigor of `pnjlim` (no Vcrit calculation, no logarithmic compression). No `expm1()` usage. Fixed iteration count limit (5000) rather than tolerance-based convergence checking with per-variable absolute+relative thresholds.

### Severity Ratings

| Rating | Justification |
|--------|--------------|
| **Minor for education** | At educational signal levels, naive evaluation is usually fine. |
| **IMPORTANT for hobbyist** | Precision circuits (precision rectifiers, log amplifiers, bandgap references) will give wrong results. |
| **CRITICAL for production** | Numerical precision IS simulation accuracy. Every bit matters for analog design. |

---

## Summary: What Makes CircuitJS a "Toy"

It is NOT just the device models. The engine itself has fundamental gaps:

1. **It cannot answer basic engineering questions.** Without AC analysis, you cannot measure gain, bandwidth, phase margin, or noise figure. Without sensitivity analysis, you cannot identify critical tolerances. Without Monte Carlo, you cannot estimate yield. A transient-only simulator forces you to extract these numbers manually from waveforms -- slow, error-prone, and sometimes impossible (try measuring phase margin from a time-domain waveform).

2. **It does not know when it is wrong.** Without LTE-based timestep control, CircuitJS has no error bound on its transient results. The waveform on screen could be 1% wrong or 50% wrong -- there is no way to tell without comparing against a reference. SPICE's LTE control gives a mathematical guarantee on per-step accuracy.

3. **It gives up on hard circuits.** Without Gmin stepping, source stepping, and pseudo-transient continuation, CircuitJS cannot find the operating point of circuits with feedback, hysteresis, or multiple stable states. These are not exotic circuits -- an SR latch, a Schmitt trigger, and a ring oscillator all fall into this category.

4. **It scales quadratically-to-cubically.** Dense O(n^3) LU means the solver becomes the bottleneck above ~100 components. SPICE's sparse O(n) solver handles 1,000,000-node post-layout netlists.

5. **It has one integration method with a known numerical artifact (trap ringing) and no mitigation.** Real SPICE engines switch to backward Euler at discontinuities and offer Gear methods for stiff circuits.

### What CircuitJS IS Good For

Despite these gaps, CircuitJS excels at:
- **Instant visual feedback** for simple circuits (< 50 components)
- **Animated current flow** that builds physical intuition
- **Zero setup** -- no installation, no netlist syntax, no learning curve
- **Interactive parameter exploration** -- drag a slider, see the waveform change

For the educational context of this project (digital logic circuits in a browser), the digital-engine approach (event-driven, not MNA) sidesteps most of these analog simulation concerns entirely. The comparison is relevant for understanding what the analog MNA engine (CircuitJS's GWT fork) can and cannot do, and where the boundary lies for mixed-signal or analog tutorial content.

---

## Sources

- [ngspice User Manual v45](https://ngspice.sourceforge.io/docs/ngspice-html-manual/manual.xhtml)
- [KLU Sparse Direct Solver (ACM TOMS)](https://dl.acm.org/doi/abs/10.1145/1824801.1824814)
- [KLU Implementation in ngspice (ResearchGate)](https://www.researchgate.net/publication/254041555_KLU_sparse_direct_linear_solver_implementation_into_NGSPICE)
- [SIMetrix DC Operating Point Algorithms](https://help.simetrix.co.uk/8.0/simetrix/mergedProjects/simulator_reference/topics/simref_convergence_accuracyandperformance_dcoperatingpointalgorithms.htm)
- [Intusoft: Solving SPICE Convergence Problems (PDF)](http://www.intusoft.com/articles/converg.pdf)
- [SPICE Convergence Tips (CU Boulder)](http://ecee.colorado.edu/~ecen5807/hw/hw6/SpiceConvergenceTips.html)
- [SPICE Differentiation (Analog Devices / Mike Engelhardt)](https://www.analog.com/en/resources/technical-articles/spice-differentiation.html)
- [SIMetrix Accuracy and Integration Methods](https://simplis.com/documentation/simetrix/simulator_reference/topics/convergence_accuracyandperformance_accuracyandintegrationmethods.htm)
- [Overview of SPICE-like Circuit Simulation Algorithms (Univ. Naples)](http://www.elettrotecnica.unina.it/files/demagistris/didattica/TdC/SPICE_like_simulation.pdf)
- [BSIM4 v4.8.0 Manual](https://ngspice.sourceforge.io/external-documents/models/BSIM480_Manual.pdf)
- [Simulating Device and Process Variation in SPICE](https://www.allaboutcircuits.com/textbook/designing-analog-chips/simulation/simulating-device-and-process-variation-in-spice/)
- [HSPICE Worst Case and Monte Carlo](http://www.ece.uci.edu/docs/hspice/hspice_2001_2-85.html)
- [Monte Carlo in SPICE (Altium)](https://resources.altium.com/p/basics-monte-carlo-spice-theory-and-demo)
- [CircuitJS1 Source (GitHub)](https://github.com/sharpie7/circuitjs1)
- [CircuitJS Documentation (Falstad)](https://www.falstad.com/circuit/doc/)
- [Parasitic Extraction (Synopsys)](https://www.synopsys.com/content/dam/synopsys/implementation&signoff/white-papers/extraction_tech_wp.pdf)
- [Post-Layout Parasitic Extraction (Virginia Tech)](https://www.mics.ece.vt.edu/ICDesign/Tutorials/AnalogIC/pex.html)
- [Ken Kundert: Achieving Accurate Results With a Circuit Simulator](https://kenkundert.com/docs/eda+t93-preso.pdf)
- [Kundert: Simulation of Analog and Mixed-Signal Circuits](https://kenkundert.com/docs/bctm98-MSsim.pdf)
- [SPICE OPUS pnjlim Documentation](https://fides.fe.uni-lj.si/spice/osdi.html)
- [LTwiki: Integration Method Issues](https://ltwiki.org/files/LTspiceHelp.chm/html/integration_method_issues.htm)
- [ngspice Pole-Zero Analysis](https://nmg.gitlab.io/ngspice-manual/analysesandoutputcontrol_batchmode/analyses/pz_pole-zeroanalysis.html)
- [ngspice Model Parameters](https://ngspice.sourceforge.io/modelparams.html)
- [Hackaday: 30 Free Circuit Simulators Reviewed](https://hackaday.com/2022/08/04/30-free-circuit-simulators-lightly-reviewed/)
