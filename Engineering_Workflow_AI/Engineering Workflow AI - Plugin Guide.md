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
4. Choose `Auto`, `Build from scratch`, `Add or modify branches`, or `Audit only`.
5. Describe the desired engineering outcome or change.
6. Check the context-route message. It lists the existing files selected for the request.
7. Review every proposed file operation. Expand **Context used** to inspect the route again.
8. Select **Apply approved changes** only when the preview is correct.

For a blank project, the request can be intentionally short. For example:

> I want to build an engineering tool that can analyse seal performance and ultimately help design a seal for specified working conditions and geometric constraints. Build the project workflow from scratch.

The user states the outcome; the assistant derives the analysis, qualification and design-development workflow. Missing engineering facts remain open rather than being invented.

## Safety boundary

- The AI proposes structured changes; it never writes directly.
- The plugin allows only `.md` and `.canvas` creation or replacement inside the selected project.
- Deletion, hidden paths, `.obsidian`, shell commands and executable-code modifications are blocked.
- Existing files require matching SHA-256 hashes before replacement.
- Every applied plan receives a JSON change journal under the selected project's `04 Development Log/AI Changes` folder.

## Network boundary

Selecting **Send** on an existing project normally makes two API requests:

1. A routing request receives the primary Canvas plus a compact metadata map of project-relative paths, frontmatter fields, headings and links.
2. The planning request receives only the routed branch and nearby linked notes.

The plugin builds the map locally. It does not send every note in full for every change. Default focused-context limits are 12 files and 40,000 characters, while the compact routing map is capped at 24,000 characters. If routing is unavailable, a local path/metadata/heading matcher selects the branch. A blank project skips routing and goes directly to planning.

Other projects are excluded. Requests use `store: false`. No project data is transmitted merely by opening the panel.

## Source and icon

- Plugin source: `.obsidian/plugins/engineering-workflow-ai/src`
- Compiled entry point: `.obsidian/plugins/engineering-workflow-ai/main.js`
- Ribbon/view icon: `.obsidian/plugins/engineering-workflow-ai/assets/icon.svg`
- Interface styling: `.obsidian/plugins/engineering-workflow-ai/styles.css`
- Workspace README: [[README]]
