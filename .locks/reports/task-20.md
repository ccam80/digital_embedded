Changed `IC` default from `NaN` to `0.0` in `CAPACITOR_PARAM_DEFS` (capacitor.ts:48), matching ngspice capload.c:46-47 where `CAPinitCond` defaults to 0.
The `cond1` branch in `load()` already uses `this._IC` unconditionally (no `isNaN` guard present), so no further changes were needed.
