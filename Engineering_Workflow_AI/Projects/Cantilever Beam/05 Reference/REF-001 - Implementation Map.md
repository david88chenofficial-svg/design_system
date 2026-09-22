---
id: REF-001
type: code-map
status: active
---

# Implementation Map

## Reference implementation

- Rectangular beam inputs and section properties: `code/beam_models.py`, lines 21–45.
- Euler–Bernoulli natural frequency: `code/beam_models.py`, lines 48–58.
- Static tip deflection: `code/beam_models.py`, lines 61–66.
- Nominal root bending stress: `code/beam_models.py`, lines 69–76.
- Regression tests: `code/test_beam_models.py`, lines 7–54.

## Limits

The code does not implement Timoshenko theory, finite elements, grip compliance, damping, tip mass or uncertainty propagation. Its presence verifies neither the selected physical model nor a design.
