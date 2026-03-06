#!/usr/bin/env python3
"""
Extract translations from Digital's XML format and convert to JSON.
Maps Digital's flat namespace to our hierarchical key structure.
"""

import xml.etree.ElementTree as ET
import json
from pathlib import Path

# Key mapping from Digital's flat keys to our hierarchical structure
KEY_MAPPING = {
    # Menu items
    "menu_file_new": "menu.file.new",
    "menu_file_open": "menu.file.open",
    "menu_file_save": "menu.file.save",
    "menu_file_saveAs": "menu.file.saveAs",
    "menu_file_close": "menu.file.close",
    "menu_file_exit": "menu.file.exit",
    "menu_file_export": "menu.file.export",

    "menu_edit_undo": "menu.edit.undo",
    "menu_edit_redo": "menu.edit.redo",
    "menu_edit_cut": "menu.edit.cut",
    "menu_edit_copy": "menu.edit.copy",
    "menu_edit_paste": "menu.edit.paste",
    "menu_edit_delete": "menu.edit.delete",
    "menu_edit_selectAll": "menu.edit.selectAll",

    "menu_view_zoomIn": "menu.view.zoomIn",
    "menu_view_zoomOut": "menu.view.zoomOut",
    "menu_view_resetZoom": "menu.view.resetZoom",
    "menu_view_fitToWindow": "menu.view.fitToWindow",

    "menu_simulation_run": "menu.simulation.run",
    "menu_simulation_stop": "menu.simulation.stop",
    "menu_simulation_step": "menu.simulation.step",
    "menu_simulation_reset": "menu.simulation.reset",

    # Toolbar items
    "btn_step": "toolbar.step",
    "btn_run": "toolbar.run",
    "btn_stop": "toolbar.stop",
    "btn_reset": "toolbar.reset",

    # Component names
    "elem_And": "components.gates.and",
    "elem_NAnd": "components.gates.nand",
    "elem_Or": "components.gates.or",
    "elem_NOr": "components.gates.nor",
    "elem_XOr": "components.gates.xor",
    "elem_XNOr": "components.gates.xnor",
    "elem_Not": "components.gates.not",

    "elem_In": "components.io.input",
    "elem_Out": "components.io.output",
    "elem_Button": "components.io.button",
    "elem_Clock": "components.io.clock",
    "elem_LED": "components.io.led",
    "elem_DipSwitch": "components.io.switch",

    "elem_ROM": "components.memory.rom",
    "elem_RAMDualPort": "components.memory.ram",

    "elem_D_FF": "components.flipflops.dFlipFlop",
    "elem_JK_FF": "components.flipflops.jkFlipFlop",
    "elem_T_FF": "components.flipflops.tFlipFlop",
    "elem_RS_FF_AS": "components.flipflops.srLatch",

    "elem_Seven-Seg": "components.display.sevenSegment",
    "elem_Seven-Seg-Hex": "components.display.hexDisplay",
    "elem_LedMatrix": "components.display.ledMatrix",

    "elem_Splitter": "components.wiring.splitter",
    "elem_Tunnel": "components.wiring.label",

    # Dialogs and common strings
    "cancel": "dialogs.common.cancel",
    "msg_warning": "dialogs.common.warning",
    "digital": "app.title",
}

def extract_translations(xml_file):
    """Extract all translations from an XML file."""
    translations = {}

    try:
        tree = ET.parse(xml_file)
        root = tree.getroot()

        for string_elem in root.findall('string'):
            name = string_elem.get('name')
            value = string_elem.text or ''

            if name:
                translations[name] = value

        return translations
    except Exception as e:
        print(f"Error parsing {xml_file}: {e}")
        return {}

def map_to_hierarchy(flat_dict, mapping):
    """Map flat Digital keys to our hierarchical structure."""
    result = {}
    unmapped = {}

    for digital_key, value in flat_dict.items():
        if digital_key in mapping:
            hier_key = mapping[digital_key]
            parts = hier_key.split('.')

            # Navigate/create nested structure
            current = result
            for part in parts[:-1]:
                if part not in current:
                    current[part] = {}
                current = current[part]

            current[parts[-1]] = value
        else:
            unmapped[digital_key] = value

    return result, unmapped

def create_complete_json(en_dict):
    """Ensure our required key structure exists."""
    # Start with what we have
    result = en_dict.copy()

    # Ensure structure exists
    if 'menu' not in result:
        result['menu'] = {}
    if 'toolbar' not in result:
        result['toolbar'] = {}
    if 'components' not in result:
        result['components'] = {}
    if 'dialogs' not in result:
        result['dialogs'] = {}
    if 'errors' not in result:
        result['errors'] = {}
    if 'messages' not in result:
        result['messages'] = {}
    if 'properties' not in result:
        result['properties'] = {}
    if 'analysis' not in result:
        result['analysis'] = {}
    if 'library' not in result:
        result['library'] = {}

    # Ensure submenu structures
    for key in ['file', 'edit', 'view', 'simulation']:
        if key not in result['menu']:
            result['menu'][key] = {}

    if 'gates' not in result['components']:
        result['components']['gates'] = {}
    if 'arithmetic' not in result['components']:
        result['components']['arithmetic'] = {}
    if 'flipflops' not in result['components']:
        result['components']['flipflops'] = {}
    if 'memory' not in result['components']:
        result['components']['memory'] = {}
    if 'io' not in result['components']:
        result['components']['io'] = {}
    if 'display' not in result['components']:
        result['components']['display'] = {}
    if 'wiring' not in result['components']:
        result['components']['wiring'] = {}

    return result

def flatten_dict(d, parent_key=''):
    """Convert nested dict back to flat for easier comparison."""
    items = []
    for k, v in d.items():
        new_key = f"{parent_key}.{k}" if parent_key else k
        if isinstance(v, dict):
            items.extend(flatten_dict(v, new_key).items())
        else:
            items.append((new_key, v))
    return dict(items)

def main():
    project_root = Path("/C:/local_working_projects/digital_js")
    ref_lang_dir = project_root / "ref/Digital/src/main/resources/lang"
    locales_dir = project_root / "src/i18n/locales"

    # Load existing English translations (our JSON format)
    with open(locales_dir / "en.json") as f:
        en_json = json.load(f)

    en_flat = flatten_dict(en_json)

    # Load Digital's English translations
    digital_en = extract_translations(ref_lang_dir / "lang_en.xml")
    digital_zh = extract_translations(ref_lang_dir / "lang_zh.xml")
    digital_de = extract_translations(ref_lang_dir / "lang_de.xml")

    print(f"Loaded {len(digital_en)} English strings from Digital")
    print(f"Loaded {len(digital_zh)} Chinese strings from Digital")
    print(f"Loaded {len(digital_de)} German strings from Digital")

    # For now, use our existing English as the base and enrich with Digital
    zh_result = en_json.copy()
    de_result = en_json.copy()

    # Map element names from Digital format
    element_mapping = {}
    for key, val in digital_en.items():
        if key.startswith('elem_'):
            element_mapping[key] = val

    # Try to match Digital keys to our structure using value comparison
    for our_key, our_value in en_flat.items():
        for digital_key, digital_value in digital_en.items():
            if digital_value == our_value and digital_key not in element_mapping:
                # Found a match - use the Chinese translation
                if digital_key in digital_zh:
                    zh_flat = flatten_dict(zh_result)
                    zh_flat[our_key] = digital_zh[digital_key]
                    # Reconstruct nested structure
                    zh_result = {}
                    for k, v in zh_flat.items():
                        parts = k.split('.')
                        current = zh_result
                        for part in parts[:-1]:
                            if part not in current:
                                current[part] = {}
                            current = current[part]
                        current[parts[-1]] = v

                if digital_key in digital_de:
                    de_flat = flatten_dict(de_result)
                    de_flat[our_key] = digital_de[digital_key]
                    # Reconstruct nested structure
                    de_result = {}
                    for k, v in de_flat.items():
                        parts = k.split('.')
                        current = de_result
                        for part in parts[:-1]:
                            if part not in current:
                                current[part] = {}
                            current = current[part]
                        current[parts[-1]] = v

    # Write results
    with open(locales_dir / "zh.json", 'w', encoding='utf-8') as f:
        json.dump(zh_result, f, ensure_ascii=False, indent=2)

    with open(locales_dir / "de.json", 'w', encoding='utf-8') as f:
        json.dump(de_result, f, ensure_ascii=False, indent=2)

    print(f"Created zh.json and de.json")

if __name__ == "__main__":
    main()
