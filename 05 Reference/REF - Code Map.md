# REF - Code Map

Code root: `D:\AI Predicates\Design_System\seal_calculations_2`

| Record/stage | File and symbol | Exact VS Code link |
|---|---|---|
| GUI launcher | `LAUNCH_GUI.pyw::main` | [Open](vscode://file/D:/AI%20Predicates/Design_System/LAUNCH_GUI.pyw:38) |
| GUI model list | `model_gui.py::MODEL_NAMES` | [Open](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/model_gui.py:21) |
| GUI input fields | `model_gui.py::PARAMETER_GROUPS` | [Open](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/model_gui.py:31) |
| Common inputs | `plot_all_models.py::CommonInputs` | [Open](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/plot_all_models.py:45) |
| Geometry | `plot_all_models.py::ToothGeometry` | [Open](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/plot_all_models.py:67) |
| Model dispatch | `plot_all_models.py::run_single_model` | [Open](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/plot_all_models.py:200) |
| All-model run | `plot_all_models.py::run_all_models` | [Open](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/plot_all_models.py:291) |
| Model implementations and comparison | Gamma, Kearton, Ueda and Saurabh-Lanjewar | [[WHY-SIM-01-01 - Model Selection]] |
| Force calculation | `plot_all_models.py::calculate_resultant_stator_force` | [Open](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/plot_all_models.py:174) |
| Optimisation | `geometry_optimizer.py::optimize_geometry_for_model` | [Open](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/geometry_optimizer.py:35) |
| Seal schematic | `seal_schematic.py::draw_seal_schematic` | [Open](vscode://file/D:/AI%20Predicates/Design_System/seal_calculations_2/seal_schematic.py:33) |

## Current implementation boundary

Dedicated implementations were found for pressure/leakage model comparison, axial-displacement clearance changes, force postprocessing, geometry optimisation, GUI input/control and schematic drawing. No dedicated off-centre, rotor-tilt, transient chamber, vibration or FSI solver was identified in the current Python files. Their stage notes therefore remain planned and must not imply that code already exists.

If a link does not open, confirm that Windows has registered the `vscode://` protocol and that VS Code is installed. A `vscode://file/...:line` link opens the file at its starting line; it does not preserve a multi-line highlight.
