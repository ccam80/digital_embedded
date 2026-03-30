# Bridge Synthesis Fix — Design Document

## Design Intent (from project owner)

> "All digital models should be evaluated in the digital engine. If a pin is 'loaded', through circuit-wide settings overridden by net-level overrides, a bridge should be added at the pin."

## Root Cause

Bridge synthesis was implemented as component reclassification (move digital components to analog) instead of per-net loading decisions (stamp bridge adapters at loaded nets). Components should never change partition; only nets should gain bridge adapters.

## Five Bugs

1. **`isDualModel` gate** (`partition.ts:160-166`) — Moves only dual-model digital components to analog, excluding pure-digital components. **SCRUBBED.**
2. **Group rerouting** (`partition.ts:233-239`) — Only adds digital groups to analogGroups if they touch rerouted components. **SCRUBBED.**
3. **Boundary-only bridges** (`partition.ts:242-253`) — BridgeDescriptors only created for `domains.size > 1`. Pure-digital nets in `"all"` mode never get bridges.
4. **Component-level bridge route** (`compiler.ts:82-94`) — Returns `'bridge'` for digital components in analog partition, triggering per-component `synthesizeDigitalCircuit` instead of per-net adapters.
5. **`perNetLoadingOverrides` unused** (`partition.ts:103`) — Parameter accepted but never referenced in partition logic.

## Fix

### partition.ts — Rewrite bridge descriptor creation

Replace boundary-only check with per-net loading decision:

```typescript
for (const g of groups) {
  // ... existing digitalGroups/analogGroups classification ...

  if (!hasDigital) continue;  // Only digital nets can have bridges

  const netOverride = perNetLoadingOverrides?.get(g.groupId);
  let isLoaded: boolean;

  if (netOverride !== undefined) {
    isLoaded = (netOverride === "loaded");
  } else {
    switch (digitalPinLoading) {
      case "all":          isLoaded = true; break;
      case "none":         isLoaded = false; break;
      case "cross-domain": isLoaded = isBoundary; break;
    }
  }

  if (isLoaded) {
    const direction = bridgeDirection(g);
    const electricalSpec = electricalSpecForGroup(g, elements, registry);
    const bitWidth = g.bitWidth ?? 1;
    bridges.push({ boundaryGroup: g, direction, bitWidth, electricalSpec });

    // Loaded digital-only nets must appear in analogGroups for MNA stamping
    if (!hasAnalog) {
      analogGroups.push(g);
    }
  }
}
```

### compiler.ts — Simplify resolveComponentRoute

Digital components are never in the analog partition:

```typescript
if (pc.modelKey === "digital") {
  return { kind: 'skip' };  // Digital components run in digital engine only
}
```

Add per-net bridge adapter stamping after the component loop. For each bridge descriptor, iterate digital-domain pins and create BridgeInputAdapter/BridgeOutputAdapter per pin direction.

### compile.ts — Fix analog partition guard

```typescript
const hasAnalog = analogPartition.components.length > 0 ||
                  analogPartition.bridgeStubs.length > 0;
```

Ensure Ground is routed to analog partition when loaded nets exist.

## Edge Cases

| Case | Behavior |
|------|----------|
| Pure-digital circuit, `"all"` mode | All components stay digital. Every net gets bridge. Analog partition has bridge stubs only. |
| Per-net `"loaded"` override on digital-only net in `"cross-domain"` | Bridge created on that net. Net added to analogGroups. |
| Per-net `"ideal"` override on boundary in `"cross-domain"` | Bridge suppressed on that net. |
| Per-net `"loaded"` override in `"none"` mode | Override wins. Bridge on that net only. |

## Tests That Encode Wrong Behavior

| Test file | Current assertion (wrong) | Correct assertion |
|-----------|--------------------------|-------------------|
| `digital-pin-loading.test.ts` | "all mode: dual-model component gets one bridge" | Per-net bridges on each net touching a digital component |
| `pin-loading-menu.test.ts` | "all mode routes dual-model components to analog partition" | Components stay in digital; bridge count increases |
| `digital-bridge-path.test.ts` | Per-component synthesizeDigitalCircuit path | CrossEngineBoundary tests remain valid; inline bridge tests need rewrite |

## Migration Path

**Phase 1 (atomic):** Remove isDualModel, add per-net bridge logic, simplify compiler routing, fix compile.ts guard, rewrite ~6 test files. Touches 3 source files.

**Phase 2 (follow-up):** Remove dead code (synthesizeDigitalCircuit, 'bridge' route).

**Phase 3 (follow-up):** Pure-digital "all" mode Ground routing.
