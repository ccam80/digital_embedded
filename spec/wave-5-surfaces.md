# Wave 5 — MCP and UI surface wiring

> Source: `docs/harness-redesign-spec.md` §9.14, §9.15, §9.16, §9.17, §12.6.
> Wave dependency: Wave 3 (comparison-session shape API + setCaptureHook conflict throw landed).
> Sizing: sonnet (multi-file surface wiring).
> Runs in parallel with: Wave 4, Wave 6.
> Exit gate: `npm run test:q -- harness-tools` — MCP tests pass. Manual: `harness_query { mode: "shape" }` returns a `SessionShape` object.

## Tasks in this wave

| ID | Title | Files | Complexity |
|----|-------|-------|------------|
| W5.T1 | Add `"shape"` mode to `harness_query`; surface `presence` in `getStepEnd` responses; (optional) `harness_get_step_at_time` | `scripts/mcp/harness-tools.ts` | L |
| W5.T2 | `circuit_convergence_log` enable/disable: catch the new throw and surface a clear MCP error | `scripts/mcp/simulation-tools.ts` | S |
| W5.T3 | postMessage `setConvergenceLogEnabled`: catch the new throw and send a `sim-error` reply | `src/io/postmessage-adapter.ts` | S |
| W5.T4 | UI panel auto-enable/disable: wrap in try/catch and surface a UI notification when harness is active | `src/app/convergence-log-panel.ts` | M |

---

## W5.T1 — `scripts/mcp/harness-tools.ts`

### Add `"shape"` mode to `harness_query` at `:401`

The current `harness_query` tool has a `mode` parameter (e.g. `"stepEnd"`, `"divergences"`, `"trace"`, etc.). Add a new mode `"shape"`:

```ts
case "shape": {
  const session = getSessionByHandle(args.handle);
  return { content: [{ type: "text", text: JSON.stringify(session.getSessionShape(), null, 2) }] };
}
```

Locate the existing `mode` switch by reading the file around line 401. Match the existing return shape (whatever serialization wrapper the other modes use). Update the tool's input schema description and the `mode` enum to include `"shape"`.

### Update `getStepEnd` call sites at `:727, :854, :900`

These three sites call `session.getStepEnd(stepIndex)` and serialize the result for the MCP response. The response shape must now include `presence` and surface `oursOnly`/`ngspiceOnly` semantics.

Before:
```ts
const report = session.getStepEnd(stepIndex);
return { ...serializeReport(report), unaligned: report.unaligned ?? false };
```

After:
```ts
const report = session.getStepEnd(stepIndex);
return { ...serializeReport(report), presence: report.presence };
```

If `report.presence !== "both"`, the MCP caller should still get a usable response — the missing-side fields will be `null` or sentinel, mirroring the old `unaligned` behavior. Verify that the serialization handles `null` cleanly.

### `getDivergences` call sites at `:753, :934`

Shape divergences (`category: "shape"`) flow through the existing structure unchanged. No code change required at these sites — just verify that the existing iteration over divergence entries handles the new `category` value (it should, because `category` was already a discriminator).

The existing NaN absDelta filter (Round 3 fix) at `:753-754` and `:937` should be preserved — that's a separate carry-over.

### Add `harness_get_step_at_time` per §5

Add a new MCP tool OR fold into `harness_query` as a `"stepAtTime"` mode. Recommend folding to keep the tool surface minimal:

```ts
case "stepAtTime": {
  const session = getSessionByHandle(args.handle);
  const t = args.time as number;
  const side = (args.side as "ours" | "ngspice") ?? "ours";
  const idx = session.getStepAtTime(t, side);
  return { content: [{ type: "text", text: JSON.stringify({ stepIndex: idx, time: t, side }, null, 2) }] };
}
```

Update the tool input schema's `mode` enum to include `"stepAtTime"` and document `time` + `side` parameters.

### Acceptance (W5.T1)

- `harness_query { mode: "shape" }` returns `SessionShape`.
- `harness_query { mode: "stepEnd", stepIndex }` response includes `presence`.
- `harness_query { mode: "stepAtTime", time, side? }` returns `{ stepIndex, time, side }`.
- Divergence responses include shape entries when present (no code change, just verify).
- `npm run test:q -- harness-tools` — passes.

---

## W5.T2 — `scripts/mcp/simulation-tools.ts`

### `circuit_convergence_log` at `:415-465`

The `enable`/`disable` action calls `coordinator.setConvergenceLogEnabled(true/false)` (or the facade method). The facade now throws when disabling while a harness capture hook is installed (Wave 2). Wrap the call:

```ts
case "disable": {
  try {
    facade.setConvergenceLogEnabled(false);
    return successResponse("Convergence log disabled");
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("comparison harness")) {
      return errorResponse(
        "Cannot disable convergence log: a comparison harness capture hook is currently installed. " +
        "Stop the harness session before disabling the log."
      );
    }
    throw err;
  }
}
```

The `enable` path doesn't throw (already-enabled is a no-op), so it remains unchanged.

### Acceptance (W5.T2)

- `circuit_convergence_log { action: "disable" }` while a harness session is active returns a clear error to the MCP caller (does NOT crash the server).
- All other paths through `circuit_convergence_log` are unchanged.
- `npm run test:q -- simulation-tools` — passes (or smoke-test manually).

---

## W5.T3 — `src/io/postmessage-adapter.ts`

### `setConvergenceLogEnabled` handlers at `:434, :438`

The postMessage adapter routes a `sim-set-convergence-log-enabled` message (or whatever the actual key is — read the file) to `facade.setConvergenceLogEnabled()`. Wrap that call:

```ts
case "sim-set-convergence-log-enabled": {
  try {
    facade.setConvergenceLogEnabled(msg.enabled);
    sendReply({ type: "sim-convergence-log-state", enabled: msg.enabled });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("comparison harness")) {
      sendReply({
        type: "sim-error",
        message: "Cannot toggle convergence log while comparison harness is active.",
        code: "harness-active",
      });
      return;
    }
    throw err;
  }
}
```

`:447` `getConvergenceLog` is unchanged.

### Acceptance (W5.T3)

- A postMessage `setConvergenceLogEnabled(false)` while a harness is active sends back a `sim-error` with `code: "harness-active"`.
- No other postMessage handlers regress.
- The message keys / shapes match what the file actually uses — read `src/io/postmessage-adapter.ts` first.

---

## W5.T4 — `src/app/convergence-log-panel.ts`

### Auto-enable / disable wrapping at `:249, :292, :363, :416-433`

The UI convergence log panel auto-enables the log when opened and disables when closed. The disable path now throws when a harness is installed. Wrap each disable call:

```ts
private disableLog(): void {
  try {
    this._coordinator.setConvergenceLogEnabled(false);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("comparison harness")) {
      this._showNotification(
        "Convergence log cannot be disabled while a comparison harness is running. " +
        "The log will remain enabled until the harness session ends."
      );
      return;
    }
    throw err;
  }
}
```

Also handle the auto-disable path triggered by panel close. If the panel is closed by the user, the disable attempt may now silently fail (caught by the wrapper above). The notification surfaces the reason.

The auto-ENABLE path at `:249, :292` does not throw (per Wave 2 — enabling while installed is a silent no-op because it's already enabled). No change needed there.

### `_showNotification` helper

If a notification helper already exists in this file or a sibling app module, reuse it. If not, fall back to whatever the file currently uses for user-facing messages (toast, status bar, modal, etc.). The exact UX is the file's existing pattern — match it.

### Acceptance (W5.T4)

- Toggling the panel off while a harness session is active surfaces a UI notification instead of crashing or silently appearing toggled-off.
- Other panel paths (auto-open, log polling) are unchanged.
- `npm run test:e2e -- convergence-log-panel` — passes (Wave 6 will add a focused E2E test for the conflict notification; Wave 5's job is to make that test pass when written).

---

## Wave 5 exit checklist

- [ ] `harness_query { mode: "shape" }` returns a `SessionShape` object.
- [ ] `harness_query { mode: "stepEnd" }` includes `presence`.
- [ ] `harness_get_step_at_time` (or `harness_query { mode: "stepAtTime" }`) is wired.
- [ ] `circuit_convergence_log { action: "disable" }` while harness installed returns a clear MCP error.
- [ ] postMessage `setConvergenceLogEnabled(false)` while harness installed sends a `sim-error` reply.
- [ ] UI panel disable while harness installed shows a UI notification.
- [ ] `npm run test:q -- harness-tools` — passes.
- [ ] `npx tsc --noEmit` — no type errors anywhere.

## Hard rules

- Read `CLAUDE.md` for non-negotiable rules.
- Do NOT modify production engine / coordinator / facade code in this wave — Wave 2 owned that. If a surface bug requires a coordinator change, surface it in `spec/progress.md` for the verifier.
- Read each surface file before editing — the actual message keys, function names, and notification helpers may differ from the names used in this spec. Match the file's existing patterns.
