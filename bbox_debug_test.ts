import { createDefaultRegistry } from "./src/components/register-all";
import { PropertyBag } from "./src/core/properties";
import { MockRenderContext } from "./src/test-utils/mock-render-context";
import { tsCallsToSegments, segmentBounds } from "./src/test-utils/shape-rasterizer";

const registry = createDefaultRegistry();
const testComponents = ["Out", "LED", "LightBulb", "Multiplexer", "Demultiplexer", "Decoder", "NFET", "PowerSupply", "Break"];

for (const name of testComponents) {
  const def = registry.get(name);
  if (!def) { console.log(`${name}: NOT FOUND`); continue; }
  const props = new PropertyBag(def.propertyDefs.map(pd => [pd.key, pd.defaultValue] as [string, any]));
  const el = def.factory(props);
  const ctx = new MockRenderContext();
  el.draw(ctx);
  const segs = tsCallsToSegments(ctx.calls);
  const b = segmentBounds(segs);
  const bbox = el.getBoundingBox();
  const bx0 = bbox.x, by0 = bbox.y, bx1 = bbox.x + bbox.width, by1 = bbox.y + bbox.height;
  const checks = [b.minX - bx0, b.minY - by0, bx0 - b.minX, by0 - b.minY, b.maxX - bx1, b.maxY - by1];
  const overflow = Math.max(0, ...checks);
  const maxCheck = checks.map((v,i) => `[${i}]=${v.toFixed(10)}`).join(" ");
  console.log(`${name}: overflow=${overflow.toFixed(10)}`);
  if (overflow > 0) console.log(`  checks: ${maxCheck}`);
  console.log(`  draw=[${b.minX.toFixed(6)},${b.minY.toFixed(6)},${b.maxX.toFixed(6)},${b.maxY.toFixed(6)}] bbox=[${bx0.toFixed(6)},${by0.toFixed(6)},${bx1.toFixed(6)},${by1.toFixed(6)}]`);
}
