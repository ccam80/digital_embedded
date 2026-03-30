/**
 * Circuit-level SPICE model library dialog.
 *
 * Opened from the main menu ("SPICE Models...").
 * Lists all imported .MODEL parameter sets and .SUBCKT definitions for the
 * current circuit.  Supports add, view, and remove operations.
 *
 * Storage:
 *   - Named parameter sets → circuit.metadata.namedParameterSets
 *   - Subcircuit definitions → circuit.metadata.modelDefinitions
 */

import { createModal } from './dialog-manager.js';
import { parseModelCard } from '../solver/analog/model-parser.js';
import { parseSubcircuit } from '../solver/analog/model-parser.js';
import type { Circuit } from '../core/circuit.js';
import { buildNetConnectivity } from '../core/mna-subcircuit-netlist.js';
import type { MnaSubcircuitNetlist, SubcircuitElement } from '../core/mna-subcircuit-netlist.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open the circuit-level SPICE model library dialog.
 *
 * @param circuit   The active circuit whose metadata holds the model library.
 * @param container The DOM container to attach the overlay to.
 * @param onChange  Called whenever the library is modified (add/remove).
 */
export function openSpiceModelLibraryDialog(
  circuit: Circuit,
  container: HTMLElement,
  onChange: () => void,
): void {
  const modal = createModal({
    title: 'SPICE Models',
    className: 'spice-library-dialog',
  });

  const { body } = modal;

  // Ensure metadata collections exist
  if (!circuit.metadata.namedParameterSets) circuit.metadata.namedParameterSets = {};
  if (!circuit.metadata.modelDefinitions) circuit.metadata.modelDefinitions = {};

  // --- Tabs ---
  const tabBar = document.createElement('div');
  tabBar.className = 'spice-library-tabs';

  const tabModel = document.createElement('button');
  tabModel.className = 'spice-library-tab spice-library-tab-active';
  tabModel.textContent = '.MODEL parameter sets';

  const tabSubckt = document.createElement('button');
  tabSubckt.className = 'spice-library-tab';
  tabSubckt.textContent = '.SUBCKT definitions';

  tabBar.appendChild(tabModel);
  tabBar.appendChild(tabSubckt);
  body.appendChild(tabBar);

  // --- Panel containers ---
  const modelPanel = document.createElement('div');
  modelPanel.className = 'spice-library-panel';
  body.appendChild(modelPanel);

  const subcktPanel = document.createElement('div');
  subcktPanel.className = 'spice-library-panel spice-library-panel-hidden';
  body.appendChild(subcktPanel);

  function switchTab(active: 'model' | 'subckt'): void {
    if (active === 'model') {
      modelPanel.classList.remove('spice-library-panel-hidden');
      subcktPanel.classList.add('spice-library-panel-hidden');
      tabModel.classList.add('spice-library-tab-active');
      tabSubckt.classList.remove('spice-library-tab-active');
    } else {
      subcktPanel.classList.remove('spice-library-panel-hidden');
      modelPanel.classList.add('spice-library-panel-hidden');
      tabSubckt.classList.add('spice-library-tab-active');
      tabModel.classList.remove('spice-library-tab-active');
    }
  }

  tabModel.addEventListener('click', () => switchTab('model'));
  tabSubckt.addEventListener('click', () => switchTab('subckt'));

  // --- Build .MODEL panel ---
  renderModelPanel(modelPanel, circuit, onChange);

  // --- Build .SUBCKT panel ---
  renderSubcktPanel(subcktPanel, circuit, onChange);

  container.appendChild(modal.overlay);
}

// ---------------------------------------------------------------------------
// .MODEL panel
// ---------------------------------------------------------------------------

function renderModelPanel(
  panel: HTMLElement,
  circuit: Circuit,
  onChange: () => void,
): void {
  panel.innerHTML = '';

  const sets = circuit.metadata.namedParameterSets ?? {};
  const names = Object.keys(sets);

  if (names.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'spice-library-empty';
    empty.textContent = 'No .MODEL parameter sets imported yet.';
    panel.appendChild(empty);
  } else {
    const table = document.createElement('table');
    table.className = 'spice-library-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['Name', 'Device Type', 'Parameters', '']) {
      const th = document.createElement('th');
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const name of names) {
      const entry = sets[name];
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = name;
      tr.appendChild(tdName);

      const tdType = document.createElement('td');
      tdType.textContent = entry.deviceType;
      tr.appendChild(tdType);

      const tdCount = document.createElement('td');
      tdCount.textContent = String(Object.keys(entry.params).length);
      tr.appendChild(tdCount);

      const tdAction = document.createElement('td');
      const removeBtn = document.createElement('button');
      removeBtn.className = 'spice-library-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        delete circuit.metadata.namedParameterSets![name];
        onChange();
        renderModelPanel(panel, circuit, onChange);
      });
      tdAction.appendChild(removeBtn);
      tr.appendChild(tdAction);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }

  // --- Add new .MODEL section ---
  const addSection = document.createElement('div');
  addSection.className = 'spice-library-add';

  const addLabel = document.createElement('label');
  addLabel.className = 'spice-library-add-label';
  addLabel.textContent = 'Add .MODEL:';

  const addTextarea = document.createElement('textarea');
  addTextarea.className = 'spice-import-textarea';
  addTextarea.rows = 3;
  addTextarea.placeholder = '.MODEL 2N2222 NPN(IS=1e-14 BF=200)';

  const addFeedback = document.createElement('div');
  addFeedback.className = 'spice-library-feedback';

  const addBtn = document.createElement('button');
  addBtn.className = 'spice-import-apply';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', () => {
    const text = addTextarea.value.trim();
    if (!text) return;
    const result = parseModelCard(text);
    if ('message' in result) {
      addFeedback.textContent = `Error: ${result.message}`;
      addFeedback.className = 'spice-library-feedback spice-import-error';
      return;
    }
    if (!circuit.metadata.namedParameterSets) circuit.metadata.namedParameterSets = {};
    circuit.metadata.namedParameterSets[result.name] = {
      deviceType: result.deviceType,
      params: result.params,
    };
    addTextarea.value = '';
    addFeedback.textContent = `Added "${result.name}"`;
    addFeedback.className = 'spice-library-feedback';
    onChange();
    renderModelPanel(panel, circuit, onChange);
  });

  addSection.appendChild(addLabel);
  addSection.appendChild(addTextarea);
  addSection.appendChild(addFeedback);
  addSection.appendChild(addBtn);
  panel.appendChild(addSection);
}

// ---------------------------------------------------------------------------
// .SUBCKT panel
// ---------------------------------------------------------------------------

function collectModelRefs(netlist: MnaSubcircuitNetlist): string[] {
  const refs = new Set<string>();
  for (const el of netlist.elements) {
    if (el.modelRef) refs.add(el.modelRef);
  }
  return [...refs].sort();
}

function renderSubcktPanel(
  panel: HTMLElement,
  circuit: Circuit,
  onChange: () => void,
): void {
  panel.innerHTML = '';
  const modelRegistry: SubcircuitModelRegistry = getTransistorModels();

  const defs = circuit.metadata.modelDefinitions ?? {};
  const names = Object.keys(defs);
  const namedSets = circuit.metadata.namedParameterSets ?? {};

  if (names.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'spice-library-empty';
    empty.textContent = 'No .SUBCKT definitions imported yet.';
    panel.appendChild(empty);
  } else {
    const table = document.createElement('table');
    table.className = 'spice-library-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['Name', 'Ports', 'Elements', 'Model Refs', '']) {
      const th = document.createElement('th');
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const name of names) {
      const entry = defs[name]!;
      const modelRefs = collectModelRefs(entry);
      const unresolvedRefs = modelRefs.filter(ref => !(ref in namedSets));
      const hasUnresolved = unresolvedRefs.length > 0;

      const tr = document.createElement('tr');
      if (hasUnresolved) tr.className = 'spice-library-row-warning';

      const tdName = document.createElement('td');
      tdName.textContent = name;
      tr.appendChild(tdName);

      const tdPorts = document.createElement('td');
      tdPorts.textContent = entry.ports.join(', ');
      tr.appendChild(tdPorts);

      const tdCount = document.createElement('td');
      tdCount.textContent = String(entry.elements.length);
      tr.appendChild(tdCount);

      const tdRefs = document.createElement('td');
      if (modelRefs.length === 0) {
        tdRefs.textContent = '—';
      } else {
        for (const ref of modelRefs) {
          const span = document.createElement('span');
          span.textContent = ref;
          if (!(ref in namedSets)) {
            span.className = 'spice-library-ref-unresolved';
            span.title = `Model "${ref}" not found in named parameter sets`;
          } else {
            span.className = 'spice-library-ref-resolved';
          }
          tdRefs.appendChild(span);
          tdRefs.appendChild(document.createTextNode(' '));
        }
      }
      tr.appendChild(tdRefs);

      const tdAction = document.createElement('td');

      const assignBtn = document.createElement('button');
      assignBtn.className = 'spice-library-assign';
      assignBtn.textContent = 'Assign\u2026';
      assignBtn.addEventListener('click', () => {
        openAssignDialog(name, circuit, onChange, () => {
          renderSubcktPanel(panel, circuit, onChange);
        });
      });
      tdAction.appendChild(assignBtn);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'spice-library-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        delete circuit.metadata.modelDefinitions![name];
        onChange();
        renderSubcktPanel(panel, circuit, onChange);
      });
      tdAction.appendChild(removeBtn);
      tr.appendChild(tdAction);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }

  // --- Subcircuit bindings section ---
  const bindings = circuit.metadata.subcircuitBindings ?? {};
  const bindingKeys = Object.keys(bindings);
  if (bindingKeys.length > 0) {
    const bindingsSection = document.createElement('div');
    bindingsSection.className = 'spice-library-bindings';

    const bindingsLabel = document.createElement('p');
    bindingsLabel.className = 'spice-library-bindings-label';
    bindingsLabel.textContent = 'Component type assignments:';
    bindingsSection.appendChild(bindingsLabel);

    const bindingsTable = document.createElement('table');
    bindingsTable.className = 'spice-library-table';
    const bthead = document.createElement('thead');
    const bheaderRow = document.createElement('tr');
    for (const col of ['ComponentType:ModelKey', 'Subcircuit', '']) {
      const th = document.createElement('th');
      th.textContent = col;
      bheaderRow.appendChild(th);
    }
    bthead.appendChild(bheaderRow);
    bindingsTable.appendChild(bthead);

    const btbody = document.createElement('tbody');
    for (const key of bindingKeys) {
      const btr = document.createElement('tr');
      const bk = document.createElement('td');
      bk.textContent = key;
      btr.appendChild(bk);
      const bv = document.createElement('td');
      bv.textContent = bindings[key]!;
      btr.appendChild(bv);
      const ba = document.createElement('td');
      const bRemove = document.createElement('button');
      bRemove.className = 'spice-library-remove';
      bRemove.textContent = 'Remove';
      bRemove.addEventListener('click', () => {
        delete circuit.metadata.subcircuitBindings![key];
        onChange();
        renderSubcktPanel(panel, circuit, onChange);
      });
      ba.appendChild(bRemove);
      btr.appendChild(ba);
      btbody.appendChild(btr);
    }
    bindingsTable.appendChild(btbody);
    bindingsSection.appendChild(bindingsTable);
    panel.appendChild(bindingsSection);
  }

  // --- Add new .SUBCKT section ---
  const addSection = document.createElement('div');
  addSection.className = 'spice-library-add';

  const addLabel = document.createElement('label');
  addLabel.className = 'spice-library-add-label';
  addLabel.textContent = 'Add .SUBCKT:';

  const addTextarea = document.createElement('textarea');
  addTextarea.className = 'spice-import-textarea';
  addTextarea.rows = 6;
  addTextarea.placeholder = '.SUBCKT OPAMP IN+ IN- OUT VCC VEE\n* ...\n.ENDS OPAMP';

  const addFeedback = document.createElement('div');
  addFeedback.className = 'spice-library-feedback';

  const addBtn = document.createElement('button');
  addBtn.className = 'spice-import-apply';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', () => {
    const text = addTextarea.value.trim();
    if (!text) return;
    let parsed;
    try {
      parsed = parseSubcircuit(text);
    } catch (e: unknown) {
      const err = e as { message?: string };
      addFeedback.textContent = `Error: ${err.message ?? String(e)}`;
      addFeedback.className = 'spice-library-feedback spice-import-error';
      return;
    }
    const typeMap: Record<string, string> = {
      R: 'Resistor', C: 'Capacitor', L: 'Inductor',
      D: 'Diode', Q: 'NpnBJT', M: 'NMOS',
    };
    const connectivity = buildNetConnectivity(
      parsed.ports,
      parsed.elements.map((e) => e.nodes),
    );
    const netlist: MnaSubcircuitNetlist = {
      ports: parsed.ports,
      elements: parsed.elements.map((e): SubcircuitElement => {
        const el: SubcircuitElement = { typeId: typeMap[e.type] ?? e.type };
        if (e.modelName !== undefined) el.modelRef = e.modelName;
        return el;
      }),
      internalNetCount: connectivity.internalNetCount,
      netlist: connectivity.netlist,
    };
    modelRegistry.register(parsed.name, netlist);
    if (!circuit.metadata.modelDefinitions) circuit.metadata.modelDefinitions = {};
    circuit.metadata.modelDefinitions[parsed.name] = netlist;
    if (parsed.models.length > 0 && !circuit.metadata.namedParameterSets) {
      circuit.metadata.namedParameterSets = {};
    }
    for (const model of parsed.models) {
      circuit.metadata.namedParameterSets![model.name] = {
        deviceType: model.deviceType,
        params: model.params,
      };
    }
    addTextarea.value = '';
    addFeedback.textContent = `Added "${parsed.name}" (${parsed.ports.length} ports, ${parsed.elements.length} elements)`;
    addFeedback.className = 'spice-library-feedback';
    onChange();
    renderSubcktPanel(panel, circuit, onChange);
  });

  addSection.appendChild(addLabel);
  addSection.appendChild(addTextarea);
  addSection.appendChild(addFeedback);
  addSection.appendChild(addBtn);
  panel.appendChild(addSection);
}

// ---------------------------------------------------------------------------
// Assign-to-component-type modal
// ---------------------------------------------------------------------------

function openAssignDialog(
  subcktName: string,
  circuit: Circuit,
  onChange: () => void,
  onRefresh: () => void,
): void {
  const modal = createModal({
    title: `Assign "${subcktName}"`,
    className: 'spice-library-assign-dialog',
  });

  const { body } = modal;

  const desc = document.createElement('p');
  desc.textContent = 'Enter the component type and model key to bind this subcircuit to.';
  body.appendChild(desc);

  const inputLabel = document.createElement('label');
  inputLabel.className = 'spice-library-assign-label';
  inputLabel.textContent = 'ComponentType:modelKey';
  body.appendChild(inputLabel);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'spice-library-assign-input';
  input.placeholder = 'And:cmos or NMOS:custom';
  body.appendChild(input);

  const errorDiv = document.createElement('div');
  errorDiv.className = 'spice-import-error';
  errorDiv.style.display = 'none';
  body.appendChild(errorDiv);

  const btnRow = document.createElement('div');
  btnRow.className = 'spice-import-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'spice-import-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => modal.close());

  const okBtn = document.createElement('button');
  okBtn.className = 'spice-import-apply';
  okBtn.textContent = 'OK';
  okBtn.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value.includes(':')) {
      errorDiv.textContent = 'Format must be ComponentType:modelKey';
      errorDiv.style.display = '';
      return;
    }
    if (!circuit.metadata.subcircuitBindings) circuit.metadata.subcircuitBindings = {};
    circuit.metadata.subcircuitBindings[value] = subcktName;
    onChange();
    modal.close();
    onRefresh();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  body.appendChild(btnRow);

  document.body.appendChild(modal.overlay);
  input.focus();
}
