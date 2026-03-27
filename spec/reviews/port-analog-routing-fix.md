# Port Label Resolution Fails in Analog Domain — Trace Report & Fix Spec

## Observation

In `src/headless/__tests__/port-analog-mixed.test.ts`, the test "readOutput() via Port label returns ~5V" (line 222) fails: `readOutput("P_read")` returns 0 instead of ~5V.

The circuit is: `DcVoltageSource(5V)` -- `Port("P_read")` -- `Resistor(1kOhm)` -- `Ground`. The voltage at the Port node should be 5V (DcVoltageSource stamps the node directly). The call does not throw (the label IS found in `labelSignalMap`), but the resolved signal value is 0.

The other 5 tests in the file pass: Port compiles in analog context, is skipped from MNA matrix, appears in netlist, and the label IS present in `readAllSignals()`.

---

## Root Cause (confirmed)

The Port label "P_read" is resolved to a **digital** `SignalAddress` instead of an **analog** one. The digital net has value 0 because no digital simulation drives it. The analog MNA solver correctly computes 5V at the node, but nothing maps the label to that analog node.

### Two Independent Bugs Combine

**Bug 1: Port is routed exclusively to the digital partition (not analog)**

In `src/compile/partition.ts` lines 164-181, neutral components are routed based on `hasAnalogModel(def)`:

```typescript
if (ma.modelKey === "neutral") {
  if (hasAnalogModel(def)) {    // <-- Port has models: {}, so this is FALSE
    analogComponents.push(partComp);
    if (hasDigitalModel(def)) { digitalComponents.push(partComp); }
  } else {
    digitalComponents.push(partComp);  // <-- Port goes here ONLY
  }
}
```

Port's definition has `models: {}` (empty object). Both `hasAnalogModel()` and `hasDigitalModel()` return false. So Port is routed exclusively to `digitalComponents`. It never enters `analogComponents`.

This means the analog compiler's `buildAnalogNodeMapFromPartition()` never sees Port in `partition.components`, so it cannot build a label mapping for it.

**Bug 2: `buildAnalogNodeMapFromPartition` omits "Port" from its `labelTypes` set**

Even if Bug 1 were fixed, the analog partition compiler at `src/solver/analog/compiler.ts` line 1744 would still miss Port:

```typescript
const labelTypes = new Set(["In", "Out", "Probe", "in", "out", "probe"]);
//                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                          "Port" is MISSING
```

The standalone `compileAnalogCircuit()` function at line 621 DOES include "Port":
```typescript
const labelTypes = new Set(["In", "Out", "Probe", "in", "out", "probe", "Port"]);
```

But `DefaultSimulatorFacade.compile()` uses the unified pipeline (`compileUnified` in `src/compile/compile.ts`), which calls `compileAnalogPartition` (not `compileAnalogCircuit`). So the partition path is always taken, and Port labels are never resolved.

**Bug 3 (consequence): Digital label takes precedence in `labelSignalMap`**

In `src/compile/compile.ts` lines 326-342, the digital compiler's `labelToNetId` is written first. The digital compiler at `src/solver/digital/compiler.ts` line 719 DOES include "Port" in its `LABELED_TYPES` set. So "P_read" gets a digital `SignalAddress`:

```typescript
labelSignalMap.set(label, { domain: "digital", netId, bitWidth });
```

The analog compiler's `labelToNodeId` (even if it contained "P_read") would be skipped due to the precedence rule at line 338:
```typescript
if (!labelSignalMap.has(label)) {  // already set by digital -- skipped
  labelSignalMap.set(label, { domain: "analog", nodeId });
}
```

### Complete Causal Chain

```
Port.models = {}
  -> resolveModelAssignments: modelKey = "neutral" (INFRASTRUCTURE_TYPES path)
  -> partitionByDomain: hasAnalogModel({}) = false -> digitalComponents only
  -> digital compiler: LABELED_TYPES includes "Port" -> labelToNetId["P_read"] = netId N
  -> analog compiler: Port not in partition.components AND not in labelTypes -> no analog mapping
  -> compile.ts step 9: digital label set first; analog would be skipped anyway
  -> labelSignalMap["P_read"] = { domain: "digital", netId: N, bitWidth: 1 }
  -> readOutput("P_read") reads digital net N -> value 0 (no digital driver)
```

### Why Test 5 ("P_probe in signals") Passes

`readAllSignals()` iterates over `labelSignalMap`. The label "P_probe" IS in the map (from the digital compiler). It resolves to the digital net value (0). The test only checks `'P_probe' in signals` (key existence), not the actual voltage. So it passes despite the value being wrong.

---

## What the Spec Claims vs Reality

`spec/subcircuit-extraction.md` (line 51) states:

> The partitioner routes infrastructure components based on their connectivity group's domain: analog group -> analog partition, digital group -> digital partition, mixed group -> both partitions.

**This claim is false.** The partitioner routes neutral infrastructure based on `hasAnalogModel(def)` / `hasDigitalModel(def)` — it checks the component definition's model declarations, NOT the connectivity group's domain. Port has `models: {}`, so it always goes to digital regardless of what it connects to.

Ground, VDD, and Probe work correctly because they DO have analog models declared (`models: { analog: {...} }`). Port is the only neutral infrastructure component that has truly empty models.

---

## Decision Points That Determine Port's Routing

| # | Location | Check | Current Result | Correct Result |
|---|----------|-------|----------------|----------------|
| 1 | `extract-connectivity.ts:22` | `INFRASTRUCTURE_TYPES.has("Port")` | true -> modelKey="neutral" | Correct |
| 2 | `partition.ts:170` | `hasAnalogModel(PortDef)` | false (models={}) | Should be true OR routing should use group domain |
| 3 | `partition.ts:179` | else branch | Port -> digitalComponents only | Port should go to analog when connected to analog |
| 4 | `partition.ts:215-219` | `isNeutralOnly` group check | Group has analog pins from Resistor, so group goes to analogGroups | Correct (group is in analog) |
| 5 | `analog/compiler.ts:1744` | `labelTypes.has("Port")` | false | Should be true |
| 6 | `digital/compiler.ts:719` | `LABELED_TYPES.has("Port")` | true -> digital label mapping created | Depends on fix option |
| 7 | `compile.ts:337` | `!labelSignalMap.has(label)` | false (digital set it) | Analog should take precedence for analog-domain Ports |

---

## Fix Options

### Option A: Route Port by connectivity-group domain in the partitioner

**Concept**: Instead of checking `hasAnalogModel(def)`, add a secondary routing path for neutral components that checks whether ANY of their pins' connectivity groups are in the analog domain.

**Files changed**:
- `src/compile/partition.ts` — Add group-domain check for neutral components with empty models
- `src/solver/analog/compiler.ts` line 1744 — Add "Port" to `labelTypes`

**Implementation sketch** (partition.ts, neutral branch):
```typescript
if (hasAnalogModel(def)) {
  analogComponents.push(partComp);
  if (hasDigitalModel(def)) digitalComponents.push(partComp);
} else {
  // Check if any of this component's pins belong to an analog-domain group
  const touchesAnalog = resolvedPins.some(rp => {
    const g = groups.find(g => g.pins.some(p =>
      p.elementIndex === i && p.pinIndex === rp.pinIndex));
    return g !== undefined && g.domains.has("analog");
  });
  if (touchesAnalog) {
    analogComponents.push(partComp);
  }
  digitalComponents.push(partComp); // always include in digital for wiring
}
```

**Pros**: Matches the spec's stated intent. Group-domain inspection is the correct abstraction. Works for any future neutral component.

**Cons**: O(components x groups x pins) lookup — could be optimized with a prebuilt index. Adds complexity to the partitioner's neutral-routing logic. Port ends up in BOTH partitions, which is arguably correct but needs testing.

**Blast radius**: Medium. Partition.ts neutral routing changes affect all infrastructure components, but only those with `models: {}` and analog-domain connections take the new path. Currently only Port qualifies.

**Edge case — Port at cross-domain boundary**: If Port connects to both digital AND analog components, its group has `domains = {"digital", "analog"}` and is a boundary group. Port would go to both partitions (correct). Both compilers would create label entries. The precedence rule in compile.ts step 9 (digital wins) needs to be revisited — analog should win when the group is analog-only, digital should win when digital-only, and for boundary groups the behavior depends on the use case.

### Option B: Add Port to both partitions unconditionally (like Bridge components)

**Concept**: In the neutral routing branch of partition.ts, always push Port to both `analogComponents` and `digitalComponents`.

**Files changed**:
- `src/compile/partition.ts` — Special-case Port in neutral routing
- `src/solver/analog/compiler.ts` line 1744 — Add "Port" to `labelTypes`

**Pros**: Simple. No group-domain lookup needed.

**Cons**: Port appears in both partitions even when the circuit is pure digital (unnecessary). Does not generalize — any future neutral component with the same problem needs its own special case.

**Blast radius**: Low. Only Port is affected. Digital compiler already handles Port in LABELED_TYPES.

**Edge case**: In a pure-digital circuit, Port would appear in the analog partition's components. But if the analog partition has no groups (no analog components to create groups), the analog compiler won't be invoked (compile.ts line 182-183 checks `analogPartition.components.length > 0`). This could cause a spurious analog compilation for pure-digital circuits with Ports. Needs a guard.

### Option C: Give Port a minimal analog model stub

**Concept**: Change `PortDefinition.models` from `{}` to `{ analog: { type: 'passthrough' } }` (or similar sentinel). This makes `hasAnalogModel(def)` return true, routing Port to the analog partition via the existing neutral path.

**Files changed**:
- `src/components/io/port.ts` — Add analog model stub to `PortDefinition.models`
- `src/solver/analog/compiler.ts` line 1744 — Add "Port" to `labelTypes`
- `src/solver/analog/compiler.ts` — Add "passthrough" handling to skip Port during MNA stamping (if not already skipped)

**Pros**: Leverages the existing routing logic with no changes to the partitioner. Matches how Ground/VDD/Probe work.

**Cons**: Port is supposed to be "neutral infrastructure with no simulation model" (per the spec and the component's own docstring). Adding a model contradicts the design intent. The spec explicitly argues against giving Port models (see `spec/subcircuit-extraction.md` lines 44-49). The analog compiler would need to know to skip the "passthrough" model during MNA stamping.

**Blast radius**: Low-medium. Port.ts model change + analog compiler skip logic.

### Option D: Fix only the labelToNodeId gap in the analog partition compiler (minimal fix)

**Concept**: Don't change Port's partition routing at all. Instead, in `buildAnalogNodeMapFromPartition`, iterate over ALL elements in the circuit (not just partition.components) to find Port labels, and map them to analog nodes using position lookup.

**Files changed**:
- `src/solver/analog/compiler.ts` — Pass circuit elements to `buildAnalogNodeMapFromPartition`; scan for Port labels using position-to-nodeId
- `src/compile/compile.ts` — Adjust labelSignalMap precedence: for labels that exist in BOTH digital and analog, prefer the one whose domain matches the group's domain

**Pros**: Minimal change to existing routing. Port stays in digital partition (existing behavior preserved). Only the label resolution is fixed.

**Cons**: Fragile — the analog compiler reaches outside its partition to find labels, breaking the partition abstraction. Does not fix the underlying routing incorrectness. If any future code depends on Port being in the analog partition's components, it will break.

**Blast radius**: Low. Only the label mapping path changes.

---

## Recommendation: Option A (group-domain routing) + labelTypes fix

**Rationale**:

1. Option A is the only fix that matches the spec's stated design: "the partitioner routes infrastructure components based on their connectivity group's domain." The spec is correct in principle; the implementation just never implemented that claim for components with empty models.

2. The `labelTypes` fix in `buildAnalogNodeMapFromPartition` (adding "Port") is independently necessary regardless of which routing option is chosen. The standalone `compileAnalogCircuit()` already includes "Port" — the partition path is simply missing it.

3. Option C (adding a model) directly contradicts the design rationale in `spec/subcircuit-extraction.md`. The spec argues convincingly that Port should not have domain-specific models.

4. Option D is a targeted patch that fixes the symptom without fixing the underlying routing bug. It would leave Port absent from the analog partition's components, which could cause other issues as the codebase evolves.

**Implementation plan**:

1. **`src/compile/partition.ts`**: In the neutral-routing branch (line 164-181), add group-domain inspection for components where `!hasAnalogModel(def) && !hasDigitalModel(def)`. Build a precomputed `elementIndex -> Set<domain>` map from groups to avoid O(n^2) lookup.

2. **`src/solver/analog/compiler.ts` line 1744**: Add "Port" to `labelTypes` set in `buildAnalogNodeMapFromPartition`.

3. **`src/compile/compile.ts` lines 326-342**: Revisit the digital-takes-precedence rule for labelSignalMap. When a label exists in both digital and analog `labelTo*Id` maps, prefer the analog mapping when the label's connectivity group is analog-only (or has analog domain). This prevents the digital compiler's spurious Port mapping from shadowing the correct analog one.

4. **Tests to update**: The test at line 219 (`'P_probe' in signals`) should be strengthened to also check the voltage value (currently it only checks key existence and would pass even with the wrong value).

**Files changed (summary)**:
| File | Change |
|------|--------|
| `src/compile/partition.ts` | Group-domain routing for neutral empty-model components |
| `src/solver/analog/compiler.ts` | Add "Port" to labelTypes in `buildAnalogNodeMapFromPartition` |
| `src/compile/compile.ts` | Fix labelSignalMap precedence for analog-domain labels |
| `src/headless/__tests__/port-analog-mixed.test.ts` | Strengthen test 5 to check voltage value |

**Edge cases to test**:
- Port in pure-digital circuit (no analog components) — Port stays in digital only, no regression
- Port at cross-domain boundary (connected to both And gate and Resistor) — Port in both partitions, label resolves to correct domain
- Multiple Ports with same label (label-collision diagnostic should fire)
- Port connected only to other neutral components (Tunnel chain) — group is neutral-only, Port stays in digital

---

## Critical Unknown

Whether Port appearing in both digital and analog partitions simultaneously causes any issues in the digital compiler (duplicate element processing, double-counting in net assignment). The digital compiler's `compileDigitalPartition` processes `partitionedComponents` — if Port is in both, it gets compiled by both backends.

**Discriminating probe**: Add Port to analogComponents in the partition for the failing test circuit, run both compilers, and check whether the digital compiler produces errors or corrupted state when the same element appears in both partitions. This can be tested by temporarily modifying the partition routing and running the full test suite.
