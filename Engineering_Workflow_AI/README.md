# Engineering Workflow AI

This folder is the permanent Engineering Workflow AI workspace, its project collection, and the complete plugin source package. Open this one vault for every project; do not copy the plugin into individual project folders.

Version **0.6.0** connects the Obsidian reasoning workflow to real engineering code and analysis results. It can build or evolve workflows, map exact code locations, propose reviewed source/data edits, run approved Python analyses, capture metrics and generated artifacts, and synchronize the observed results into workflow evidence. Codex is not required.

See [[Engineering Workflow AI - Plugin Guide]] for the user workflow and [[Code Traceability Contract]] for the code/Obsidian synchronization rules.

## How the system works

```text
User request
  → route the relevant workflow and code/data files
  → ask the LLM for a structured change and run plan
  → validate and preview every operation
  → apply approved Markdown/Canvas or source/data changes
  → run approved Python scripts and tests
  → capture logs, metrics, fitted parameters and output files
  → prepare the corresponding workflow/evidence update
```

The LLM does not independently access the filesystem. The plugin owns file discovery, bounded reading, path and hash validation, local writing, execution, result capture, and exact code-link generation.

## Open and test

1. Clone or download this repository, then open the `Engineering_Workflow_AI` directory as a separate Obsidian vault.
2. In **Settings → Community plugins**, enable **Engineering Workflow AI** if it is not already enabled.
3. The chat opens on the right at startup. If it is closed, click the connected-chat icon in the left ribbon.
4. Select an existing project or enter a name under **New project name** and select **Create project**.
5. Paste an OpenAI API key into the field at the top of the panel and select **Save key** when required.
6. Choose a mode, describe the engineering outcome or change, and select **Send**.
7. Review the generated plan. Workflow or engineering files change only after the corresponding Apply action is selected.

The starting request does not need to prescribe an engineering process. A request such as “Build a tool to analyse seal performance and ultimately design a seal for specified working conditions and geometric constraints” is sufficient. The internal policy derives the necessary workflow while leaving missing engineering facts open.

The API key is stored through Obsidian `SecretStorage`, not in this repository or the plugin's `data.json` file.

## Choose a code-folder layout

Code can live inside the selected Obsidian project or in a separate repository anywhere on the computer.

### Self-contained and automatically detected

Use a direct `code/` or `src/` child of the selected project:

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

Under **Settings → Engineering Workflow AI**, enter one or more absolute or vault-relative paths in **External code roots for selected project**. For this repository's bundled seal example, use the portable relative path:

```text
..\seal_calculations_2
```

The workflow project name and repository name do not need to match. The configured root must already exist; the plugin may create files inside an approved root but does not currently create the external repository directory itself. Relative paths are recommended for packages shared between computers.

## Write and run engineering code

Choose **Code + workflow**, or leave the mode on **Auto** and make the implementation intent explicit. For example:

> Implement the supplied seal model in the existing Python comparison tool, add it to the shared model comparison, run the tests and comparison plot, and update the relevant model-qualification records.

The plugin routes a bounded set of relevant source/data files, then proposes exact hash-checked source edits, new data files, and Python runs. Review the replacements and select **Apply code, run, and sync workflow**. The plugin writes the approved files, invokes the configured Python executable directly without a shell, checks declared output files, and prepares a second review for the corresponding Obsidian implementation/evidence update.

For experiment work, include the test configuration, column meanings, units, data points, uncertainties when available, and whether the dataset is for calibration or independent validation. The coding agent can create CSV data, comparison/fitting code, plots and metric tables. It must leave missing equations, units, parameters, acceptance thresholds and physical conclusions open instead of inventing them.

Configure the repository root and Python interpreter under **Settings → Engineering Workflow AI**. Source/data writes are limited to configured roots and permitted engineering file types. Existing files must have been supplied in full and must still match their reviewed SHA-256 hash. Python runs are limited to relative scripts, `pytest`, or `unittest`; no shell command is executed.

## Connect code to the workflow

The separate link builder can scan code read-only and propose exact-link updates to the corresponding workflow branch:

1. Keep code in the selected project's `code/` or `src/` folder, or add one or more external code roots under **Settings → Engineering Workflow AI**. External roots are saved separately for each project.
2. Optionally place a stable workflow ID immediately above a function or class, for example `# workflow: SEAL-ANA-01, SEAL-DEC-01`. Python, JavaScript/TypeScript, C/C++, C#, Java, Go, Rust, Fortran, Julia and Objective-C file extensions are scanned.
3. Select **Build/update code links** in the assistant.
4. Review the model/equation/function mappings, exact local code links, available GitHub commit permalinks and proposed generated trace sections.
5. Apply the workflow changes, or select **Accept current trace state** when no note edit is needed.

Every trace build scans a bounded catalog of relevant classes, functions, methods and annotated line regions, even when a previous baseline exists. The first build classifies the full catalog; later builds reuse mappings for unchanged artifacts and send only changed artifacts unless the workflow graph changes. The plugin generates every URL and inserts a managed **Code traceability** table into each mapped workflow note. Human-authored content outside that table is preserved. GitHub permalinks are shown only for code that matches a committed revision. Code is never modified by this feature.

Structured comments make the mapping deterministic:

```python
# workflow: SEAL-DEC-01
# role: candidate-model
# model: Kearton
class KeartonSeal:
    ...
```

Use a region when the trace must open an exact equation or arbitrary line range:

```python
# workflow-region: SEAL-DEC-01
# role: implementation
# model: Kearton
# equation: mass-flow relation
w = C1 * sqrt(...)
# workflow-region-end
```

Supported roles include `candidate-model`, `implementation`, `comparison`, `verification`, `validation`, `parameter`, `input-output`, `design` and `test`. A role records the code relationship only; it never changes the workflow record's selection, verification, validation, release or approval status.

## Network and privacy

- A request is sent only when **Send** is selected.
- The request goes directly from Obsidian to `https://api.openai.com/v1/responses` using the saved key.
- Existing projects use graph-guided retrieval. The plugin first builds a local metadata index from project-relative paths, frontmatter, headings and links, and reads the primary Canvas as the high-level map.
- A small routing request chooses the relevant stage or branch. A second planning request receives only the selected Markdown/Canvas files and their graph neighbours—not the whole project.
- **Code + workflow** first sends a filename/size manifest to select at most eight relevant engineering files, then sends only those selected file contents plus the focused workflow branch for code planning. The default source/data context cap is 120,000 characters.
- **Build/update code links** locally scans configured source roots and sends one bounded catalog of relevant symbols/annotated regions plus workflow IDs, paths, types, statuses and headings. Full workflow-note content and the entire code repository are not uploaded for this mapping step.
- The defaults cap focused planning context at 12 files and 40,000 characters. The routing map has a separate 24,000-character cap. Both limits can prevent large projects from being sent wholesale.
- Blank projects skip routing because there is no existing graph to inspect.
- API requests use `store: false`.
- The key can be removed with **Clear** in the chat panel.
- This direct bring-your-own-key design is suitable for a local prototype. A broadly distributed product should use a backend or another managed authorization design rather than ship long-lived API credentials in a client application.

## Package map

```text
Engineering_Workflow_AI/
├── .obsidian/plugins/engineering-workflow-ai/  Plugin and source code
│   ├── assets/icon.svg                         Custom ribbon/view icon
│   ├── src/                                    TypeScript source
│   ├── tests/                                  Safety, retrieval and code-index tests
│   ├── main.js                                 Compiled plugin loaded by Obsidian
│   ├── manifest.json                           Obsidian plugin manifest
│   └── styles.css                              Chat-panel styles
├── Projects/
│   ├── Cantilever Beam/                        Completed example project
│   └── Seal Design System/                     Generated seal-workflow example
├── Engineering Workflow AI - Plugin Guide.md   User guide
└── README.md                                   Workspace and build instructions
```

## Build the plugin

Run these commands from `.obsidian\plugins\engineering-workflow-ai`:

```powershell
npm install
npm run check
npm test
npm run build
```

The compiled `main.js` remains in the same plugin folder. There is no separate installation or build directory.

## Prototype limits

- Desktop Obsidian 1.11.4 or later.
- OpenAI Responses API using the user's API key.
- Workflow mode writes are limited to Markdown and Canvas inside the selected project.
- Code + workflow mode can create or edit reviewed engineering source/data files inside configured roots, and can run declared Python scripts/tests directly without a shell.
- No deletion, rename, hidden-path write, inline Python, interactive Python, package installation, arbitrary shell execution, or write outside the selected project/configured engineering roots.
- AI context, writes, change journals and structural validation are scoped to the selected project.
- The panel shows the exact context route and files used before displaying the proposed plan.
- Every AI change is previewed and requires an explicit Apply action.
