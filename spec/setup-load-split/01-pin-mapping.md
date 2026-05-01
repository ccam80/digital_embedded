# Setup/Load Split- Pin Mapping Registry (01)

This file is the authoritative source for pin-label → ngspice-node-suffix
correspondence. Per-component `setup()` bodies (in `components/PB-*.md`)
read this map to know which `pinNodes.get(digitsLabel)` corresponds to
which ngspice node variable.

Implementer agents writing setup() bodies use this file as their sole
reference for pin labels- they are forbidden from reading digiTS
component source to discover them.

---

## Mechanism: `ngspiceNodeMap` on `MnaModel` and `ComponentDefinition`

A new optional field is added in two places:

### `src/core/registry.ts`- `ComponentDefinition`

```ts
/** Maps digiTS pin label → ngspice node-variable suffix.
 *  Used by the netlist generator and by setup() bodies to reach
 *  ngspice's named view of nodes from digiTS's labelled view.
 *
 *  Examples:
 *    Resistor: { A: "pos", B: "neg" }
 *      → pinNodes.get("A") corresponds to RESposNode
 *    MOSFET:   { G: "gate", D: "drain", S: "source", B: "bulk" }
 *      → pinNodes.get("D") corresponds to MOS1dNode
 *
 *  Sub-element composites (transformer, opamp, ADC, etc.) leave this
 *  field UNDEFINED; the composite's own setup() does not reach into
 *  ngspice- it constructs sub-elements which carry their own
 *  ngspiceNodeMap entries.
 *
 *  Sibling pattern to ParamDef.spiceName which renames param keys for
 *  netlist emission.
 */
ngspiceNodeMap?: Record<string, string>;
```

### `src/compile/types.ts`- `MnaModel`

Same field shape- see `00-engine.md` ssA3.1. Each model registration
duplicates the map from its `ComponentDefinition` so setup() can read
it without round-tripping through the registry.

The netlist-generator (`src/solver/analog/__tests__/harness/netlist-generator.ts`)
should also be refactored to read this map (replacing the hard-coded
positional `nodes[2]` etc. logic at lines 111-188), but that cleanup is
**out of scope** for this spec- flag it as a follow-up.

---

## How agents use this

Per-component spec files (`components/PB-*.md`) reference this registry
by component name. Example for PB-RES:

> Pin map (from `01-pin-mapping.md`): `{ A: "pos", B: "neg" }`.
> In setup():
> ```
> const posNode = pinNodes.get("A")!;
> const negNode = pinNodes.get("B")!;
> // TSTALLOC sequence (ressetup.c:46-49):
> this._hPP = solver.allocElement(posNode, posNode);  // (RESposNode, RESposNode)
> this._hNN = solver.allocElement(negNode, negNode);  // (RESnegNode, RESnegNode)
> this._hPN = solver.allocElement(posNode, negNode);  // (RESposNode, RESnegNode)
> this._hNP = solver.allocElement(negNode, posNode);  // (RESnegNode, RESposNode)
> ```

The map is the single point of variation- TSTALLOC body is mechanical
once the map is fixed.

---

## Per-component pin maps (authoritative)

Components grouped by category. Composites that decompose into sub-elements
(transformer, opamp, etc.) do not get their own map- sub-elements carry
their own. The `Anchor` column lists the ngspice `*setup.c` (or "behavioral"
for digiTS-internal primitives).

### Passives- primitive (own ngspice anchor)

| Component | digiTS pin labels (in pinLayout order) | `ngspiceNodeMap` | Anchor |
|---|---|---|---|
| Resistor (`resistor.ts`) | `A`, `B` | `{ A: "pos", B: "neg" }` | `res/ressetup.c` |
| Capacitor (`capacitor.ts`) | `pos`, `neg` | `{ pos: "pos", neg: "neg" }` | `cap/capsetup.c` |
| PolarizedCap (`polarized-cap.ts`) | `pos`, `neg` | `{ pos: "pos", neg: "neg" }` | `cap/capsetup.c` (delegated) |
| Inductor (`inductor.ts`) | `A`, `B` | `{ A: "pos", B: "neg" }` | `ind/indsetup.c` |
| TransmissionLine (`transmission-line.ts`) | `P1b`, `P2b`, `P1a`, `P2a` | `{ P1a: "posNode1", P1b: "negNode1", P2a: "posNode2", P2b: "negNode2" }` | `tra/trasetup.c` |

### Passives- composites (decomposed)

| Component | Decomposition | Per-sub-element map |
|---|---|---|
| Transformer (`transformer.ts`) | IND (`L1`) + IND (`L2`) + MUT (`K`) | `L1.ngspiceNodeMap = { P1: "pos", P2: "neg" }`, `L2.ngspiceNodeMap = { S1: "pos", S2: "neg" }`, MUT carries no pin map (uses `findDevice` refs) |
| TappedTransformer (`tapped-transformer.ts`) | 3× IND (`L1`/`L2`/`L3`) + 3× MUT (pairwise) | `L1: { P1: "pos", P2: "neg" }`, `L2: { S1: "pos", CT: "neg" }`, `L3: { CT: "pos", S2: "neg" }`, MUTs use `findDevice` |
| Potentiometer (`potentiometer.ts`) | 2× RES (`R_AW`, `R_WB`) | `R_AW: { A: "pos", W: "neg" }`, `R_WB: { W: "pos", B: "neg" }` |
| AnalogFuse (`analog-fuse.ts`) | 1× RES (variable, set in `accept()`) | `{ out1: "pos", out2: "neg" }` |
| Memristor (`memristor.ts`) | 1× RES (state-dependent G updated each load() iteration; state `_w` integrated in `accept()`) | `{ A: "pos", B: "neg" }` |
| Crystal (`crystal.ts`) | RES + IND + CAP (series) + CAP (parallel) | inferred per RES/IND/CAP standard maps; sub-element node assignments documented in `components/PB-CRYSTAL.md` |

### Sources- primitive

| Component | digiTS pin labels (in pinLayout order) | `ngspiceNodeMap` | Anchor |
|---|---|---|---|
| DcVoltageSource (`dc-voltage-source.ts`) | `neg`, `pos` (idx 0, 1) | `{ neg: "neg", pos: "pos" }` | `vsrc/vsrcset.c` |
| AcVoltageSource (`ac-voltage-source.ts`) | `neg`, `pos` (idx 0, 1) | `{ neg: "neg", pos: "pos" }` | `vsrc/vsrcset.c` |
| VariableRail (`variable-rail.ts`) | `pos` (single) | `{ pos: "pos" }` (`neg` implicit ground) | `vsrc/vsrcset.c` |
| CurrentSource (`current-source.ts`) | `neg`, `pos` (idx 0, 1) | `{ neg: "neg", pos: "pos" }` | none- ISRC has no `*set.c` (no-op setup) |

### Semiconductors- primitive

| Component | digiTS pin labels | `ngspiceNodeMap` | Anchor |
|---|---|---|---|
| Diode (`diode.ts`) | `A`, `K` | `{ A: "pos", K: "neg" }` | `dio/diosetup.c` |
| Zener (`zener.ts`) | `A`, `K` | `{ A: "pos", K: "neg" }` | `dio/diosetup.c` (Zener flag) |
| Schottky (`schottky.ts`) | `A`, `K` | `{ A: "pos", K: "neg" }` | `dio/diosetup.c` (Schottky defaults) |
| Varactor (`varactor.ts`) | `A`, `K` | `{ A: "pos", K: "neg" }` | `dio/diosetup.c` (C-V biased) |
| BJT NPN (`bjt.ts`) | `B`, `C`, `E` | `{ B: "base", C: "col", E: "emit" }` (substrate node = ground) | `bjt/bjtsetup.c` |
| BJT PNP (`bjt.ts`) | `B`, `C`, `E` | `{ B: "base", C: "col", E: "emit" }` | `bjt/bjtsetup.c` |
| NJfet (`njfet.ts`) | `G`, `S`, `D` | `{ G: "gate", S: "source", D: "drain" }` | `jfet/jfetset.c` |
| PJfet (`pjfet.ts`) | `G`, `D`, `S` | `{ G: "gate", D: "drain", S: "source" }` | `jfet/jfetset.c` |
| NMOSFET (`mosfet.ts`) | `G`, `S`, `D` | `{ G: "g", S: "s", D: "d" }` (bulk B internal- corresponds to MOS1bNode aka `b`; for 3-terminal the bulk pin is wired to S internally) | `mos1/mos1set.c` |
| PMOSFET (`mosfet.ts`) | `G`, `D`, `S` | `{ G: "g", D: "d", S: "s" }` (bulk B internal- corresponds to MOS1bNode aka `b`; for 3-terminal the bulk pin is wired to S internally) | `mos1/mos1set.c` |

### Semiconductors- composites (decomposed; no native ngspice anchor)

| Component | Decomposition | Sub-element pin maps |
|---|---|---|
| TunnelDiode (`tunnel-diode.ts`) | 1× VCCS | `vccs.ngspiceNodeMap = { A: "contPos", K: "contNeg" }`; same controlling pair stamped onto same output pair (out+ ≡ A, out- ≡ K) |
| Diac (`diac.ts`) | 2× DIO antiparallel (`D_fwd`, `D_rev`) with breakdown enabled | `D_fwd: { A: "pos", K: "neg" }` against (A, B); `D_rev: { A: "pos", K: "neg" }` against (B, A) |
| Scr (`scr.ts`) | 2× BJT (NPN + PNP, two-transistor latch model: `Q1` NPN, `Q2` PNP) | `Q1: { B: "base", C: "col", E: "emit" }`, `Q2: { B: "base", C: "col", E: "emit" }`; specific node assignments documented in `components/PB-SCR.md` |
| Triac (`triac.ts`) | 4× BJT (= 2× SCR antiparallel) | per `components/PB-TRIAC.md` |
| Triode (`triode.ts`) | 1× VCCS (Koren transconductance) | `vccs.ngspiceNodeMap = { G: "contPos", K: "contNeg" }`; output stamps onto (P, K) |

### Switching- primitive

| Component | digiTS pin labels | `ngspiceNodeMap` | Anchor |
|---|---|---|---|
| Switch (`switch.ts`) | `A1`, `B1` (default 1-pole) | `{ A1: "pos", B1: "neg" }` | `sw/swsetup.c` |
| Fuse (`switching/fuse.ts`) | `out1`, `out2` | `{ out1: "pos", out2: "neg" }` | `res/ressetup.c` (variable RES) |

### Switching- composites

| Component | Decomposition | Per-sub-element |
|---|---|---|
| SwitchDT (`switch-dt.ts`) | 2× SW per pole (`SW_AB`, `SW_AC`) | `SW_AB: { A1: "pos", B1: "neg" }`, `SW_AC: { A1: "pos", C1: "neg" }` |
| NFET (`nfet.ts`) | 1× SW (gate threshold) | `{ G: "contPos", D: "pos", S: "neg" }` (G uses VCVS/VCCS controlling-pair vocabulary; ngspice SW has no control-node TSTALLOC entries- control voltage is read in load() via the composite's `setCtrlVoltage` forwarding to the SW sub-element. S serves dual roles: SWnegNode for stamps + implicit contNeg reference for the gate-source control voltage) |
| PFET (`pfet.ts`) | 1× SW (inverted) | `{ G: "contPos", D: "pos", S: "neg" }` (G uses VCVS/VCCS controlling-pair vocabulary; ngspice SW has no control-node TSTALLOC entries- control voltage is read in load() via the composite's `setCtrlVoltage` forwarding to the SW sub-element. S serves dual roles: SWnegNode for stamps + implicit contNeg reference for the gate-source control voltage) |
| FGNFET (`fgnfet.ts`) | MOS + CAP (floating-gate) | per `components/PB-FGNFET.md` |
| FGPFET (`fgpfet.ts`) | MOS + CAP (floating-gate) | per `components/PB-FGPFET.md` |
| TransGate (`trans-gate.ts`) | NFET + PFET (shared signal path) | per `components/PB-TRANSGATE.md` |
| Relay (`relay.ts`) | IND (coil) + SW (contact) per pole | `coil_IND: { in1: "pos", in2: "neg" }`, `contact_SW: { A1: "pos", B1: "neg" }` (per pole) |
| RelayDT (`relay-dt.ts`) | IND (coil) + 2× SW per pole | `coil_IND: { in1: "pos", in2: "neg" }`, `SW_AB: { A1: "pos", B1: "neg" }`, `SW_AC: { A1: "pos", C1: "neg" }` |

### Sensors

| Component | Pin labels | `ngspiceNodeMap` | Anchor |
|---|---|---|---|
| LDR (`ldr.ts`) | `pos`, `neg` | `{ pos: "pos", neg: "neg" }` | `res/ressetup.c` (variable) |
| NTC (`ntc-thermistor.ts`) | `pos`, `neg` | `{ pos: "pos", neg: "neg" }` | `res/ressetup.c` (variable) |
| SparkGap (`spark-gap.ts`) | `pos`, `neg` | `{ pos: "pos", neg: "neg" }` | `sw/swsetup.c` |

### Controlled sources- primitive

| Component | Pin labels | `ngspiceNodeMap` | Anchor |
|---|---|---|---|
| VCVS (`vcvs.ts`) | `ctrl+`, `ctrl-`, `out+`, `out-` | `{ "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }` | `vcvs/vcvsset.c` |
| VCCS (`vccs.ts`) | `ctrl+`, `ctrl-`, `out+`, `out-` | `{ "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }` | `vccs/vccsset.c` |
| CCCS (`cccs.ts`) | `sense+`, `sense-`, `out+`, `out-` | `{ "out+": "pos", "out-": "neg" }` (sense pair routed via `setParam("senseSourceLabel", ...)`- controlling branch resolved by `ctx.findBranch`) | `cccs/cccsset.c` |
| CCVS (`ccvs.ts`) | `sense+`, `sense-`, `out+`, `out-` | `{ "out+": "pos", "out-": "neg" }` (same as CCCS) | `ccvs/ccvsset.c` |

**Note on sense pins for CCCS/CCVS**: ngspice's CCCS/CCVS take a controlling-source label, not pin nodes. digiTS pins `sense+` / `sense-` are wired via the netlist generator to a virtual zero-volt VSRC whose label is the `senseSourceLabel` setParam. setup() ignores the sense pins and calls `ctx.findBranch(senseSourceLabel)` to get the controlling branch.

### Active composites- pin maps for SUB-ELEMENTS only

The composite itself does not get an `ngspiceNodeMap`- it doesn't stamp into the matrix directly. Per-composite decompositions and sub-element maps are in their `components/PB-*.md` files; this section just lists the composites and their decomposition rule.

| Component | Pin labels | Decomposition | Spec file |
|---|---|---|---|
| OpAmp (`opamp.ts`) | `in-`, `in+`, `out` | VCVS (with optional output RES) | `components/PB-OPAMP.md` |
| RealOpAmp (`real-opamp.ts`) | `in-`, `in+`, `out`, `Vcc+`, `Vcc-` | VCVS + RC (slew/GBW) + clamp diodes | `components/PB-REAL_OPAMP.md` |
| Comparator (`comparator.ts`) | `in+`, `in-`, `out` | VCVS (high-gain) | `components/PB-COMPARATOR.md` |
| OTA (`ota.ts`) | `V+`, `V-`, `Iabc`, `OUT+`, `OUT` | VCCS + bias | `components/PB-OTA.md` |
| Schmitt (`schmitt-trigger.ts`) | `in`, `out` | VCVS (hysteretic) | `components/PB-SCHMITT.md` |
| Optocoupler (`optocoupler.ts`) | `anode`, `cathode`, `collector`, `emitter` | DIO (LED) + BJT (NPN) | `components/PB-OPTO.md` |
| Timer555 (`timer-555.ts`) | `DIS`, `TRIG`, `THR`, `VCC`, `CTRL`, `OUT`, `RST`, `GND` | 2× Comparator + RS latch + BJT | `components/PB-TIMER555.md` |
| ADC (`adc.ts`) | `VIN`, `CLK`, `VREF`, `EOC`, `D0`..`D{N-1}`, `GND` | behavioral (no analog matrix entries other than VIN/VREF input loading via DigitalInputPinModel) | `components/PB-ADC.md` |
| DAC (`dac.ts`) | `D0`..`D{N-1}`, `VREF`, `OUT`, `GND` | VCVS (output) + behavioral input loading | `components/PB-DAC.md` |
| AnalogSwitch SPST (`analog-switch.ts`) | `in`, `out`, `ctrl` | 1× SW | `components/PB-ANALOG_SWITCH.md` |
| AnalogSwitch SPDT (`analog-switch.ts`) | `com`, `no`, `nc`, `ctrl` | 2× SW | `components/PB-ANALOG_SWITCH.md` |

---

## Behavioral elements- see `02-behavioral.md`

Pure-digital and behavioral analog elements (gates, mux, demux, decoder,
driver, splitter, sevenseg, button-LED) are NOT in this registry. They
use `DigitalInputPinModel` / `DigitalOutputPinModel` whose own
`setup()` bodies (specced in `02-behavioral.md`) handle their TSTALLOC
allocations. Their composite container forwards `setup()` calls to
their pin models and capacitor children- no `ngspiceNodeMap` needed.

---

## Subcircuit composition rule

`PB-SUBCKT` (`src/components/subcircuit/subcircuit.ts`):

The subcircuit composite carries a `subElements: AnalogElement[]` array,
sorted by `ngspiceLoadOrder`. Composite's `setup(ctx)` forwards to each
sub-element's `setup(ctx)`. Each sub-element carries its own
`ngspiceNodeMap`- the composite has no map of its own.

The composite's pin nodes route to specific internal sub-elements via
the existing port-binding mechanism (compiler.ts:262). Pin-label routing
is preserved unchanged from current code.

---

## Verification

A9's `setup-stamp-order.test.ts` (per `00-engine.md` ssA9) implicitly
verifies every pin-map entry: if the map names the wrong ngspice node,
the resulting TSTALLOC sequence's `(extRow, extCol)` pairs will diverge
from the ngspice anchor and the test row turns red.

A separate "pin-map sanity" test is also added:
`src/solver/analog/__tests__/pin-map-coverage.test.ts`. For every
component listed in `components/PB-*.md`, this test asserts:

1. The component's `ComponentDefinition.ngspiceNodeMap` is defined (or
   the component is documented as a composite that decomposes- in which
   case its sub-elements' maps must be defined).
2. Every key in the map matches a pin label in `pinLayout`.
3. Every value in the map matches a known ngspice-node-suffix string
   from the anchor's `*setup.c` (e.g., `"pos"`, `"neg"`, `"drain"`,
   `"gate"`, `"source"`, `"bulk"`, `"col"`, `"base"`, `"emit"`,
   `"posNode1"`, `"negNode1"`, `"posNode2"`, `"negNode2"`, `"contPos"`,
   `"contNeg"`, `"d"`, `"g"`, `"s"`, `"b"`). The allowlist legitimately
   covers both naming conventions: JFET still uses the long names
   (`"drain"`, `"gate"`, `"source"`, `"bulk"`) per `jfet/jfetset.c`,
   while MOSFET uses the single-letter names (`"d"`, `"g"`, `"s"`, `"b"`)
   per `mos1/mos1set.c`- the project keeps both verbatim per the
   corresponding ngspice anchor.
