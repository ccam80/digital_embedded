/**
 * Analysis dialogs — circuit analysis, K-map, expressions, expression editor,
 * critical path, state transition, test vector editor, auto-connect power,
 * and tutorials menu wiring.
 *
 * Extracted from app-init.ts as Step 8 of the modularization plan.
 * Entry point: initAnalysisDialogs(ctx)
 */

import type { AppContext } from './app-context.js';
import { createModal } from './dialog-manager.js';
import { analyseCircuit } from '../analysis/model-analyser.js';
import { TruthTableTab } from '../analysis/truth-table-ui.js';
import { TruthTable } from '../analysis/truth-table.js';
import { KarnaughMapTab } from '../analysis/karnaugh-map.js';
import { minimize } from '../analysis/quine-mccluskey.js';
import { generateSOP, generatePOS } from '../analysis/expression-gen.js';
import { ExpressionEditorTab } from '../analysis/expression-editor.js';
import { synthesizeCircuit } from '../analysis/synthesis.js';
import { exprToString } from '../analysis/expression.js';
import { findCriticalPath } from '../analysis/path-analysis.js';
import { analyseSequential } from '../analysis/state-transition.js';
import type { SequentialAnalysisFacade, SignalSpec } from '../analysis/state-transition.js';
import { PropertyBag } from '../core/properties.js';

// ---------------------------------------------------------------------------
// JS test script evaluator
// ---------------------------------------------------------------------------

/**
 * Detect whether test data is a JavaScript test script (vs plain format).
 * Heuristic: contains `signals(` call.
 */
export function isJsTestScript(text: string): boolean {
  return /\bsignals\s*\(/.test(text);
}

/**
 * Evaluate a JavaScript test script and return the equivalent plain-format
 * test data string. The script runs in a sandboxed Function() with helpers:
 *   signals('A', 'B', 'Y')  — declare pin names (must be called once)
 *   row(0, 1, 1)            — add a test vector row
 *   X                       — don't-care value
 *   C                       — clock pulse value
 *   Z                       — high-impedance value
 */
export function evalJsTestScript(script: string): string {
  let pinNames: string[] | null = null;
  const rows: string[][] = [];

  const sandbox = {
    X: 'X',
    C: 'C',
    Z: 'Z',
    signals: (...names: string[]) => {
      if (pinNames !== null) throw new Error('signals() can only be called once');
      if (names.length === 0) throw new Error('signals() requires at least one pin name');
      pinNames = names;
    },
    row: (...values: (number | string)[]) => {
      if (pinNames === null) throw new Error('Call signals() before row()');
      if (values.length !== pinNames.length) {
        throw new Error(
          `row() expects ${pinNames.length} values (${pinNames.join(', ')}), got ${values.length}`,
        );
      }
      rows.push(values.map(v => String(v)));
    },
  };

  // Build and execute the sandboxed function
  const argNames = Object.keys(sandbox);
  const argValues = Object.values(sandbox);
  const fn = new Function(...argNames, script);
  fn(...argValues);

  if (pinNames === null) throw new Error('Test script must call signals()');
  if (rows.length === 0) throw new Error('Test script must add at least one row()');

  // Build plain-format output
  const names: string[] = pinNames;
  const lines = [names.join(' ')];
  for (const r of rows) {
    lines.push(r.join(' '));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// K-map tab renderer
// ---------------------------------------------------------------------------

function renderKMapTab(container: HTMLElement, ttModel: TruthTable): void {
  const numVars = ttModel.totalInputBits;
  if (numVars < 2 || numVars > 6) {
    const errDiv = document.createElement('div');
    errDiv.className = 'analysis-error';
    errDiv.textContent = 'K-Map requires 2\u20136 input variables. This circuit has ' + numVars + '.';
    container.appendChild(errDiv);
    return;
  }

  let selectedOutput = 0;
  if (ttModel.outputs.length > 1) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:8px;display:flex;align-items:center;gap:8px;font-size:12px;';
    const lbl = document.createElement('label');
    lbl.textContent = 'Output: ';
    const sel = document.createElement('select');
    sel.style.cssText = 'background:var(--bg);color:var(--fg);border:1px solid var(--panel-border);border-radius:3px;padding:2px 4px;font-size:12px;';
    for (let i = 0; i < ttModel.outputs.length; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = ttModel.outputs[i]!.name;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => { selectedOutput = parseInt(sel.value, 10); renderKMapCanvas(); });
    row.appendChild(lbl);
    row.appendChild(sel);
    container.appendChild(row);
  }

  const kmapTab = new KarnaughMapTab(ttModel);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;max-width:100%;';
  container.appendChild(canvas);

  function renderKMapCanvas(): void {
    const CELL = 44;
    const layout = kmapTab.kmap.layout;
    const subMaps = kmapTab.subMapCount;
    const labelOff = CELL;
    const mapW = (layout.cols + 1) * CELL;
    const totalW = labelOff + subMaps * mapW + 16;
    const totalH = labelOff + layout.rows * CELL + 16;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = totalW + 'px';
    canvas.style.height = totalH + 'px';
    const ctx2 = canvas.getContext('2d')!;
    ctx2.scale(dpr, dpr);

    const cs = getComputedStyle(document.documentElement);
    const fg = cs.getPropertyValue('--fg').trim() || '#d4d4d4';
    const border = cs.getPropertyValue('--panel-border').trim() || '#3c3c3c';
    const LOOP_COLORS = ['#e84a4a88','#4ae84a88','#4a9ee888','#e8e84a88','#e84ae888','#4ae8e888','#ff8c0088','#8888ff88'];

    ctx2.clearRect(0, 0, totalW, totalH);
    ctx2.font = Math.round(CELL * 0.4) + 'px monospace';
    ctx2.textAlign = 'center';
    ctx2.textBaseline = 'middle';

    try {
      const minResult = minimize(ttModel, selectedOutput);
      kmapTab.setImplicants(minResult.primeImplicants);
    } catch (_e) { /* ignore */ }

    const kctx = {
      drawRect(x: number, y: number, w: number, h: number) {
        ctx2.strokeStyle = border;
        ctx2.lineWidth = 1;
        ctx2.strokeRect(x, y, w, h);
      },
      drawText(text: string, x: number, y: number) {
        ctx2.fillStyle = fg;
        ctx2.fillText(text, x, y);
      },
      drawLoop(x: number, y: number, w: number, h: number, colorIdx: number) {
        const c = LOOP_COLORS[colorIdx % LOOP_COLORS.length]!;
        ctx2.fillStyle = c;
        ctx2.strokeStyle = c.replace('88', 'ff');
        ctx2.lineWidth = 2;
        ctx2.beginPath();
        ctx2.roundRect(x + 2, y + 2, w - 4, h - 4, 6);
        ctx2.fill();
        ctx2.stroke();
        ctx2.lineWidth = 1;
      },
    };

    kmapTab.render(kctx, CELL, selectedOutput);
  }

  renderKMapCanvas();
}

// ---------------------------------------------------------------------------
// Expressions tab renderer
// ---------------------------------------------------------------------------

function renderExpressionsTab(container: HTMLElement, ttModel: TruthTable): void {
  const tbl = document.createElement('table');
  tbl.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;font-family:monospace;';
  const thead = document.createElement('thead');
  const hRow = document.createElement('tr');
  for (const h of ['Output', 'Minimized (SOP)', 'Canonical SOP', 'Canonical POS']) {
    const th = document.createElement('th');
    th.textContent = h;
    th.style.cssText = 'text-align:left;padding:4px 10px;border-bottom:1px solid var(--panel-border);opacity:0.7;font-size:11px;text-transform:uppercase;';
    hRow.appendChild(th);
  }
  thead.appendChild(hRow);
  tbl.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let i = 0; i < ttModel.outputs.length; i++) {
    const tr = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.textContent = ttModel.outputs[i]!.name;
    nameCell.style.cssText = 'padding:4px 10px;font-weight:600;border-bottom:1px solid rgba(128,128,128,0.15);';
    tr.appendChild(nameCell);

    let minExpr = '', sopExpr = '', posExpr = '';
    try { const m = minimize(ttModel, i); minExpr = exprToString(m.selectedCover); } catch (e) { minExpr = 'Error'; }
    try { sopExpr = exprToString(generateSOP(ttModel, i)); } catch (_e) { sopExpr = 'Error'; }
    try { posExpr = exprToString(generatePOS(ttModel, i)); } catch (_e) { posExpr = 'Error'; }

    for (const val of [minExpr, sopExpr, posExpr]) {
      const td = document.createElement('td');
      td.textContent = val;
      td.style.cssText = 'padding:4px 10px;border-bottom:1px solid rgba(128,128,128,0.15);word-break:break-all;';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  container.appendChild(tbl);
}

// ---------------------------------------------------------------------------
// Expression editor tab renderer
// ---------------------------------------------------------------------------

function renderExpressionEditorTab(container: HTMLElement, ctx: AppContext): void {
  const editorCtrl = new ExpressionEditorTab();

  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;opacity:0.7;margin-bottom:6px;';
  lbl.textContent = 'Enter a boolean expression (e.g. A AND B OR NOT C). Press Parse or Enter.';
  container.appendChild(lbl);

  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
  const exprInput = document.createElement('input');
  exprInput.type = 'text';
  exprInput.placeholder = 'A AND B OR NOT C';
  exprInput.style.cssText = 'flex:1;padding:4px 8px;background:var(--bg);border:1px solid var(--panel-border);color:var(--fg);border-radius:3px;font-family:monospace;font-size:13px;';
  const parseBtn = document.createElement('button');
  parseBtn.textContent = 'Parse';
  parseBtn.style.cssText = 'padding:4px 12px;background:var(--toolbar-bg);border:1px solid var(--panel-border);color:var(--fg);border-radius:3px;cursor:pointer;font-size:12px;';
  inputRow.appendChild(exprInput);
  inputRow.appendChild(parseBtn);
  container.appendChild(inputRow);

  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'font-size:11px;margin-bottom:8px;min-height:16px;';
  container.appendChild(statusEl);

  const ttWrapper = document.createElement('div');
  ttWrapper.style.cssText = 'margin-bottom:12px;overflow:auto;';
  container.appendChild(ttWrapper);

  const synthBtn = document.createElement('button');
  synthBtn.textContent = 'Generate Circuit from Expression';
  synthBtn.disabled = true;
  synthBtn.style.cssText = 'padding:5px 16px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;';
  synthBtn.addEventListener('click', () => {
    const pr = editorCtrl.lastResult;
    if (!pr.expr) return;
    const vars = editorCtrl.detectVariables();
    const exprMap = new Map<string, import('../analysis/expression.js').BoolExpr>([['Y', pr.expr]]);
    try {
      const synth = synthesizeCircuit(exprMap, vars, ctx.registry);
      ctx.applyLoadedCircuit(synth);
      container.closest('.analysis-overlay')?.remove();
      ctx.showStatus('Circuit synthesized (' + synth.elements.length + ' components)');
    } catch (e) {
      ctx.showStatus('Synthesis error: ' + (e instanceof Error ? e.message : String(e)), true);
    }
  });
  container.appendChild(synthBtn);

  function doParse(): void {
    editorCtrl.setText(exprInput.value);
    const pr = editorCtrl.parse();
    ttWrapper.innerHTML = '';
    if (pr.error) {
      statusEl.style.color = '#ffaaaa';
      statusEl.textContent = 'Parse error: ' + pr.error;
      synthBtn.disabled = true;
    } else {
      statusEl.style.color = '#4ae84a';
      statusEl.textContent = 'Valid: ' + exprToString(pr.expr!);
      synthBtn.disabled = false;
      try {
        const tt = editorCtrl.toTruthTable('Y');
        const ttTab = new TruthTableTab(tt);
        ttTab.render(ttWrapper);
      } catch (e) {
        ttWrapper.textContent = 'Table error: ' + (e instanceof Error ? e.message : String(e));
      }
    }
  }

  parseBtn.addEventListener('click', doParse);
  exprInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') doParse(); });
}

// ---------------------------------------------------------------------------
// Main analysis dialog
// ---------------------------------------------------------------------------

function openAnalysisDialog(ctx: AppContext): void {
  const { circuit, registry, facade } = ctx;
  const flipFlopDefs = registry.getByCategory('FLIP_FLOPS' as any);
  const flipFlopNames = new Set(flipFlopDefs.map((d: { name: string }) => d.name));
  const hasFlipFlop = circuit.elements.some(el => flipFlopNames.has(el.typeId));

  const { overlay, dialog } = createModal({
    title: 'Circuit Analysis',
    className: 'analysis-dialog',
    overlayClassName: 'analysis-overlay',
  });

  if (hasFlipFlop) {
    const errDiv = document.createElement('div');
    errDiv.className = 'analysis-error';
    errDiv.style.margin = '16px';
    errDiv.textContent = 'This circuit contains sequential elements (flip-flops). ' +
      'Truth table analysis requires a purely combinational circuit. ' +
      'Use State Transition Analysis for sequential circuits.';
    dialog.appendChild(errDiv);
  } else {
    // Run analysis once; share result across tabs
    let ttModel: TruthTable | null = null;
    let analysisError: string | null = null;
    try {
      const result = analyseCircuit(facade, circuit);
      const inputSpecs = result.inputs.map(s => ({ name: s.name, bitWidth: s.bitWidth }));
      const outputSpecs = result.outputs.map(s => ({ name: s.name, bitWidth: s.bitWidth }));
      const outCount = outputSpecs.length;
      const data: import('../analysis/truth-table.js').TernaryValue[] = [];
      for (const row of result.rows) {
        for (let o = 0; o < outCount; o++) {
          const v = row.outputValues[o] ?? 0n;
          data.push(v === 0n ? 0n : 1n);
        }
      }
      ttModel = new TruthTable(inputSpecs, outputSpecs, data);
    } catch (err) {
      analysisError = err instanceof Error ? err.message : String(err);
    }

    // Build tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'analysis-tabs';
    const TAB_NAMES = ['Truth Table', 'K-Map', 'Expressions', 'Expression Editor'];
    const tabBtns: HTMLButtonElement[] = [];
    for (const name of TAB_NAMES) {
      const btn = document.createElement('button');
      btn.className = 'analysis-tab';
      btn.textContent = name;
      tabBar.appendChild(btn);
      tabBtns.push(btn);
    }
    dialog.appendChild(tabBar);

    const contentArea = document.createElement('div');
    contentArea.className = 'analysis-tab-content';
    dialog.appendChild(contentArea);

    function showAnalysisTab(idx: number): void {
      tabBtns.forEach((b, i) => b.classList.toggle('active', i === idx));
      contentArea.innerHTML = '';

      if (analysisError && idx !== 3) {
        const errDiv = document.createElement('div');
        errDiv.className = 'analysis-error';
        errDiv.textContent = analysisError;
        contentArea.appendChild(errDiv);
        return;
      }

      if (idx === 0 && ttModel) {
        const ttTab = new TruthTableTab(ttModel);
        ttTab.render(contentArea);
      } else if (idx === 1 && ttModel) {
        renderKMapTab(contentArea, ttModel);
      } else if (idx === 2 && ttModel) {
        renderExpressionsTab(contentArea, ttModel);
      } else if (idx === 3) {
        renderExpressionEditorTab(contentArea, ctx);
      }
    }

    tabBtns.forEach((btn, i) => btn.addEventListener('click', () => showAnalysisTab(i)));
    showAnalysisTab(0);
  }

  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function initAnalysisDialogs(ctx: AppContext): void {
  const { circuit, registry, facade } = ctx;

  // -------------------------------------------------------------------------
  // Analysis menu: Analyse Circuit / Synthesise Circuit
  // -------------------------------------------------------------------------
  document.getElementById('btn-analyse-circuit')?.addEventListener('click', () => openAnalysisDialog(ctx));
  document.getElementById('btn-synthesise-circuit')?.addEventListener('click', () => openAnalysisDialog(ctx));

  // -------------------------------------------------------------------------
  // Tutorials menu
  // -------------------------------------------------------------------------
  document.getElementById('btn-browse-tutorials')?.addEventListener('click', () => {
    window.open('tutorials.html', '_blank');
  });
  document.getElementById('btn-edit-tutorial')?.addEventListener('click', () => {
    window.open('tutorial-editor.html', '_blank');
  });

  // -------------------------------------------------------------------------
  // Analysis menu: Critical Path
  // -------------------------------------------------------------------------
  document.getElementById('btn-critical-path')?.addEventListener('click', () => {
    let result;
    try {
      result = findCriticalPath(circuit, registry);
    } catch (err) {
      alert('Critical path analysis failed: ' + (err instanceof Error ? err.message : String(err)));
      return;
    }

    const { overlay, body } = createModal({
      title: 'Critical Path Analysis',
      className: 'cp-dialog',
      overlayClassName: 'cp-dialog-overlay',
    });

    const stats = [
      ['Path Length', `${result.pathLength} ns`],
      ['Gate Count', String(result.gateCount)],
      ['Total Components', String(result.components.length)],
    ];
    for (const [label, value] of stats) {
      const row = document.createElement('div');
      row.className = 'cp-stat-row';
      const l = document.createElement('span');
      l.className = 'cp-stat-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'cp-stat-value';
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      body.appendChild(row);
    }

    if (result.components.length > 0) {
      const listLabel = document.createElement('div');
      listLabel.style.cssText = 'margin-top:12px;margin-bottom:6px;font-weight:600;opacity:0.8;';
      listLabel.textContent = 'Components (topological order):';
      body.appendChild(listLabel);

      const list = document.createElement('ol');
      list.className = 'cp-path-list';
      for (const name of result.components) {
        const item = document.createElement('li');
        item.textContent = name;
        list.appendChild(item);
      }
      body.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'analysis-error';
      empty.style.marginTop = '12px';
      empty.textContent = 'No components found in circuit.';
      body.appendChild(empty);
    }

    document.body.appendChild(overlay);
  });

  // -------------------------------------------------------------------------
  // Analysis menu: State Transition Table
  // -------------------------------------------------------------------------
  document.getElementById('btn-state-transition')?.addEventListener('click', () => {
    // Identify flip-flop Q outputs as state variables
    const flipFlopDefs = registry.getByCategory('FLIP_FLOPS' as any);
    const flipFlopNames = new Set(flipFlopDefs.map((d: { name: string }) => d.name));

    const stateVarSpecs: SignalSpec[] = [];
    const inputSpecs: SignalSpec[] = [];
    const outputSpecs: SignalSpec[] = [];

    for (const el of circuit.elements) {
      const props = el.getProperties();
      const label = props.has('label') ? String(props.get('label')) : '';
      const bits = props.has('bitWidth') ? Number(props.get('bitWidth')) : 1;

      if (flipFlopNames.has(el.typeId)) {
        const name = label.length > 0 ? label : `${el.typeId}_${el.instanceId}`;
        stateVarSpecs.push({ name, bitWidth: 1 });
      } else if (el.typeId === 'In') {
        const name = label.length > 0 ? label : `In_${el.instanceId}`;
        inputSpecs.push({ name, bitWidth: bits });
      } else if (el.typeId === 'Out') {
        const name = label.length > 0 ? label : `Out_${el.instanceId}`;
        outputSpecs.push({ name, bitWidth: bits });
      }
    }

    const { overlay, body } = createModal({
      title: 'State Transition Table',
      className: 'st-dialog',
      overlayClassName: 'st-dialog-overlay',
    });

    if (stateVarSpecs.length === 0) {
      const errDiv = document.createElement('div');
      errDiv.className = 'analysis-error';
      errDiv.textContent = 'No flip-flops found in circuit. State transition analysis requires a sequential circuit.';
      body.appendChild(errDiv);
    } else {
      let tableResult;
      try {
        const engineEl = (name: string, typeId: string) =>
          circuit.elements.find(el => {
            const p = el.getProperties();
            const lbl = p.has('label') ? String(p.get('label')) : '';
            return el.typeId === typeId && lbl === name;
          });

        const seqEng = facade.getCoordinator();
        const seqFacade: SequentialAnalysisFacade = {
          setStateValue(name: string, value: bigint): void {
            const el = circuit.elements.find(e => {
              if (!flipFlopNames.has(e.typeId)) return false;
              const p = e.getProperties();
              const lbl = p.has('label') ? String(p.get('label')) : `${e.typeId}_${e.instanceId}`;
              return lbl === name;
            });
            if (el && seqEng) {
              (seqEng as any).setFlipFlopState?.(el.instanceId, value);
            }
          },
          setInput(name: string, value: bigint): void {
            const el = engineEl(name, 'In');
            if (el && seqEng) {
              (seqEng as any).setInputValue?.(el.instanceId, value);
            }
          },
          clockStep(): void {
            if (seqEng) {
              (seqEng as any).clockStep?.();
            }
          },
          getStateValue(name: string): bigint {
            const el = circuit.elements.find(e => {
              if (!flipFlopNames.has(e.typeId)) return false;
              const p = e.getProperties();
              const lbl = p.has('label') ? String(p.get('label')) : `${e.typeId}_${e.instanceId}`;
              return lbl === name;
            });
            if (el && seqEng) {
              return (seqEng as any).getFlipFlopState?.(el.instanceId) ?? 0n;
            }
            return 0n;
          },
          getOutput(name: string): bigint {
            const el = engineEl(name, 'Out');
            if (el && seqEng) {
              return (seqEng as any).getOutputValue?.(el.instanceId) ?? 0n;
            }
            return 0n;
          },
        };

        tableResult = analyseSequential(seqFacade, stateVarSpecs, inputSpecs, outputSpecs);
      } catch (err) {
        const errDiv = document.createElement('div');
        errDiv.className = 'analysis-error';
        errDiv.textContent = 'Analysis failed: ' + (err instanceof Error ? err.message : String(err));
        body.appendChild(errDiv);
        document.body.appendChild(overlay);
        return;
      }

      // Build table
      const table = document.createElement('table');
      table.className = 'st-table';

      // Group header row
      const groupRow = document.createElement('tr');
      groupRow.className = 'st-group-header';
      const groups = [
        { label: 'Current State', count: tableResult.stateVars.length },
        { label: 'Inputs', count: tableResult.inputs.length },
        { label: 'Next State', count: tableResult.stateVars.length },
        { label: 'Outputs', count: tableResult.outputs.length },
      ].filter(g => g.count > 0);

      for (const g of groups) {
        const th = document.createElement('th');
        th.colSpan = g.count;
        th.textContent = g.label;
        groupRow.appendChild(th);
      }
      table.appendChild(groupRow);

      // Column header row
      const colRow = document.createElement('tr');
      const allCols = [
        ...tableResult.stateVars.map(v => v.name),
        ...tableResult.inputs.map(v => v.name),
        ...tableResult.stateVars.map(v => v.name + "'"),
        ...tableResult.outputs.map(v => v.name),
      ];
      for (const col of allCols) {
        const th = document.createElement('th');
        th.textContent = col;
        colRow.appendChild(th);
      }
      table.appendChild(colRow);

      // Data rows
      for (const row of tableResult.transitions) {
        const tr = document.createElement('tr');
        const vals = [
          ...row.currentState,
          ...row.input,
          ...row.nextState,
          ...row.output,
        ];
        for (const val of vals) {
          const td = document.createElement('td');
          td.textContent = val.toString();
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }

      body.appendChild(table);
    }

    document.body.appendChild(overlay);
  });

  // -------------------------------------------------------------------------
  // Test vector editor dialog
  // -------------------------------------------------------------------------
  document.getElementById('btn-tests')?.addEventListener('click', () => {
    // Find existing Testcase component or create the dialog with empty content
    let existingTestData = '';
    for (const el of circuit.elements) {
      if (el.typeId === 'Testcase') {
        const props = el.getProperties();
        if (props.has('testData')) {
          existingTestData = String(props.get('testData'));
        }
        break;
      }
    }

    const { overlay, dialog } = createModal({
      title: 'Test Vectors',
      className: 'test-dialog',
      overlayClassName: 'test-dialog-overlay',
    });

    const help = document.createElement('div');
    help.className = 'test-help';
    help.innerHTML =
      '<b>Plain format:</b> signal names on first line, then one row per test vector. Use 0/1, X (don\'t-care), C (clock).<br>' +
      '<b>JavaScript:</b> use <code>signals(\'A\',\'B\',\'Y\')</code> then <code>row(0,0,1)</code>. ' +
      'Use loops, variables, functions — full JS. Constants: <code>X</code> (don\'t-care), <code>C</code> (clock), <code>Z</code> (high-Z).';
    dialog.appendChild(help);

    const textarea = document.createElement('textarea');
    textarea.value = existingTestData;
    textarea.placeholder =
      '// Plain format:\nA B Y\n0 0 0\n0 1 1\n\n// Or JavaScript:\nsignals(\'A\', \'B\', \'Y\');\nfor (let i = 0; i < 4; i++) {\n  row(i >> 1, i & 1, (i >> 1) ^ (i & 1));\n}';
    dialog.appendChild(textarea);

    const footer = document.createElement('div');
    footer.className = 'test-dialog-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const rawText = textarea.value;

      // If the test data is a JS script, evaluate it to produce plain format
      let testData: string;
      if (isJsTestScript(rawText)) {
        try {
          testData = evalJsTestScript(rawText);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.showStatus(`Test script error: ${msg}`, true);
          return; // Don't close dialog — let user fix the script
        }
      } else {
        testData = rawText;
      }

      // Store the raw source (JS or plain) so the user sees their script when reopening
      // Also store the evaluated plain-format data for the test executor
      const storeValue = rawText;

      // Find or create Testcase element
      let testEl = circuit.elements.find(el => el.typeId === 'Testcase');
      if (testEl) {
        testEl.getProperties().set('testData', storeValue);
        testEl.getProperties().set('testDataCompiled', testData);
      } else {
        const testDef = registry.get('Testcase');
        if (testDef) {
          const props = new PropertyBag();
          props.set('testData', storeValue);
          props.set('testDataCompiled', testData);
          const el = testDef.factory(props);
          el.position = { x: 0, y: -3 };
          circuit.addElement(el);
        }
      }
      ctx.invalidateCompiled();
      overlay.remove();
      if (isJsTestScript(rawText)) {
        ctx.showStatus(`Test script evaluated: ${testData.split('\n').length - 1} test vectors generated`);
      }
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    dialog.appendChild(footer);

    document.body.appendChild(overlay);
    textarea.focus();
  });
}
