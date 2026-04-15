#!/usr/bin/env node
/**
 * Generate Graphviz DOT state-machine diagrams from per-engine YAML inventories.
 *
 * Usage:
 *   node spec/state-machines/generate-charts.mjs
 *
 * Reads ngspice.yaml and ours.yaml, produces DOT (and SVG when `dot` is on PATH)
 * into spec/state-machines/charts/.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'charts');

// ---------------------------------------------------------------------------
// YAML loading with duplicate-key merging
// ---------------------------------------------------------------------------
// Some YAML files have duplicate mapping keys (e.g. two edges_out blocks in one
// state). js-yaml rejects these by default. We use a custom schema type that
// merges array-valued duplicates instead of throwing.

/**
 * Load YAML tolerantly: when a mapping has duplicate keys whose values are
 * arrays, concatenate them. Non-array duplicates: last wins (standard behavior).
 */
function loadYamlTolerant(text) {
  // Pre-process: find duplicate keys at the same indent and merge them.
  // Strategy: scan lines, track current list-item block, merge duplicate keys.
  const lines = text.split(/\r?\n/);
  const result = [];
  // Stack of (indent, key, firstLineIndex) for array-valued mapping keys
  // within the current list item.
  let seenKeys = new Map(); // key -> { indent, insertAfterLine }
  let currentItemIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect new list item at state level: "  - id:"
    const listItemMatch = line.match(/^(\s*)- id:/);
    if (listItemMatch) {
      currentItemIndent = listItemMatch[1].length;
      seenKeys = new Map();
      result.push(line);
      continue;
    }

    // Detect a mapping key at the item's property level (indent = currentItemIndent + 2..4)
    if (currentItemIndent >= 0) {
      const keyMatch = line.match(/^(\s+)(edges_in|edges_out):\s*$/);
      if (keyMatch) {
        const indent = keyMatch[1].length;
        const key = keyMatch[2];
        if (seenKeys.has(key) && seenKeys.get(key).indent === indent) {
          // Duplicate key -- skip this line (the key header) and let its
          // children append to the previous block. We just need to not emit
          // this key line; the child lines (deeper indent) will be appended
          // after the previous block's children.
          continue;
        }
        seenKeys.set(key, { indent });
      }
    }

    result.push(line);
  }

  return yaml.load(result.join('\n'));
}

// ---------------------------------------------------------------------------
// Phase grouping rules -- map id prefixes to phase clusters
// ---------------------------------------------------------------------------

/** Ordered list of (prefix, phaseName) pairs. First match wins. */
const PHASE_RULES = [
  // ngspice-specific prefixes
  ['gmin_',     'dcop'],
  ['source_',   'dcop'],
  ['cktop_',    'dcop'],
  ['cktload_',  'nr'],
  ['niiter_',   'nr'],
  ['sparse_',   'nr'],
  ['lu_',       'nr'],
  ['preorder_', 'nr'],
  ['swap_',     'nr'],
  ['allocate_rhs', 'nr'],
  ['clear_noncon', 'nr'],
  ['check_iteration', 'nr'],
  ['check_node',     'nr'],
  ['check_initf',    'nr'],
  ['apply_newton',   'nr'],
  ['apply_nodesets',  'nr'],

  // shared / ours prefixes
  ['engine_',       'lifecycle'],
  ['seed_',         'lifecycle'],
  ['allocate_',     'lifecycle'],
  ['dcop_',         'dcop'],
  ['nr_',           'nr'],
  ['transient_',    'transient'],
  ['tran_',         'transient'],
  ['limit_',        'device'],
  ['integrate_',    'integration'],
  ['truncation_',   'lte'],
  ['temperature_',  'device'],
  ['transition_',   'nr'],
];

function classifyPhase(id) {
  for (const [prefix, phase] of PHASE_RULES) {
    if (id.startsWith(prefix)) return phase;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Phase visual styling
// ---------------------------------------------------------------------------

const PHASE_STYLES = {
  lifecycle:    { fill: '#e0e0e0', stroke: '#999999', fontcolor: '#333333', label: 'Lifecycle' },
  dcop:         { fill: '#bbdefb', stroke: '#1565c0', fontcolor: '#0d47a1', label: 'DC Operating Point' },
  nr:           { fill: '#c8e6c9', stroke: '#2e7d32', fontcolor: '#1b5e20', label: 'Newton-Raphson' },
  transient:    { fill: '#ffe0b2', stroke: '#e65100', fontcolor: '#bf360c', label: 'Transient' },
  integration:  { fill: '#e1bee7', stroke: '#6a1b9a', fontcolor: '#4a148c', label: 'Integration' },
  lte:          { fill: '#fff9c4', stroke: '#f9a825', fontcolor: '#f57f17', label: 'LTE / Truncation' },
  device:       { fill: '#ffccbc', stroke: '#bf360c', fontcolor: '#870000', label: 'Device' },
  other:        { fill: '#f5f5f5', stroke: '#bdbdbd', fontcolor: '#616161', label: 'Other' },
};

// ---------------------------------------------------------------------------
// DOT generation
// ---------------------------------------------------------------------------

/** Sanitize an id for DOT node names */
function dotId(id) {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Truncate long strings for edge labels */
function truncLabel(s, max = 50) {
  if (!s) return '';
  s = s.replace(/"/g, '\\"');
  return s.length > max ? s.slice(0, max - 1) + '...' : s;
}

/** Human-readable node label from snake_case id */
function nodeLabel(id) {
  return id.replace(/_/g, ' ');
}

function generateDot(states, engineName) {
  const stateIds = new Set(states.map(s => s.id));

  // Group states by phase
  const byPhase = {};
  for (const s of states) {
    const phase = classifyPhase(s.id);
    if (!byPhase[phase]) byPhase[phase] = [];
    byPhase[phase].push(s);
  }

  const lines = [];
  lines.push(`digraph "${engineName}" {`);
  lines.push('  rankdir=TB;');
  lines.push('  fontname="Helvetica";');
  lines.push('  node [fontname="Helvetica", fontsize=10, shape=box, style="filled,rounded"];');
  lines.push('  edge [fontname="Helvetica", fontsize=8];');
  lines.push('  compound=true;');
  lines.push('  newrank=true;');
  lines.push(`  label="${engineName} State Machine";`);
  lines.push('  labelloc=t;');
  lines.push('  fontsize=16;');
  lines.push('');

  // Emit phase subgraphs
  const phaseOrder = ['lifecycle', 'dcop', 'nr', 'transient', 'integration', 'lte', 'device', 'other'];
  for (const phase of phaseOrder) {
    const group = byPhase[phase];
    if (!group || group.length === 0) continue;
    const style = PHASE_STYLES[phase];

    lines.push(`  subgraph cluster_${phase} {`);
    lines.push(`    label="${style.label}";`);
    lines.push(`    style="rounded,filled";`);
    lines.push(`    fillcolor="${style.fill}";`);
    lines.push(`    color="${style.stroke}";`);
    lines.push(`    fontcolor="${style.fontcolor}";`);
    lines.push(`    fontsize=12;`);
    lines.push('');

    for (const s of group) {
      const nid = dotId(s.id);
      const nlabel = nodeLabel(s.id);
      lines.push(`    ${nid} [label="${nlabel}", fillcolor="white"];`);
    }
    lines.push('  }');
    lines.push('');
  }

  // Emit edges (from edges_out of each state)
  const emitted = new Set();
  for (const s of states) {
    if (!s.edges_out) continue;
    for (const e of s.edges_out) {
      if (!e.to) continue;
      const toId = e.to.replace(/[()]/g, '').trim();
      if (!stateIds.has(toId)) continue;

      const fromDot = dotId(s.id);
      const toDot = dotId(toId);
      const edgeKey = `${fromDot}->${toDot}`;
      if (emitted.has(edgeKey)) continue;
      emitted.add(edgeKey);

      const label = truncLabel(e.label || e.condition || '');
      if (label) {
        lines.push(`  ${fromDot} -> ${toDot} [label="${label}"];`);
      } else {
        lines.push(`  ${fromDot} -> ${toDot};`);
      }
    }
  }

  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });

const engines = [
  { file: 'ngspice.yaml', name: 'ngspice' },
  { file: 'ours.yaml',    name: 'ours' },
];

let hasDot = false;
try {
  execFileSync('dot', ['-V'], { stdio: 'pipe' });
  hasDot = true;
} catch {
  // dot not available
}

for (const { file, name } of engines) {
  const yamlPath = join(__dirname, file);
  const doc = loadYamlTolerant(readFileSync(yamlPath, 'utf8'));
  const states = doc.states || [];
  const engineLabel = doc.engine?.name || name;

  const dot = generateDot(states, engineLabel);
  const dotPath = join(outDir, `${name}.dot`);
  writeFileSync(dotPath, dot, 'utf8');
  console.log(`wrote ${dotPath} (${states.length} states)`);

  if (hasDot) {
    const svgPath = join(outDir, `${name}.svg`);
    try {
      const svg = execFileSync('dot', ['-Tsvg', dotPath], { maxBuffer: 10 * 1024 * 1024 });
      writeFileSync(svgPath, svg);
      console.log(`wrote ${svgPath}`);
    } catch (err) {
      console.error(`dot SVG generation failed for ${name}: ${err.message}`);
    }
  }
}

if (!hasDot) {
  console.log('\nNote: Graphviz `dot` not found on PATH. Only .dot files were generated.');
  console.log('Install Graphviz and re-run to also produce SVG output.');
}
