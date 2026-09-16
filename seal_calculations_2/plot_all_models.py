"""Run every seal model with common inputs and plot the pressure results."""

from __future__ import annotations

import ast
import csv
from dataclasses import dataclass
import math
from pathlib import Path
import types

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

import gamma_seal_2 as gamma_2
import gamma_seal_3 as gamma_3
import seal_models
from saurabh_solver import SaurabhConfig, solve as solve_saurabh


HERE = Path(__file__).resolve().parent


def load_gamma_1() -> types.ModuleType:
    """Load Gamma 1's definitions without running its legacy demo plots."""

    path = HERE / "gamma_seal.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    gamma_class = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "GammaSeal"
    )
    tree.body = [
        node for node in tree.body if getattr(node, "lineno", 0) <= gamma_class.end_lineno
    ]
    module = types.ModuleType("comparison_gamma_seal_1")
    exec(compile(tree, str(path), "exec"), module.__dict__)
    return module


@dataclass(frozen=True)
class CommonInputs:
    """Inputs shared by every model in this comparison."""

    inlet_pressure_pa: float = 200_000.0
    outlet_pressure_pa: float = 100_000.0
    temperature_k: float = 300.0
    gamma: float = 1.4
    gas_constant_j_kgk: float = 287.05
    discharge_coefficient: float = 0.70
    clearance_m: float = 0.0002
    tooth_tip_thickness_m: float = 0.001
    tooth_pitch_m: float = 0.003
    first_inlet_tooth_diameter_m: float = 0.120
    rotor_tip_diameter_m: float = 0.165
    final_outlet_tooth_diameter_m: float = 0.0925
    inlet_teeth: int = 8
    outlet_teeth: int = 4
    axial_displacement_percent: float = 0.0
    carryover_factor: float = 0.0


@dataclass(frozen=True)
class ToothGeometry:
    """Per-tooth nominal clearances and centre-to-centre pitches."""

    stage1_clearances_m: tuple[float, ...]
    stage2_clearances_m: tuple[float, ...]
    stage1_pitches_m: tuple[float, ...]
    stage2_pitches_m: tuple[float, ...]

    @classmethod
    def uniform(cls, inputs: CommonInputs) -> "ToothGeometry":
        return cls(
            stage1_clearances_m=(inputs.clearance_m,) * inputs.inlet_teeth,
            stage2_clearances_m=(inputs.clearance_m,) * inputs.outlet_teeth,
            stage1_pitches_m=(inputs.tooth_pitch_m,) * max(0, inputs.inlet_teeth - 1),
            stage2_pitches_m=(inputs.tooth_pitch_m,) * max(0, inputs.outlet_teeth - 1),
        )

    def validate(self, inputs: CommonInputs) -> None:
        expected = (
            ("Stage 1 clearances", self.stage1_clearances_m, inputs.inlet_teeth),
            ("Stage 2 clearances", self.stage2_clearances_m, inputs.outlet_teeth),
            ("Stage 1 pitches", self.stage1_pitches_m, max(0, inputs.inlet_teeth - 1)),
            ("Stage 2 pitches", self.stage2_pitches_m, max(0, inputs.outlet_teeth - 1)),
        )
        for label, values, count in expected:
            if len(values) != count:
                raise ValueError(f"{label} requires {count} values; received {len(values)}.")
            if any(value <= 0.0 for value in values):
                raise ValueError(f"Every value in {label.lower()} must be positive.")
        if any(
            pitch <= inputs.tooth_tip_thickness_m
            for pitch in self.stage1_pitches_m + self.stage2_pitches_m
        ):
            raise ValueError("Every pitch must exceed the tooth-tip thickness.")
        if max(self.stage1_diameters_m(inputs) + self.stage2_diameters_m(inputs)) > inputs.rotor_tip_diameter_m:
            raise ValueError("The custom pitch sequence places a tooth beyond the rotor-tip diameter.")

    def stage1_diameters_m(self, inputs: CommonInputs) -> list[float]:
        diameters = [inputs.first_inlet_tooth_diameter_m + 0.001]
        for pitch in self.stage1_pitches_m:
            diameters.append(diameters[-1] + 2.0 * pitch)
        return diameters

    def stage2_diameters_m(self, inputs: CommonInputs) -> list[float]:
        # Stage 2 is returned in inward-flow order: largest tooth first.
        diameters = [inputs.final_outlet_tooth_diameter_m + 0.001]
        for pitch in reversed(self.stage2_pitches_m):
            diameters.append(diameters[-1] + 2.0 * pitch)
        return list(reversed(diameters))

    def effective_clearances_m(self, inputs: CommonInputs) -> tuple[list[float], list[float]]:
        displacement = inputs.axial_displacement_percent / 100.0
        return (
            [value * (1.0 + displacement) for value in self.stage1_clearances_m],
            [value * (1.0 - displacement) for value in self.stage2_clearances_m],
        )

    def restriction_areas_m2(self, inputs: CommonInputs) -> tuple[list[float], list[float]]:
        clearances_1, clearances_2 = self.effective_clearances_m(inputs)
        return (
            [
                math.pi * diameter * clearance
                for diameter, clearance in zip(self.stage1_diameters_m(inputs), clearances_1)
            ],
            [
                math.pi * diameter * clearance
                for diameter, clearance in zip(self.stage2_diameters_m(inputs), clearances_2)
            ],
        )


def configure_legacy_module(module, inputs: CommonInputs) -> None:
    """Apply the common fluid and geometry values to a legacy solver module."""

    module.gamma = inputs.gamma
    module.R = inputs.gas_constant_j_kgk
    module.T = inputs.temperature_k
    module.Cd = inputs.discharge_coefficient
    module.dia_a = inputs.first_inlet_tooth_diameter_m
    module.dia_b = inputs.rotor_tip_diameter_m
    module.dia_c = inputs.final_outlet_tooth_diameter_m
    module.tooth_pitch = inputs.tooth_pitch_m


def run_gamma_model(
    module, inputs: CommonInputs, geometry: ToothGeometry
) -> tuple[list[float], float]:
    configure_legacy_module(module, inputs)
    model = module.GammaSeal(
        p_in=inputs.inlet_pressure_pa,
        p_out_target=inputs.outlet_pressure_pa,
        c=inputs.clearance_m,
        axial_disp=inputs.axial_displacement_percent,
        teeth_a=inputs.inlet_teeth,
        teeth_b=inputs.outlet_teeth,
    )
    areas_1, areas_2 = geometry.restriction_areas_m2(inputs)
    model.diameters = geometry.stage1_diameters_m(inputs) + geometry.stage2_diameters_m(inputs)

    def custom_gap_areas(_model) -> list[float]:
        return areas_1 + areas_2

    model.gap_areas = types.MethodType(custom_gap_areas, model)
    pressures = [float(value) for value in model.compute_pressures()]
    return pressures, float(model.mdot_solution)


def calculate_resultant_stator_force(
    pressures_pa: list[float], inputs: CommonInputs, geometry: ToothGeometry
) -> float:
    """Apply one common gauge-force balance to any model's pressure curve.

    The force calculation is the Gamma 2 stator balance. Using the same
    postprocessor for every pressure model keeps the comparison consistent.
    Positive and negative values indicate opposite axial directions; the rotor
    reaction is equal in magnitude and opposite in sign.
    """

    configure_legacy_module(gamma_2, inputs)
    force_model = gamma_2.GammaSeal(
        p_in=inputs.inlet_pressure_pa,
        p_out_target=inputs.outlet_pressure_pa,
        c=inputs.clearance_m,
        axial_disp=inputs.axial_displacement_percent,
        teeth_a=inputs.inlet_teeth,
        teeth_b=inputs.outlet_teeth,
    )
    force_model.pressures = pressures_pa
    force_model.chamber_pressure = pressures_pa[inputs.inlet_teeth]
    force_model.diameters = geometry.stage1_diameters_m(inputs) + geometry.stage2_diameters_m(inputs)
    return float(force_model.compute_resultant_force())


def run_single_model(
    name: str, inputs: CommonInputs, geometry: ToothGeometry | None = None
) -> dict[str, object]:
    """Run one named model, used by both plotting and geometry optimization."""

    geometry = geometry or ToothGeometry.uniform(inputs)
    geometry.validate(inputs)
    configure_legacy_module(seal_models, inputs)
    configure_legacy_module(gamma_2, inputs)

    gamma_modules = {"Gamma 1": load_gamma_1, "Gamma 2": lambda: gamma_2, "Gamma 3": lambda: gamma_3}
    if name in gamma_modules:
        pressures, mass_flow = run_gamma_model(gamma_modules[name](), inputs, geometry)
    elif name == "Orifice":
        pressures, mass_flow = run_gamma_model(gamma_2, inputs, geometry)
    elif name in {"Kearton", "Ueda"}:
        areas_1, areas_2 = geometry.restriction_areas_m2(inputs)
        diameters_1 = geometry.stage1_diameters_m(inputs)
        diameters_2 = geometry.stage2_diameters_m(inputs)
        if name == "Kearton":
            model = seal_models.KeartonSeal(
                p_in=inputs.inlet_pressure_pa,
                p_out_target=inputs.outlet_pressure_pa,
                c=inputs.clearance_m,
                teeth_a=inputs.inlet_teeth,
                teeth_b=inputs.outlet_teeth,
                axial_disp=inputs.axial_displacement_percent,
                C1=inputs.discharge_coefficient,
            )
            model.areas_s1, model.areas_s2 = areas_1, areas_2
            model.diams_s1, model.diams_s2 = diameters_1, diameters_2
            model._inv_sq_s1 = [1.0 / area**2 for area in areas_1]
            model._inv_sq_s2 = [1.0 / area**2 for area in areas_2]
        else:
            model = seal_models.UedaSeal(
                p_in=inputs.inlet_pressure_pa,
                p_out_target=inputs.outlet_pressure_pa,
                c=inputs.clearance_m,
                teeth_a=inputs.inlet_teeth,
                teeth_b=inputs.outlet_teeth,
                axial_disp=inputs.axial_displacement_percent,
                alpha=inputs.discharge_coefficient,
                nu=inputs.carryover_factor,
            )
            model.areas_s1, model.areas_s2 = areas_1, areas_2
            model.diams_s1, model.diams_s2 = diameters_1, diameters_2
        pressures = [float(value) for value in model.compute_pressures()]
        mass_flow = float(model.mdot)
    elif name == "Saurabh (Lanjewar)":
        diameters_1 = geometry.stage1_diameters_m(inputs)
        diameters_2 = geometry.stage2_diameters_m(inputs)
        clearances_1, clearances_2 = geometry.effective_clearances_m(inputs)
        nominal_clearances = geometry.stage1_clearances_m + geometry.stage2_clearances_m
        pitches = geometry.stage1_pitches_m + geometry.stage2_pitches_m
        result = solve_saurabh(
            SaurabhConfig(
                inlet_pressure_pa=inputs.inlet_pressure_pa,
                outlet_pressure_pa=inputs.outlet_pressure_pa,
                cavity_temperature_k=inputs.temperature_k,
                gas_constant_j_kgk=inputs.gas_constant_j_kgk,
                clearance_m=sum(nominal_clearances) / len(nominal_clearances),
                tooth_tip_thickness_m=inputs.tooth_tip_thickness_m,
                tooth_pitch_m=sum(pitches) / len(pitches) if pitches else inputs.tooth_pitch_m,
                first_inlet_tooth_diameter_m=inputs.first_inlet_tooth_diameter_m,
                inlet_tooth_count=inputs.inlet_teeth,
                final_outlet_tooth_diameter_m=inputs.final_outlet_tooth_diameter_m,
                outlet_tooth_count=inputs.outlet_teeth,
                rotor_tip_diameter_m=inputs.rotor_tip_diameter_m,
                discharge_coefficient=inputs.discharge_coefficient,
            ),
            inlet_diameters_m=diameters_1,
            outlet_diameters_m=diameters_2,
            clearances_m=clearances_1 + clearances_2,
        )
        pressures = [float(value) for value in result["cavity_pressures_pa"]]
        mass_flow = float(result["mass_flow_kg_s"])
    else:
        raise ValueError(f"Unknown model: {name}")

    expected_nodes = inputs.inlet_teeth + inputs.outlet_teeth + 1
    if len(pressures) != expected_nodes:
        raise ValueError(f"{name} returned {len(pressures)} nodes; expected {expected_nodes}.")
    return {
        "pressures_pa": pressures,
        "mass_flow_kg_s": mass_flow,
        "resultant_stator_force_n": calculate_resultant_stator_force(
            pressures, inputs, geometry
        ),
    }


def run_all_models(
    inputs: CommonInputs, geometry: ToothGeometry | None = None
) -> dict[str, dict[str, object]]:
    """Return pressure, mass-flow, and force results from all included models."""

    names = ("Gamma 1", "Gamma 2", "Gamma 3", "Orifice", "Kearton", "Ueda", "Saurabh (Lanjewar)")
    return {name: run_single_model(name, inputs, geometry) for name in names}


def write_csv(results: dict[str, dict[str, object]], inputs: CommonInputs) -> Path:
    output_path = HERE / "all_models_pressure_distribution.csv"
    stage_labels = (
        ["in"]
        + [f"S1T{i}" for i in range(1, inputs.inlet_teeth + 1)]
        + [f"S2T{i}" for i in range(1, inputs.outlet_teeth + 1)]
    )
    with output_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(
            ["stage_index", "stage_label"]
            + [f"{name}_pressure_bar" for name in results]
        )
        for index, stage_label in enumerate(stage_labels):
            writer.writerow(
                [index, stage_label]
                + [results[name]["pressures_pa"][index] / 1.0e5 for name in results]
            )
    return output_path


def plot_results(results: dict[str, dict[str, object]], inputs: CommonInputs) -> Path:
    output_path = HERE / "all_models_pressure_distribution.png"
    x = list(range(inputs.inlet_teeth + inputs.outlet_teeth + 1))
    colors = ("#0072B2", "#56B4E9", "#009E73", "#D55E00", "#E69F00", "#CC79A7", "#332288")
    markers = ("o", "s", "^", "D", "v", "P", "X")
    styles = ("-", "--", "-.", "-", "--", "-.", "-")

    fig, ax = plt.subplots(figsize=(13.0, 8.0))
    for (name, result), color, marker, style in zip(
        results.items(), colors, markers, styles
    ):
        ax.plot(
            x,
            [pressure / 1.0e5 for pressure in result["pressures_pa"]],
            color=color,
            marker=marker,
            linestyle=style,
            linewidth=2.5 if name == "Saurabh (Lanjewar)" else 1.8,
            markersize=6.5 if name == "Saurabh (Lanjewar)" else 5.2,
            label=f"{name} ({result['mass_flow_kg_s'] * 1.0e3:.3f} g/s)",
        )

    ax.axvline(inputs.inlet_teeth, color="#666666", linestyle=":", linewidth=1.2)
    ax.text(
        inputs.inlet_teeth / 2,
        1.015,
        "Stage 1: radial outward",
        transform=ax.get_xaxis_transform(),
        ha="center",
        color="#555555",
    )
    ax.text(
        inputs.inlet_teeth + inputs.outlet_teeth / 2,
        1.015,
        "Stage 2: radial inward",
        transform=ax.get_xaxis_transform(),
        ha="center",
        color="#555555",
    )
    ax.set_xticks(x)
    ax.set_xticklabels(
        ["in"]
        + [str(i) for i in range(1, inputs.inlet_teeth + 1)]
        + [str(i) for i in range(1, inputs.outlet_teeth + 1)]
    )
    ax.set_xlabel("Tooth index")
    ax.set_ylabel("Pressure (bar, absolute)")
    ax.set_xlim(0, x[-1])
    ax.grid(True, linestyle="dotted", linewidth=0.7, alpha=0.65)
    ax.legend(loc="best", fontsize=9, frameon=True)
    ax.set_title("Pressure-distribution comparison: common inputs", pad=24, fontsize=15)

    fig.text(
        0.5,
        0.015,
        (
            f"Pin={inputs.inlet_pressure_pa / 1e5:g} bar, "
            f"Pout={inputs.outlet_pressure_pa / 1e5:g} bar, "
            f"T={inputs.temperature_k:g} K, Cd={inputs.discharge_coefficient:.2f}, "
            f"clearance={inputs.clearance_m * 1e3:g} mm, "
            f"teeth={inputs.inlet_teeth}+{inputs.outlet_teeth}"
        ),
        ha="center",
        fontsize=9.5,
        color="#444444",
    )
    fig.tight_layout(rect=(0.02, 0.04, 0.98, 0.98))
    fig.savefig(output_path, dpi=180, bbox_inches="tight")
    plt.close(fig)
    return output_path


def main() -> None:
    inputs = CommonInputs()  # Edit this one block to change the common test case.
    results = run_all_models(inputs)
    csv_path = write_csv(results, inputs)
    plot_path = plot_results(results, inputs)
    print(f"Wrote: {plot_path}")
    print(f"Wrote: {csv_path}")


if __name__ == "__main__":
    main()
