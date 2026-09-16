# Seal Model Comparison Tool — User Manual

This desktop tool compares pressure distribution, mass flow, and resultant force for several two-stage radial labyrinth-seal models. It also supports per-tooth geometry and model-specific force balancing.

## 1. Requirements

Use Python 3.10 or newer. Install the required packages:

```powershell
py -m pip install -r "..\requirements.txt"
```

Tkinter is normally included with Python on Windows.

## 2. Start the tool

From the top-level `Design_System` folder, double-click:

```text
LAUNCH_GUI.pyw
```

Or run:

```powershell
py model_gui.py
```

## 3. Define the seal geometry

The GUI opens on **1. Seal geometry**.

Enter the main dimensions on the left:

Use the mouse wheel or the vertical scrollbar to move through the left input panel.

- Default clearance, mm
- Tooth-tip thickness, mm
- Default tooth pitch, mm
- First inlet diameter, mm
- Rotor-tip diameter, mm
- Final outlet diameter, mm
- Number of Stage 1 and Stage 2 teeth

The live diagram updates as the geometry changes.

### Add design constraints

Click **Add constraints...** to set:

- Minimum effective tooth clearance
- Maximum effective tooth clearance
- Maximum permitted Radius B
- Operating seal diameter
- Minimum first inlet diameter
- Minimum final outlet diameter

The operating diameter is applied to the rotor-tip diameter field. Clearance limits apply after axial displacement. The optional clamp setting moves any current out-of-range clearances to the middle of the permitted range so that optimisation can move in either direction.

Active clearance and minimum end-diameter limits are also used by the near-zero-force optimiser.

### Different clearance and pitch for each tooth

Click **Edit per-tooth clearances and pitches...**.

For each tooth, enter:

- **Clearance:** nominal clearance for that tooth
- **Pitch to next:** distance from that tooth to the next tooth

The final tooth in each stage does not require a pitch-to-next value.

Use **Fill all from default values** to return to uniform clearance and pitch.

## 4. Enter operating conditions

Set the inlet and outlet pressures, temperature, gas properties, discharge coefficient, carry-over factor, and axial displacement.

The inlet pressure must be greater than the outlet pressure.

## 5. Select and run models

Select any combination of:

- Gamma 1, 2, and 3
- Orifice
- Kearton
- Ueda
- Saurabh/Lanjewar

Click **Plot selected models**.

The results tab shows:

- Pressure distribution for every selected model
- Mass-flow rate in g/s
- Signed resultant stator force in N
- Equal-and-opposite rotor reaction in N

## 6. Find a near-zero-force geometry

Select the models and click **Find near-zero-force geometries**.

The optimiser runs each model separately. It can independently change:

- Every Stage 1 and Stage 2 tooth clearance
- Every pitch between adjacent teeth
- First inlet diameter
- Final outlet diameter

Tooth counts and rotor-tip diameter remain fixed. Clearance constraints from **Add constraints...** apply to every tooth. Pitch and diameter changes are bounded, and any geometry that places a tooth beyond the rotor tip is rejected.

One force target can have many possible geometries, so a small minimum-change penalty makes the optimiser prefer a near-zero-force design close to the geometry currently entered in the GUI.

The results window reports:

- Initial and optimised force
- Optimised mass flow
- Optimised first inlet and final outlet diameters
- Complete per-tooth geometry

Select a model and click **Apply selected geometry to GUI** to load its geometry. Then click **Plot selected models** to compare every model using that design.

The normal force target is within ±0.1 N. If zero cannot be reached within the permitted clearance range, the tool returns the geometry with the smallest force.

## 7. Save results

- **Save plot:** exports PNG, PDF, or SVG
- **Export CSV:** exports mass flow, force, geometry, and pressure data
- **Export optimization CSV:** exports all model-specific optimised geometries

## 8. Command-line use

Run all models with the default uniform geometry:

```powershell
python plot_all_models.py
```

This creates:

- `all_models_pressure_distribution.png`
- `all_models_pressure_distribution.csv`

## 9. Troubleshooting

The launcher displays an error dialog if a package is missing or the application
cannot start. For more detail, open PowerShell in this folder and run:

```powershell
py model_gui.py
```

This will display the error message.

If a module is missing, run:

```powershell
py -m pip install -r "..\requirements.txt"
```

If the geometry is rejected, check that all clearances are positive, every pitch exceeds the tooth-tip thickness, and no tooth extends beyond the rotor-tip diameter.

## Important note

This is an engineering investigation tool. Check results against the relevant theory, experimental data, manufacturing constraints, and safety requirements before using them for hardware decisions.
