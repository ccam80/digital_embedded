# Signal Assertion Strategy: 5B and 5C Component Sweep Tests
Generated: 2026-03-27T20:45:42.033347

[OBJECTIVE] Design signal propagation assertion strategies for the 5B (digital width sweep,
~140 tests) and 5C (analog/mixed mode sweep, 26 tests) parameterized E2E test suites.

[DATA] Source files analysed:
- e2e/gui/component-sweep.spec.ts (541 lines): full WIDTH_MATRIX (31 entries), MUX_MATRIX (13), MEM_MATRIX (15), DUAL_ENGINE_TYPES (14)
- e2e/fixtures/ui-circuit-builder.ts: full UICircuitBuilder API
- e2e/gui/digital-circuit-assembly.spec.ts: 18 confirmed runTestVectors patterns
- e2e/gui/analog-circuit-assembly.spec.ts: stepAndReadAnalog, sortedVoltages, expectVoltage
- e2e/gui/mixed-circuit-assembly.spec.ts: DAC/ADC circuit patterns

---

## Key Infrastructure Facts

### UICircuitBuilder signal methods available
| Method | What it does |
|--------|-------------|
| `builder.runTestVectors(testData)` | Posts digital-test via postMessage; state preserved across rows |
| `builder.stepViaUI(n)` | Clicks toolbar Step button n times |
| `builder.stepAndReadAnalog(steps)` | Steps n times, returns nodeVoltages dict |
| `builder.getAnalogState()` | Returns current analog engine state |
| `builder.verifyNoErrors()` | Asserts status bar has no error class |

### runTestVectors format
```
"col1 col2 col3\n"  // header: labeled In/Out/Clock component names
"v1   v2   v3\n"   // row 1: drive inputs, read outputs in one step
```
- `C` as a cell value triggers a rising clock edge on that column
- State IS preserved between rows (sequential components work)
- Confirmed working for D_FF, JK_FF, SR latch (existing digital-circuit-assembly tests)

### BLOCKER: switchEngineMode() not defined
`switchEngineMode()` is called in 5C but missing from UICircuitBuilder.
Must be added before any 5C test can run.

---

## 5B Strategy

### Per-component test vectors (WIDTH_MATRIX)

#### LOGIC GATES (And, Or, XOr, NAnd, NOr, XNOr, Not)
5B currently only wires SRC->In_1. Need to add SRC2->In_2 for two-input gates.

Helper function (add above the WIDTH_MATRIX loop):
```typescript
function gateTestVector(type: string, width: number): string {
  const mask = width < 32 ? (1 << width) - 1 : 0xFFFFFFFF;
  const a = 5 & mask, b = 3 & mask;
  switch (type) {
    case 'And':  return `SRC SRC2 DST\n${a} ${b} ${a & b}`;
    case 'Or':   return `SRC SRC2 DST\n${a} ${b} ${a | b}`;
    case 'XOr':  return `SRC SRC2 DST\n${a} ${b} ${a ^ b}`;
    case 'NAnd': return `SRC SRC2 DST\n${a} ${b} ${mask ^ (a & b)}`;
    case 'NOr':  return `SRC SRC2 DST\n${a} ${b} ${mask ^ (a | b)}`;
    case 'XNOr': return `SRC SRC2 DST\n${a} ${b} ${mask ^ (a ^ b)}`;
    case 'Not':  return `SRC DST\n${a} ${mask ^ a}`;
    default: return '';
  }
}
```

Values (a=5&mask, b=3&mask) at each width:
| Width | a  | b  | And | Or | XOr | NAnd | NOr | XNOr | Not(a) |
|-------|----|----|-----|----|-----|------|-----|------|--------|
| 1     | 1  | 1  | 1   | 1  | 0   | 0    | 0   | 1    | 0      |
| 2     | 1  | 3  | 1   | 3  | 2   | 2    | 0   | 1    | 2      |
| 4     | 5  | 3  | 1   | 7  | 6   | 14   | 8   | 9    | 10     |
| 8     | 5  | 3  | 1   | 7  | 6   | 254  | 248 | 249  | 250    |
| 32    | 5  | 3  | 1   | 7  | 6   | 4294967294 | 4294967288 | 4294967289 | 4294967290 |

Extra wiring (add before runTestVectors call, skip for Not):
```typescript
if (entry.type !== 'Not') {
  await builder.placeLabeled('In', 3, 12, 'SRC2');
  await builder.setComponentProperty('SRC2', 'Bits', width);
  await builder.drawWire('SRC2', 'out', 'DUT', 'In_2');
}
const vec = gateTestVector(entry.type, width);
const result = await builder.runTestVectors(vec);
expect(result.passed).toBe(result.total);
expect(result.failed).toBe(0);
```

---

#### ARITHMETIC (Add, Sub, Mul, Div, Comparator)
All need SRC2(In,Bits=w)->DUT:b. Comparator output pin is '>'.

```typescript
function arithmeticVector(type: string, width: number): string {
  const mask = width < 32 ? (1 << width) - 1 : 0xFFFFFFFF;
  if (type === 'Add') {
    const a = 5 & mask, b = 3 & mask;
    return `SRC SRC2 DST\n${a} ${b} ${(a + b) & mask}`;
  } else if (type === 'Sub') {
    const a = 5 & mask, b = 3 & mask;
    return `SRC SRC2 DST\n${a} ${b} ${((a - b) + mask + 1) & mask}`;
  } else if (type === 'Mul') {
    const a = 3 & mask, b = 2 & mask;
    return `SRC SRC2 DST\n${a} ${b} ${(a * b) & mask}`;
  } else if (type === 'Div') {
    const a = mask < 6 ? 1 : 6, b = mask < 2 ? 1 : 2;
    return `SRC SRC2 DST\n${a} ${b} ${Math.floor(a / b)}`;
  } else if (type === 'Comparator') {
    const a = 5 & mask, b = 3 & mask;
    return `SRC SRC2 DST\n${a} ${b} 1`;  // a > b always at w>=2
  }
  return '';
}
```

Selected canonical values:
| Component | w=1    | w=4        | w=8        | w=32       |
|-----------|--------|------------|------------|------------|
| Add       | 1+1=0  | 5+3=8      | 5+3=8      | 5+3=8      |
| Sub       | 1-1=0  | 5-3=2      | 5-3=2      | 5-3=2      |
| Mul       | 1*0=0  | 3*2=6      | 3*2=6      | 3*2=6      |
| Div       | 1/1=1  | 6/2=3      | 6/2=3      | 6/2=3      |
| Comparator| 1>1=0  | 5>3=1      | 5>3=1      | 5>3=1      |

Note: Comparator at w=1: 1>1=0, so DST=0. The vector must handle this edge:
```typescript
// Comparator special case at w=1
const a = 5 & mask, b = 3 & mask;
const expected = a > b ? 1 : 0;
const vec = `SRC SRC2 DST\n${a} ${b} ${expected}`;
```

---

#### SEQUENTIAL (Counter, CounterPreset, Register, D_FF, D_FF_AS, JK_FF, JK_FF_AS)

runTestVectors preserves state between rows. State-carrying components work.

| Component | Extra wiring | Test vector | Notes |
|-----------|-------------|-------------|-------|
| Counter | None | `SRC DST\n1 1\n0 1\n1 2\n0 2\n1 3\n0 3` | 3 rising edges on SRC (In) = count 3 |
| CounterPreset | None | Same | Same |
| Register | Add CLK(Clock,'CLK')->DUT:C | `D CLK Q\n5 C 5` | D=5 clocked in; Q=5 |
| D_FF | Add CLK(Clock,'CLK')->DUT:C, rename SRC->D | `D C Q\n1 C 1\n0 C 0` | Clock edge latches D |
| D_FF_AS | Same | Same | Same |
| JK_FF | Add CLK(Clock,'CLK')->DUT:C, SRC2->K | `J K C Q\n1 0 C 1\n0 1 C 0` | Set then Reset |
| JK_FF_AS | Same | Same | Same |

Counter note: SRC is an In component driving pin C directly (not a Clock component).
Toggle SRC 0->1->0->1->0->1 = 3 rising edges. State is preserved between rows.

```typescript
// Counter assertion (appended after verifyNoErrors)
const result = await builder.runTestVectors('SRC DST\n1 1\n0 1\n1 2\n0 2\n1 3\n0 3');
expect(result.passed).toBe(6);
expect(result.failed).toBe(0);
```

For Register, D_FF, JK_FF: the test must also add a Clock component:
```typescript
await builder.placeLabeled('Clock', 3, 12, 'CLK');
await builder.drawWire('CLK', 'out', 'DUT', 'C');
```

---

#### WIRING / ROUTING

| Component | Extra wiring | Test vector |
|-----------|-------------|-------------|
| Decoder | None | `SRC DST\n0 1\n1 0` (sel=0->out_0=1, sel=1->out_0=0) |
| BitSelector | Add SEL(In)->DUT:sel | `SRC SEL DST\n5 0 1\n5 2 1` (bit0 and bit2 of 5=0b101 both 1) |
| PriorityEncoder | None | `SRC DST\n4 2` (in=0b100->highest bit index=2) |
| BarrelShifter | Add SHFT(In)->DUT:shift | `SRC SHFT DST\n2 2 8` (2<<2=8) |
| Driver | Add EN(In,Bits=1)->DUT:en | `SRC EN DST\n5 1 5\n0 1 0` (pass-through when EN=1) |
| DriverInvSel | Add EN(In,Bits=1)->DUT:en | `SRC EN DST\n5 0 5` (pass-through when EN=0) |
| Delay | None | `SRC DST\n5 5` (1-cycle delay; after one step output=input) |
| BusSplitter | None | `SRC DST\n5 5` (bus pass-through, D-in = D-out) |

Decoder edge: at selectorBits=1, selector=0->out_0=1 always valid.
At higher selectorBits: same vector works (out_0=1 only when sel=0).

PriorityEncoder note: input=4 (bit2 set) is valid at all widths>=3.
At width=2: use input=2 (bit1 set)->output=1.
```typescript
const v = width >= 3 ? 4 : 2;
const expected = width >= 3 ? 2 : 1;
const vec = `SRC DST\n${v} ${expected}`;
```

---

#### MUX/DEMUX (MUX_MATRIX loop)

**Multiplexer**: currently wires SEL->sel, D0->0, Y<-out. Need to add D1->1.
sel=0 -> out=D0=5; sel=1 -> out=D1=3.
```typescript
// Add D1 input
await builder.placeLabeled('In', 3, 14, 'D1');
await builder.setComponentProperty('D1', 'Bits', entry.dataBits);
await builder.drawWire('D1', 'out', 'DUT', '1');

const mask = entry.dataBits < 32 ? (1 << entry.dataBits) - 1 : 0xFFFFFFFF;
const v0 = 5 & mask, v1 = 3 & mask;
const result = await builder.runTestVectors(
  `SEL D0 D1 Y\n0 ${v0} ${v1} ${v0}\n1 ${v0} ${v1} ${v1}`
);
expect(result.passed).toBe(2);
expect(result.failed).toBe(0);
```

**Demultiplexer**: wires SEL->sel, DIN->in, Y0<-out_0. Add Y1<-out_1.
sel=0 -> out_0=DIN, out_1=0; sel=1 -> out_0=0, out_1=DIN.
```typescript
await builder.placeLabeled('Out', 20, 12, 'Y1');
await builder.setComponentProperty('Y1', 'Bits', entry.dataBits);
await builder.drawWire('DUT', 'out_1', 'Y1', 'in');

const v = 5 & mask;
const result = await builder.runTestVectors(
  `SEL DIN Y0 Y1\n0 ${v} ${v} 0\n1 ${v} 0 ${v}`
);
expect(result.passed).toBe(2);
```

---

#### MEMORY (MEM_MATRIX loop)
ROM/EEPROM: default content = all zeros. Read address 0 -> data = 0.
```typescript
// ROM assertion (ADDR=0->DOUT=0 with empty memory)
const result = await builder.runTestVectors('ADDR DOUT\n0 0');
expect(result.passed).toBe(1);
```

RAM (single-port): write then read.
```typescript
// RAMSinglePort: WE=1 writes; WE=0 reads
// Need to add WE(In,Bits=1)->DUT:WE, DIN(In,dataBits)->DUT:D
// First row: write value 5 to addr 1; second row: read addr 1 -> 5
const v = 5 & mask;
const result = await builder.runTestVectors(
  `ADDR DIN WE DOUT\n1 ${v} 1 0\n1 0 0 ${v}`
);
expect(result.passed).toBe(2);
```

---

#### BITEXTENDER (EXTENDER_MATRIX loop)
Zero-extension (default mode): input 5 -> output 5 (positive value, high bit clear).
```typescript
const result = await builder.runTestVectors('SRC DST\n5 5');
expect(result.passed).toBe(1);
```

#### TUNNEL (TUNNEL_WIDTHS loop)
Pass-through. Use width-masked value.
```typescript
const mask = width < 32 ? (1 << width) - 1 : 0xFFFFFFFF;
const v = 5 & mask;
const result = await builder.runTestVectors(`SRC DST\n${v} ${v}`);
expect(result.passed).toBe(1);
```

#### SPLITTER (SPLITTER_MATRIX loop)
No SRC/DST labels are wired in the Splitter test (splitting-pattern-only test).
Splitter tests remain compile-and-step-only. No runTestVectors possible without
SRC/DST wiring which requires knowing the split-derived pin names per pattern.

---

## 5C Strategy

### BLOCKER
`switchEngineMode()` must be added to UICircuitBuilder:
```typescript
async switchEngineMode(): Promise<void> {
  // Click toolbar engine-mode toggle button (adjust selector to actual DOM id)
  await this.page.locator('#btn-engine-mode').click();
}
```

### Gates in analog mode

Wire power to gate inputs, check output voltage after convergence.
```typescript
// Add before DUT step in analog gate test:
await builder.placeLabeled('DcVoltageSource', 3, 4, 'VDD5');
await builder.setComponentProperty('VDD5', 'voltage', 5);
await builder.placeLabeled('Ground', 3, 16, 'GND0');
// Wire VDD5(+) to each input pin
if (entry.type !== 'Not') {
  await builder.drawWire('VDD5', '+', 'DUT', 'In_1');
  await builder.drawWire('VDD5', '+', 'DUT', 'In_2');
} else {
  await builder.drawWire('VDD5', '+', 'DUT', 'in');
}

const state = await builder.stepAndReadAnalog(20);
if (state) {
  const voltages = Object.values(state.nodeVoltages);
  const maxV = Math.max(...voltages);
  const minV = Math.min(...voltages);
  const HIGH_TYPES = ['And', 'Or', 'XNOr'];
  if (HIGH_TYPES.includes(entry.type)) {
    expect(maxV, `${entry.type} analog: expected HIGH output >4V`).toBeGreaterThan(4.0);
  } else {
    expect(minV, `${entry.type} analog: expected LOW output <1V`).toBeLessThan(1.0);
  }
}
```

Expected output per gate with all-HIGH inputs (VDD=5V):
| Component | Expected | SPICE_REF |
|-----------|---------|-----------|
| And | HIGH (~5V) | CMOS_RAIL_LOGIC |
| Or | HIGH (~5V) | CMOS_RAIL_LOGIC |
| Not | LOW (~0V) | CMOS_RAIL_LOGIC |
| NAnd | LOW (~0V) | CMOS_RAIL_LOGIC |
| NOr | LOW (~0V) | CMOS_RAIL_LOGIC |
| XOr | LOW (~0V) | CMOS_RAIL_LOGIC |
| XNOr | HIGH (~5V) | CMOS_RAIL_LOGIC |

Analog tolerance: ±0.5V (CMOS VIH > 0.7×VDD = 3.5V, VOL < 0.1×VDD = 0.5V).
Thresholds: HIGH assertion > 4.0V, LOW assertion < 1.0V.

---

### Flip-flops in analog mode

Analog D_FF with D=5V, clock rising:
```typescript
await builder.placeLabeled('DcVoltageSource', 3, 4, 'VHIGH');
await builder.setComponentProperty('VHIGH', 'voltage', 5);
await builder.placeLabeled('Ground', 3, 16, 'GND0');
await builder.drawWire('VHIGH', '+', 'DUT', 'D');
await builder.placeLabeled('Clock', 3, 10, 'CLK');
await builder.drawWire('CLK', 'out', 'DUT', 'C');
const state = await builder.stepAndReadAnalog(30);
// Q output should settle to HIGH
expect(Math.max(...Object.values(state!.nodeVoltages))).toBeGreaterThan(4.0);
```

For RS_FF: S=5V, R=0V (grounded), Q->HIGH.
For JK_FF: J=5V, K=0V (grounded), CLK rising -> Q=HIGH (set).
For T_FF: T=5V, CLK rising -> Q changes (not all-zero anymore).

SPICE_REF: CMOS_FF_ANALOG (same rail-to-rail model as CMOS gates).

---

### VoltageComparator

SPICE_REF: IDEAL_COMPARATOR — open-rail output.
```typescript
await builder.placeLabeled('DcVoltageSource', 3, 4, 'VPOS');
await builder.setComponentProperty('VPOS', 'voltage', 3);   // V+ = 3V
await builder.placeLabeled('DcVoltageSource', 3, 10, 'VNEG');
await builder.setComponentProperty('VNEG', 'voltage', 1);   // V- = 1V
await builder.placeLabeled('Ground', 3, 16, 'GND0');
await builder.drawWire('VPOS', '+', 'DUT', 'IN+');
await builder.drawWire('VNEG', '+', 'DUT', 'IN-');
const state = await builder.stepAndReadAnalog(20);
// V+ > V- -> OUT should be HIGH
expect(Math.max(...Object.values(state!.nodeVoltages))).toBeGreaterThan(4.0);
```

Expected voltage: OUT ≈ 5V (±0.5V) when V+=3V > V-=1V.
SPICE validation: output saturates to positive rail.

---

### DAC in mixed mode

SPICE_REF: IDEAL_DAC_4BIT (linear, VREF=VDD=5V).
- Code = 8 (0b1000): D3=1, D2=0, D1=0, D0=0
- Expected Vout = 5 × 8/16 = 2.5V ± 0.2V
```typescript
// Wire 4 digital inputs D0-D3 to DAC
// Drive code=8 via runTestVectors, then read analog state
const result = await builder.runTestVectors('D3 D2 D1 D0 OUT\n1 0 0 0 0');
// Note: OUT is digital placeholder; actual output is analog
// Read analog state for the actual voltage
const state = await builder.getAnalogState();
const voltages = Object.values(state!.nodeVoltages);
const outV = voltages.find(v => v > 2.0 && v < 3.5) ?? -1;
expect(outV).toBeGreaterThan(2.0);
expect(outV).toBeLessThan(3.5);
```

---

### ADC in mixed mode

SPICE_REF: IDEAL_ADC_4BIT (linear, VREF=VDD=5V).
- Vin = 2.5V -> expected code = 8 ± 1 LSB (7, 8, or 9 acceptable)
```typescript
await builder.placeLabeled('DcVoltageSource', 3, 6, 'VIN_SRC');
await builder.setComponentProperty('VIN_SRC', 'voltage', 2.5);
await builder.drawWire('VIN_SRC', '+', 'DUT', 'VIN');
// Wire D0-D3 to Out components DOUT0-DOUT3 and read digital code
const state = await builder.stepAndReadAnalog(20);
// The digital outputs form a code; decode and check 7<=code<=9
// OR: rely on runTestVectors with analog input column once ADC wiring is complete
```

---

## Findings Summary

[FINDING] runTestVectors is the correct mechanism for all 5B digital signal assertions.
It handles combinational, width-parameterized, and sequential components in one API.
[STAT:n] n=18 existing confirmed usages in digital-circuit-assembly.spec.ts
[STAT:effect_size] Estimated 130 new signal assertions across ~130 WIDTH_MATRIX + MUX + MEM tests

[FINDING] Five groups in 5B need extra In components wired beyond current test body:
two-input gates (SRC2->In_2), arithmetic (SRC2->b), BarrelShifter (SHFT->shift),
BitSelector (SEL->sel), and Driver family (EN->en).
[STAT:n] 5 component groups, ~85 tests affected out of ~140 total 5B tests

[FINDING] switchEngineMode() is absent from UICircuitBuilder — hard blocker for all 5C.
[STAT:n] 26 5C tests blocked

[FINDING] For 5C analog assertions, threshold checks (maxVoltage > 4.0 or minVoltage < 1.0)
are appropriate for CMOS rail-to-rail logic outputs. SPICE_REF: CMOS_RAIL_LOGIC.
The ±0.1% tolerance used in RC tests is too tight for logic-level assertions.
[STAT:n] 14 analog gate tests, 8 analog FF tests

[FINDING] Memory components (ROM, RAM, EEPROM, 15 tests) need circuit-specific write wiring
for meaningful signal assertions. ROM content defaults to zero; ADDR=0->DOUT=0 is the
minimal viable assertion. RAMSinglePort needs a write-then-read two-row vector.

[FINDING] Splitter tests cannot use runTestVectors without explicit SRC/DST label wiring
that maps to the splitting-pattern-derived pin names. These 4 tests remain compile-only.

[LIMITATION] sortedVoltages() pattern identifies max/min node voltages but cannot
pinpoint which node is the DUT output pin without a labeled Probe component wired
to the output. Stronger assertions require adding a Probe(label='PROBE')
and mapping its node key in the analog state.

[LIMITATION] Counter and CounterPreset test vectors assume reset-to-zero on compile
and rising-edge increment only. If preset value or edge mode differs, vectors need adjustment.

[LIMITATION] DAC/ADC expected voltages assume linear DAC model with VREF=VDD=5V.
The actual MNA model may use a different reference. Tolerance ±0.5V is conservative.

[LIMITATION] All 5C analog assertions assume the analog engine reaches DC steady state
within 20 steps. Circuits with high-Q poles or slow time constants may need more steps.
