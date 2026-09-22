---
id: ANA-01
type: stage
status: in-progress
---

# Baseline Beam Model Qualification

## Question

Which beam formulation and support representation predict first-mode frequency accurately enough over the intended study envelope?

## Upstream

[[ANA-00A - Define Analysis Question]]

## Decisions

- [[DEC-ANA-01-01 - Choose Baseline Beam Theory]]
- [[DEC-ANA-01-02 - Choose Clamp Representation]]

## Evidence

- Verification: [[VER-001 - Euler-Bernoulli Analytical Check]]
- Validation plan: [[VAL-001 - Cantilever Impact Test]]
- Sources: [[EVID-001 - Source and Test Map]]

## Code boundary

[[REF-001 - Implementation Map]] identifies the implemented reference functions. Only the Euler–Bernoulli candidate is currently implemented.

## Gate

Compare all retained candidates on common cases, then require the chosen combination to meet the stated validation metric using independent physical measurements. Until then, no analysis release is approved.
