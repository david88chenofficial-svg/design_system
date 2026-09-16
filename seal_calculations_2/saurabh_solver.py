"""Pressure solver based on Saurabh Lanjewar's labyrinth-seal model.

The model equations are Eqs. (38)-(42) of:
    S. Lanjewar et al., "Analytical Model for Leakage Prediction in an
    Axial Labyrinth Seal," Journal of Engineering for Gas Turbines and
    Power, 2026.

Project-specific adaptations are explicit:
* annular radial-tooth area is A_i = pi * D_i * c;
* air is represented as an ideal gas at the specified isothermal cavity
  temperature, rho_i = p_i / (R*T), instead of REFPROP real-gas data;
* the first tooth of each radial stage uses Eq. (38), so kinetic carry-over
  is reset across the large chamber separating the two tooth sets;
* shaft-rotation correction from the companion radial paper is not applied
  unless a future case supplies and validates its high-speed inward-flow
  operating conditions.

This is a model-native implementation: the default Cd is 0.75, as specified
by Lanjewar's Eq. (40). It is not the ideal-gas nozzle/orifice model used by
the pre-existing generated solvers in this project.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Sequence


@dataclass(frozen=True)
class SaurabhConfig:
    """Inputs for the two-stage radial seal in the project tool specification."""

    inlet_pressure_pa: float = 200_000.0
    outlet_pressure_pa: float = 100_000.0
    cavity_temperature_k: float = 300.0
    gas_constant_j_kgk: float = 287.05

    clearance_m: float = 2.0e-4
    tooth_tip_thickness_m: float = 1.0e-3
    tooth_pitch_m: float = 3.0e-3

    first_inlet_tooth_diameter_m: float = 0.120
    inlet_tooth_count: int = 8
    final_outlet_tooth_diameter_m: float = 0.0925
    outlet_tooth_count: int = 4
    rotor_tip_diameter_m: float = 0.165

    discharge_coefficient: float = 0.75
    reset_carryover_between_stages: bool = True
    relative_tolerance: float = 1.0e-11
    maximum_iterations: int = 180


def pressure_function(beta: float) -> float:
    """Lanjewar pressure function F(beta), with beta=p_down/p_up."""

    return beta + 0.5 * beta**2 + 0.75 * beta**3


def critical_pressure_ratio() -> float:
    """Return the maximum-flow ratio of F(beta)*(1-beta**2).

    Differentiating the paper's pressure function gives beta_crit=2/3.
    The present 2 bar to 1 bar, 12-tooth case remains above this value at
    every individual tooth.
    """

    return 2.0 / 3.0


def rotation_discharge_ratio(tangential_to_max_flow_velocity: float) -> float:
    """Companion radial-paper Eq. (14), Cd/(Cd without rotation).

    This correlation was fitted for high-speed inward radial sCO2 flow. The
    stationary project comparison does not call it. Use
    ``inward_rotation_corrected_cd`` to obtain a domain-checked Cd.
    """

    x = tangential_to_max_flow_velocity
    if x < 0.0 or not math.isfinite(x):
        raise ValueError("tangential_to_max_flow_velocity must be finite and nonnegative")
    return -0.006124 * x**3 - 0.01955 * x**2 - 0.04316 * x + 0.9357


def inward_rotation_corrected_cd(
    base_discharge_coefficient: float,
    tangential_to_max_flow_velocity: float,
    *,
    shaft_speed_rpm: float,
    inlet_pressure_bar: float,
    outlet_pressure_bar: float,
    inlet_temperature_c: float,
    tooth_width_to_clearance: float,
    pitch_to_clearance: float,
    tooth_count: int,
    reynolds_number: float,
    allow_extrapolation: bool = False,
) -> float:
    """Return the radial-paper rotation-corrected Cd after domain checks.

    Published calibration domain: inward radial flow, 50-100 krpm,
    Pin=120-210 bar, Pout=95 bar, Tin=500 C, t/c=1.25-15, s/c=12-50,
    N=3-7, and Re>8000. Set ``allow_extrapolation`` only for an explicitly
    justified study; it is intentionally false by default.
    """

    checks = {
        "shaft_speed_rpm": 50_000.0 <= shaft_speed_rpm <= 100_000.0,
        "inlet_pressure_bar": 120.0 <= inlet_pressure_bar <= 210.0,
        "outlet_pressure_bar": math.isclose(outlet_pressure_bar, 95.0, rel_tol=0.0, abs_tol=1.0e-9),
        "inlet_temperature_c": math.isclose(inlet_temperature_c, 500.0, rel_tol=0.0, abs_tol=1.0e-9),
        "tooth_width_to_clearance": 1.25 <= tooth_width_to_clearance <= 15.0,
        "pitch_to_clearance": 12.0 <= pitch_to_clearance <= 50.0,
        "tooth_count": 3 <= tooth_count <= 7,
        "reynolds_number": reynolds_number > 8000.0,
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed and not allow_extrapolation:
        raise ValueError(
            "radial rotation correlation is outside its published domain: " + ", ".join(failed)
        )
    ratio = rotation_discharge_ratio(tangential_to_max_flow_velocity)
    if ratio <= 0.0:
        raise ValueError("rotation correlation returned a nonpositive discharge ratio")
    return base_discharge_coefficient * ratio


def carryover_parameters(config: SaurabhConfig) -> tuple[float, float]:
    """Return relative kinetic energy alpha and carry-over coefficient mu."""

    gap_ratio = (config.tooth_pitch_m - config.tooth_tip_thickness_m) / config.clearance_m
    alpha = 15.6224 / (gap_ratio + 15.4178)
    if not 0.0 <= alpha < 1.0:
        raise ValueError(
            "Saurabh carry-over correlation produced alpha outside [0, 1); "
            "check pitch, tooth thickness, and clearance"
        )
    return alpha, 1.0 / math.sqrt(1.0 - alpha)


def tooth_diameters(config: SaurabhConfig) -> tuple[list[float], list[float]]:
    """Return tooth diameters in physical flow order: outward, then inward."""

    inlet = [
        config.first_inlet_tooth_diameter_m + 2.0 * index * config.tooth_pitch_m
        for index in range(config.inlet_tooth_count)
    ]
    outlet = [
        config.final_outlet_tooth_diameter_m
        + 2.0 * (config.outlet_tooth_count - 1 - index) * config.tooth_pitch_m
        for index in range(config.outlet_tooth_count)
    ]
    return inlet, outlet


def restriction_area_m2(diameter_m: float, clearance_m: float) -> float:
    """Annular radial-tooth clearance area, A=2*pi*r*c=pi*D*c."""

    return math.pi * diameter_m * clearance_m


def _validate(config: SaurabhConfig, *, check_generated_geometry: bool = True) -> None:
    positive_fields = {
        "inlet_pressure_pa": config.inlet_pressure_pa,
        "outlet_pressure_pa": config.outlet_pressure_pa,
        "cavity_temperature_k": config.cavity_temperature_k,
        "gas_constant_j_kgk": config.gas_constant_j_kgk,
        "clearance_m": config.clearance_m,
        "tooth_tip_thickness_m": config.tooth_tip_thickness_m,
        "tooth_pitch_m": config.tooth_pitch_m,
        "discharge_coefficient": config.discharge_coefficient,
    }
    for name, value in positive_fields.items():
        if value <= 0.0:
            raise ValueError(f"{name} must be positive")
    if config.inlet_pressure_pa <= config.outlet_pressure_pa:
        raise ValueError("inlet_pressure_pa must exceed outlet_pressure_pa")
    if config.tooth_tip_thickness_m >= config.tooth_pitch_m:
        raise ValueError("tooth_tip_thickness_m must be smaller than tooth_pitch_m")
    if config.inlet_tooth_count < 1 or config.outlet_tooth_count < 1:
        raise ValueError("both stages require at least one tooth")
    if config.relative_tolerance <= 0.0 or config.maximum_iterations < 20:
        raise ValueError("invalid convergence settings")
    if check_generated_geometry:
        inlet, outlet = tooth_diameters(config)
        if max(inlet + outlet) > config.rotor_tip_diameter_m:
            raise ValueError("generated tooth diameter exceeds rotor_tip_diameter_m")
    carryover_parameters(config)


def _density(pressure_pa: float, config: SaurabhConfig) -> float:
    return pressure_pa / (config.gas_constant_j_kgk * config.cavity_temperature_k)


def stage_mass_flow(
    pressure_up_pa: float,
    pressure_down_pa: float,
    area_m2: float,
    config: SaurabhConfig,
    *,
    first_tooth_of_stage: bool,
    previous_upstream_pressure_pa: float | None = None,
) -> tuple[float, bool]:
    """Evaluate Lanjewar Eq. (38) or Eq. (39) for one restriction.

    The returned boolean indicates whether beta was limited to the derived
    maximum-flow ratio of 2/3. The comparison case does not activate this limit.
    """

    if not 0.0 < pressure_down_pa <= pressure_up_pa:
        raise ValueError("stage pressures must satisfy 0 < p_down <= p_up")
    alpha, mu = carryover_parameters(config)
    del alpha

    beta = pressure_down_pa / pressure_up_pa
    beta_eval = max(beta, critical_pressure_ratio())
    rho_up = _density(pressure_up_pa, config)

    if first_tooth_of_stage:
        carryover_multiplier = 1.0
        density_ratio = 1.0
    else:
        if previous_upstream_pressure_pa is None:
            raise ValueError("Eq. (39) requires the preceding upstream pressure")
        carryover_multiplier = mu
        density_ratio = _density(previous_upstream_pressure_pa, config) / rho_up

    radicand = (
        pressure_up_pa
        * rho_up
        * pressure_function(beta_eval)
        * (1.0 - beta_eval**2)
    )
    mass_flow = (
        config.discharge_coefficient
        * area_m2
        * carryover_multiplier
        * density_ratio
        * math.sqrt(max(radicand, 0.0))
    )
    return mass_flow, beta < critical_pressure_ratio()


def _is_stage_start(index: int, config: SaurabhConfig) -> bool:
    if index == 0:
        return True
    return config.reset_carryover_between_stages and index == config.inlet_tooth_count


def _downstream_pressure_for_flow(
    mass_flow_kg_s: float,
    pressure_up_pa: float,
    area_m2: float,
    config: SaurabhConfig,
    *,
    first_tooth_of_stage: bool,
    previous_upstream_pressure_pa: float | None,
) -> float | None:
    """Invert one subcritical tooth equation on beta in [2/3, 1]."""

    p_at_limit = pressure_up_pa * critical_pressure_ratio()
    maximum_flow, _ = stage_mass_flow(
        pressure_up_pa,
        p_at_limit,
        area_m2,
        config,
        first_tooth_of_stage=first_tooth_of_stage,
        previous_upstream_pressure_pa=previous_upstream_pressure_pa,
    )
    if mass_flow_kg_s > maximum_flow * (1.0 + 5.0e-13):
        return None

    beta_low = critical_pressure_ratio()
    beta_high = 1.0
    for _ in range(90):
        beta_mid = 0.5 * (beta_low + beta_high)
        trial_flow, _ = stage_mass_flow(
            pressure_up_pa,
            pressure_up_pa * beta_mid,
            area_m2,
            config,
            first_tooth_of_stage=first_tooth_of_stage,
            previous_upstream_pressure_pa=previous_upstream_pressure_pa,
        )
        if trial_flow > mass_flow_kg_s:
            beta_low = beta_mid
        else:
            beta_high = beta_mid
    return pressure_up_pa * 0.5 * (beta_low + beta_high)


def _propagate_pressures(
    mass_flow_kg_s: float,
    areas_m2: Sequence[float],
    config: SaurabhConfig,
) -> list[float] | None:
    pressures = [config.inlet_pressure_pa]
    for index, area in enumerate(areas_m2):
        previous_upstream = pressures[-2] if len(pressures) >= 2 else None
        pressure_down = _downstream_pressure_for_flow(
            mass_flow_kg_s,
            pressures[-1],
            area,
            config,
            first_tooth_of_stage=_is_stage_start(index, config),
            previous_upstream_pressure_pa=previous_upstream,
        )
        if pressure_down is None:
            return None
        pressures.append(pressure_down)
    return pressures


def solve(
    config: SaurabhConfig | None = None,
    *,
    inlet_diameters_m: Sequence[float] | None = None,
    outlet_diameters_m: Sequence[float] | None = None,
    clearances_m: Sequence[float] | None = None,
) -> dict[str, Any]:
    """Solve the common leakage flow and all cavity pressures."""

    config = config or SaurabhConfig()
    _validate(
        config,
        check_generated_geometry=inlet_diameters_m is None and outlet_diameters_m is None,
    )
    default_inlet, default_outlet = tooth_diameters(config)
    inlet_diameters = list(default_inlet if inlet_diameters_m is None else inlet_diameters_m)
    outlet_diameters = list(default_outlet if outlet_diameters_m is None else outlet_diameters_m)
    if len(inlet_diameters) != config.inlet_tooth_count:
        raise ValueError("inlet_diameters_m length must match inlet_tooth_count")
    if len(outlet_diameters) != config.outlet_tooth_count:
        raise ValueError("outlet_diameters_m length must match outlet_tooth_count")
    if max(inlet_diameters + outlet_diameters) > config.rotor_tip_diameter_m:
        raise ValueError("custom tooth diameter exceeds rotor_tip_diameter_m")
    diameters = inlet_diameters + outlet_diameters
    clearances = list(
        [config.clearance_m] * len(diameters) if clearances_m is None else clearances_m
    )
    if len(clearances) != len(diameters) or any(value <= 0.0 for value in clearances):
        raise ValueError("clearances_m must contain one positive value per tooth")
    areas = [
        restriction_area_m2(diameter, clearance)
        for diameter, clearance in zip(diameters, clearances)
    ]

    # Eq. (38) at its maximum-flow beta gives a safe initial upper bound.
    mass_low = 0.0
    mass_high, _ = stage_mass_flow(
        config.inlet_pressure_pa,
        config.inlet_pressure_pa * critical_pressure_ratio(),
        areas[0],
        config,
        first_tooth_of_stage=True,
    )

    iteration_count = 0
    for iteration_count in range(1, config.maximum_iterations + 1):
        mass_mid = 0.5 * (mass_low + mass_high)
        trial_pressures = _propagate_pressures(mass_mid, areas, config)
        if trial_pressures is None or trial_pressures[-1] < config.outlet_pressure_pa:
            mass_high = mass_mid
        else:
            mass_low = mass_mid
        if (mass_high - mass_low) / max(mass_high, 1.0e-30) < config.relative_tolerance:
            break
    else:
        raise RuntimeError("Saurabh mass-flow iteration did not converge")

    mass_flow = 0.5 * (mass_low + mass_high)
    pressures = _propagate_pressures(mass_flow, areas, config)
    if pressures is None:
        pressures = _propagate_pressures(mass_low, areas, config)
        mass_flow = mass_low
    if pressures is None:
        raise RuntimeError("failed to recover a pressure distribution")

    # The bisection solves p_out through mass flow. Pin the terminal node to the
    # exact boundary only after confirming the residual is within tolerance.
    outlet_residual = pressures[-1] - config.outlet_pressure_pa
    if abs(outlet_residual) / config.outlet_pressure_pa > 2.0e-8:
        raise RuntimeError(f"outlet pressure residual is too large: {outlet_residual:g} Pa")
    pressures[-1] = config.outlet_pressure_pa

    stages: list[dict[str, Any]] = []
    stage_flows: list[float] = []
    for index, (diameter, area) in enumerate(zip(diameters, areas)):
        is_start = _is_stage_start(index, config)
        previous_upstream = pressures[index - 1] if index > 0 else None
        flow, choked = stage_mass_flow(
            pressures[index],
            pressures[index + 1],
            area,
            config,
            first_tooth_of_stage=is_start,
            previous_upstream_pressure_pa=previous_upstream,
        )
        stage_flows.append(flow)
        stages.append(
            {
                "index": index + 1,
                "section": "inlet_radial_outward" if index < config.inlet_tooth_count else "outlet_radial_inward",
                "stage_tooth_index": (
                    index + 1 if index < config.inlet_tooth_count else index - config.inlet_tooth_count + 1
                ),
                "first_tooth_of_stage": is_start,
                "equation": "Eq. (38)" if is_start else "Eq. (39)",
                "diameter_m": diameter,
                "area_m2": area,
                "pressure_up_pa": pressures[index],
                "pressure_down_pa": pressures[index + 1],
                "pressure_ratio": pressures[index + 1] / pressures[index],
                "mass_flow_kg_s": flow,
                "choked": choked,
            }
        )

    alpha, mu = carryover_parameters(config)
    mean_stage_flow = sum(stage_flows) / len(stage_flows)
    continuity_spread = (max(stage_flows) - min(stage_flows)) / mean_stage_flow

    return {
        "model": "Saurabh Lanjewar analytical leakage model (stationary adaptation)",
        "model_origin": {
            "equations": "Lanjewar et al. (2026), Eqs. (38)-(42)",
            "native_discharge_coefficient": 0.75,
            "radial_area_adaptation": "A_i = pi*D_i*c",
            "property_adaptation": "ideal-gas air, isothermal cavities, rho_i=p_i/(R*T)",
            "stage_interface": "carry-over reset at the large inter-stage chamber",
            "rotation": "not applied; comparison has no shaft speed and includes an outward-flow stage",
        },
        "config": asdict(config),
        "mass_flow_kg_s": mass_flow,
        "cavity_pressures_pa": pressures,
        "chamber_pressure_pa": pressures[config.inlet_tooth_count],
        "inlet_tooth_diameters_m": inlet_diameters,
        "outlet_tooth_diameters_m": outlet_diameters,
        "carryover_alpha": alpha,
        "carryover_mu": mu,
        "critical_pressure_ratio": critical_pressure_ratio(),
        "choked_stage_count": sum(bool(stage["choked"]) for stage in stages),
        "continuity_relative_spread": continuity_spread,
        "outlet_residual_before_pinning_pa": outlet_residual,
        "iteration_count": iteration_count,
        "stages": stages,
    }


def main() -> None:
    result = solve()
    output_path = Path(__file__).resolve().parent / "saurabh_results.json"
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"Mass flow: {result['mass_flow_kg_s'] * 1e3:.6f} g/s")
    print(f"Chamber pressure: {result['chamber_pressure_pa'] / 1e5:.6f} bar")
    print(f"Continuity spread: {result['continuity_relative_spread']:.3e}")
    print(f"Wrote: {output_path}")


if __name__ == "__main__":
    main()
