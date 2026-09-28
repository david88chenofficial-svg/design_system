# Engineering Workflow AI and Seal Design System

This repository contains a working Obsidian engineering assistant, its complete TypeScript source, example reasoning vaults, and a Python seal-model comparison project.

The assistant connects three kinds of work that are normally separated:

- engineering reasoning in Markdown and Obsidian Canvas;
- implementation and tests in source code;
- calculation, experimental comparison, parameter fitting, plots, and evidence.

The current plugin version is **0.6.0**. It runs inside desktop Obsidian and calls the OpenAI Responses API with the user's own API key. Codex is not required.

## What it can do

- Build an engineering workflow from a short analysis or design objective.
- Add or modify the relevant branch of an existing workflow without reading every note.
- Read selected source files and map models, equations, functions, tests, and result-generation code to exact workflow records.
- Propose and apply reviewed Python and engineering-data changes inside configured code roots.
- Run approved Python scripts, `pytest`, or `unittest` without invoking a shell.
- Create model comparisons, experimental overlays, parameter-fitting routines, metrics, tables, and plot files.
- Feed actual run results back into the relevant Obsidian evidence and decision records.
- Preserve the distinction between implementation verification, calibration, independent validation, model selection, release, and approval.

## How it works

```text
User request
  → local project/code router selects relevant files
  → selected context is sent to the LLM
  → LLM returns a structured change/run plan
  → plugin validates paths, hashes, file types, and commands
  → user reviews and applies the plan
  → local Python produces calculations, metrics, and plots
  → plugin captures the actual outputs
  → LLM prepares the linked Obsidian workflow/evidence update
  → user reviews and applies the workflow update
```

The LLM does not independently browse the computer. The plugin supplies bounded file-reading, file-writing, execution, result-capture, and traceability tools. Existing code replacements require the SHA-256 hash observed during review, and every AI-authored change requires an explicit Apply action.

## Repository map

```text
design_system/
├── Engineering_Workflow_AI/     Open this folder as the AI-enabled Obsidian vault
│   ├── .obsidian/plugins/engineering-workflow-ai/
│   │   ├── src/                 TypeScript plugin source
│   │   ├── tests/               Safety, routing, traceability, and execution tests
│   │   ├── main.js              Compiled plugin loaded by Obsidian
│   │   └── manifest.json
│   ├── Projects/                Example and user-created reasoning projects
│   ├── README.md                Complete setup and usage guide
│   └── Engineering Workflow AI - Plugin Guide.md
├── seal_calculations_2/          Python seal-model comparison repository
├── 00 Start Here/               Original Aero Seal Design vault material
├── 01 Simulation Tool/
├── 02 Design Tool/
├── 03 Evidence/
├── 04 Development Log/
└── 05 Reference/
```

## Quick start

1. Clone or download this repository.
2. In desktop Obsidian, open `Engineering_Workflow_AI` as a vault.
3. Open **Settings → Community plugins** and enable **Engineering Workflow AI**.
4. Reload Obsidian if the right-hand assistant is not already visible.
5. Save an OpenAI API key in the assistant. It is stored using Obsidian `SecretStorage` and is not committed to this repository.
6. Select **Seal Design System** or create another project.
7. For the bundled seal example, open **Settings → Engineering Workflow AI** and set the project's external code root to:

   ```text
   ..\seal_calculations_2
   ```

8. Keep the Python executable as `python`, or enter the absolute path to the required interpreter.
9. Choose a mode, enter a request, inspect the routed files and proposed operations, and apply only the changes you accept.

For example:

> Implement the supplied seal model in the existing all-model comparison. Add focused verification tests, run the common comparison, generate the CSV and plot outputs, and synchronize the implementation and results into the relevant Obsidian model-qualification records.

## Code folder layouts

Code may live inside the Obsidian project or anywhere else on the computer.

### Self-contained project

Place a `code/` or `src/` directory directly inside the selected workflow project. It is detected automatically:

```text
Engineering_Workflow_AI/
└── Projects/
    └── My Engineering Project/
        ├── 00 Start Here/
        ├── 01 Analysis Tool/
        ├── 02 Design Tool/
        ├── 03 Evidence/
        └── code/
            ├── models.py
            ├── tests/
            ├── data/
            └── results/
```

### Separate or existing repository

Add one or more absolute or vault-relative paths under **External code roots for selected project**, one per line. The workflow project name and repository name do not have to match.

For a portable download, keep code beside the vault and use a relative path such as `..\seal_calculations_2`. Avoid distributing machine-specific paths such as `D:\...`.

The configured code-root directory must already exist. The plugin can create files within an existing approved root, but version 0.6.0 does not create a new external repository directory automatically.

## Workflow and scientific visualization

- Obsidian Canvas visualizes the engineering stages, decisions, reasons, evidence, code, releases, iterations, and approvals.
- Python generates scientific plots and result files under the engineering code root.
- Workflow records link to exact source-code lines and generated evidence. A dedicated automatic plot-copy/embed step is not yet included; plots remain result artifacts unless the generated workflow note explicitly links or embeds an accessible file.

## Requirements

- Desktop Obsidian 1.11.4 or later.
- An OpenAI API key and access to the model configured in plugin settings.
- Python 3.10 or later for the bundled seal example.
- Python packages listed in [`requirements.txt`](requirements.txt) for the seal GUI and calculations.

## Build and test the plugin

From `Engineering_Workflow_AI/.obsidian/plugins/engineering-workflow-ai`:

```powershell
npm install
npm run check
npm test
npm run build
```

The compiled `main.js` is written back into the same plugin folder.

## Security and prototype status

This is a local, review-first prototype:

- API requests use `store: false`.
- Only routed project/code context is sent; the plugin does not upload the entire vault for every request.
- Workflow writes are limited to Markdown and Canvas inside the selected project.
- Code/data writes are limited to permitted file types inside configured engineering roots.
- Deletion, renaming, hidden-path writes, parent traversal, inline Python, interactive Python, package-install commands, and arbitrary shell execution are blocked.
- Approved Python scripts run locally with the same operating-system permissions as Obsidian, so users must review generated code before applying and executing it.
- Passing code tests is not physical validation, and fitting calibration data is not independent validation.

See the [complete workspace guide](Engineering_Workflow_AI/README.md), [plugin guide](Engineering_Workflow_AI/Engineering%20Workflow%20AI%20-%20Plugin%20Guide.md), and [code traceability contract](Engineering_Workflow_AI/Code%20Traceability%20Contract.md) for details.
