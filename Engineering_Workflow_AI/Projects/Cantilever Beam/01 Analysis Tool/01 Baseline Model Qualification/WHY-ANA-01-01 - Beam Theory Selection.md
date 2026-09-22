---
id: WHY-ANA-01-01
type: reason
status: incomplete
---

# Why This Beam Theory?

## Candidates

| Candidate | Captures | Important omissions or costs | Current state |
|---|---|---|---|
| Euler–Bernoulli | Bending of a slender uniform beam | Neglects shear deformation and rotary inertia | Reference implementation exists |
| Timoshenko | Bending, shear deformation and rotary inertia | Requires shear modulus and a shear correction treatment | Not implemented |
| 3D finite element | Detailed geometry and potentially the grip | Requires element, mesh and boundary-condition qualification | Not implemented |

NASA TM X-55743 treats transverse frequencies of a uniform cantilever with bending, rotary inertia and shear flexibility. MIT course material presents the Euler–Bernoulli cantilever derivation and notes that refined theory can change higher-frequency predictions. Full citations are in [[EVID-001 - Source and Test Map]].

## Selection basis

- Shared geometry, material inputs and boundary assumptions.
- First-mode relative error against an independent impact-test dataset.
- Proposed acceptance threshold: ≤ 5% on every accepted validation specimen.
- Measurement uncertainty and material-property uncertainty reported.
- Prefer the least complex candidate that passes throughout the declared domain.

## Evidence

- [[VER-001 - Euler-Bernoulli Analytical Check]] verifies only the current implementation.
- [[VAL-001 - Cantilever Impact Test]] is not yet executed.

## Implementation

See [[REF-001 - Implementation Map]]. Code existence is not evidence of physical validity.

## Conclusion

Open. No candidate may be selected until the shared comparison and physical validation are complete.
