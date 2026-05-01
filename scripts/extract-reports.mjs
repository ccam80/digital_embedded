#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const SRC_DIR = "C:/Users/cca79/.claude/projects/C--local-working-projects-digital-in-browser/151df9b3-eb3e-47fe-aa20-c71607679eeb/tool-results";
const DST_DIR = "C:/local_working_projects/digital_in_browser/spec";

const mapping = [
  { src: "toolu_018P4QHDHVe9P2vnnfgMo84p.json", dst: "ngspice-alignment-F1-sparse-solver.md",   tag: "F1",    title: "Sparse solver core" },
  { src: "toolu_015GXaCWpvMJRsoatkgNVmJk.json", dst: "ngspice-alignment-F3-dcop-transient.md",  tag: "F3",    title: "DCOP/transient transition" },
  { src: "toolu_011Hr6npqvhGMnyPsbKiNgu7.json", dst: "ngspice-alignment-F4-cktload-devices.md", tag: "F4",    title: "cktLoad / LoadContext / device gates" },
  { src: "toolu_019HbaBzw1pay9iCmypichLw.json", dst: "ngspice-alignment-F5ext-jfet.md",         tag: "F5-ext",title: "JFET full convergence port" },
  { src: "toolu_01FwHbezRkSkY1NyRSCQz37d.json", dst: "ngspice-alignment-F-bjt.md",              tag: "F-BJT", title: "BJT full convergence port" },
  { src: "toolu_01WHKqvwoEj6kW8XSKbu1fw7.json", dst: "ngspice-alignment-F-mos.md",              tag: "F-MOS", title: "MOSFET + FET base full convergence port" },
];

for (const { src, dst, tag, title } of mapping) {
  const srcPath = resolve(SRC_DIR, src);
  const dstPath = resolve(DST_DIR, dst);
  const raw = readFileSync(srcPath, "utf8");
  const parsed = JSON.parse(raw);
  const text = Array.isArray(parsed)
    ? parsed.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n\n")
    : typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
  const header = `# ngspice alignment- ${tag}: ${title}\n\n_Extracted from ephemeral tool-results cache. Source agent output verbatim below._\n\n---\n\n`;
  writeFileSync(dstPath, header + text, "utf8");
  console.log(`wrote ${dstPath} (${Buffer.byteLength(text, "utf8")} bytes)`);
  unlinkSync(srcPath);
  console.log(`removed ${srcPath}`);
}

console.log("\nDone.");
