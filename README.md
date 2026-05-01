# digiTS

A browser-based mixed-domain digital logic and analog MNA-based simulator, statring from a TypeScript port of Helmut Neeman's [Digital](https://github.com/hneemann/Digital) and Paul Falstad's [circuitjs1](https://www.falstad.com/circuit/)- purely static files, no server, no licensing dependencies. I wanted to combine some digital/analog simulations for the ADC/DAC portion of a computer architecture course, and my life has been taken over by AI-agent-fuelled ambition, so I made one. 

## Quick Start

```bash
npm install
npx vite           # Vite dev server on localhost:5173
```

Open `http://localhost:5173/` in your browser.

## Build

```bash
npm run build        # Production bundle -> dist/
```

##

## URL Parameters

All parameters work on the simulator (root URL):

| Parameter | Example | Description |
|-----------|---------|-------------|
| `file` | `file=circuits/half-adder.dig` | Auto-load a circuit on startup |
| `base` | `base=my/path/` | Base path for file resolution (default: `./`) |
| `module` | `module=ece101` | Load a module config (see [Modules](#modules)) |
| `palette` | `palette=And,Or,Not,In,Out` | Restrict component palette to listed types |
| `locked` | `locked=1` | Start in locked (non-editable) mode |
| `dark` | `dark=0` | Force light color scheme (default: dark) |
| `panels` | `panels=none` | Hide all panels (presentation mode) |

Parameters can be combined: `/?file=intro.dig&locked=1&palette=And,Or,Not,In,Out`

URL parameters always override module config defaults.

## Embedding in Moodle (iframe)

The simulator is designed for iframe embedding. It communicates with the host page via postMessage.

### Basic embed

```html
<iframe
  src="https://<user>.github.io/<repo>/"
  width="800" height="600"
></iframe>
```

### Load a specific circuit

```html
<iframe
  src="https://<user>.github.io/<repo>/?file=circuits/half-adder.dig&locked=1"
  width="800" height="600"
></iframe>
```

### Load a module-scoped instance

```html
<iframe
  src="https://<user>.github.io/<repo>/?module=ece101"
  width="800" height="600"
></iframe>
```

### Controlling the simulator from the host page

```javascript
const iframe = document.getElementById('sim');

window.addEventListener('message', (e) => {
  if (e.data.type === 'sim-ready') {
    // Load a circuit
    iframe.contentWindow.postMessage({
      type: 'sim-load-url',
      url: 'https://<user>.github.io/<repo>/circuits/half-adder.dig'
    }, '*');

    // Lock editing
    iframe.contentWindow.postMessage({
      type: 'sim-set-locked', locked: true
    }, '*');

    // Restrict palette
    iframe.contentWindow.postMessage({
      type: 'sim-set-palette',
      components: ['And', 'Or', 'Not', 'In', 'Out']
    }, '*');
  }
});
```

See `CLAUDE.md` for the full postMessage API reference.

## Modules

Modules let you bundle a course-worth of circuits, tutorials, and settings into a single configuration. This is the recommended way to scope the simulator for a specific course on Moodle.

### Directory structure

```
modules/
  ece101/
    config.json           # Module configuration
    week1-intro.dig       # Circuit files for this course
    week2-adders.dig
    lab3-latches.dig
  ece201/
    config.json
    alu-exercise.dig
```

### config.json format

```json
{
  "title": "ECE 101 -- Introduction to Digital Logic",
  "description": "First-year digital logic course.",
  "palette": ["And", "Or", "Not", "NAnd", "In", "Out", "Clock", "Led"],
  "locked": false,
  "file": "week1-intro.dig",
  "circuits": [
    {
      "title": "AND Gate",
      "file": "and-gate.dig",
      "description": "Simple 2-input AND gate"
    },
    {
      "title": "Half Adder",
      "file": "half-adder.dig",
      "description": "XOR + AND half adder"
    }
  ],
  "tutorials": [
    {
      "title": "From SR Latch to D Flip-Flop",
      "manifest": "sr-to-flipflop/manifest.json",
      "description": "Build sequential logic from first principles"
    }
  ]
}
```

### Config fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Display title for the module |
| `description` | string? | Optional description |
| `palette` | string[]? | Restrict palette to these component types. `null` = show all |
| `locked` | boolean? | Lock the editor by default |
| `dark` | boolean? | Override color scheme |
| `panels` | `"default"` or `"none"`? | Panel display mode |
| `file` | string? | Auto-load this circuit (relative to module dir) |
| `circuits` | array? | Available circuits with title, file path, description |
| `tutorials` | array? | Available tutorials with title, manifest path, description |

### Usage

```
/?module=ece101
```

The module config is fetched from `modules/ece101/config.json`. Circuit file paths in the config are resolved relative to the module directory.

URL parameters override module defaults, so `?module=ece101&file=lab3.dig` loads the module's palette but opens a different circuit.

## Tutorials

Step-by-step circuit-building exercises with test-vector validation.

### Viewing tutorials

- `app/tutorial/` -- Tutorial index (lists all available tutorials)
- `app/tutorial/view.html?manifest=tutorials/sr-to-flipflop/manifest.json` -- Single tutorial viewer

### Tutorial files

```
tutorials/
  index.json              # Registry of all tutorials
  sr-to-flipflop/
    manifest.json          # Tutorial definition (steps, test vectors, palette)
    sr-latch-goal.dig      # Goal circuit for step 1
    gated-sr-goal.dig      # Goal circuit for step 2
    edge-triggered-goal.dig
  mcu-build/
    manifest.json
    step-1-adder-goal.dig
    ...
```

### Including tutorials in a module

Reference tutorial manifests in your module's `config.json`. Paths are relative to the module directory, or use `../tutorials/` to reference the shared tutorials directory:

```json
{
  "tutorials": [
    {
      "title": "SR Latch to D Flip-Flop",
      "manifest": "../tutorials/sr-to-flipflop/manifest.json"
    }
  ]
}
```

## Hosted Circuit Files

Example circuits are served from `circuits/`:

```
circuits/
  and-gate.dig
  half-adder.dig
  sr-latch.dig
  shift-add-multiplier.dig
```

Load any hosted circuit via URL: `/?file=circuits/half-adder.dig`

Or via postMessage: `{ type: 'sim-load-url', url: 'circuits/half-adder.dig' }`

## Testing

```bash
npm test             # Vitest unit/integration tests
npm run test:e2e     # Playwright E2E tests
npm run test:all     # Both
```

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/` | TypeScript source |
| `dist/` | Build output |
| `circuits/` | Example .dig circuit files |
| `tutorials/` | Tutorial manifests and goal circuits |
| `modules/` | Course module configs |
| `e2e/` | Playwright E2E tests |
| `scripts/` | CLI tools and MCP server |

## License

See LICENSE file.
