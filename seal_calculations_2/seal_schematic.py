"""Parameter-driven cross-section schematic for the two-stage radial seal."""

from __future__ import annotations

from matplotlib.axes import Axes
from matplotlib.patches import Patch, Rectangle

from plot_all_models import CommonInputs, ToothGeometry


def _dimension_arrow(
    ax: Axes, x: float, y: float, label: str, *, color: str = "#444444"
) -> None:
    ax.annotate(
        "",
        xy=(x, y),
        xytext=(x, 0.0),
        arrowprops={"arrowstyle": "<->", "color": color, "linewidth": 1.0},
    )
    ax.text(
        x - 0.08 if x < 0 else x + 0.08,
        y / 2,
        label,
        rotation=90,
        ha="right" if x < 0 else "left",
        va="center",
        fontsize=8.5,
        color=color,
        bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.8, "pad": 1.5},
    )


def draw_seal_schematic(
    ax: Axes, inputs: CommonInputs, geometry: ToothGeometry | None = None
) -> None:
    """Draw a live engineering schematic from the current GUI inputs.

    Radial values use millimetres. Axial clearances are deliberately enlarged
    so that their changes remain visible on screen.
    """

    ax.clear()
    geometry = geometry or ToothGeometry.uniform(inputs)
    geometry.validate(inputs)

    radius_a = inputs.first_inlet_tooth_diameter_m * 500.0
    radius_b = inputs.rotor_tip_diameter_m * 500.0
    radius_c = inputs.final_outlet_tooth_diameter_m * 500.0
    tooth_thickness = inputs.tooth_tip_thickness_m * 1000.0
    displacement = inputs.axial_displacement_percent / 100.0
    stage_1_radii = [value * 500.0 for value in geometry.stage1_diameters_m(inputs)]
    stage_2_radii = [value * 500.0 for value in geometry.stage2_diameters_m(inputs)]
    clearances_1, clearances_2 = geometry.effective_clearances_m(inputs)
    clearances_1_mm = [value * 1.0e3 for value in clearances_1]
    clearances_2_mm = [value * 1.0e3 for value in clearances_2]
    highest_tooth = max(stage_1_radii + stage_2_radii)
    maximum_radius = max(radius_b, highest_tooth)

    # X is a schematic axial coordinate. The rotor moves horizontally with
    # axial displacement while the stator walls remain fixed.
    left_wall = -2.55
    right_wall = 2.55
    rotor_shift = displacement * 0.18

    def displayed_gap(clearance_mm: float) -> float:
        return min(0.60, max(0.08, 0.12 + clearance_mm * 0.30))

    left_tips = [left_wall + displayed_gap(value) for value in clearances_1_mm]
    right_tips = [right_wall - displayed_gap(value) for value in clearances_2_mm]
    rotor_left = -1.10 + rotor_shift
    rotor_right = 1.10 + rotor_shift
    stator_top = maximum_radius + 8.0

    stator_color = "#D7DEE8"
    rotor_color = "#9FB6CC"
    tooth_color = "#4F86B6"

    # Stator housing and bridge.
    ax.add_patch(
        Rectangle(
            (-3.05, max(0.0, radius_a - 8.0)),
            0.50,
            stator_top - max(0.0, radius_a - 8.0),
            facecolor=stator_color,
            edgecolor="#374151",
            linewidth=1.1,
        )
    )
    ax.add_patch(
        Rectangle(
            (right_wall, max(0.0, radius_c - 8.0)),
            0.50,
            stator_top - max(0.0, radius_c - 8.0),
            facecolor=stator_color,
            edgecolor="#374151",
            linewidth=1.1,
        )
    )
    ax.add_patch(
        Rectangle(
            (-3.05, stator_top),
            6.10,
            5.0,
            facecolor=stator_color,
            edgecolor="#374151",
            linewidth=1.1,
        )
    )

    # A single continuous rotor block ensures every tooth remains visibly
    # attached, including cases with a small first-inlet diameter.
    ax.add_patch(
        Rectangle(
            (rotor_left, 0.0),
            rotor_right - rotor_left,
            radius_b,
            facecolor=rotor_color,
            edgecolor="#263547",
            linewidth=1.2,
        )
    )

    shown_thickness = max(0.45, tooth_thickness)
    for index, (radius, left_tip) in enumerate(zip(stage_1_radii, left_tips), start=1):
        ax.add_patch(
            Rectangle(
                (left_tip, radius - shown_thickness / 2),
                rotor_left - left_tip,
                shown_thickness,
                facecolor=tooth_color,
                edgecolor="#263547",
                linewidth=0.9,
            )
        )
        if inputs.inlet_teeth <= 12:
            ax.text(
                left_tip + 0.10,
                radius,
                str(index),
                ha="left",
                va="center",
                fontsize=6.5,
                color="white",
                weight="bold",
            )

    for index, (radius, right_tip) in enumerate(zip(stage_2_radii, right_tips), start=1):
        ax.add_patch(
            Rectangle(
                (rotor_right, radius - shown_thickness / 2),
                right_tip - rotor_right,
                shown_thickness,
                facecolor=tooth_color,
                edgecolor="#263547",
                linewidth=0.9,
            )
        )
        if inputs.outlet_teeth <= 12:
            ax.text(
                right_tip - 0.10,
                radius,
                str(index),
                ha="right",
                va="center",
                fontsize=6.5,
                color="white",
                weight="bold",
            )

    # Clearance dimensions at representative tooth tips.
    left_dimension_y = stage_1_radii[-1]
    right_dimension_y = stage_2_radii[0]
    left_tip = left_tips[-1]
    right_tip = right_tips[0]
    ax.annotate(
        "",
        xy=(left_wall, left_dimension_y),
        xytext=(left_tip, left_dimension_y),
        arrowprops={"arrowstyle": "<->", "color": "#B45309", "linewidth": 1.4},
    )
    ax.text(
        (left_wall + left_tip) / 2,
        left_dimension_y + 2.0,
        f"S1 tooth {inputs.inlet_teeth} clearance\n{clearances_1_mm[-1]:.3f} mm",
        ha="center",
        va="bottom",
        fontsize=8,
        color="#92400E",
    )
    ax.annotate(
        "",
        xy=(right_tip, right_dimension_y),
        xytext=(right_wall, right_dimension_y),
        arrowprops={"arrowstyle": "<->", "color": "#B45309", "linewidth": 1.4},
    )
    ax.text(
        (right_wall + right_tip) / 2,
        right_dimension_y + 2.0,
        f"S2 tooth 1 clearance\n{clearances_2_mm[0]:.3f} mm",
        ha="center",
        va="bottom",
        fontsize=8,
        color="#92400E",
    )

    _dimension_arrow(ax, -3.45, radius_a, f"Radius a = {radius_a:.2f} mm")
    _dimension_arrow(ax, -3.80, radius_b, f"Radius b = {radius_b:.2f} mm")
    _dimension_arrow(ax, 3.45, radius_c, f"Radius c = {radius_c:.2f} mm")

    ax.axhline(0.0, color="#111827", linestyle="-.", linewidth=1.0)
    ax.text(-3.05, -3.0, "Axis of rotation", ha="left", va="top", fontsize=9)
    ax.text(
        rotor_shift,
        radius_b * 0.45,
        "ROTOR",
        ha="center",
        va="center",
        fontsize=12,
        weight="bold",
        color="#263547",
    )
    ax.text(0.0, stator_top + 2.5, "STATOR", ha="center", va="center", fontsize=11, weight="bold")
    ax.text(
        1.65,
        min(stator_top - 3.0, max(stage_2_radii) + 8.0),
        "Balancing\nchamber",
        ha="center",
        va="center",
        fontsize=9,
        bbox={"boxstyle": "round,pad=0.3", "facecolor": "#F8FAFC", "edgecolor": "#64748B"},
    )

    ax.annotate(
        "",
        xy=(-1.75, min(radius_b, stage_1_radii[-1]) + 1.0),
        xytext=(-1.75, radius_a - 8.0),
        arrowprops={"arrowstyle": "->", "color": "#047857", "linewidth": 1.5},
    )
    ax.text(
        -1.75,
        min(stage_1_radii) - 5.0,
        "Stage 1: radial outward",
        ha="center",
        va="top",
        fontsize=8.5,
        color="#047857",
    )
    ax.annotate(
        "",
        xy=(1.75, radius_c - 3.0),
        xytext=(1.75, max(stage_2_radii) + 6.0),
        arrowprops={"arrowstyle": "->", "color": "#047857", "linewidth": 1.5},
    )
    ax.text(
        1.75,
        min(stage_2_radii) - 5.0,
        "Stage 2: radial inward",
        ha="center",
        va="top",
        fontsize=8.5,
        color="#047857",
    )

    ax.text(-2.95, radius_a - 10.5, "INLET", ha="left", va="center", fontsize=9, weight="bold")
    ax.text(2.95, radius_c - 10.5, "OUTLET", ha="right", va="center", fontsize=9, weight="bold")
    ax.legend(
        handles=(
            Patch(facecolor=stator_color, edgecolor="#374151", label="Stator"),
            Patch(facecolor=rotor_color, edgecolor="#263547", label="Rotor"),
            Patch(facecolor=tooth_color, edgecolor="#263547", label="Labyrinth teeth"),
        ),
        loc="lower center",
        ncol=3,
        frameon=False,
        bbox_to_anchor=(0.5, -0.02),
    )

    ax.set_xlim(-4.15, 4.15)
    ax.set_ylim(-12.0, stator_top + 8.0)
    ax.set_xticks([])
    ax.set_yticks([])
    all_pitches_mm = [
        value * 1.0e3
        for value in geometry.stage1_pitches_m + geometry.stage2_pitches_m
    ]
    pitch_text = (
        "n/a"
        if not all_pitches_mm
        else (
            f"{all_pitches_mm[0]:.3f} mm"
            if max(all_pitches_mm) - min(all_pitches_mm) < 1.0e-12
            else f"variable ({min(all_pitches_mm):.3f}–{max(all_pitches_mm):.3f} mm)"
        )
    )
    ax.set_title(
        f"Two-stage radial seal — {inputs.inlet_teeth} + {inputs.outlet_teeth} teeth\n"
        f"Pitch = {pitch_text}, tooth-tip thickness = {tooth_thickness:.3f} mm, "
        f"axial displacement = {inputs.axial_displacement_percent:+.1f}%",
        fontsize=12,
        pad=10,
    )
    for spine in ax.spines.values():
        spine.set_visible(False)
