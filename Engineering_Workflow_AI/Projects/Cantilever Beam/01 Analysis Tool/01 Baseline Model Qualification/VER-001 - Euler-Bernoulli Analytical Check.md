---
id: VER-001
type: verification
status: passed
---

# Euler–Bernoulli Analytical Check

## Purpose

Verify that the reference implementation reproduces the closed-form cantilever relationship and expected scaling behaviour. This does not validate the model against a physical beam.

## Reference case

- Length: 0.4 m
- Width: 0.025 m
- Thickness: 0.003 m
- Young's modulus: 69 GPa
- Density: 2700 kg/m³
- Ideal fixed-free boundary

The first-mode reference uses `β₁ = 1.875104068711961` and

`f₁ = β₁² /(2πL²) × sqrt(EI/(ρA))`.

## Checks

- Direct numerical result versus an independently evaluated reference value.
- Frequency scales linearly with rectangular-section thickness when other inputs are fixed.
- Frequency scales with the inverse square of length.
- Invalid non-positive inputs are rejected.

## Implementation

[[REF-001 - Implementation Map]]

## Result

Passed on 2026-09-21:

- Computed first-mode frequency: `15.31172767216716 Hz`.
- Reference-value check: passed.
- Thickness scaling: passed.
- Inverse-length-squared scaling: passed.
- Invalid-input rejection: passed.

The first run failed because the manually entered expected value was `15.312320510516997 Hz`. Re-evaluation of the stated formula and inputs gave `15.31172767216716 Hz`; the reference value was corrected and the unchanged implementation then passed. This record establishes implementation verification only.
