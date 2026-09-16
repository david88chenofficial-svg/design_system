---
id: SIM-01
type: stream-stage
status: in-progress
upstream: [SIM-00A]
downstream: [SIM-02]
---

# SIM-01 - Pressure and Leakage Model Qualification

## Purpose

Develop the first working analysis capability by running candidate pressure/leakage models, choosing parameter treatments such as discharge coefficient and kinetic-energy carryover, and comparing calculated pressure and leakage with experimental data.

This is the first complete use of [[Stage Development Cycle]], not an administrative step before calculation.

## Decisions

- [[DEC-SIM-01-01 - Choose Pressure and Leakage Model]]
- [[DEC-SIM-01-02 - Choose Discharge Coefficient]]
- [[DEC-SIM-01-03 - Choose Kinetic-Energy Carryover]]

## Exit condition

A named, versioned baseline model and parameter set is implementation-verified, physically validated within a stated domain, and supported by explicit comparison and selection decisions. Its approved output feeds [[SIM-02 - Pressure and Leakage]].
