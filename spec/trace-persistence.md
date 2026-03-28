# Trace Persistence — Save/Restore Watched Signals and Display Settings

## Problem

Watched signals (scope traces) are transient runtime state in `ViewerController`. Lost on reload. Users must manually re-add and reconfigure every signal after every load.

## What to Persist

The full signal identity **and** all display settings. Each saved trace captures everything needed to reconstruct a scope channel exactly as the user left it.

```ts
interface SavedTrace {
  /** Re-resolution key: "label" for labeled signals, "instanceId:pinLabel" for unlabeled. */
  name: string;
  domain: "digital" | "analog";
  panelIndex: number;
  group: SignalGroup;              // reuse existing type from data-table.ts
  // Display settings (from ScopeChannel)
  color: string;                   // hex color
  autoRange: boolean;
  yMin: number;
  yMax: number;
  overlays: OverlayKind[];         // serialized from Set<OverlayKind>
  vdd: number | null;              // VDD level for digital channels
}
```

Panel-level FFT state is saved alongside:

```ts
interface SavedPanel {
  panelIndex: number;
  fftEnabled: boolean;
  fftChannelLabel: string | null;
}
```

Declare `SavedTrace` and `SavedPanel` in `src/core/circuit.ts` alongside `CircuitMetadata`.

## Signal Addressing — Pin-Level Resolution

Compiler-assigned `netId`/`nodeId` are integers that change on recompile. **Not persisted.**

Two resolution maps exist in `CompiledModel` (`compile/types.ts`):
- `labelSignalMap`: `"label"` → `SignalAddress` (for In/Out/Probe components)
- `pinSignalMap`: `"instanceId:pinLabel"` → `SignalAddress` (for any component pin)

**Resolution strategy on restore:**

1. Try `labelSignalMap.get(trace.name)` — covers labeled signals.
2. If not found, try `pinSignalMap.get(trace.name)` — covers unlabeled component pins.
3. If neither resolves, log a warning and skip.

**Save strategy:** When persisting, use the label if one exists in `labelSignalMap` (reverse-lookup by address). Otherwise use the `instanceId:pinLabel` key from `pinSignalMap`. The `instanceId` is stable across saves (it's a circuit property, not compiler-assigned). Since files are not modified between save and load, all signals reliably survive.

The existing `resolveWatchedSignalAddresses` function at `viewer-controller.ts` currently only checks `labelSignalMap`. It must be extended to also check `pinSignalMap` as a fallback.

## Schema Addition

### CircuitMetadata (`circuit.ts`)
```ts
traces?: SavedTrace[];
panels?: SavedPanel[];
```

### DTS Format (`dts-schema.ts`)

Add to `DtsCircuit`:
```ts
traces?: SavedTrace[];
panels?: SavedPanel[];
```

Legacy JSON (`save-schema.ts` / `save.ts`) is not extended — it is a read-only backward-compatibility format. New features target DTS only.

### .dig XML

Skip — compatibility import format, no Digital equivalent.

## Save Path (Wrapper-Based Sync)

Rather than placing sync calls at each mutation site, wrap `watchedSignals` mutations through a single sync mechanism. All push/splice operations on `watchedSignals` call `_syncTracesToMetadata()` after mutation.

`_syncTracesToMetadata` is a private function inside the `initViewerController` closure:

```ts
function _syncTracesToMetadata(): void {
  const circuit = ctx.circuitStore.circuit;
  if (!circuit) return;

  // Build reverse lookup: address → stable name
  const compiled = ctx.coordinator?.compiled;
  const labelMap = compiled?.labelSignalMap;
  const pinMap = compiled?.pinSignalMap;

  circuit.metadata.traces = watchedSignals.map(sig => {
    // Prefer label name, fall back to pin address
    let name = sig.name;
    if (labelMap) {
      // sig.name is already the label if it came from labelSignalMap
      // For pin-sourced signals, sig.name is "instanceId:pinLabel"
    }
    return {
      name,
      domain: sig.addr.domain,
      panelIndex: sig.panelIndex,
      group: sig.group,
      color: getChannelColor(sig),
      autoRange: getChannelAutoRange(sig),
      yMin: getChannelYMin(sig),
      yMax: getChannelYMax(sig),
      overlays: [...getChannelOverlays(sig)],
      vdd: getChannelVdd(sig),
    };
  });

  // Panel-level settings
  circuit.metadata.panels = scopePanels.map((panel, i) => ({
    panelIndex: i,
    fftEnabled: panel.isFftEnabled(),
    fftChannelLabel: panel.getFftChannelLabel(),
  }));
}
```

Channel display settings are read from the corresponding `ScopePanel` channel. The `ScopePanel` already exposes `getChannelDescriptors()` — extend it to also return `color`, `vdd`, and the full `overlays` set if not already exposed.

**Mutation sites** that must call `_syncTracesToMetadata()` (all inside `initViewerController`):

| Function | Mutation |
|----------|----------|
| `addWireToViewer` | `.push()` — digital and analog |
| `removeSignalFromViewer` | `.splice()` — digital by netId |
| `attachScopeContextMenu` | `.splice()` — channel remove (digital and analog) |
| `appendComponentTraceItems` | `.push()` — voltage/current traces via context menu |

The serializer reads from `circuit.metadata` automatically — no serializer API changes needed beyond the schema fields.

## Restore Path

**Timing:** After compilation (`labelSignalMap` and `pinSignalMap` required).

**Method:** Add `restoreTraces(traces: SavedTrace[], panels: SavedPanel[])` to the `ViewerController` interface. This is the public entry point called from `app-init.ts`.

**Hydration flag:** Transient `let tracesHydrated = false` inside the `initViewerController` closure. Prevents re-restore on recompile while allowing restore after page reload.

**Entry point:** The `rebuildViewersIfOpen` callback in `app-init.ts` (passed to `initSimulationController`). After the existing `resolveWatchedSignalAddresses` call, invoke `restoreTraces` if not yet hydrated.

```ts
restoreTraces(traces: SavedTrace[], panels: SavedPanel[]): void {
  if (tracesHydrated || !traces?.length) return;
  tracesHydrated = true;

  const compiled = ctx.coordinator?.compiled;
  if (!compiled) return;
  const { labelSignalMap, pinSignalMap } = compiled;

  for (const trace of traces) {
    // Two-stage resolution: label first, then pin
    let addr = labelSignalMap.get(trace.name);
    if (!addr) addr = pinSignalMap.get(trace.name);
    if (!addr) {
      console.warn(`[trace-restore] Signal "${trace.name}" not found, skipping`);
      continue;
    }

    watchedSignals.push({
      name: trace.name,
      addr,
      width: addr.domain === 'digital' ? addr.bitWidth : 1,
      group: trace.group,
      panelIndex: trace.panelIndex,
    });
  }

  // Rebuild viewers, then apply display settings
  rebuildViewers();

  // Apply per-channel display settings from saved traces
  for (const trace of traces) {
    const panel = scopePanels.get(trace.panelIndex);
    if (!panel) continue;
    panel.setChannelColor(trace.name, trace.color);
    if (!trace.autoRange) panel.setYRange(trace.name, trace.yMin, trace.yMax);
    for (const overlay of trace.overlays) panel.toggleOverlay(trace.name, overlay);
    if (trace.vdd !== null) panel.setChannelVdd(trace.name, trace.vdd);
  }

  // Apply per-panel FFT state
  for (const p of panels ?? []) {
    const panel = scopePanels.get(p.panelIndex);
    if (!panel) continue;
    panel.setFftEnabled(p.fftEnabled);
    if (p.fftChannelLabel) panel.setFftChannel(p.fftChannelLabel);
  }
}
```

**Viewer panel behavior:** Only call `rebuildViewers()`. Do not force-open the viewer panel. If the user had it closed, traces are in metadata and appear when they open it.

## Edge Cases

| Case | Behavior |
|------|----------|
| Signal removed from circuit | Skip with console warning, others restore normally |
| Component renamed (instanceId changed) | Old `instanceId:pinLabel` key not found, skip with warning |
| Domain changed (analog↔digital) | Use new domain's address from map, log if domain differs from saved |
| Older file version (no `traces` field) | Optional field — silently absent, no restore attempted |
| Duplicate signal names | Last-write-wins (pre-existing limitation in labelSignalMap) |

## Files to Modify

| File | Change |
|------|--------|
| `src/core/circuit.ts` | Add `SavedTrace`, `SavedPanel` interfaces; add `traces?`, `panels?` to `CircuitMetadata` |
| `src/io/dts-schema.ts` | Add `traces?`, `panels?` to `DtsCircuit` |
| `src/io/dts-serializer.ts` | Serialize `traces` and `panels` from `circuit.metadata` onto the DTS output object |
| `src/io/dts-deserializer.ts` | Deserialize `traces` and `panels` from DTS input into `circuit.metadata` |
| `src/app/viewer-controller.ts` | Add `_syncTracesToMetadata()` (private closure fn); add `restoreTraces()` method to interface and implementation; extend `resolveWatchedSignalAddresses` to fall back to `pinSignalMap`; call sync after every `watchedSignals` mutation |
| `src/runtime/analog-scope-panel.ts` | Expose `setChannelColor`, `setChannelVdd`, `setYRange(label)`, `toggleOverlay(label)` if not already public; extend `getChannelDescriptors` to return `color` and `vdd` |
| `src/app/app-init.ts` | In `rebuildViewersIfOpen` callback, call `viewerController.restoreTraces(circuit.metadata.traces, circuit.metadata.panels)` after `resolveWatchedSignalAddresses` |

## Testing (Three-Surface Rule)

### 1. Headless — `src/io/__tests__/trace-persistence.test.ts`

- **Round-trip DTS:** Build circuit with traces and panel settings in metadata → `serializeDts()` → `deserializeDts()` → assert `traces` and `panels` arrays match.
- **Missing signal:** Deserialize a circuit whose `traces` reference a signal name not in the compiled `labelSignalMap` or `pinSignalMap` → assert it is skipped, others restored.
- **Pin-level addressing:** Save a trace with `instanceId:pinLabel` name → round-trip → assert name preserved.
- **Display settings preserved:** Save trace with non-default color, yRange, overlays → round-trip → assert all fields match.

### 2. MCP — `src/headless/__tests__/trace-persistence-mcp.test.ts`

- `circuit_build` → add traces to metadata → `circuit_save` (DTS) → `circuit_load` → `circuit_describe` → assert `metadata.traces` contains saved entries with correct names, domains, colors, and panel indices.
- Patch a circuit to remove a component → `circuit_compile` → assert trace referencing removed component is absent from resolved signals.

### 3. E2E — `e2e/parity/trace-persistence.spec.ts`

- Add `sim-read-traces` postMessage response: returns current `watchedSignals` with their display settings from the active scope panels.
- Load circuit with traces via `sim-load-json` → compile → send `sim-read-traces` → assert response contains expected signal names, colors, panel indices, and FFT state.
- Remove a signal via UI → send `sim-read-traces` → assert removed signal absent, others intact.

### postMessage Addition

New response message for E2E observability:

```
Parent → iframe: sim-read-traces
Iframe → parent: sim-trace-data { traces: SavedTrace[], panels: SavedPanel[] }
```

Add to `src/io/postmessage-adapter.ts`. Reads from `viewerController.watchedSignals` and active `ScopePanel` state, maps to `SavedTrace[]`/`SavedPanel[]` format.
