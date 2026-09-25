# Engineering Workflow AI

This folder is the permanent Engineering Workflow AI workspace, its project collection, and the complete plugin source package. Open this one vault for every project; do not copy the plugin into individual project folders.

See [[Engineering Workflow AI - Plugin Guide]] for the user workflow and [[Code Traceability Contract]] for the code/Obsidian synchronization rules.

## Open and test

1. Clone or download this repository, then open the `Engineering_Workflow_AI` directory as a separate Obsidian vault.
2. In **Settings → Community plugins**, enable **Engineering Workflow AI** if it is not already enabled.
3. The chat opens on the right at startup. If it is closed, click the connected-chat icon in the left ribbon.
4. Select an existing project or enter a name under **New project name** and select **Create project**.
5. Paste an OpenAI API key into the field at the top of the panel and select **Save key** when required.
6. Choose a mode, describe the engineering outcome or change, and select **Send**.
7. Review the generated plan. Files inside the selected project change only after **Apply approved changes** is selected.

The starting request does not need to prescribe an engineering process. A request such as “Build a tool to analyse seal performance and ultimately design a seal for specified working conditions and geometric constraints” is sufficient. The internal policy derives the necessary workflow while leaving missing engineering facts open.

The API key is stored through Obsidian `SecretStorage`, not in this repository or the plugin's `data.json` file.

## Connect code to the workflow

The plugin can scan code read-only and propose updates to the corresponding workflow branch:

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
- AI writes are limited to Markdown and Canvas; source code is read-only.
- No deletion, shell execution, arbitrary code execution, or writes outside the selected project.
- AI context, writes, change journals and structural validation are scoped to the selected project.
- The panel shows the exact context route and files used before displaying the proposed plan.
- Every AI change is previewed and requires an explicit Apply action.
