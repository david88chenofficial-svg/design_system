---
id: GUIDE-PLUGIN-001
type: guide
status: prototype
---

# Engineering Workflow AI Plugin

## Open the assistant

After cloning or downloading the repository, open the `Engineering_Workflow_AI` directory as a separate Obsidian vault. The assistant opens in the right sidebar when the vault starts. If it is closed, select the connected-chat icon in Obsidian's left ribbon or run **Engineering Workflow AI: Open chat panel** from the command palette. Startup opening can be disabled in the plugin settings.

## First use

1. Select an existing project, or enter a name and select **Create project**.
2. Paste an OpenAI API key into the assistant when required.
3. Select **Save key**. The key is stored with Obsidian SecretStorage and can be removed with **Clear**.
4. Choose `Auto`, `Build from scratch`, `Add or modify branches`, `Audit only`, or `Manual code + workflow`.
5. Describe the desired engineering outcome or change.
6. Check the context-route message. It lists the existing files selected for the request.
7. Review every proposed file operation. Expand **Context used** to inspect the route again.
8. Select **Apply approved changes** only when the preview is correct.

Use **Add reference images** before sending to include up to four diagrams, equation screenshots, sketches, or photos in that planning request. Supported formats are PNG, JPEG, WebP, and GIF. On send, the plugin saves each image under the selected project's `Reference Images/` folder using a content-hashed filename, supplies that exact path to the planner, and embeds the image in at least one relevant Markdown stage or interface note. Reattaching the same file reuses the same asset path.

While an AI request or Verifier run is active, select **Abort** beside **Working…** to stop the session. The plugin terminates a running Python process, discards late AI responses, clears the active stage queue, and leaves any file changes that completed before cancellation visible for review.

Select **Agent activity** in the Copilot header to open the terminal-style progress console. It opens automatically for a new session and can be moved or resized. The console reports the active Router, Planner, Coder, Verifier, or Python Runner phase; stage and attempt progress; proposed or changed files; concise verification output; elapsed API time; and exact input/output/total tokens after each API response. Use its **Abort**, **Copy log**, **Clear**, and **Close** controls as needed. It intentionally excludes API keys, complete prompts, and hidden model reasoning.

For a typical coupled-analysis project, the primary Canvas targets about three large main boxes in one horizontal row—for example **Design basis → Aerodynamic model → Structural model**. Every box is a Canvas file node backed by a real Markdown note, so it can be opened fully. Each executable model has one smaller code-input file above it and one code-output file below it. Requirements, open questions, interface decisions, verification, qualification, release, and approval records do not automatically become additional main-workflow boxes.

For a blank project, the request can be intentionally short. For example:

> I want to build an engineering tool that can analyse seal performance and ultimately help design a seal for specified working conditions and geometric constraints. Build the project workflow from scratch.

The user states the outcome; the assistant derives the analysis, qualification and design-development workflow. Missing engineering facts remain open rather than being invented.

## Model-stage input and output contracts

For every executable computational or physical-model stage, the assistant builds two complementary traces:

```text
inputs → stage → outputs
         stage → decision → reason → evidence/code
```

Each executable box creates a concise stage brief with two parts. **Physical/theoretical model** contains the purpose, assumptions and applicability, and governing model/equations. **Code implementation contract** contains the numerical method, links to dedicated input and output contracts, and concise verification intent. The input contract defines practical runtime fields such as dimensions, working conditions and solver controls; the output contract defines calculated fields and downstream consumers. A short horizontal edge between the main model boxes names the selected handoff.

Stage IDs and `type: stage` metadata are generated automatically. The assistant does not create one node per scalar parameter, generate detailed coding subtasks, or turn ordinary coding steps into main workflow boxes. Missing runtime values may remain user-supplied/TBD; only missing governing physics or an undefined engineering mapping is treated as a model-definition gap. Passing execution is not automatically treated as verification, and verification remains separate from physical validation.

## Implement models, experiments and plots

### Generate and verify code from workflow boxes

After applying the planned workflow, use **Executable workflow stages** in the Copilot window. A model box appears here when its `stage` note contains **Inputs**, **Model or method**, **Outputs**, and **Acceptance and verification** sections.

1. Set **Max attempts** between 1 and 8.
2. Select the stages to implement, or choose **Generate/modify all unresolved**.
3. The plugin includes unresolved dependencies and orders the queue from upstream producers to downstream consumers.
4. Review the Coder's exact source changes and standard `--input <json> --output <json>` runner. Select **Apply code and let Verifier test** only if the code is acceptable. Applying it does not run it.
5. The independent Verifier prepares example inputs and checks. The plugin then runs those cases directly and returns the captured JSON evidence to the Verifier for a `pass`, `fail`, or `inconclusive` verdict.
6. A pass advances to the next selected stage. A fail or inconclusive verdict supplies concrete feedback to the next Coder attempt, up to the chosen limit. Every repair still requires user approval before it can be applied.

The plugin stores verification records, implementation hashes, attempts, and upstream signatures per project. Editing a stage contract or implemented file, or re-verifying an upstream dependency, marks affected stages stale. This status is implementation verification only; physical validation and engineering approval remain explicit workflow decisions.

If no configured, `code/`, or `src/` root exists, the staged path creates a `code/` folder inside the selected project. External repositories must already exist and be listed in settings.

### Manual code and analysis

Use **Manual code + workflow** when a one-off instruction should modify the engineering repository, execute a reviewed run plan, and synchronize the observed result into Obsidian. **Auto** also routes explicit implementation, run, plot, fitting and calibration requests to this path. Use the executable-stage path above when the Verifier must own test inputs and execution.

1. Select the matching Obsidian project.
2. Under **Settings → Engineering Workflow AI**, add the repository under **External code roots for selected project** and set the Python executable or interpreter path.
3. Describe the implementation directly—for example, “Implement this seal model and add it to the existing all-model comparison.” Include the governing equations, variable definitions, units, coefficients, assumptions and intended domain that are not already present in a cited implementation.
4. For experiments, include or identify the operating configuration, data columns, units, points, measurement uncertainty and whether the data is for calibration or independent validation.
5. Review every exact source/data replacement and declared Python run.
6. Select **Apply code, run, and sync workflow**.
7. Inspect the actual run status and then review/apply the proposed Obsidian evidence update.
8. Use **Build/update code links** after implementation to regenerate all exact line links when desired.

The agent can add a candidate class/function, register it with a common comparison runner, create focused tests, create CSV/JSON data, generate non-interactive comparison scripts, fit declared parameters, calculate metrics, and generate plots. It does not silently infer missing physics or call calibration agreement an independent validation. Model selection remains open unless the record contains the comparison domain, metric, threshold and applicable evidence.

## Build and update exact code links

Code inside the selected project's `code/` or `src/` folder is detected automatically. For code elsewhere:

1. Select the project in the assistant.
2. Open **Settings → Engineering Workflow AI**.
3. Enter absolute or vault-relative paths under **External code roots for selected project**, one per line.
4. Return to the assistant and select **Build/update code links**.

Use stable workflow IDs to make a deterministic connection from a function or class to an existing note:

```python
# workflow: SEAL-DEC-01
# role: candidate-model
# model: Kearton
def calculate_leakage(...):
    ...
```

For a single equation or arbitrary line range, use an explicit region:

```python
# workflow-region: SEAL-DEC-01
# role: implementation
# model: Kearton
# equation: mass-flow relation
w = C1 * sqrt(...)
# workflow-region-end
```

The scanner builds a bounded catalog of relevant classes, functions, methods and annotated regions. The LLM classifies each artifact against existing workflow IDs, but it does not write URLs. The plugin validates the IDs, generates exact VS Code/GitHub line links, and creates a managed **Code traceability** table inside every mapped workflow note. Therefore a Canvas decision block opens its note, where each candidate model or equation links directly to its implementation.

The generated section is delimited by `workflow-ai-code-trace` comments. Rebuild it through the plugin instead of editing it manually; human-authored content elsewhere in the note is preserved.

See [[Code Traceability Contract]] for the complete annotation grammar, role meanings and LLM safety boundary.

Applying the proposed note changes also saves the reviewed trace state. If no note changes are required, select **Accept current trace state**. Later builds reuse unchanged mappings and classify only changed artifacts unless the workflow graph changes. The link-building action never edits code; code edits occur only through a separately previewed staged or **Manual code + workflow** plan. A `candidate-model` mapping does not select that model; a `verification` or `validation` mapping identifies implementation only and does not establish a successful result.

## Safety boundary

- The AI proposes structured changes; the plugin validates and applies them only after explicit review.
- Workflow plans allow only `.md` and `.canvas` creation or replacement inside the selected project.
- Staged and manual code plans allow reviewed source/data creation or exact-block replacement only inside configured engineering roots.
- In staged mode, Coder output has no run command. The independent Verifier authors the cases before the controller invokes the standard runner.
- Python execution uses the configured interpreter directly and permits only relative scripts, `pytest`, or `unittest`; no shell, inline Python, interactive Python or package-install command is exposed.
- Deletion, renaming, hidden paths, `.obsidian`, parent traversal and writes outside the configured scopes are blocked.
- Existing files require matching SHA-256 hashes before replacement.
- Every applied workflow plan receives a JSON change journal under the selected project's `04 Development Log/AI Changes` folder. Source edits are prevalidated as one set and restored if a filesystem write fails before execution.

## Network boundary

Selecting **Send** on an existing project normally makes two API requests:

1. A routing request receives the primary Canvas plus a compact metadata map of project-relative paths, frontmatter fields, headings and links.
2. The planning request receives only the routed branch and nearby linked notes.

The plugin builds the map locally. It does not send every note in full for every change. Default focused-context limits are 12 files and 40,000 characters, while the compact routing map is capped at 24,000 characters. If routing is unavailable, a local path/metadata/heading matcher selects the branch. A blank project skips routing and goes directly to planning.

Manual code + workflow requests add a repository-routing request containing paths, extensions and sizes, followed by a coding request containing at most eight selected files and 120,000 source/data characters by default. After approved execution, a result-synchronization request receives the actual run output, declared result hashes, affected code artifacts and focused workflow branch. Staged requests send one stage contract plus bounded implementation context to the Coder; after approval, the Verifier receives the implementation context and locally captured case evidence needed for its verdict.

Other projects are excluded. Requests use `store: false`. No project data is transmitted merely by opening the panel.

## Source and icon

- Plugin source: `.obsidian/plugins/engineering-workflow-ai/src`
- Compiled entry point: `.obsidian/plugins/engineering-workflow-ai/main.js`
- Ribbon/view icon: `.obsidian/plugins/engineering-workflow-ai/assets/icon.svg`
- Interface styling: `.obsidian/plugins/engineering-workflow-ai/styles.css`
- Workspace README: [[README]]
