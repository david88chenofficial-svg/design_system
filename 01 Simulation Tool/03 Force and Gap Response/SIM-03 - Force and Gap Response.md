---
id: SIM-03
type: stream-stage
status: planned
upstream: [SIM-02]
downstream: [SIM-04]
evidence: []
decisions: []
---

# SIM-03 - Force and Gap Response

## Purpose

Develop and qualify calculation of resultant axial force and restoring/destabilising force response across permitted gap or displacement positions, using the approved pressure solution.

Repeat [[Stage Development Cycle]] for this added capability: define force outputs and tolerances, evaluate candidate integration/area treatments, verify the implementation, validate against available force evidence, and justify the selected method.

## Inputs

TBD

## Methods and parameters

Current candidate code applies a common Gamma 2 gauge-force postprocessor to every model pressure curve. This records what the tool currently does; the method is not approved until the stage verification, validation and decision records are completed.

- [Open common force postprocessor](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/plot_all_models.py:174)
- [Open inlet-side force equation](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/gamma_seal_2.py:166)
- [Open outlet-side force equation](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/gamma_seal_2.py:182)
- [Open balancing-chamber force equation](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/gamma_seal_2.py:198)
- [Open resultant-force equation](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/gamma_seal_2.py:213)
- [Open displacement-to-effective-clearance mapping](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/plot_all_models.py:117)

## Decisions

None recorded yet. When a force method is chosen, create one decision note and one linked reason note.

## Approved output/release

TBD
