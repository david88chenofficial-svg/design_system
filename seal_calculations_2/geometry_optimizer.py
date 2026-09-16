"""Bounded, model-specific geometry optimization for near-zero stator force."""

from __future__ import annotations

from dataclasses import dataclass, replace
import math

import numpy as np
from scipy.optimize import least_squares

from plot_all_models import CommonInputs, ToothGeometry, run_single_model


@dataclass(frozen=True)
class GeometryOptimizationResult:
    model_name: str
    initial_force_n: float
    optimized_force_n: float
    mass_flow_kg_s: float
    stage1_clearance_scale: float
    stage2_clearance_scale: float
    geometry: ToothGeometry
    optimized_inputs: CommonInputs
    evaluations: int
    converged: bool
    method: str


def _geometric_mean_ratio(values: tuple[float, ...], base: tuple[float, ...]) -> float:
    if not values:
        return 1.0
    return math.exp(sum(math.log(value / original) for value, original in zip(values, base)) / len(values))


def optimize_geometry_for_model(
    model_name: str,
    inputs: CommonInputs,
    initial_geometry: ToothGeometry,
    *,
    force_tolerance_n: float = 0.10,
    minimum_clearance_m: float = 0.02e-3,
    maximum_clearance_m: float = 2.0e-3,
    maximum_scale_change: float = 4.0,
    minimum_first_inlet_diameter_m: float | None = None,
    minimum_final_outlet_diameter_m: float | None = None,
) -> GeometryOptimizationResult:
    """Optimize every clearance/pitch and both end diameters."""

    initial_geometry.validate(inputs)
    if not 0.0 < minimum_clearance_m < maximum_clearance_m:
        raise ValueError("Clearance bounds must be positive and increasing.")
    displacement = inputs.axial_displacement_percent / 100.0
    stage_factors = (1.0 + displacement, 1.0 - displacement)
    if min(stage_factors) <= 0.0:
        raise ValueError("Axial displacement must leave positive effective clearances.")

    counts = (
        len(initial_geometry.stage1_clearances_m), len(initial_geometry.stage2_clearances_m),
        len(initial_geometry.stage1_pitches_m), len(initial_geometry.stage2_pitches_m),
    )
    initial_values = np.asarray(
        initial_geometry.stage1_clearances_m + initial_geometry.stage2_clearances_m
        + initial_geometry.stage1_pitches_m + initial_geometry.stage2_pitches_m
        + (inputs.first_inlet_tooth_diameter_m, inputs.final_outlet_tooth_diameter_m), dtype=float,
    )

    lower: list[float] = []
    upper: list[float] = []
    for stage_index, clearances in enumerate(
        (initial_geometry.stage1_clearances_m, initial_geometry.stage2_clearances_m)
    ):
        factor = stage_factors[stage_index]
        for value in clearances:
            lower.append(max(minimum_clearance_m / factor, value / maximum_scale_change))
            upper.append(min(maximum_clearance_m / factor, value * maximum_scale_change))
    minimum_pitch = inputs.tooth_tip_thickness_m * 1.001
    for pitches in (initial_geometry.stage1_pitches_m, initial_geometry.stage2_pitches_m):
        for value in pitches:
            lower.append(max(minimum_pitch, value / maximum_scale_change))
            upper.append(value * maximum_scale_change)
    minimum_end_diameter = max(1.0e-3, inputs.tooth_tip_thickness_m)
    maximum_end_diameter = inputs.rotor_tip_diameter_m - 1.001e-3
    end_diameters = (inputs.first_inlet_tooth_diameter_m, inputs.final_outlet_tooth_diameter_m)
    requested_minimums = (minimum_first_inlet_diameter_m, minimum_final_outlet_diameter_m)
    for value, requested_minimum in zip(end_diameters, requested_minimums):
        if requested_minimum is not None and value < requested_minimum - 1.0e-12:
            raise ValueError(
                f"The current end diameter of {value * 1e3:.3f} mm is below its "
                f"constrained minimum of {requested_minimum * 1e3:.3f} mm."
            )
        lower.append(max(minimum_end_diameter, value / maximum_scale_change, requested_minimum or 0.0))
        upper.append(min(maximum_end_diameter, value * maximum_scale_change))

    lower_values = np.asarray(lower, dtype=float)
    upper_values = np.asarray(upper, dtype=float)
    if np.any(lower_values >= upper_values):
        raise ValueError("The current design and constraints leave no feasible optimization range.")
    ranges = upper_values - lower_values
    z_lower = (lower_values - initial_values) / ranges
    z_upper = (upper_values - initial_values) / ranges
    cache: dict[tuple[float, ...], tuple[float, dict[str, object], ToothGeometry, CommonInputs]] = {}

    def decode(z: np.ndarray) -> tuple[CommonInputs, ToothGeometry]:
        values = initial_values + np.asarray(z) * ranges
        offset = 0
        pieces: list[tuple[float, ...]] = []
        for count in counts:
            pieces.append(tuple(float(value) for value in values[offset:offset + count]))
            offset += count
        trial_inputs = replace(
            inputs, first_inlet_tooth_diameter_m=float(values[-2]),
            final_outlet_tooth_diameter_m=float(values[-1]),
        )
        geometry = ToothGeometry(
            stage1_clearances_m=pieces[0], stage2_clearances_m=pieces[1],
            stage1_pitches_m=pieces[2], stage2_pitches_m=pieces[3],
        )
        return trial_inputs, geometry

    def geometry_excess(trial_inputs: CommonInputs, geometry: ToothGeometry) -> tuple[float, float]:
        rotor = trial_inputs.rotor_tip_diameter_m
        return (
            max(0.0, max(geometry.stage1_diameters_m(trial_inputs)) - rotor),
            max(0.0, max(geometry.stage2_diameters_m(trial_inputs)) - rotor),
        )

    def evaluate(z: np.ndarray) -> tuple[float, dict[str, object], ToothGeometry, CommonInputs]:
        key = tuple(round(float(value), 10) for value in z)
        if key not in cache:
            trial_inputs, geometry = decode(z)
            excess = geometry_excess(trial_inputs, geometry)
            if max(excess) > 0.0:
                cache[key] = (math.nan, {}, geometry, trial_inputs)
            else:
                try:
                    result = run_single_model(model_name, trial_inputs, geometry)
                    cache[key] = (float(result["resultant_stator_force_n"]), result, geometry, trial_inputs)
                except (ValueError, RuntimeError, OverflowError, FloatingPointError):
                    cache[key] = (math.nan, {}, geometry, trial_inputs)
        return cache[key]

    z0 = np.zeros(initial_values.size)
    initial_force, initial_result, _, _ = evaluate(z0)
    if not math.isfinite(initial_force):
        raise RuntimeError(f"{model_name} could not solve the current geometry.")
    if abs(initial_force) <= force_tolerance_n:
        return GeometryOptimizationResult(
            model_name, initial_force, initial_force, float(initial_result["mass_flow_kg_s"]),
            1.0, 1.0, initial_geometry, inputs, len(cache), True,
            "Current geometry already meets tolerance",
        )

    force_scale = max(force_tolerance_n, 1.0e-6)
    regularization = 2.0e-3

    def residual(z: np.ndarray) -> np.ndarray:
        trial_inputs, geometry = decode(z)
        excess_1, excess_2 = geometry_excess(trial_inputs, geometry)
        force, _, _, _ = evaluate(z)
        force_residual = force / force_scale if math.isfinite(force) else 1.0e4 + 1.0e7 * (excess_1 + excess_2)
        return np.concatenate((
            np.asarray([force_residual, excess_1 * 1.0e7, excess_2 * 1.0e7]),
            regularization * np.asarray(z),
        ))

    optimum = least_squares(
        residual, z0, bounds=(z_lower, z_upper), x_scale="jac",
        ftol=1.0e-10, xtol=1.0e-9, gtol=1.0e-9, max_nfev=180,
    )
    candidates = [np.asarray(optimum.x), z0]
    valid = [candidate for candidate in candidates if math.isfinite(evaluate(candidate)[0])]
    best = min(valid, key=lambda candidate: abs(evaluate(candidate)[0]))
    optimized_force, optimized_result, optimized_geometry, optimized_inputs = evaluate(best)
    return GeometryOptimizationResult(
        model_name=model_name, initial_force_n=initial_force, optimized_force_n=optimized_force,
        mass_flow_kg_s=float(optimized_result["mass_flow_kg_s"]),
        stage1_clearance_scale=_geometric_mean_ratio(optimized_geometry.stage1_clearances_m, initial_geometry.stage1_clearances_m),
        stage2_clearance_scale=_geometric_mean_ratio(optimized_geometry.stage2_clearances_m, initial_geometry.stage2_clearances_m),
        geometry=optimized_geometry, optimized_inputs=optimized_inputs, evaluations=len(cache),
        converged=abs(optimized_force) <= force_tolerance_n,
        method="Bounded multivariable least-squares (minimum design change)",
    )
