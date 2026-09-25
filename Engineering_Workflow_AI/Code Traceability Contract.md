---
id: GUIDE-CODE-TRACE-001
type: guide
status: prototype
---

# Code Traceability Contract

This contract keeps engineering code and the Obsidian reasoning workflow coherent without treating implementation as proof of engineering validity.

## Identity in Obsidian

Every workflow record that may receive code links must have a unique, stable frontmatter `id`. Titles and filenames may change; the ID is the code-facing identity.

## Identity in code

Place structured metadata immediately above a function/class, or use an exact region. The minimum deterministic link is:

```python
# workflow: SEAL-DEC-01
def implementation(...):
    ...
```

Recommended metadata is:

```python
# workflow: SEAL-DEC-01
# role: candidate-model
# model: Kearton
class KeartonSeal:
    ...
```

For an equation or arbitrary line range:

```python
# workflow-region: SEAL-DEC-01
# role: implementation
# model: Kearton
# equation: mass-flow relation
w = C1 * sqrt(...)
# workflow-region-end
```

Supported relationship roles are `candidate-model`, `implementation`, `comparison`, `verification`, `validation`, `parameter`, `input-output`, `design`, `test` and `other`.

## Generated Obsidian section

The first **Build/update code links** run performs one bounded classification request. Later runs reuse unchanged mappings and classify only changed artifacts unless the workflow graph changes. The LLM may choose only scanner-provided artifact IDs and existing workflow IDs. The plugin—not the LLM—generates exact local and GitHub links and inserts them between:

```text
<!-- workflow-ai-code-trace:start -->
<!-- workflow-ai-code-trace:end -->
```

Do not manually edit inside those markers. Human-authored content outside them is preserved. Rebuilding recalculates line ranges, updates moved code and removes generated links that are no longer mapped, subject to explicit preview and approval.

## Engineering meaning

- `candidate-model` means an implementation candidate was observed; it does not select the model.
- `verification` or `test` identifies verification software; it does not establish a passing verification result.
- `validation` identifies data-comparison software; it does not establish agreement with physical evidence.
- `comparison` identifies a shared comparison implementation; it does not establish a preferred candidate.
- `design` identifies design or optimisation implementation; it does not approve a design.

Model selection still requires declared quantities, domain, assumptions, shared cases, metrics, thresholds and evidence. Verification and validation remain separate.

## Direction of synchronization

- **Code → Obsidian:** stable workflow IDs, roles, model/equation metadata and code hashes identify what changed and where it belongs.
- **Obsidian → code:** generated tables expose exact file/line links and immutable GitHub permalinks when the source is committed.
- **No silent code writes:** the plugin reads source code but never inserts or modifies annotations. Engineers retain control of implementation changes.
- **Review first:** every Markdown replacement is previewed, hash-checked, journaled and applied only after approval.

## LLM boundary

The LLM classifies semantic relationships when code lacks explicit annotations. It cannot author URLs, target nonexistent workflow IDs, change source code, or advance decision/verification/validation/release/approval status through trace building. Ambiguous relationships must be omitted or flagged for an engineer.
