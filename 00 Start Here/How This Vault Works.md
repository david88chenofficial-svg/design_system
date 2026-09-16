---
id: GUIDE-001
type: guide
status: active
---

# How This Vault Works

The vault is a small reasoning graph, not a form library.

```text
workflow stage → decision → reason → evidence or code
                              ↓
                       further decision, only if needed
```

## Rules

1. Keep the main workflow in [[Engineering Stream]].
2. Create a `DEC-...` note only when a real engineering choice must be made.
3. Every decision links to one `WHY-...` note containing its reason, alternatives and evidence.
4. Put comparisons, experimental results and code links directly in the reason note unless they genuinely need their own reusable record.
5. If a reason depends on another choice, link to another `DEC-...` note. Repeat the same pattern recursively.
6. `TBD` means unknown. An LLM must not invent missing reasons, evidence, values or approval.

## Naming

- Decision: `DEC-<stage>-<number> - <short decision>.md`
- Reason: `WHY-<stage>-<number> - <short reason>.md`

Use [[Template - Decision]] and [[Template - Reason]].

