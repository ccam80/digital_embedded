/**
 * Serialization for the guarded-worker boundary.
 *
 * The worker (`ngspice-worker.ts`) runs ngspice in an isolated child process
 * and must hand its `NgspiceRunResult` back to the parent over stdout as a
 * single JSON document. `CaptureSession` / `RawNgspiceAcPoint` carry typed
 * arrays (`Float64Array`, `Int32Array`) and `Map`s (`TopologySnapshot`'s label
 * maps, `NgspiceTopology.nodeNames`) that `JSON.stringify` flattens lossily
 * (typed arrays → index-keyed objects, Maps → `{}`). These functions encode
 * those types explicitly so the parent reconstructs the EXACT same in-memory
 * shape the in-process path produces — preserving the `CaptureSession`
 * contract downstream diff/compare code depends on (no shape change).
 *
 * Encoding scheme (tagged-object envelopes, recognizable by a `$` discriminator):
 *   - Float64Array → { $f64: number[] }
 *   - Int32Array   → { $i32: number[] }
 *   - Map          → { $map: [key, value][] }
 * Everything else round-trips as plain JSON. Numbers preserve full IEEE-754
 * precision through JSON (V8 emits round-trippable decimal for finite doubles);
 * non-finite values (NaN / ±Infinity) — which DO appear in captured matrices /
 * residuals — are encoded as sentinel strings so they survive (plain JSON would
 * coerce them to `null`).
 */

const NAN_TAG = "$nan";
const POS_INF_TAG = "$+inf";
const NEG_INF_TAG = "$-inf";

function encodeNumber(n: number): number | string {
  if (Number.isNaN(n)) return NAN_TAG;
  if (n === Infinity) return POS_INF_TAG;
  if (n === -Infinity) return NEG_INF_TAG;
  return n;
}

function decodeNumber(v: number | string): number {
  if (typeof v === "number") return v;
  if (v === NAN_TAG) return NaN;
  if (v === POS_INF_TAG) return Infinity;
  if (v === NEG_INF_TAG) return -Infinity;
  // Any other string is a programming error in the encoder; fail loud rather
  // than silently coercing.
  throw new Error(`ngspice-job-serde: unexpected encoded number token "${v}"`);
}

/**
 * Recursively encode a value so typed arrays, Maps, and non-finite numbers
 * survive `JSON.stringify`. Pure data only (the run result has no functions /
 * class instances beyond Maps and typed arrays).
 */
export function encodeForTransport(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "number") return encodeNumber(value);

  if (value instanceof Float64Array) {
    return { $f64: Array.from(value, encodeNumber) };
  }
  if (value instanceof Int32Array) {
    // Int32 values are always finite integers; no NaN/Inf encoding needed.
    return { $i32: Array.from(value) };
  }
  if (value instanceof Map) {
    return {
      $map: Array.from(value.entries(), ([k, v]) => [encodeForTransport(k), encodeForTransport(v)]),
    };
  }
  if (Array.isArray(value)) {
    return value.map(encodeForTransport);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = encodeForTransport(v);
    }
    return out;
  }
  // string / boolean
  return value;
}

/** Inverse of `encodeForTransport`. */
export function decodeFromTransport(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "number") return value;
  if (typeof value === "string") {
    if (value === NAN_TAG || value === POS_INF_TAG || value === NEG_INF_TAG) {
      return decodeNumber(value);
    }
    return value;
  }
  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map(decodeFromTransport);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("$f64" in obj && Array.isArray(obj.$f64)) {
      const arr = obj.$f64 as Array<number | string>;
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = decodeNumber(arr[i]);
      return out;
    }
    if ("$i32" in obj && Array.isArray(obj.$i32)) {
      return Int32Array.from(obj.$i32 as number[]);
    }
    if ("$map" in obj && Array.isArray(obj.$map)) {
      const m = new Map<unknown, unknown>();
      for (const pair of obj.$map as Array<[unknown, unknown]>) {
        m.set(decodeFromTransport(pair[0]), decodeFromTransport(pair[1]));
      }
      return m;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = decodeFromTransport(v);
    }
    return out;
  }
  return value;
}
