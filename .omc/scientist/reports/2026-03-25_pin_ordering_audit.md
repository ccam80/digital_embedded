# Pin Ordering Audit -- Post-Unification

**Date:** 2026-03-25
**Scope:** All production TypeScript under src/ (tests excluded)
**Purpose:** Identify every location where pin order is established, re-established,
or assumed by index rather than flowing canonically from pinLayout.

---

## Audit Methodology

Grep patterns executed:
- nodeIndices[ -- positional index reads
- .nodeIndices  -- property access on AnalogElement
- gateNode|drainNode|sourceNode|nodeB|nodeC|nodeE
- inBase + k | outBase + k -- digital executeFn positional offset reads
- nodeIds[ -- positional reads on flat nodeIds arrays (comments + factories)
- pinNodes.get -- label-based access (acceptable pattern, audited for misuse)

---

## Category A -- CRITICAL: Positional index reads that could produce wrong results

### A1 -- src/editor/analog-tooltip.ts:215

Pattern: Positional assumption on nodeIndices

  let pinIdx = 0;
  for (const p of pins) {
    if (p.label === pinLabel) break;
    pinIdx++;
  }
  const nodeId = analogEl.nodeIndices[pinIdx] ?? analogEl.nodeIndices[0];

What it does: Walks getPins() order to find a label, then uses the resulting index
directly into nodeIndices. This assumes getPins() order == nodeIndices order, which
was the original bug the refactor was designed to fix. For 2-pin elements it is
accidentally correct. For BJT/FET (nodeIndices is in pinLayout order [B,C,E] /
[G,S,D] but getPins() may return a different order for rotated/mirrored elements
at render time) this returns the wrong node's voltage.

Severity: CRITICAL -- will show voltage of wrong pin in tooltip for 3-terminal
devices when the element is rotated.

Can it be eliminated? YES. The compiler stores elementResolvedPins keyed by element
index. Look up element index, get ResolvedPin[], find the pin with matching label,
use resolvedPin.nodeId directly. No index arithmetic needed.

---

### A2 -- src/analog/analog-engine.ts:343-345 (BDF-2 history push)

Pattern: Positional assumption -- nodeIndices[0] and [1] assumed to be the two
primary terminals of any reactive element.

  if (el.isReactive && (el.nodeIndices?.length ?? 0) >= 2) {
    const nA = el.nodeIndices[0];
    const nB = el.nodeIndices[1];
    // records vA - vB as the element voltage history

What it does: Computes the voltage across pin[0] and pin[1] for BDF-2 timestep
control. For crystals (nodeIndices = [nA, nB, n1_internal, n2_internal]), [0] and
[1] happen to be the external terminals -- correct today. This is an implicit
contract: any new reactive element that places internal nodes first would silently
compute a wrong voltage for BDF-2 history.

Severity: MODERATE -- currently correct for all existing reactive elements, fragile
for future additions.

Can it be eliminated? YES. After pinNodeIds/internalNodeIds split, use
el.pinNodeIds[0] and el.pinNodeIds[1].

---

### A3 -- src/analog/analog-engine.ts:586-608 (getElementPinCurrents + getElementPower)

Pattern: Positional assumption -- nodeIndices[0] and [1] as positive/negative terminal.

  // getElementPinCurrents 2-terminal fallback:
  if (el.nodeIndices.length === 2) {
    const I = this.getElementCurrent(elementId);
    return [I, -I];   // convention: I flows node[0] -> node[1]
  }

  // getElementPower:
  const nA = el.nodeIndices[0] ?? 0;
  const nB = el.nodeIndices[1] ?? 0;
  const vAB = vA - vB;

getElementPower has no nodeIndices.length === 2 guard, so any element with
nodeIndices.length >= 2 (including internal-node elements like crystals or
polarized caps) will have power calculated from the first two nodes regardless of
how many there are.

Severity: MODERATE -- currently correct for 2-terminal elements; the unguarded
getElementPower is a latent bug for multi-node elements whose pin[0]/pin[1] are
not the "primary" terminals.

Can it be eliminated? YES. After pinNodeIds/internalNodeIds split, use
el.pinNodeIds[0] and el.pinNodeIds[1] with a guard on pinNodeIds.length >= 2.

---

### A4 -- src/editor/wire-current-resolver.ts:146 and 220

Pattern: nodeIndices.length used as proxy for "external pin count".

  } else if (elements[eIdx].nodeIndices.length === 2) { // line 146
  if (pinCurrents !== null && elements[eIdx].nodeIndices.length > 2) { // line 220

What it does: The > 2 guard routes multi-pin elements to the source/sink
path-drawing code. For crystals, nodeIndices.length is 4 (2 external + 2 internal)
but getPinCurrents() returns length-2 (external only). The Math.min in the inner
loop (line 232) bounds the iteration to min(pinCurrents.length, cePins.length),
preventing out-of-bounds access. Functionally safe but conceptually wrong: the
guard should test the number of external pins, not total nodeIndices length.

Severity: LOW (functionally) / MODERATE (conceptually) -- Math.min saves it, but
the branch intent is incorrect. After pinNodeIds split, the guard should be
el.pinNodeIds.length.

Can it be eliminated? YES. Change both guards to el.pinNodeIds.length.

---

## Category B -- MODERATE: Element classes that receive pre-ordered nodeIndices arrays

These element classes take their node IDs as a positional array constructor
parameter. The factory (caller) is responsible for building the array in the
correct order. This is a "passed-as-parameter" ordering contract.

### B1 -- src/components/passives/analog-fuse.ts:103-111

  constructor(nodeIndices: number[], ...) {
    this.nodeIndices = nodeIndices;

Factory call:
  new AnalogFuseElement([pinNodes.get("out1")!, pinNodes.get("out2")!], ...)

Factory correctly uses label-based access. Internal class uses nodeIndices[0]=nPos,
[1]=nNeg by convention documented in a comment.

Severity: MODERATE -- self-consistent, but the semantic contract is in a comment,
not the type signature.

Can it be eliminated? YES. Constructor could accept (nPos: number, nNeg: number)
instead of an array.

---

### B2 -- src/components/passives/crystal.ts:251

  constructor(nodeIndices: number[], ...) {
    this.nodeIndices = nodeIndices;

Factory call:
  [pinNodes.get("A")!, pinNodes.get("B")!, internalNodeIds[0], internalNodeIds[1]]

Mix of pin nodes (label-derived) and internal nodes (positional within
internalNodeIds). Internal node indexing ([0], [1]) is acceptable per plan since
the factory both declares the count and consumes them.

Severity: MODERATE -- same as B1.

Can it be eliminated? YES. Constructor (nA, nB, n1, n2, branchIdx, ...) would
be self-documenting.

---

### B3 -- polarized-cap.ts:252, potentiometer.ts:226, transformer.ts:207, tapped-transformer.ts:233

Same pattern as B1/B2. All constructed by factories using pinNodes.get(label)
for external pins plus internalNodeIds for internal nodes. All currently correct.

Severity: MODERATE. Mitigation: named constructor parameters.

---

### B4 -- src/components/passives/transmission-line.ts:417-455

TransmissionLineElement constructor receives nodeIds: number[] and uses:
  rlMidNodes.push(nodeIds[2 + k]);
  junctionNodes.push(nodeIds[2 + (N - 1) + k]);
  nodeIds[0]  // Port1
  nodeIds[1]  // Port2

Factory builds:
  const nodeIds = [pinNodes.get("P1b")!, pinNodes.get("P2b")!, ...internalNodeIds];

Factory correctly uses label-based access for pin nodes. The internal node
indexing (nodeIds[2+k]) is a positional assumption about the layout of
internalNodeIds, acceptable because the same factory declares getInternalNodeCount
and TransmissionLineElement consumes them.

Severity: MODERATE. Partially eliminated by separating (port1, port2,
internalNodes) parameters.

---

## Category C -- LOW (Acceptable or infrastructure): Uniform iteration without pin semantics

### C1 -- dc-operating-point.ts:333, newton-raphson.ts:232

  for (const n of (el.nodeIndices ?? [])) { ... }

Iterating all nodes uniformly to check convergence deltas or count terminal usage.
No positional semantics assumed.

Severity: LOW -- acceptable iteration.

---

### C2 -- analog/compiler.ts:602-628

Handles transistor expansion sub-elements. These are private to the transistor
model and have no external pinLayout. The compiler synthesizes ResolvedPin entries
with placeholder labels ("node0", "node1", ...). Acknowledged in comment:
"Expansion elements have no pinLayout -- use nodeIndices positionally."

Severity: LOW -- documented exception.

---

### C3 -- analog/compiler.ts:733,741

  topologyInfo.push({ nodeIds: Array.from(adapter.nodeIndices), ... });

Bridge adapters have nodeIndices = [pinModel.nodeId] -- one node. Passed to
topology analysis for weak-node detection, which iterates all nodes uniformly.

Severity: LOW -- single-element array, no positional semantics.

---

### C4 -- analog/bridge-adapter.ts:60,185

  this.nodeIndices = [pinModel.nodeId];

Single-pin pseudo-elements. nodeIndices[0] is the only node.

Severity: LOW -- acceptable.

---

### C5 -- analog/fet-base.ts:237

  for (let i = 3; i < this.nodeIndices.length; i++) {
    result.push(0);  // pad extra bulk/body nodes in getPinCurrents
  }

Positional loop that pads current=0 for any nodes beyond the first 3 (gate,
drain, source). For 4-terminal MOSFETs the bulk current is correctly zero.

Severity: LOW -- physically correct, but iterates nodeIndices.length instead of
pinLayout.length. After pinNodeIds/internalNodeIds split, use pinNodeIds.length.

---

### C6 -- app/app-init.ts:3001

  watchedSignals.push({ ..., netId: nodeIds[0], ... });

nodeIds[0] for a voltage probe. Probes have exactly one pin; [0] is the only
meaningful choice.

Severity: LOW -- N/A, probe has 1 pin.

---

### C7 -- app/app-init.ts:3142

  if (!analogEl.nodeIndices.includes(sig.netId)) continue;

Membership test -- "does this element touch this net?" No positional semantics.

Severity: LOW -- acceptable.

---

## Category D -- LOW: Stale comments documenting old nodeIds[i] protocol

After Phase B migration, factory functions correctly use pinNodes.get(label),
but the file-level and per-class docstrings in the following files still document
the old "nodeIds[i] = PinName" positional protocol:

  D1: src/analog/behavioral-combinational.ts:50-52, 176-178, 285-286
      "nodeIds[0] = sel ..."
  D2: src/analog/behavioral-flipflop-variants.ts:10-16, 852-1036
      "JK: nodeIds[0]=J, nodeIds[1]=C, ..."
  D3: src/analog/behavioral-flipflop.ts:286-289
      "nodeIds[0] = D input node ..."
  D4: src/analog/behavioral-remaining.ts:476-478, 600-604, 692-696
      relay and optocoupler nodeIds[i] lists
  D5: src/analog/behavioral-sequential.ts:356-360
      counter nodeIds[i] list
  D6: src/components/active/comparator.ts:28-30, real-opamp.ts:272-276, timer-555.ts:45
      component class docstrings with nodeIds[i] mapping

Severity: LOW -- stale documentation only, code is correct. Misleading to
future maintainers.

Fix: Replace "nodeIds[i]=..." docstrings with "pins accessed by label via
pinNodes.get(...) in factory; nodeIndices is set by compiler in pinLayout order."

---

## Category E -- MODERATE: Digital executeFn positional contract (Phase C open work)

### E1 -- All asymmetric digital components (~30+ files)

  const inBase = layout.inputOffset(index);
  const a  = state[wt[inBase]];      // first input
  const b  = state[wt[inBase + 1]];  // second input
  const ci = state[wt[inBase + 2]];  // carry-in

Pattern: executeFn bodies read inputs by offset, implicitly assuming
inBase+0=A, inBase+1=B, inBase+2=Cin (or equivalent for each component type).
This is the Phase C concern in the plan: if pinLayout is reordered for an
asymmetric component without adding/updating inputSchema, the executeFn silently
reads the wrong signal.

Phase C (inputSchema/outputSchema on component definitions, compiler uses schema
when present) is marked "In progress (separate agent)" in the plan. This pattern
is therefore expected open work, not an oversight.

Severity: MODERATE -- affects all asymmetric components (adder, mux, flipflop,
RAM, ROM, counter, register, comparator, priority-encoder, barrel-shifter, and
~20 more). Not a present bug since pinLayout has not been reordered, but a
latent fragility until Phase C completes.

Can it be eliminated? YES -- this is exactly Phase C. Each asymmetric component
needs inputSchema: ["A", "B", "Cin"] (adder example) in ComponentDefinition.
Digital compiler builds wiring table from schema instead of getPins() iteration
order. No executeFn bodies change.

---

## Summary Table

| ID  | File(s)                                     | Pattern                                        | Severity | Eliminable? |
|-----|---------------------------------------------|------------------------------------------------|----------|-------------|
| A1  | editor/analog-tooltip.ts:215                | getPins() walk + nodeIndices[idx] index        | CRITICAL | YES         |
| A2  | analog/analog-engine.ts:343-345             | nodeIndices[0,1] = primary reactive terminals  | MODERATE | YES         |
| A3  | analog/analog-engine.ts:586-608             | nodeIndices[0,1] for power/current             | MODERATE | YES         |
| A4  | editor/wire-current-resolver.ts:146,220     | nodeIndices.length as external-pin-count proxy | LOW-MOD  | YES         |
| B1  | passives/analog-fuse.ts:103                 | Array constructor [nPos, nNeg]                 | MODERATE | PARTIALLY   |
| B2  | passives/crystal.ts:251                     | Array constructor [nA, nB, n1, n2]             | MODERATE | PARTIALLY   |
| B3  | polarized-cap:252, potentiometer:226,       | Same as B1/B2                                  | MODERATE | PARTIALLY   |
|     | transformer:207, tapped-transformer:233     |                                                |          |             |
| B4  | passives/transmission-line.ts:417-455       | nodeIds[2+k] for internal node layout          | MODERATE | PARTIALLY   |
| C1  | dc-operating-point.ts:333, newton-R:232     | Uniform for-of iteration                       | LOW      | N/A         |
| C2  | analog/compiler.ts:602-628                  | Expansion sub-elements (documented exception)  | LOW      | N/A         |
| C3  | analog/compiler.ts:733,741                  | Single-node bridge adapters                    | LOW      | N/A         |
| C4  | analog/bridge-adapter.ts:60,185             | Single-node nodeIndices = [nodeId]             | LOW      | N/A         |
| C5  | analog/fet-base.ts:237                      | Pad loop i>=3 in getPinCurrents                | LOW      | YES         |
| C6  | app/app-init.ts:3001                        | nodeIds[0] for single-pin probe                | LOW      | N/A         |
| C7  | app/app-init.ts:3142                        | .includes() membership test                    | LOW      | N/A         |
| D1-D6 | behavioral-*.ts, active/*.ts             | Stale nodeIds[i] docstrings post-Phase-B       | LOW      | YES (docs)  |
| E1  | All asymmetric digital components (~30)     | inBase+k positional contract (Phase C open)    | MODERATE | YES (Ph.C)  |

---

## Priority Action Items

1. CRITICAL -- Fix editor/analog-tooltip.ts:215 immediately.
   Real user-visible bug: pin voltage tooltip is wrong for rotated 3-terminal
   devices. Replace getPins() walk + nodeIndices[pinIdx] with elementResolvedPins
   lookup by label.

2. MODERATE -- Execute Phase C (inputSchema/outputSchema on all ~30 asymmetric
   digital components). Largest remaining open work item. Latent fragility for
   any future pinLayout reordering.

3. MODERATE -- Complete nodeIndices -> pinNodeIds rename (Phase D cleanup).
   Once renamed, A2, A3, A4, and C5 all become self-documenting or trivially
   corrected. Also adds a guard that separates external-pin count from
   internal-node count in wire-current-resolver.ts.

4. LOW -- Sweep stale comments in D1-D6. One pass to replace nodeIds[i]=...
   docstrings with pinNodes.get("label") descriptions.

5. LOW -- Refactor B-class constructors from positional array params to named
   params for AnalogFuseElement, AnalogCrystalElement, PolarizedCapElement,
   PotentiometerElement, TransformerElement, TappedTransformerElement.
   Low risk, improves clarity, eliminates last sites where ordering is expressed
   in a call-site array literal.
