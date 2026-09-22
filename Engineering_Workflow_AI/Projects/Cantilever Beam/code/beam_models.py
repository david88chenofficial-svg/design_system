"""Small reference calculations for the cantilever-beam skill pilot.

These functions support implementation verification only. They do not establish
that Euler-Bernoulli theory or an ideal clamp is physically valid for a design.
"""

from __future__ import annotations

from dataclasses import dataclass
import math


EULER_BERNOULLI_BETA = (
    1.875104068711961,
    4.694091132974174,
    7.854757438237612,
)


@dataclass(frozen=True)
class RectangularBeam:
    length_m: float
    width_m: float
    thickness_m: float
    youngs_modulus_pa: float
    density_kg_m3: float

    def __post_init__(self) -> None:
        values = (
            self.length_m,
            self.width_m,
            self.thickness_m,
            self.youngs_modulus_pa,
            self.density_kg_m3,
        )
        if not all(math.isfinite(value) and value > 0.0 for value in values):
            raise ValueError("All beam inputs must be finite and positive")

    @property
    def area_m2(self) -> float:
        return self.width_m * self.thickness_m

    @property
    def second_moment_m4(self) -> float:
        return self.width_m * self.thickness_m**3 / 12.0


def euler_bernoulli_frequency_hz(beam: RectangularBeam, mode: int = 1) -> float:
    """Return an ideal fixed-free Euler-Bernoulli bending frequency."""
    if mode < 1 or mode > len(EULER_BERNOULLI_BETA):
        raise ValueError("mode must be 1, 2, or 3")
    beta = EULER_BERNOULLI_BETA[mode - 1]
    flexural_rigidity = beam.youngs_modulus_pa * beam.second_moment_m4
    mass_per_length = beam.density_kg_m3 * beam.area_m2
    omega = beta**2 / beam.length_m**2 * math.sqrt(
        flexural_rigidity / mass_per_length
    )
    return omega / (2.0 * math.pi)


def cantilever_tip_deflection_m(beam: RectangularBeam, tip_load_n: float) -> float:
    """Return small-deflection ideal-cantilever tip displacement magnitude."""
    if not math.isfinite(tip_load_n) or tip_load_n < 0.0:
        raise ValueError("tip_load_n must be finite and non-negative")
    rigidity = beam.youngs_modulus_pa * beam.second_moment_m4
    return tip_load_n * beam.length_m**3 / (3.0 * rigidity)


def cantilever_root_bending_stress_pa(
    beam: RectangularBeam, tip_load_n: float
) -> float:
    """Return nominal root bending stress for an end-loaded rectangular beam."""
    if not math.isfinite(tip_load_n) or tip_load_n < 0.0:
        raise ValueError("tip_load_n must be finite and non-negative")
    root_moment = tip_load_n * beam.length_m
    return root_moment * (beam.thickness_m / 2.0) / beam.second_moment_m4
