"""Interactive desktop GUI for comparing the seal pressure models."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk
from matplotlib.figure import Figure

from plot_all_models import CommonInputs, ToothGeometry, run_all_models
from geometry_optimizer import GeometryOptimizationResult, optimize_geometry_for_model
from seal_schematic import draw_seal_schematic


MODEL_NAMES = (
    "Gamma 1",
    "Gamma 2",
    "Gamma 3",
    "Orifice",
    "Kearton",
    "Ueda",
    "Saurabh (Lanjewar)",
)

PARAMETER_GROUPS = {
    "Operating conditions": (
        ("inlet_pressure_pa", "Inlet pressure", 1.0e-5, "bar", float),
        ("outlet_pressure_pa", "Outlet pressure", 1.0e-5, "bar", float),
        ("temperature_k", "Temperature", 1.0, "K", float),
        ("gamma", "Heat-capacity ratio", 1.0, "", float),
        ("gas_constant_j_kgk", "Gas constant", 1.0, "J/(kg K)", float),
    ),
    "Flow settings": (
        ("discharge_coefficient", "Discharge coefficient", 1.0, "", float),
        ("carryover_factor", "Ueda carry-over factor", 1.0, "", float),
        ("axial_displacement_percent", "Axial displacement", 1.0, "%", float),
    ),
    "Seal geometry": (
        ("clearance_m", "Default clearance", 1.0e3, "mm", float),
        ("tooth_tip_thickness_m", "Tooth-tip thickness", 1.0e3, "mm", float),
        ("tooth_pitch_m", "Default tooth pitch", 1.0e3, "mm", float),
        ("first_inlet_tooth_diameter_m", "First inlet diameter", 1.0e3, "mm", float),
        ("rotor_tip_diameter_m", "Rotor-tip diameter", 1.0e3, "mm", float),
        ("final_outlet_tooth_diameter_m", "Final outlet diameter", 1.0e3, "mm", float),
        ("inlet_teeth", "Stage 1 teeth", 1.0, "", int),
        ("outlet_teeth", "Stage 2 teeth", 1.0, "", int),
    ),
}

COLORS = ("#0072B2", "#56B4E9", "#009E73", "#D55E00", "#E69F00", "#CC79A7", "#332288")
MARKERS = ("o", "s", "^", "D", "v", "P", "X")
LINESTYLES = ("-", "--", "-.", "-", "--", "-.", "-")


@dataclass(frozen=True)
class DesignConstraints:
    minimum_effective_clearance_m: float
    maximum_effective_clearance_m: float
    maximum_radius_b_m: float
    operating_diameter_m: float | None = None
    minimum_first_inlet_diameter_m: float = 0.0
    minimum_final_outlet_diameter_m: float = 0.0

    def validate(self, inputs: CommonInputs, geometry: ToothGeometry) -> None:
        radius_b = inputs.rotor_tip_diameter_m / 2.0
        if radius_b > self.maximum_radius_b_m + 1.0e-12:
            raise ValueError(
                f"Radius B is {radius_b * 1e3:.3f} mm, above the constrained maximum "
                f"of {self.maximum_radius_b_m * 1e3:.3f} mm."
            )
        if self.operating_diameter_m is not None and abs(
            inputs.rotor_tip_diameter_m - self.operating_diameter_m
        ) > 1.0e-9:
            raise ValueError(
                f"Rotor-tip diameter must equal the constrained operating diameter "
                f"of {self.operating_diameter_m * 1e3:.3f} mm."
            )
        if inputs.first_inlet_tooth_diameter_m < self.minimum_first_inlet_diameter_m - 1.0e-12:
            raise ValueError(
                f"First inlet diameter is {inputs.first_inlet_tooth_diameter_m * 1e3:.3f} mm; "
                f"the constrained minimum is {self.minimum_first_inlet_diameter_m * 1e3:.3f} mm."
            )
        if inputs.final_outlet_tooth_diameter_m < self.minimum_final_outlet_diameter_m - 1.0e-12:
            raise ValueError(
                f"Final outlet diameter is {inputs.final_outlet_tooth_diameter_m * 1e3:.3f} mm; "
                f"the constrained minimum is {self.minimum_final_outlet_diameter_m * 1e3:.3f} mm."
            )
        effective_1, effective_2 = geometry.effective_clearances_m(inputs)
        for stage_name, clearances in (("Stage 1", effective_1), ("Stage 2", effective_2)):
            for index, clearance in enumerate(clearances, start=1):
                if not (
                    self.minimum_effective_clearance_m - 1.0e-12
                    <= clearance
                    <= self.maximum_effective_clearance_m + 1.0e-12
                ):
                    raise ValueError(
                        f"{stage_name} tooth {index} effective clearance is "
                        f"{clearance * 1e3:.4f} mm; permitted range is "
                        f"{self.minimum_effective_clearance_m * 1e3:.4f}–"
                        f"{self.maximum_effective_clearance_m * 1e3:.4f} mm."
                    )

    def summary(self) -> str:
        diameter_text = (
            "not fixed"
            if self.operating_diameter_m is None
            else f"{self.operating_diameter_m * 1e3:g} mm"
        )
        return (
            f"Constraints: clearance {self.minimum_effective_clearance_m * 1e3:g}–"
            f"{self.maximum_effective_clearance_m * 1e3:g} mm; "
            f"max Radius B {self.maximum_radius_b_m * 1e3:g} mm; "
            f"operating diameter {diameter_text}; min inlet/outlet diameters "
            f"{self.minimum_first_inlet_diameter_m * 1e3:g}/"
            f"{self.minimum_final_outlet_diameter_m * 1e3:g} mm."
        )


class ModelComparisonGUI:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Seal Model Pressure Comparison")
        self.root.geometry("1450x860")
        self.root.minsize(1100, 700)

        self.defaults = CommonInputs()
        self.parameter_vars: dict[str, tk.StringVar] = {}
        self.model_vars = {name: tk.BooleanVar(value=True) for name in MODEL_NAMES}
        self.current_inputs = self.defaults
        self.current_geometry = ToothGeometry.uniform(self.defaults)
        self.current_results: dict[str, dict[str, object]] = {}
        self._schematic_after_id: str | None = None
        self.tooth_clearance_vars: dict[str, list[tk.StringVar]] = {
            "stage1": [],
            "stage2": [],
        }
        self.tooth_pitch_vars: dict[str, list[tk.StringVar]] = {
            "stage1": [],
            "stage2": [],
        }
        self.tooth_editor: tk.Toplevel | None = None
        self.optimization_queue: queue.Queue[tuple[object, ...]] = queue.Queue()
        self.optimization_worker: threading.Thread | None = None
        self.optimization_results: dict[str, GeometryOptimizationResult] = {}
        self.optimization_inputs = self.defaults
        self.optimization_constraints: DesignConstraints | None = None
        self.optimization_buttons: list[ttk.Button] = []
        self.optimization_window: tk.Toplevel | None = None
        self.design_constraints: DesignConstraints | None = None
        self.constraint_window: tk.Toplevel | None = None
        self.constraint_summary_var = tk.StringVar(value="No additional design constraints enabled.")

        self._configure_style()
        self._build_layout()

    def _configure_style(self) -> None:
        style = ttk.Style(self.root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("Title.TLabel", font=("Segoe UI", 15, "bold"))
        style.configure("Section.TLabel", font=("Segoe UI", 10, "bold"))
        style.configure("Status.TLabel", foreground="#444444")

    def _build_layout(self) -> None:
        self.root.columnconfigure(1, weight=1)
        self.root.rowconfigure(0, weight=1)

        controls_panel = ttk.Frame(self.root)
        self.controls_panel = controls_panel
        controls_panel.grid(row=0, column=0, sticky="nsew")
        controls_panel.columnconfigure(0, weight=1)
        controls_panel.rowconfigure(0, weight=1)
        self.controls_canvas = tk.Canvas(
            controls_panel, width=390, highlightthickness=0, borderwidth=0
        )
        controls_scrollbar = ttk.Scrollbar(
            controls_panel, orient=tk.VERTICAL, command=self.controls_canvas.yview
        )
        self.controls_canvas.configure(yscrollcommand=controls_scrollbar.set)
        self.controls_canvas.grid(row=0, column=0, sticky="nsew")
        controls_scrollbar.grid(row=0, column=1, sticky="ns")
        controls = ttk.Frame(self.controls_canvas, padding=12)
        controls_window = self.controls_canvas.create_window((0, 0), window=controls, anchor="nw")
        controls.bind(
            "<Configure>",
            lambda _event: self.controls_canvas.configure(scrollregion=self.controls_canvas.bbox("all")),
        )
        self.controls_canvas.bind(
            "<Configure>",
            lambda event: self.controls_canvas.itemconfigure(controls_window, width=event.width),
        )
        self.root.bind_all("<MouseWheel>", self._scroll_controls)
        controls.columnconfigure(0, weight=1)

        chart_panel = ttk.Frame(self.root, padding=(0, 12, 12, 12))
        chart_panel.grid(row=0, column=1, sticky="nsew")
        chart_panel.columnconfigure(0, weight=1)
        chart_panel.rowconfigure(0, weight=1)

        self.notebook = ttk.Notebook(chart_panel)
        self.notebook.grid(row=0, column=0, sticky="nsew")
        self.results_tab = ttk.Frame(self.notebook, padding=6)
        self.geometry_tab = ttk.Frame(self.notebook, padding=6)
        self.notebook.add(self.geometry_tab, text="1. Seal geometry")
        self.notebook.add(self.results_tab, text="2. Pressure plot and results")
        self.results_tab.columnconfigure(0, weight=1)
        self.results_tab.rowconfigure(0, weight=1)
        self.geometry_tab.columnconfigure(0, weight=1)
        self.geometry_tab.rowconfigure(0, weight=1)

        ttk.Label(controls, text="Common model inputs", style="Title.TLabel").grid(
            row=0, column=0, sticky="w", pady=(0, 8)
        )

        row = 1
        for group_name, parameters in PARAMETER_GROUPS.items():
            frame = ttk.LabelFrame(controls, text=group_name, padding=8)
            frame.grid(row=row, column=0, sticky="ew", pady=4)
            frame.columnconfigure(1, weight=1)
            for parameter_row, (field, label, scale, unit, _converter) in enumerate(parameters):
                ttk.Label(frame, text=label).grid(
                    row=parameter_row, column=0, sticky="w", padx=(0, 8), pady=2
                )
                value = getattr(self.defaults, field) * scale
                display = str(int(value)) if float(value).is_integer() else f"{value:g}"
                variable = tk.StringVar(value=display)
                self.parameter_vars[field] = variable
                ttk.Entry(frame, textvariable=variable, width=14).grid(
                    row=parameter_row, column=1, sticky="ew", pady=2
                )
                ttk.Label(frame, text=unit, width=9).grid(
                    row=parameter_row, column=2, sticky="w", padx=(6, 0)
                )
            if group_name == "Seal geometry":
                ttk.Button(
                    frame,
                    text="Edit per-tooth clearances and pitches...",
                    command=self.show_tooth_geometry_editor,
                ).grid(
                    row=len(parameters),
                    column=0,
                    columnspan=3,
                    sticky="ew",
                    pady=(8, 0),
                )
                ttk.Button(
                    frame,
                    text="Add constraints...",
                    command=self.show_constraints_dialog,
                ).grid(
                    row=len(parameters) + 1,
                    column=0,
                    columnspan=3,
                    sticky="ew",
                    pady=(5, 0),
                )
                ttk.Label(
                    frame,
                    textvariable=self.constraint_summary_var,
                    style="Status.TLabel",
                    wraplength=300,
                ).grid(
                    row=len(parameters) + 2,
                    column=0,
                    columnspan=3,
                    sticky="w",
                    pady=(4, 0),
                )
            row += 1

        models_frame = ttk.LabelFrame(controls, text="Models to plot", padding=8)
        models_frame.grid(row=row, column=0, sticky="ew", pady=4)
        for index, name in enumerate(MODEL_NAMES):
            ttk.Checkbutton(
                models_frame, text=name, variable=self.model_vars[name]
            ).grid(row=index // 2, column=index % 2, sticky="w", padx=(0, 12), pady=2)
        button_row = (len(MODEL_NAMES) + 1) // 2
        ttk.Button(models_frame, text="Select all", command=self.select_all).grid(
            row=button_row, column=0, sticky="ew", padx=(0, 4), pady=(6, 0)
        )
        ttk.Button(models_frame, text="Clear all", command=self.clear_all).grid(
            row=button_row, column=1, sticky="ew", padx=(4, 0), pady=(6, 0)
        )
        row += 1

        actions = ttk.Frame(controls)
        actions.grid(row=row, column=0, sticky="ew", pady=(8, 4))
        actions.columnconfigure((0, 1), weight=1)
        ttk.Button(actions, text="Plot selected models", command=self.plot).grid(
            row=0, column=0, columnspan=2, sticky="ew", pady=(0, 5)
        )
        optimize_button = ttk.Button(
            actions,
            text="Find near-zero-force geometries",
            command=self.start_force_optimization,
        )
        optimize_button.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(0, 5))
        self.optimization_buttons.append(optimize_button)
        ttk.Button(actions, text="Save plot", command=self.save_plot).grid(
            row=2, column=0, sticky="ew", padx=(0, 3)
        )
        ttk.Button(actions, text="Export CSV", command=self.export_csv).grid(
            row=2, column=1, sticky="ew", padx=(3, 0)
        )
        ttk.Button(actions, text="Reset inputs", command=self.reset_inputs).grid(
            row=3, column=0, columnspan=2, sticky="ew", pady=(5, 0)
        )
        row += 1

        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(
            controls,
            textvariable=self.status_var,
            style="Status.TLabel",
            wraplength=315,
        ).grid(row=row, column=0, sticky="ew", pady=(5, 0))

        self.figure = Figure(figsize=(10, 7), dpi=100, constrained_layout=True)
        self.axis = self.figure.add_subplot(111)
        self.canvas = FigureCanvasTkAgg(self.figure, master=self.results_tab)
        self.canvas.get_tk_widget().grid(row=0, column=0, sticky="nsew")

        results_frame = ttk.LabelFrame(
            self.results_tab, text="Calculated model results", padding=(8, 5)
        )
        results_frame.grid(row=1, column=0, sticky="ew", pady=(8, 4))
        results_frame.columnconfigure(0, weight=1)
        columns = ("model", "mass_flow", "stator_force", "rotor_force")
        self.results_tree = ttk.Treeview(
            results_frame, columns=columns, show="headings", height=7
        )
        headings = {
            "model": "Model",
            "mass_flow": "Mass flow (g/s)",
            "stator_force": "Resultant stator force (N)",
            "rotor_force": "Rotor reaction (N)",
        }
        widths = {"model": 220, "mass_flow": 135, "stator_force": 175, "rotor_force": 145}
        for column in columns:
            self.results_tree.heading(column, text=headings[column])
            self.results_tree.column(
                column,
                width=widths[column],
                minwidth=90,
                anchor="w" if column == "model" else "e",
                stretch=True,
            )
        self.results_tree.grid(row=0, column=0, sticky="ew")
        ttk.Label(
            results_frame,
            text="Rotor reaction is shown as equal and opposite to the signed stator resultant.",
            style="Status.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(3, 0))

        toolbar_frame = ttk.Frame(self.results_tab)
        toolbar_frame.grid(row=2, column=0, sticky="ew")
        self.toolbar = NavigationToolbar2Tk(self.canvas, toolbar_frame, pack_toolbar=False)
        self.toolbar.update()
        self.toolbar.pack(side=tk.LEFT)

        self.geometry_figure = Figure(figsize=(10, 7), dpi=100, constrained_layout=True)
        self.geometry_axis = self.geometry_figure.add_subplot(111)
        self.geometry_canvas = FigureCanvasTkAgg(self.geometry_figure, master=self.geometry_tab)
        self.geometry_canvas.get_tk_widget().grid(row=0, column=0, sticky="nsew")
        geometry_actions = ttk.Frame(self.geometry_tab)
        geometry_actions.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        ttk.Button(
            geometry_actions,
            text="Edit per-tooth clearances and pitches...",
            command=self.show_tooth_geometry_editor,
        ).pack(side=tk.LEFT)
        geometry_optimize_button = ttk.Button(
            geometry_actions,
            text="Find near-zero-force geometries",
            command=self.start_force_optimization,
        )
        geometry_optimize_button.pack(side=tk.LEFT, padx=(8, 0))
        self.optimization_buttons.append(geometry_optimize_button)
        ttk.Button(
            geometry_actions,
            text="Add constraints...",
            command=self.show_constraints_dialog,
        ).pack(side=tk.LEFT, padx=(8, 0))
        self.geometry_status_var = tk.StringVar(value="Geometry uses the current input fields.")
        ttk.Label(
            self.geometry_tab,
            textvariable=self.geometry_status_var,
            style="Status.TLabel",
        ).grid(row=2, column=0, sticky="w", pady=(3, 0))

        self._resize_tooth_geometry_vars(
            self.defaults.inlet_teeth, self.defaults.outlet_teeth, reset=True
        )
        for variable in self.parameter_vars.values():
            variable.trace_add("write", self._schedule_schematic_update)
        self.parameter_vars["inlet_teeth"].trace_add("write", self._tooth_count_changed)
        self.parameter_vars["outlet_teeth"].trace_add("write", self._tooth_count_changed)
        self.update_schematic()

    def _scroll_controls(self, event: tk.Event) -> None:
        left = self.controls_panel.winfo_rootx()
        top = self.controls_panel.winfo_rooty()
        if (
            left <= event.x_root < left + self.controls_panel.winfo_width()
            and top <= event.y_root < top + self.controls_panel.winfo_height()
        ):
            self.controls_canvas.yview_scroll(-int(event.delta / 120), "units")

    def select_all(self) -> None:
        for variable in self.model_vars.values():
            variable.set(True)

    def clear_all(self) -> None:
        for variable in self.model_vars.values():
            variable.set(False)

    def _new_tooth_variable(self, value: float) -> tk.StringVar:
        variable = tk.StringVar(value=f"{value:g}")
        variable.trace_add("write", self._schedule_schematic_update)
        return variable

    def _default_geometry_value(self, field: str, fallback: float) -> float:
        try:
            return float(self.parameter_vars[field].get())
        except (KeyError, ValueError):
            return fallback

    def _resize_tooth_geometry_vars(
        self, inlet_count: int, outlet_count: int, *, reset: bool = False
    ) -> None:
        default_clearance = self._default_geometry_value(
            "clearance_m", self.defaults.clearance_m * 1.0e3
        )
        default_pitch = self._default_geometry_value(
            "tooth_pitch_m", self.defaults.tooth_pitch_m * 1.0e3
        )
        for stage, tooth_count in (("stage1", inlet_count), ("stage2", outlet_count)):
            clearance_vars = [] if reset else self.tooth_clearance_vars[stage][:tooth_count]
            pitch_count = max(0, tooth_count - 1)
            pitch_vars = [] if reset else self.tooth_pitch_vars[stage][:pitch_count]
            while len(clearance_vars) < tooth_count:
                clearance_vars.append(self._new_tooth_variable(default_clearance))
            while len(pitch_vars) < pitch_count:
                pitch_vars.append(self._new_tooth_variable(default_pitch))
            self.tooth_clearance_vars[stage] = clearance_vars
            self.tooth_pitch_vars[stage] = pitch_vars

    def _tooth_count_changed(self, *_args: object) -> None:
        try:
            inlet_count = int(self.parameter_vars["inlet_teeth"].get())
            outlet_count = int(self.parameter_vars["outlet_teeth"].get())
            if inlet_count < 1 or outlet_count < 1:
                return
        except ValueError:
            return
        self._resize_tooth_geometry_vars(inlet_count, outlet_count)
        if self.tooth_editor is not None and self.tooth_editor.winfo_exists():
            self._rebuild_tooth_editor()

    def fill_uniform_tooth_geometry(self) -> None:
        default_clearance = self._default_geometry_value(
            "clearance_m", self.defaults.clearance_m * 1.0e3
        )
        default_pitch = self._default_geometry_value(
            "tooth_pitch_m", self.defaults.tooth_pitch_m * 1.0e3
        )
        for variables in self.tooth_clearance_vars.values():
            for variable in variables:
                variable.set(f"{default_clearance:g}")
        for variables in self.tooth_pitch_vars.values():
            for variable in variables:
                variable.set(f"{default_pitch:g}")

    def show_tooth_geometry_editor(self) -> None:
        self._tooth_count_changed()
        if self.tooth_editor is not None and self.tooth_editor.winfo_exists():
            self.tooth_editor.deiconify()
            self.tooth_editor.lift()
            return

        self.tooth_editor = tk.Toplevel(self.root)
        self.tooth_editor.title("Per-tooth seal geometry")
        self.tooth_editor.geometry("760x620")
        self.tooth_editor.minsize(650, 420)
        self.tooth_editor.transient(self.root)
        self.tooth_editor.protocol("WM_DELETE_WINDOW", self._close_tooth_editor)

        instructions = ttk.Label(
            self.tooth_editor,
            text=(
                "Enter nominal clearance for each tooth and the centre-to-centre pitch to the next tooth. "
                "Stage 1 is listed in outward-flow order; Stage 2 is listed in inward-flow order."
            ),
            wraplength=710,
        )
        instructions.pack(fill=tk.X, padx=12, pady=(12, 6))

        canvas_frame = ttk.Frame(self.tooth_editor)
        canvas_frame.pack(fill=tk.BOTH, expand=True, padx=12, pady=4)
        canvas_frame.columnconfigure(0, weight=1)
        canvas_frame.rowconfigure(0, weight=1)
        self.tooth_editor_canvas = tk.Canvas(canvas_frame, highlightthickness=0)
        scrollbar = ttk.Scrollbar(
            canvas_frame, orient=tk.VERTICAL, command=self.tooth_editor_canvas.yview
        )
        self.tooth_editor_canvas.configure(yscrollcommand=scrollbar.set)
        self.tooth_editor_canvas.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.tooth_editor_inner = ttk.Frame(self.tooth_editor_canvas)
        self.tooth_editor_window = self.tooth_editor_canvas.create_window(
            (0, 0), window=self.tooth_editor_inner, anchor="nw"
        )
        self.tooth_editor_inner.bind(
            "<Configure>",
            lambda _event: self.tooth_editor_canvas.configure(
                scrollregion=self.tooth_editor_canvas.bbox("all")
            ),
        )
        self.tooth_editor_canvas.bind(
            "<Configure>",
            lambda event: self.tooth_editor_canvas.itemconfigure(
                self.tooth_editor_window, width=event.width
            ),
        )

        buttons = ttk.Frame(self.tooth_editor)
        buttons.pack(fill=tk.X, padx=12, pady=(6, 12))
        ttk.Button(
            buttons,
            text="Fill all from default values",
            command=self.fill_uniform_tooth_geometry,
        ).pack(side=tk.LEFT)
        ttk.Button(buttons, text="Close", command=self._close_tooth_editor).pack(
            side=tk.RIGHT
        )
        self._rebuild_tooth_editor()

    def _close_tooth_editor(self) -> None:
        if self.tooth_editor is not None:
            self.tooth_editor.destroy()
        self.tooth_editor = None

    def _rebuild_tooth_editor(self) -> None:
        if self.tooth_editor is None or not self.tooth_editor.winfo_exists():
            return
        for child in self.tooth_editor_inner.winfo_children():
            child.destroy()
        self.tooth_editor_inner.columnconfigure((0, 1), weight=1)
        for column, (stage, title) in enumerate(
            (("stage1", "Stage 1 — radial outward"), ("stage2", "Stage 2 — radial inward"))
        ):
            frame = ttk.LabelFrame(self.tooth_editor_inner, text=title, padding=8)
            frame.grid(row=0, column=column, sticky="nsew", padx=5, pady=5)
            ttk.Label(frame, text="Tooth", style="Section.TLabel").grid(row=0, column=0, padx=4)
            ttk.Label(frame, text="Clearance (mm)", style="Section.TLabel").grid(
                row=0, column=1, padx=4
            )
            ttk.Label(frame, text="Pitch to next (mm)", style="Section.TLabel").grid(
                row=0, column=2, padx=4
            )
            clearance_vars = self.tooth_clearance_vars[stage]
            pitch_vars = self.tooth_pitch_vars[stage]
            for index, clearance_variable in enumerate(clearance_vars):
                ttk.Label(frame, text=str(index + 1)).grid(
                    row=index + 1, column=0, padx=4, pady=2
                )
                ttk.Entry(frame, textvariable=clearance_variable, width=12).grid(
                    row=index + 1, column=1, padx=4, pady=2
                )
                if index < len(pitch_vars):
                    ttk.Entry(frame, textvariable=pitch_vars[index], width=14).grid(
                        row=index + 1, column=2, padx=4, pady=2
                    )
                else:
                    ttk.Label(frame, text="—").grid(row=index + 1, column=2, padx=4, pady=2)

    def show_constraints_dialog(self) -> None:
        if self.constraint_window is not None and self.constraint_window.winfo_exists():
            self.constraint_window.deiconify()
            self.constraint_window.lift()
            return
        current = self.design_constraints
        self.constraint_window = tk.Toplevel(self.root)
        self.constraint_window.title("Seal design constraints")
        self.constraint_window.geometry("520x470")
        self.constraint_window.resizable(False, False)
        self.constraint_window.transient(self.root)
        self.constraint_window.protocol("WM_DELETE_WINDOW", self._close_constraints_dialog)

        ttk.Label(
            self.constraint_window,
            text="Design constraints",
            style="Title.TLabel",
        ).pack(anchor="w", padx=14, pady=(14, 4))
        ttk.Label(
            self.constraint_window,
            text=(
                "Clearance limits apply to the effective operating gap after axial displacement. "
                "The operating diameter is applied to the rotor-tip diameter field."
            ),
            wraplength=460,
        ).pack(anchor="w", padx=14, pady=(0, 10))

        form = ttk.LabelFrame(self.constraint_window, text="Limits", padding=10)
        form.pack(fill=tk.X, padx=14, pady=4)
        form.columnconfigure(1, weight=1)
        defaults = (
            ("Minimum effective clearance", "minimum_clearance", 0.10 if current is None else current.minimum_effective_clearance_m * 1e3, "mm"),
            ("Maximum effective clearance", "maximum_clearance", 0.15 if current is None else current.maximum_effective_clearance_m * 1e3, "mm"),
            ("Maximum Radius B", "maximum_radius_b", 550.0 if current is None else current.maximum_radius_b_m * 1e3, "mm"),
            (
                "Operating seal diameter",
                "operating_diameter",
                450.0
                if current is None or current.operating_diameter_m is None
                else current.operating_diameter_m * 1e3,
                "mm",
            ),
            (
                "Minimum first inlet diameter",
                "minimum_first_inlet_diameter",
                self._default_geometry_value("first_inlet_tooth_diameter_m", 120.0)
                if current is None
                else current.minimum_first_inlet_diameter_m * 1e3,
                "mm",
            ),
            (
                "Minimum final outlet diameter",
                "minimum_final_outlet_diameter",
                self._default_geometry_value("final_outlet_tooth_diameter_m", 92.5)
                if current is None
                else current.minimum_final_outlet_diameter_m * 1e3,
                "mm",
            ),
        )
        self.constraint_vars: dict[str, tk.StringVar] = {}
        for row, (label, name, value, unit) in enumerate(defaults):
            ttk.Label(form, text=label).grid(row=row, column=0, sticky="w", padx=(0, 8), pady=4)
            variable = tk.StringVar(value=f"{value:g}")
            self.constraint_vars[name] = variable
            ttk.Entry(form, textvariable=variable, width=16).grid(
                row=row, column=1, sticky="ew", pady=4
            )
            ttk.Label(form, text=unit).grid(row=row, column=2, sticky="w", padx=(6, 0))

        self.clamp_clearances_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            self.constraint_window,
            text="Clamp current per-tooth clearances into the permitted range",
            variable=self.clamp_clearances_var,
        ).pack(anchor="w", padx=14, pady=(8, 3))

        buttons = ttk.Frame(self.constraint_window)
        buttons.pack(fill=tk.X, padx=14, pady=(10, 14))
        ttk.Button(buttons, text="Apply constraints", command=self.apply_constraints).pack(
            side=tk.LEFT
        )
        ttk.Button(buttons, text="Clear constraints", command=self.clear_constraints).pack(
            side=tk.LEFT, padx=(8, 0)
        )
        ttk.Button(buttons, text="Cancel", command=self._close_constraints_dialog).pack(
            side=tk.RIGHT
        )

    def _close_constraints_dialog(self) -> None:
        if self.constraint_window is not None:
            self.constraint_window.destroy()
        self.constraint_window = None

    def apply_constraints(self) -> None:
        try:
            minimum_mm = float(self.constraint_vars["minimum_clearance"].get())
            maximum_mm = float(self.constraint_vars["maximum_clearance"].get())
            maximum_radius_b_mm = float(self.constraint_vars["maximum_radius_b"].get())
            operating_text = self.constraint_vars["operating_diameter"].get().strip()
            operating_diameter_mm = float(operating_text) if operating_text else None
            minimum_first_inlet_diameter_mm = float(
                self.constraint_vars["minimum_first_inlet_diameter"].get()
            )
            minimum_final_outlet_diameter_mm = float(
                self.constraint_vars["minimum_final_outlet_diameter"].get()
            )
        except ValueError:
            messagebox.showerror("Invalid constraints", "All constraint values must be valid numbers.")
            return
        if minimum_mm <= 0 or maximum_mm < minimum_mm:
            messagebox.showerror(
                "Invalid constraints",
                "Minimum clearance must be positive and no greater than maximum clearance.",
            )
            return
        if (
            maximum_radius_b_mm <= 0
            or minimum_first_inlet_diameter_mm <= 0
            or minimum_final_outlet_diameter_mm <= 0
            or (
            operating_diameter_mm is not None and operating_diameter_mm <= 0
            )
        ):
            messagebox.showerror("Invalid constraints", "Radius and diameter must be positive.")
            return

        constraints = DesignConstraints(
            minimum_effective_clearance_m=minimum_mm / 1.0e3,
            maximum_effective_clearance_m=maximum_mm / 1.0e3,
            maximum_radius_b_m=maximum_radius_b_mm / 1.0e3,
            operating_diameter_m=(
                None if operating_diameter_mm is None else operating_diameter_mm / 1.0e3
            ),
            minimum_first_inlet_diameter_m=minimum_first_inlet_diameter_mm / 1.0e3,
            minimum_final_outlet_diameter_m=minimum_final_outlet_diameter_mm / 1.0e3,
        )
        if operating_diameter_mm is not None:
            self.parameter_vars["rotor_tip_diameter_m"].set(f"{operating_diameter_mm:g}")

        if self.clamp_clearances_var.get():
            try:
                displacement = float(self.parameter_vars["axial_displacement_percent"].get()) / 100.0
            except ValueError:
                messagebox.showerror("Invalid input", "Axial displacement must be a valid number.")
                return
            for stage, factor in (("stage1", 1.0 + displacement), ("stage2", 1.0 - displacement)):
                for variable in self.tooth_clearance_vars[stage]:
                    try:
                        nominal_mm = float(variable.get())
                    except ValueError:
                        nominal_mm = minimum_mm / factor
                    effective_mm = nominal_mm * factor
                    clamped_effective = (
                        effective_mm
                        if minimum_mm <= effective_mm <= maximum_mm
                        else 0.5 * (minimum_mm + maximum_mm)
                    )
                    variable.set(f"{clamped_effective / factor:.8g}")

        previous = self.design_constraints
        self.design_constraints = constraints
        try:
            inputs = self.read_inputs()
            geometry = self.read_tooth_geometry(inputs)
            constraints.validate(inputs, geometry)
        except ValueError as error:
            self.design_constraints = previous
            messagebox.showerror("Constraint conflict", str(error))
            return
        self.constraint_summary_var.set(constraints.summary())
        self.update_schematic()
        self.status_var.set("Design constraints applied.")
        self._close_constraints_dialog()

    def clear_constraints(self) -> None:
        self.design_constraints = None
        self.constraint_summary_var.set("No additional design constraints enabled.")
        self.status_var.set("Design constraints cleared.")
        self.update_schematic()
        self._close_constraints_dialog()

    def reset_inputs(self) -> None:
        self.design_constraints = None
        self.constraint_summary_var.set("No additional design constraints enabled.")
        for parameters in PARAMETER_GROUPS.values():
            for field, _label, scale, _unit, _converter in parameters:
                value = getattr(self.defaults, field) * scale
                self.parameter_vars[field].set(
                    str(int(value)) if float(value).is_integer() else f"{value:g}"
                )
        self._resize_tooth_geometry_vars(
            self.defaults.inlet_teeth, self.defaults.outlet_teeth, reset=True
        )
        if self.tooth_editor is not None and self.tooth_editor.winfo_exists():
            self._rebuild_tooth_editor()
        self.select_all()
        self.plot()

    def _schedule_schematic_update(self, *_args: object) -> None:
        if self._schematic_after_id is not None:
            self.root.after_cancel(self._schematic_after_id)
        self._schematic_after_id = self.root.after(250, self.update_schematic)

    def update_schematic(self) -> None:
        self._schematic_after_id = None
        try:
            inputs = self.read_inputs()
            geometry = self.read_tooth_geometry(inputs)
            draw_seal_schematic(self.geometry_axis, inputs, geometry)
            self.geometry_canvas.draw_idle()
            self.geometry_status_var.set(
                "Live schematic updated. Axial clearances are exaggerated for visibility; radial dimensions are scaled."
            )
        except (TypeError, ValueError) as error:
            self.geometry_status_var.set(f"Waiting for valid geometry inputs: {error}")

    def read_inputs(self) -> CommonInputs:
        values: dict[str, float | int] = {}
        for parameters in PARAMETER_GROUPS.values():
            for field, label, scale, _unit, converter in parameters:
                raw_value = self.parameter_vars[field].get().strip()
                try:
                    displayed_value = converter(raw_value)
                except ValueError as error:
                    raise ValueError(f"{label} must be a valid number.") from error
                values[field] = (
                    int(displayed_value)
                    if converter is int
                    else float(displayed_value) / scale
                )

        inputs = CommonInputs(**values)
        if inputs.inlet_pressure_pa <= inputs.outlet_pressure_pa:
            raise ValueError("Inlet pressure must be greater than outlet pressure.")
        if inputs.outlet_pressure_pa <= 0 or inputs.temperature_k <= 0:
            raise ValueError("Pressure and temperature must be positive.")
        if inputs.clearance_m <= 0 or inputs.tooth_pitch_m <= 0:
            raise ValueError("Clearance and tooth pitch must be positive.")
        if inputs.tooth_tip_thickness_m <= 0:
            raise ValueError("Tooth-tip thickness must be positive.")
        if inputs.inlet_teeth < 1 or inputs.outlet_teeth < 1:
            raise ValueError("Each stage must contain at least one tooth.")
        if min(
            inputs.first_inlet_tooth_diameter_m,
            inputs.rotor_tip_diameter_m,
            inputs.final_outlet_tooth_diameter_m,
        ) <= 0:
            raise ValueError("All diameters must be positive.")
        if inputs.rotor_tip_diameter_m <= max(
            inputs.first_inlet_tooth_diameter_m,
            inputs.final_outlet_tooth_diameter_m,
        ):
            raise ValueError("Rotor-tip diameter must exceed the inlet and outlet diameters.")
        if inputs.discharge_coefficient <= 0:
            raise ValueError("Discharge coefficient must be positive.")
        if not 0.0 <= inputs.carryover_factor < 1.0:
            raise ValueError("Ueda carry-over factor must be from 0 (inclusive) to 1 (exclusive).")
        if not -99.0 < inputs.axial_displacement_percent < 99.0:
            raise ValueError("Axial displacement must be between -99% and 99%.")
        return inputs

    def read_tooth_geometry(self, inputs: CommonInputs) -> ToothGeometry:
        self._resize_tooth_geometry_vars(inputs.inlet_teeth, inputs.outlet_teeth)

        def values_mm(stage: str, kind: str) -> tuple[float, ...]:
            variables = (
                self.tooth_clearance_vars[stage]
                if kind == "clearance"
                else self.tooth_pitch_vars[stage]
            )
            values: list[float] = []
            for index, variable in enumerate(variables, start=1):
                try:
                    values.append(float(variable.get()) / 1.0e3)
                except ValueError as error:
                    raise ValueError(
                        f"{stage.title()} tooth {index} {kind} must be a valid number."
                    ) from error
            return tuple(values)

        geometry = ToothGeometry(
            stage1_clearances_m=values_mm("stage1", "clearance"),
            stage2_clearances_m=values_mm("stage2", "clearance"),
            stage1_pitches_m=values_mm("stage1", "pitch"),
            stage2_pitches_m=values_mm("stage2", "pitch"),
        )
        geometry.validate(inputs)
        if self.design_constraints is not None:
            self.design_constraints.validate(inputs, geometry)
        return geometry

    def start_force_optimization(self) -> None:
        if self.optimization_worker is not None and self.optimization_worker.is_alive():
            return
        model_names = self.selected_model_names()
        if not model_names:
            messagebox.showwarning("No models selected", "Select at least one model to optimize.")
            return
        try:
            inputs = self.read_inputs()
            geometry = self.read_tooth_geometry(inputs)
        except ValueError as error:
            messagebox.showerror("Invalid geometry", str(error))
            return

        self.optimization_inputs = inputs
        self.optimization_constraints = self.design_constraints
        self.optimization_results = {}
        while not self.optimization_queue.empty():
            try:
                self.optimization_queue.get_nowait()
            except queue.Empty:
                break
        for button in self.optimization_buttons:
            button.configure(state=tk.DISABLED)
        self.status_var.set(f"Optimizing 0/{len(model_names)} models...")

        def worker() -> None:
            completed: dict[str, GeometryOptimizationResult] = {}
            errors: dict[str, str] = {}
            optimization_bounds = (
                {}
                if self.optimization_constraints is None
                else {
                    "minimum_clearance_m": self.optimization_constraints.minimum_effective_clearance_m,
                    "maximum_clearance_m": self.optimization_constraints.maximum_effective_clearance_m,
                    "minimum_first_inlet_diameter_m": self.optimization_constraints.minimum_first_inlet_diameter_m,
                    "minimum_final_outlet_diameter_m": self.optimization_constraints.minimum_final_outlet_diameter_m,
                }
            )
            for index, model_name in enumerate(model_names, start=1):
                try:
                    completed[model_name] = optimize_geometry_for_model(
                        model_name, inputs, geometry, **optimization_bounds
                    )
                except Exception as error:
                    errors[model_name] = str(error)
                self.optimization_queue.put(
                    ("progress", index, len(model_names), model_name)
                )
            self.optimization_queue.put(("done", completed, errors))

        self.optimization_worker = threading.Thread(target=worker, daemon=True)
        self.optimization_worker.start()
        self.root.after(100, self._poll_optimization_queue)

    def _poll_optimization_queue(self) -> None:
        done = False
        while True:
            try:
                message = self.optimization_queue.get_nowait()
            except queue.Empty:
                break
            if message[0] == "progress":
                _kind, index, total, model_name = message
                self.status_var.set(f"Optimizing {index}/{total}: {model_name}")
            elif message[0] == "done":
                _kind, results, errors = message
                self.optimization_results = results
                for button in self.optimization_buttons:
                    button.configure(state=tk.NORMAL)
                if results:
                    self.status_var.set(
                        f"Optimization finished for {len(results)} model"
                        f"{'s' if len(results) != 1 else ''}."
                    )
                    self.show_optimization_results(errors)
                else:
                    self.status_var.set("Optimization failed.")
                    messagebox.showerror(
                        "Optimization failed",
                        "\n".join(f"{name}: {error}" for name, error in errors.items()),
                    )
                done = True
        if not done and self.optimization_worker is not None and self.optimization_worker.is_alive():
            self.root.after(100, self._poll_optimization_queue)

    def show_optimization_results(self, errors: dict[str, str] | None = None) -> None:
        if self.optimization_window is not None and self.optimization_window.winfo_exists():
            self.optimization_window.destroy()
        self.optimization_window = tk.Toplevel(self.root)
        self.optimization_window.title("Near-zero-force geometry results")
        self.optimization_window.geometry("1050x700")
        self.optimization_window.minsize(850, 550)
        self.optimization_window.transient(self.root)

        ttk.Label(
            self.optimization_window,
            text="Model-specific optimized geometries",
            style="Title.TLabel",
        ).pack(anchor="w", padx=12, pady=(12, 3))
        ttk.Label(
            self.optimization_window,
            text=(
                "The algorithm independently adjusts every tooth clearance, every pitch-to-next, "
                "the first inlet diameter, and the final outlet diameter. A small minimum-change "
                "penalty selects a nearby design when several geometries give the same force. "
                + (
                    "The search keeps clearances between 0.02 and 2.0 mm"
                    if self.optimization_constraints is None
                    else (
                        f"The active clearance constraint is "
                        f"{self.optimization_constraints.minimum_effective_clearance_m * 1e3:g}–"
                        f"{self.optimization_constraints.maximum_effective_clearance_m * 1e3:g} mm"
                    )
                )
                + ". Pitch and diameter changes are bounded, and every tooth must remain within the rotor tip."
            ),
            wraplength=1000,
        ).pack(anchor="w", padx=12, pady=(0, 8))

        summary_frame = ttk.LabelFrame(
            self.optimization_window, text="Optimization summary", padding=8
        )
        summary_frame.pack(fill=tk.X, padx=12, pady=4)
        summary_columns = (
            "model",
            "initial_force",
            "optimized_force",
            "mass_flow",
            "inlet_diameter",
            "outlet_diameter",
            "status",
        )
        self.optimization_tree = ttk.Treeview(
            summary_frame, columns=summary_columns, show="headings", height=7
        )
        summary_headings = {
            "model": "Model",
            "initial_force": "Initial force (N)",
            "optimized_force": "Optimized force (N)",
            "mass_flow": "Mass flow (g/s)",
            "inlet_diameter": "First inlet dia. (mm)",
            "outlet_diameter": "Final outlet dia. (mm)",
            "status": "Status",
        }
        for column in summary_columns:
            self.optimization_tree.heading(column, text=summary_headings[column])
            self.optimization_tree.column(
                column,
                width=190 if column == "model" else 120,
                anchor="w" if column in {"model", "status"} else "e",
            )
        self.optimization_tree.pack(fill=tk.X)
        for model_name, result in self.optimization_results.items():
            self.optimization_tree.insert(
                "",
                "end",
                iid=model_name,
                values=(
                    model_name,
                    f"{result.initial_force_n:+.4f}",
                    f"{result.optimized_force_n:+.4f}",
                    f"{result.mass_flow_kg_s * 1.0e3:.4f}",
                    f"{result.optimized_inputs.first_inlet_tooth_diameter_m * 1e3:.4f}",
                    f"{result.optimized_inputs.final_outlet_tooth_diameter_m * 1e3:.4f}",
                    "Near zero" if result.converged else "Best within bounds",
                ),
            )
        self.optimization_tree.bind("<<TreeviewSelect>>", self._optimization_selection_changed)

        detail_frame = ttk.LabelFrame(
            self.optimization_window, text="Selected model geometry", padding=8
        )
        detail_frame.pack(fill=tk.BOTH, expand=True, padx=12, pady=4)
        detail_columns = ("stage", "tooth", "diameter", "clearance", "pitch")
        self.optimization_detail_tree = ttk.Treeview(
            detail_frame, columns=detail_columns, show="headings", height=12
        )
        detail_headings = {
            "stage": "Stage",
            "tooth": "Tooth",
            "diameter": "Diameter (mm)",
            "clearance": "Nominal clearance (mm)",
            "pitch": "Pitch to next (mm)",
        }
        for column in detail_columns:
            self.optimization_detail_tree.heading(column, text=detail_headings[column])
            self.optimization_detail_tree.column(column, width=150, anchor="center")
        self.optimization_detail_tree.pack(fill=tk.BOTH, expand=True)

        if errors:
            ttk.Label(
                self.optimization_window,
                text="Failed models: " + "; ".join(f"{name}: {error}" for name, error in errors.items()),
                foreground="#B91C1C",
                wraplength=1000,
            ).pack(fill=tk.X, padx=12, pady=3)

        buttons = ttk.Frame(self.optimization_window)
        buttons.pack(fill=tk.X, padx=12, pady=(5, 12))
        ttk.Button(
            buttons,
            text="Apply selected geometry to GUI",
            command=self.apply_selected_optimized_geometry,
        ).pack(side=tk.LEFT)
        ttk.Button(
            buttons,
            text="Export optimization CSV",
            command=self.export_optimization_csv,
        ).pack(side=tk.LEFT, padx=(8, 0))
        ttk.Button(
            buttons, text="Close", command=self.optimization_window.destroy
        ).pack(side=tk.RIGHT)

        children = self.optimization_tree.get_children()
        if children:
            self.optimization_tree.selection_set(children[0])
            self.optimization_tree.focus(children[0])
            self._optimization_selection_changed()

    def _selected_optimization_model(self) -> str | None:
        selection = self.optimization_tree.selection()
        return selection[0] if selection else None

    def _optimization_selection_changed(self, _event: object | None = None) -> None:
        model_name = self._selected_optimization_model()
        if model_name is None:
            return
        result = self.optimization_results[model_name]
        geometry = result.geometry
        inputs = result.optimized_inputs
        for item in self.optimization_detail_tree.get_children():
            self.optimization_detail_tree.delete(item)
        for stage_name, diameters, clearances, pitches in (
            (
                "Stage 1",
                geometry.stage1_diameters_m(inputs),
                geometry.stage1_clearances_m,
                geometry.stage1_pitches_m,
            ),
            (
                "Stage 2",
                geometry.stage2_diameters_m(inputs),
                geometry.stage2_clearances_m,
                geometry.stage2_pitches_m,
            ),
        ):
            for index, (diameter, clearance) in enumerate(
                zip(diameters, clearances), start=1
            ):
                self.optimization_detail_tree.insert(
                    "",
                    "end",
                    values=(
                        stage_name,
                        index,
                        f"{diameter * 1.0e3:.4f}",
                        f"{clearance * 1.0e3:.5f}",
                        "" if index > len(pitches) else f"{pitches[index - 1] * 1.0e3:.5f}",
                    ),
                )

    def apply_selected_optimized_geometry(self) -> None:
        model_name = self._selected_optimization_model()
        if model_name is None:
            messagebox.showinfo("No result selected", "Select a model result first.")
            return
        result = self.optimization_results[model_name]
        geometry = result.geometry
        self._resize_tooth_geometry_vars(
            self.optimization_inputs.inlet_teeth, self.optimization_inputs.outlet_teeth
        )
        for variable, value in zip(
            self.tooth_clearance_vars["stage1"], geometry.stage1_clearances_m
        ):
            variable.set(f"{value * 1.0e3:.8g}")
        for variable, value in zip(
            self.tooth_clearance_vars["stage2"], geometry.stage2_clearances_m
        ):
            variable.set(f"{value * 1.0e3:.8g}")
        for variable, value in zip(self.tooth_pitch_vars["stage1"], geometry.stage1_pitches_m):
            variable.set(f"{value * 1.0e3:.8g}")
        for variable, value in zip(self.tooth_pitch_vars["stage2"], geometry.stage2_pitches_m):
            variable.set(f"{value * 1.0e3:.8g}")
        self.parameter_vars["first_inlet_tooth_diameter_m"].set(
            f"{result.optimized_inputs.first_inlet_tooth_diameter_m * 1.0e3:.8g}"
        )
        self.parameter_vars["final_outlet_tooth_diameter_m"].set(
            f"{result.optimized_inputs.final_outlet_tooth_diameter_m * 1.0e3:.8g}"
        )
        if self.tooth_editor is not None and self.tooth_editor.winfo_exists():
            self._rebuild_tooth_editor()
        self.update_schematic()
        self.notebook.select(self.geometry_tab)
        self.status_var.set(f"Applied optimized geometry from {model_name}. Click Plot to evaluate it.")

    def export_optimization_csv(self) -> None:
        if not self.optimization_results:
            return
        path = filedialog.asksaveasfilename(
            title="Export optimized geometries",
            defaultextension=".csv",
            filetypes=(("CSV file", "*.csv"),),
            initialfile="near_zero_force_geometries.csv",
        )
        if not path:
            return
        with Path(path).open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            if self.design_constraints is not None:
                writer.writerow(["active_design_constraints"])
                writer.writerow(
                    [
                        "minimum_effective_clearance_mm",
                        self.design_constraints.minimum_effective_clearance_m * 1e3,
                    ]
                )
                writer.writerow(
                    [
                        "maximum_effective_clearance_mm",
                        self.design_constraints.maximum_effective_clearance_m * 1e3,
                    ]
                )
                writer.writerow(
                    ["maximum_radius_b_mm", self.design_constraints.maximum_radius_b_m * 1e3]
                )
                writer.writerow(
                    [
                        "minimum_first_inlet_diameter_mm",
                        self.design_constraints.minimum_first_inlet_diameter_m * 1e3,
                    ]
                )
                writer.writerow(
                    [
                        "minimum_final_outlet_diameter_mm",
                        self.design_constraints.minimum_final_outlet_diameter_m * 1e3,
                    ]
                )
                writer.writerow(
                    [
                        "operating_diameter_mm",
                        ""
                        if self.design_constraints.operating_diameter_m is None
                        else self.design_constraints.operating_diameter_m * 1e3,
                    ]
                )
                writer.writerow([])
            writer.writerow(
                [
                    "model",
                    "initial_force_n",
                    "optimized_force_n",
                    "mass_flow_g_s",
                    "stage1_clearance_scale",
                    "stage2_clearance_scale",
                    "first_inlet_diameter_mm",
                    "final_outlet_diameter_mm",
                    "converged",
                    "method",
                ]
            )
            for result in self.optimization_results.values():
                writer.writerow(
                    [
                        result.model_name,
                        result.initial_force_n,
                        result.optimized_force_n,
                        result.mass_flow_kg_s * 1.0e3,
                        result.stage1_clearance_scale,
                        result.stage2_clearance_scale,
                        result.optimized_inputs.first_inlet_tooth_diameter_m * 1.0e3,
                        result.optimized_inputs.final_outlet_tooth_diameter_m * 1.0e3,
                        result.converged,
                        result.method,
                    ]
                )
            writer.writerow([])
            writer.writerow(
                ["model", "stage", "tooth", "diameter_mm", "clearance_mm", "pitch_to_next_mm"]
            )
            for result in self.optimization_results.values():
                geometry = result.geometry
                inputs = result.optimized_inputs
                for stage_name, diameters, clearances, pitches in (
                    (
                        "Stage 1",
                        geometry.stage1_diameters_m(inputs),
                        geometry.stage1_clearances_m,
                        geometry.stage1_pitches_m,
                    ),
                    (
                        "Stage 2",
                        geometry.stage2_diameters_m(inputs),
                        geometry.stage2_clearances_m,
                        geometry.stage2_pitches_m,
                    ),
                ):
                    for index, (diameter, clearance) in enumerate(
                        zip(diameters, clearances), start=1
                    ):
                        writer.writerow(
                            [
                                result.model_name,
                                stage_name,
                                index,
                                diameter * 1.0e3,
                                clearance * 1.0e3,
                                "" if index > len(pitches) else pitches[index - 1] * 1.0e3,
                            ]
                        )
        self.status_var.set(f"Exported optimized geometries: {path}")

    def selected_model_names(self) -> list[str]:
        return [name for name in MODEL_NAMES if self.model_vars[name].get()]

    def plot(self) -> None:
        selected_names = self.selected_model_names()
        if not selected_names:
            messagebox.showwarning("No models selected", "Select at least one model to plot.")
            return
        try:
            inputs = self.read_inputs()
            geometry = self.read_tooth_geometry(inputs)
            self.status_var.set("Running models...")
            self.root.update_idletasks()
            all_results = run_all_models(inputs, geometry)
            results = {name: all_results[name] for name in selected_names}
            self._draw_chart(results, inputs, geometry)
            self._update_results_table(results)
            self.update_schematic()
            self.current_inputs = inputs
            self.current_geometry = geometry
            self.current_results = results
            self.notebook.select(self.results_tab)
            self.status_var.set(
                f"Plotted {len(results)} model{'s' if len(results) != 1 else ''}."
            )
        except Exception as error:
            self.status_var.set("Plot failed.")
            messagebox.showerror("Unable to plot", str(error))

    def _draw_chart(
        self,
        results: dict[str, dict[str, object]],
        inputs: CommonInputs,
        geometry: ToothGeometry,
    ) -> None:
        self.axis.clear()
        x = list(range(inputs.inlet_teeth + inputs.outlet_teeth + 1))
        style_by_name = {
            name: (COLORS[index], MARKERS[index], LINESTYLES[index])
            for index, name in enumerate(MODEL_NAMES)
        }
        for name, result in results.items():
            color, marker, linestyle = style_by_name[name]
            self.axis.plot(
                x,
                [pressure / 1.0e5 for pressure in result["pressures_pa"]],
                color=color,
                marker=marker,
                linestyle=linestyle,
                linewidth=2.6 if name == "Saurabh (Lanjewar)" else 1.8,
                markersize=6.0,
                label=f"{name} ({result['mass_flow_kg_s'] * 1.0e3:.3f} g/s)",
            )

        self.axis.axvline(
            inputs.inlet_teeth, color="#666666", linestyle=":", linewidth=1.2
        )
        self.axis.set_xticks(x)
        self.axis.set_xticklabels(
            ["in"]
            + [str(i) for i in range(1, inputs.inlet_teeth + 1)]
            + [str(i) for i in range(1, inputs.outlet_teeth + 1)]
        )
        self.axis.set_xlabel("Tooth index")
        self.axis.set_ylabel("Pressure (bar, absolute)")
        self.axis.set_xlim(0, x[-1])
        self.axis.grid(True, linestyle="dotted", linewidth=0.7, alpha=0.65)
        self.axis.legend(loc="best", fontsize=8.5)
        all_clearances = geometry.stage1_clearances_m + geometry.stage2_clearances_m
        clearance_min = min(all_clearances) * 1.0e3
        clearance_max = max(all_clearances) * 1.0e3
        clearance_text = (
            f"{clearance_min:g} mm"
            if abs(clearance_max - clearance_min) < 1.0e-12
            else f"{clearance_min:g}–{clearance_max:g} mm"
        )
        self.axis.set_title(
            "Seal pressure-distribution comparison\n"
            f"Pin={inputs.inlet_pressure_pa / 1e5:g} bar, "
            f"Pout={inputs.outlet_pressure_pa / 1e5:g} bar, "
            f"T={inputs.temperature_k:g} K, "
            f"Cd={inputs.discharge_coefficient:g}, "
            f"nominal clearance range={clearance_text}"
        )
        self.canvas.draw_idle()

    def _update_results_table(self, results: dict[str, dict[str, object]]) -> None:
        for item in self.results_tree.get_children():
            self.results_tree.delete(item)
        for name, result in results.items():
            stator_force = float(result["resultant_stator_force_n"])
            self.results_tree.insert(
                "",
                "end",
                values=(
                    name,
                    f"{float(result['mass_flow_kg_s']) * 1.0e3:.4f}",
                    f"{stator_force:+.3f}",
                    f"{-stator_force:+.3f}",
                ),
            )

    def save_plot(self) -> None:
        if not self.current_results:
            messagebox.showinfo("Nothing to save", "Plot at least one model first.")
            return
        path = filedialog.asksaveasfilename(
            title="Save comparison plot",
            defaultextension=".png",
            filetypes=(("PNG image", "*.png"), ("PDF", "*.pdf"), ("SVG", "*.svg")),
            initialfile="selected_models_pressure_distribution.png",
        )
        if path:
            self.figure.savefig(path, dpi=180, bbox_inches="tight")
            self.status_var.set(f"Saved plot: {path}")

    def export_csv(self) -> None:
        if not self.current_results:
            messagebox.showinfo("Nothing to export", "Plot at least one model first.")
            return
        path = filedialog.asksaveasfilename(
            title="Export comparison data",
            defaultextension=".csv",
            filetypes=(("CSV file", "*.csv"),),
            initialfile="selected_models_pressure_distribution.csv",
        )
        if not path:
            return

        inputs = self.current_inputs
        geometry = self.current_geometry
        stage_labels = (
            ["in"]
            + [f"S1T{i}" for i in range(1, inputs.inlet_teeth + 1)]
            + [f"S2T{i}" for i in range(1, inputs.outlet_teeth + 1)]
        )
        with Path(path).open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            if self.optimization_constraints is not None:
                writer.writerow(["active_design_constraints"])
                writer.writerow(
                    [
                        "minimum_effective_clearance_mm",
                        self.optimization_constraints.minimum_effective_clearance_m * 1e3,
                    ]
                )
                writer.writerow(
                    [
                        "maximum_effective_clearance_mm",
                        self.optimization_constraints.maximum_effective_clearance_m * 1e3,
                    ]
                )
                writer.writerow(
                    ["maximum_radius_b_mm", self.optimization_constraints.maximum_radius_b_m * 1e3]
                )
                writer.writerow(
                    [
                        "minimum_first_inlet_diameter_mm",
                        self.optimization_constraints.minimum_first_inlet_diameter_m * 1e3,
                    ]
                )
                writer.writerow(
                    [
                        "minimum_final_outlet_diameter_mm",
                        self.optimization_constraints.minimum_final_outlet_diameter_m * 1e3,
                    ]
                )
                writer.writerow([])
            writer.writerow(
                [
                    "model",
                    "mass_flow_kg_s",
                    "mass_flow_g_s",
                    "resultant_stator_force_n",
                    "rotor_reaction_n",
                ]
            )
            for name, result in self.current_results.items():
                stator_force = float(result["resultant_stator_force_n"])
                writer.writerow(
                    [
                        name,
                        result["mass_flow_kg_s"],
                        float(result["mass_flow_kg_s"]) * 1.0e3,
                        stator_force,
                        -stator_force,
                    ]
                )
            writer.writerow([])
            writer.writerow(
                [
                    "stage",
                    "tooth",
                    "diameter_mm",
                    "nominal_clearance_mm",
                    "effective_clearance_mm",
                    "pitch_to_next_mm",
                ]
            )
            effective_1, effective_2 = geometry.effective_clearances_m(inputs)
            for stage_name, diameters, nominal, effective, pitches in (
                (
                    "Stage 1",
                    geometry.stage1_diameters_m(inputs),
                    geometry.stage1_clearances_m,
                    effective_1,
                    geometry.stage1_pitches_m,
                ),
                (
                    "Stage 2",
                    geometry.stage2_diameters_m(inputs),
                    geometry.stage2_clearances_m,
                    effective_2,
                    geometry.stage2_pitches_m,
                ),
            ):
                for index, (diameter, clearance, effective_clearance) in enumerate(
                    zip(diameters, nominal, effective), start=1
                ):
                    writer.writerow(
                        [
                            stage_name,
                            index,
                            diameter * 1.0e3,
                            clearance * 1.0e3,
                            effective_clearance * 1.0e3,
                            "" if index > len(pitches) else pitches[index - 1] * 1.0e3,
                        ]
                    )
            writer.writerow([])
            writer.writerow(
                ["stage_index", "stage_label"]
                + [f"{name}_pressure_bar" for name in self.current_results]
            )
            for index, stage_label in enumerate(stage_labels):
                writer.writerow(
                    [index, stage_label]
                    + [
                        result["pressures_pa"][index] / 1.0e5
                        for result in self.current_results.values()
                    ]
                )
        self.status_var.set(f"Exported CSV: {path}")


def main() -> None:
    root = tk.Tk()
    ModelComparisonGUI(root)
    root.mainloop()


if __name__ == "__main__":
    main()
