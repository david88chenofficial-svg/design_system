---
id: SEAL-WHY-01
type: reason
status: incomplete
---

# Why the Baseline Seal Model Must Be Qualified

## Reason

Seal performance depends on the actual seal architecture, materials, interfaces, installation, operating conditions, and selected performance measure. A model or implementation can be internally consistent yet physically inapplicable to the intended seal.

Where a model requires coefficients or carry-over terms, predicted performance also depends on their definitions, values, source or derivation, and domain of applicability. An undocumented default, calibration choice, or transferred value can conceal uncertainty or invalidate use outside the supporting conditions.

## Selection basis

The eventual model comparison must use a common declared domain and assess:

- representation of the selected seal mechanism and interfaces;
- required material, geometry, loading, thermal, media, and parameter inputs;
- definitions, sources, selection rules, and applicability of configurable parameters, including discharge coefficient and kinetic-energy carry-over where used;
- applicability limits and uncertainty;
- implementation verification against independent reference cases; and
- physical validation against independent representative measurements.

## Evidence

[[SEAL-EVID-001 - Baseline Qualification Evidence Plan]]

## Conclusion

Incomplete. Candidate methods, parameter formulations and values, evidence, acceptance criteria, and release domain are TBD.
