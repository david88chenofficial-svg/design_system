---
id: SEAL-DEC-02
type: decision
status: open
parent-decision: SEAL-DEC-01
---

# Select Model Parameter Basis

## Decision

TBD. The newly proposed model has not been identified or selected, and no parameter value is selected.

## Decision required

For each parameter required by a selected model, define and select a controlled parameter basis before using the model for a prediction. This includes the parameters named in the request:

| Parameter or term | Definition/form used by model | Value or selection rule | Source or derivation | Applicable domain | Uncertainty/sensitivity | Status |
|---|---|---|---|---|---|---|
| Discharge coefficient | TBD | TBD | TBD | TBD | TBD | Open |
| Kinetic-energy carry-over | TBD; clarify the intended quantity, formulation, and where it enters the model | TBD | TBD | TBD | TBD | Open |
| Other model parameters | TBD after model definition | TBD | TBD | TBD | TBD | Open |

## Selection controls

A parameter basis must state whether a value is measured, supplied by a source, calibrated, estimated, or derived; identify units and reference conditions where applicable; identify the configuration and model version to which it applies; and prohibit use outside its justified domain without an explicit disposition.

Calibration data and independent validation data must be separated. Selecting a parameter value from code availability or a default setting alone is not sufficient evidence of physical applicability.

## Dependencies

- Parent decision: [[SEAL-DEC-01 - Select Baseline Seal Model Basis]]
- Rationale: [[SEAL-WHY-01 - Why the Baseline Seal Model Must Be Qualified]]
- Evidence plan: [[SEAL-EVID-001 - Baseline Qualification Evidence Plan]]
- Controlled implementation boundary: [[SEAL-REF-001 - Analysis Implementation Map]]

## Downstream impact

Any analysis result produced with the selected model must record the controlled parameter set, its source or derivation, its uncertainty treatment, and its applicability. A qualified analysis release cannot claim coverage for conditions or parameter ranges not supported by its verification and independent physical validation evidence.
