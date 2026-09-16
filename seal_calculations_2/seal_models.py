"""
seal_models.py
==============
Low-order labyrinth seal leakage models:
  - Kearton (1955):      quasi-incompressible p^2 formulation for radial glands
  - Ueda & Kubo (1967):  adiabatic polytropic formulation with kinetic carry-over

Each model simulates the FULL two-stage seal (stage 1 outward, stage 2 inward)
with the coupled displacement: when stage 1 opens, stage 2 closes by the same
amount, exactly matching the GammaSeal convention.

Per-tooth clearances are applied individually to every tooth (not just A1),
so that pressure distributions respond correctly to axial displacement.

All plots show both stages concatenated on one axis, matching GammaSeal output.
"""

import numpy as np
from scipy.optimize import bisect
import matplotlib.pyplot as plt
from pathlib import Path
from gamma_seal_2 import GammaSeal

# ─────────────────────────────────────────────────────────────────────────────
# Shared geometry constants (must match gamma_seal_2.py)
# ─────────────────────────────────────────────────────────────────────────────
OUTPUT_DIR = Path(__file__).resolve().parent / 'outputs'
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
gamma       = 1.4
R           = 287.05      # J/(kg·K)
T           = 300.0       # K
dia_a       = 0.12        # m  — inlet inner wall (stage 1 base)
dia_b       = 0.165       # m  — rotor disk outer diameter
dia_c       = 0.0925      # m  — outlet inner wall (stage 2 base)
tooth_pitch = 0.003       # m  — half-pitch; centre spacing = 2*tooth_pitch


# ─────────────────────────────────────────────────────────────────────────────
# Helper: per-tooth areas with displacement (mirrors GammaSeal.gap_areas)
# ─────────────────────────────────────────────────────────────────────────────
def _stage1_areas(c, axial_disp, teeth_a):
    """
    Area at each stage-1 tooth with displacement applied individually.
    Stage 1 OPENS when axial_disp > 0.
    Returns list of length teeth_a.
    """
    diameters = [dia_a + 0.001 + i * (tooth_pitch * 2) for i in range(teeth_a)]
    c_eff = c * (1 + axial_disp / 100)
    return [np.pi * d * c_eff for d in diameters], diameters


def _stage2_areas(c, axial_disp, teeth_b):
    """
    Area at each stage-2 tooth with displacement applied individually.
    Stage 2 CLOSES when axial_disp > 0 (same sign convention as GammaSeal).
    Returns list of length teeth_b, largest-tooth-first (inward flow order).
    """
    diameters_asc = [dia_c + 0.001 + i * (tooth_pitch * 2) for i in range(teeth_b)]
    diameters = diameters_asc[::-1]          # largest first
    c_eff = c * (1 - axial_disp / 100)
    return [np.pi * d * c_eff for d in diameters], diameters


# ─────────────────────────────────────────────────────────────────────────────
# Kearton (1955) — full two-stage seal
# ─────────────────────────────────────────────────────────────────────────────
class KeartonSeal:
    """
    Kearton (1955) model for the full dual-stage radial labyrinth seal.

    Theory
    ------
    Isothermal ideal-gas orifice flow. The p^2 formulation is exact for
    isothermal flow and a good approximation when per-tooth drops are modest.
    Carry-over is neglected.

    With non-uniform clearance (displacement ≠ 0), the analytical phi_n
    formula (which assumes uniform clearance) is replaced by a numerical
    equivalent: the sum of inverse squared areas, which is what phi_n
    encodes. This gives the correct displacement sensitivity.

    Key formulae [Kearton eqs 6, 10 — converted to SI, generalised]
    ----------------------------------------------------------------
    Effective geometric sum:
        S = sum_{i=1}^{n}  1/A_i^2      (per-tooth, exact for any area sequence)

    Mass flow:
        w = C1 * sqrt( F * (p_in^2 - p_out^2) / (R*T*S*A1^2) )
          = C1/A1 * sqrt( F * (p_in^2 - p_out^2) / (R*T*S) )

    Intermediate pressure at tooth m:
        p_m^2 = p_in^2 - (R*T/F) * w^2 * sum_{i=1}^{m} 1/A_i^2

    Stage 2 inlet is the chamber pressure p1 from stage 1.
    Mass flow is conserved: same w flows through both stages.
    """

    def __init__(self, p_in=2e5, p_out_target=1e5, c=0.0002,
                 axial_disp=0, teeth_a=7, teeth_b=4, C1=0.7):
        self.p_in         = p_in
        self.p_out_target = p_out_target
        self.c            = c
        self.axial_disp   = axial_disp
        self.teeth_a      = teeth_a
        self.teeth_b      = teeth_b
        self.C1           = C1

        # Per-tooth areas for both stages
        self.areas_s1, self.diams_s1 = _stage1_areas(c, axial_disp, teeth_a)
        self.areas_s2, self.diams_s2 = _stage2_areas(c, axial_disp, teeth_b)

        # Inverse-square sums (Kearton's S)
        self._inv_sq_s1 = [1.0 / a**2 for a in self.areas_s1]
        self._inv_sq_s2 = [1.0 / a**2 for a in self.areas_s2]

        self.pressures      = None   # full seal: length teeth_a + teeth_b + 1
        self.chamber_pressure = None
        self.mdot           = None

    def _stage_mdot(self, p_up, p_down, inv_sq_list):
        """
        Mass flow through a stage given per-tooth inverse-square-area list.
        w = C1 * sqrt( F*(p_up^2-p_down^2) / (R*T * sum(1/Ai^2)) )
        F = geometric mean pressure ratio.
        """
        S = sum(inv_sq_list)
        F = np.sqrt(p_down / p_up)
        val = F * (p_up**2 - p_down**2) / (R * T * S)
        return self.C1 * np.sqrt(max(val, 0.0))

    def _stage_pressures(self, p_up, mdot, inv_sq_list, F):
        """
        Pressure after each tooth in a stage.
        p_m^2 = p_up^2 - (R*T/F)*w_theoretical^2 * cumulative_sum(1/Ai^2)

        Kearton's intermediate pressure formula is derived from the theoretical
        (ideal) mass flow, not the actual mass flow. C1 scales the actual mass
        flow reported but does not appear in the pressure distribution formula.
        Dividing mdot by C1 recovers the theoretical flow, guaranteeing that
        the last tooth reproduces p_out exactly.
        """
        pressures = [p_up]
        cumsum = 0.0
        w_theoretical = mdot / self.C1          # remove C1 to get ideal flow
        coeff  = (R * T / F) * w_theoretical**2
        for isq in inv_sq_list:
            cumsum += isq
            pm_sq = p_up**2 - coeff * cumsum
            pressures.append(np.sqrt(max(pm_sq, self.p_out_target**2)))
        return pressures

    def compute_pressures(self):
        """
        Solve the full two-stage seal.

        Algorithm:
          1. Bisect on chamber pressure p_ch to find the value where
             mass flow through stage 1 == mass flow through stage 2.
          2. Recover per-tooth pressure distributions for both stages.
        """
        p_in  = self.p_in
        p_out = self.p_out_target

        def mdot_residual(p_ch):
            w1 = self._stage_mdot(p_in,  p_ch,  self._inv_sq_s1)
            w2 = self._stage_mdot(p_ch,  p_out, self._inv_sq_s2)
            return w1 - w2

        # Chamber pressure must be between p_out and p_in
        try:
            p_ch = bisect(mdot_residual, p_out * 1.001, p_in * 0.9999, xtol=0.1)
        except ValueError:
            p_ch = np.sqrt(p_in * p_out)  # fallback: geometric mean

        self.chamber_pressure = p_ch
        w = self._stage_mdot(p_in, p_ch, self._inv_sq_s1)
        self.mdot = w

        # Stage 1 pressures
        F1 = np.sqrt(p_ch / p_in)
        ps1 = self._stage_pressures(p_in, w, self._inv_sq_s1, F1)

        # Stage 2 pressures
        F2 = np.sqrt(p_out / p_ch)
        ps2 = self._stage_pressures(p_ch, w, self._inv_sq_s2, F2)

        # Concatenate: share the chamber pressure point
        self.pressures = ps1 + ps2[1:]
        return self.pressures


# ─────────────────────────────────────────────────────────────────────────────
# Ueda & Kubo (1967) — full two-stage seal
# ─────────────────────────────────────────────────────────────────────────────
class UedaSeal:
    """
    Ueda & Kubo (1967) model for the full dual-stage radial labyrinth seal.

    Theory
    ------
    Fully compressible adiabatic (polytropic) formulation with carry-over.
    Per-tooth areas enter through F1, Fn (first and last tooth areas) and
    through the intermediate-pressure sub-gland calculation.

    For each stage:
      - First tooth: standard isentropic orifice (eq 17), no carry-over.
      - Remaining teeth: Ueda eq (15) applied as a sub-gland, with the
        LARGER root selected (physical, subsonic pressure distribution).

    The two stages are coupled through the chamber pressure p_ch:
    mass flow through stage 1 == mass flow through stage 2.
    A bisection on p_ch enforces this constraint.
    """

    def __init__(self, p_in=2e5, p_out_target=1e5, c=0.0002,
                 axial_disp=0, teeth_a=7, teeth_b=4, alpha=0.7, nu=0.0):
        self.p_in         = p_in
        self.p_out_target = p_out_target
        self.c            = c
        self.axial_disp   = axial_disp
        self.teeth_a      = teeth_a
        self.teeth_b      = teeth_b
        self.alpha        = alpha
        self.nu           = min(nu, 0.9999)
        self.kappa        = gamma

        self.areas_s1, self.diams_s1 = _stage1_areas(c, axial_disp, teeth_a)
        self.areas_s2, self.diams_s2 = _stage2_areas(c, axial_disp, teeth_b)

        self.Pi_crit = (2 / (gamma + 1)) ** (gamma / (gamma - 1))

        self.pressures        = None
        self.chamber_pressure = None
        self.mdot             = None

    # ── Single-tooth isentropic orifice ───────────────────────────────────────
    def _iso_mdot(self, F_area, p_up, p_down):
        k   = self.kappa
        r   = max(p_down / p_up, self.Pi_crit)
        val = r**(2/k) - r**((k+1)/k)
        if val <= 0:
            return 0.0
        return self.alpha * F_area * p_up * np.sqrt(2*k / ((k-1)*R*T) * val)

    def _p1_from_mdot(self, G, F_area, p_up, p_down_min):
        """Pressure after first tooth given mass flow G."""
        def res(p1):
            return self._iso_mdot(F_area, p_up, p1) - G
        try:
            return bisect(res, p_down_min * 1.0001, p_up * 0.9999, xtol=0.1)
        except ValueError:
            return p_up * 0.95

    # ── Ueda eq(15): direct mass flow given p1, pn, n teeth, areas ───────────
    def _ueda_direct(self, p1, pn, n_teeth, F1, Fn):
        """
        Direct evaluation of Ueda eq(15) in SI (zeta_m=1):
          G = (alpha/sqrt(1-nu^2)) * sqrt(F1*Fn) * (p1/sqrt(RT)) *
              sqrt( (1-(pn/p1)^2) / ((n-1) + (2/k)*(1/(1-nu^2))*ln(p1/pn)) )
        """
        nu = self.nu; k = self.kappa
        if pn >= p1 or p1 <= 0 or n_teeth < 2:
            return 0.0
        r        = pn / p1
        log_term = (2/k) * (1/(1-nu**2)) * np.log(1/r)
        denom    = (n_teeth - 1) + log_term
        if denom <= 0:
            return 0.0
        return ((self.alpha / np.sqrt(1-nu**2)) *
                np.sqrt(F1 * Fn) * (p1 / np.sqrt(R*T)) *
                np.sqrt((1 - r**2) / denom))

    # ── Stage mass flow (iterate p1 and G to self-consistency) ───────────────
    def _stage_mdot(self, p_up, p_down, areas):
        """
        Find self-consistent G and p1 for a stage via fixed-point iteration.
        Returns (G, p1).
        """
        F1 = areas[0]; Fn = areas[-1]; n = len(areas)
        if n == 1:
            G = self._iso_mdot(F1, p_up, p_down)
            return G, p_up

        # Start with p1 = p_up (no first-tooth drop), iterate twice
        p1 = p_up
        G  = self._ueda_direct(p1, p_down, n, F1, Fn)
        for _ in range(3):
            p1_new = self._p1_from_mdot(G, F1, p_up, p_down)
            G_new  = self._ueda_direct(p1_new, p_down, n, F1, Fn)
            if abs(G_new - G) / (G + 1e-12) < 1e-6:
                G, p1 = G_new, p1_new
                break
            G, p1 = G_new, p1_new
        return G, p1

    # ── Intermediate pressures via sub-gland approach ─────────────────────────
    def _stage_pressures(self, p_up, G, p1, p_floor, areas):
        """
        Full pressure list for a stage: [p_up, p1, p2, ..., pn].
        p_up  = inlet
        p1    = after first tooth (from isentropic)
        p2..n = from Ueda eq(15) sub-glands, taking the larger (physical) root.
        """
        nu = self.nu; k = self.kappa
        F1 = areas[0]
        pressures = [p_up, p1]

        for m in range(2, len(areas) + 1):
            Fm = areas[m - 1]
            X  = (G**2 * (1-nu**2) /
                  (self.alpha**2 * F1 * Fm * p1**2 / (R*T)))

            def f(r, _m=m, _X=X):
                if r <= 0 or r >= 1:
                    return 1e10
                lt = (2/k) * (1/(1-nu**2)) * np.log(1/r)
                return (1 - r**2) / ((_m - 1) + lt) - _X

            # Scan high→low r to find the larger (physical) root first
            r_scan = np.linspace(0.9999, 0.0001, 3000)
            f_vals = [f(r) for r in r_scan]
            pm = p_floor
            for i in range(len(f_vals) - 1):
                if f_vals[i] * f_vals[i+1] < 0:
                    try:
                        r_sol = bisect(f, r_scan[i+1], r_scan[i], xtol=1e-10)
                        pm = max(r_sol * p1, p_floor)
                    except ValueError:
                        pass
                    break   # take first (largest) root found
            pressures.append(pm)

        return pressures

    # ── Full seal solve ────────────────────────────────────────────────────────
    def compute_pressures(self):
        """
        Solve the full two-stage seal by bisecting on chamber pressure p_ch.
        """
        p_in  = self.p_in
        p_out = self.p_out_target

        def mdot_residual(p_ch):
            G1, _ = self._stage_mdot(p_in,  p_ch,  self.areas_s1)
            G2, _ = self._stage_mdot(p_ch,  p_out, self.areas_s2)
            return G1 - G2

        try:
            p_ch = bisect(mdot_residual, p_out * 1.001, p_in * 0.9999, xtol=0.1)
        except ValueError:
            p_ch = np.sqrt(p_in * p_out)

        self.chamber_pressure = p_ch
        G1, p1_s1 = self._stage_mdot(p_in,  p_ch,  self.areas_s1)
        G2, p1_s2 = self._stage_mdot(p_ch,  p_out, self.areas_s2)
        self.mdot = G1

        ps1 = self._stage_pressures(p_in,  G1, p1_s1, p_ch,  self.areas_s1)
        ps2 = self._stage_pressures(p_ch,  G2, p1_s2, p_out, self.areas_s2)

        self.pressures = ps1 + ps2[1:]
        return self.pressures


# ─────────────────────────────────────────────────────────────────────────────
# Comparison runner — all three models, full seal
# ─────────────────────────────────────────────────────────────────────────────
def run_comparison(p_in=2e5, p_out=1e5, c=0.0002, teeth_a=7, teeth_b=4,
                   axial_disp=0, nu=0.0, C1=0.7, alpha=0.7):
    """
    Run GammaSeal (orifice-flow), KeartonSeal, and UedaSeal at one operating
    point. Returns a dict with full pressure lists and mass flows.
    """
    gs = GammaSeal(p_in=p_in, p_out_target=p_out, c=c,
                   axial_disp=axial_disp, teeth_a=teeth_a, teeth_b=teeth_b)
    gs.compute_pressures()

    ks = KeartonSeal(p_in=p_in, p_out_target=p_out, c=c,
                     axial_disp=axial_disp, teeth_a=teeth_a, teeth_b=teeth_b, C1=C1)
    ks.compute_pressures()

    us = UedaSeal(p_in=p_in, p_out_target=p_out, c=c,
                  axial_disp=axial_disp, teeth_a=teeth_a, teeth_b=teeth_b,
                  alpha=alpha, nu=nu)
    us.compute_pressures()

    return {
        'orifice':   gs.pressures,
        'kearton':   ks.pressures,
        'ueda':      us.pressures,
        'mdot_orifice':  gs.mdot_solution,
        'mdot_kearton':  ks.mdot,
        'mdot_ueda':     us.mdot,
        'p_ch_orifice':  gs.chamber_pressure,
        'p_ch_kearton':  ks.chamber_pressure,
        'p_ch_ueda':     us.chamber_pressure,
        'teeth_a':   teeth_a,
        'teeth_b':   teeth_b,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Plotting helpers
# ─────────────────────────────────────────────────────────────────────────────
_COL = {
    'Orifice-flow':      '#2c7bb6',
    'Kearton (1955)':    '#d7191c',
    'Ueda & Kubo (1967)':'#1a9641',
}

def _stage_divider(ax, teeth_a):
    """Draw a vertical dashed line at the stage 1/2 boundary."""
    ax.axvline(x=teeth_a, color='gray', linestyle=':', linewidth=1.0, alpha=0.7)
    ax.text(teeth_a + 0.1, ax.get_ylim()[0] + 0.02,
            '← S1 | S2 →', fontsize=7, color='gray', va='bottom')


def _x_labels(teeth_a, teeth_b):
    """X-axis tick labels spanning both stages."""
    total = teeth_a + teeth_b + 1
    labels = (
        ['inlet'] +
        [f'S1T{i}' for i in range(1, teeth_a + 1)] +
        [f'S2T{i}' for i in range(1, teeth_b + 1)]
    )
    return list(range(total)), labels


def _plot_full_seal(ax, res, disp_label, teeth_a):
    """Plot all three models on one axis for a given displacement."""
    n = len(res['orifice'])
    xs = list(range(n))
    ax.plot(xs, [p/1e5 for p in res['orifice']],
            'o-',  color=_COL['Orifice-flow'],
            label=f"Orifice  ṁ={res['mdot_orifice']*1e3:.3f} g/s")
    ax.plot(xs, [p/1e5 for p in res['kearton']],
            's--', color=_COL['Kearton (1955)'],
            label=f"Kearton  ṁ={res['mdot_kearton']*1e3:.3f} g/s")
    ax.plot(xs, [p/1e5 for p in res['ueda']],
            '^-.', color=_COL['Ueda & Kubo (1967)'],
            label=f"Ueda  ṁ={res['mdot_ueda']*1e3:.3f} g/s")

    # Mark chamber pressure points
    ax.axhline(res['p_ch_orifice']/1e5, color=_COL['Orifice-flow'],
               linestyle=':', linewidth=0.8, alpha=0.5)
    ax.axhline(res['p_ch_kearton']/1e5, color=_COL['Kearton (1955)'],
               linestyle=':', linewidth=0.8, alpha=0.5)
    ax.axhline(res['p_ch_ueda']/1e5,    color=_COL['Ueda & Kubo (1967)'],
               linestyle=':', linewidth=0.8, alpha=0.5)

    ax.axvline(x=teeth_a, color='gray', linestyle=':', linewidth=1.2)
    ax.set_title(disp_label, fontsize=10)
    ax.set_ylabel('Pressure (bar)')
    ax.set_xlabel('Seal stage')
    ax.set_xticks(list(range(n)))
    ax.set_xticklabels(
        ['in'] + [f'{i}' for i in range(1, teeth_a+1)] +
        [f'{i}' for i in range(1, res['teeth_b']+1)],
        fontsize=7
    )
    ax.text(teeth_a/2, ax.get_ylim()[0] + 0.03, 'Stage 1 →',
            fontsize=7, color='gray', ha='center')
    ax.text(teeth_a + res['teeth_b']/2, ax.get_ylim()[0] + 0.03, '← Stage 2',
            fontsize=7, color='gray', ha='center')
    ax.legend(fontsize=8)
    ax.grid(True, linestyle='dotted', alpha=0.6)


# ─────────────────────────────────────────────────────────────────────────────
# Plot 1: central position comparison + mass flow bar chart
# ─────────────────────────────────────────────────────────────────────────────
def plot_comparison(p_in=2e5, p_out=1e5, c=0.0002, teeth_a=7, teeth_b=4,
                    axial_disp=0, nu=0.0, C1=0.7, alpha=0.7):
    """
    Two-panel figure:
      Left  — full seal pressure distribution (both stages on one axis)
      Right — mass flow bar chart
    """
    res = run_comparison(p_in, p_out, c, teeth_a, teeth_b,
                         axial_disp, nu, C1, alpha)

    plt.style.use('bmh')
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    fig.suptitle(
        f'Model comparison  |  $p_{{in}}$={p_in/1e5:.1f} bar, '
        f'$c$={c*1e3:.3f} mm, disp={axial_disp}%, $\\nu$={nu}',
        fontsize=11
    )

    # Panel 1: full seal pressure distribution
    _plot_full_seal(axes[0], res,
                    f'Full seal pressure distribution (disp={axial_disp}%)',
                    teeth_a)

    # Panel 2: mass flow bars
    ax   = axes[1]
    labs = ['Orifice-flow', 'Kearton (1955)', 'Ueda & Kubo (1967)']
    vals = [res['mdot_orifice'], res['mdot_kearton'], res['mdot_ueda']]
    cols = [_COL[l] for l in labs]
    bars = ax.bar(labs, [v*1e3 for v in vals], color=cols,
                  alpha=0.85, edgecolor='k', linewidth=0.5)
    ax.bar_label(bars, fmt='%.4f g/s', fontsize=9, padding=3)
    ax.set_ylabel('Mass flow (g/s)')
    ax.set_title('Mass flow comparison')
    ax.tick_params(axis='x', labelsize=9)
    ax.grid(True, axis='y', linestyle='dotted', alpha=0.7)

    # Annotate chamber pressures
    txt = (f"Chamber pressure:\n"
           f"  Orifice:  {res['p_ch_orifice']/1e5:.4f} bar\n"
           f"  Kearton:  {res['p_ch_kearton']/1e5:.4f} bar\n"
           f"  Ueda:     {res['p_ch_ueda']/1e5:.4f} bar")
    axes[0].text(0.02, 0.02, txt, transform=axes[0].transAxes,
                 fontsize=7, verticalalignment='bottom',
                 bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.4))

    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / 'model_comparison.png',
                dpi=150, bbox_inches='tight')
    plt.show()

    # Console summary
    print("\n" + "="*55)
    print(f"{'Model':<24} {'mdot (g/s)':>8}  {'p_ch (bar)':>10}")
    print("="*55)
    for name, mdot, pch in [
        ('Orifice-flow',       res['mdot_orifice'],  res['p_ch_orifice']),
        ('Kearton (1955)',     res['mdot_kearton'],  res['p_ch_kearton']),
        ('Ueda & Kubo (1967)', res['mdot_ueda'],     res['p_ch_ueda']),
    ]:
        print(f"{name:<24} {mdot*1e3:>8.4f}  {pch/1e5:>10.4f}")
    print("="*55)
    return res


# ─────────────────────────────────────────────────────────────────────────────
# Plot 2: displacement sweep — full seal, three displacements, three models
# ─────────────────────────────────────────────────────────────────────────────
def plot_displacement_sweep(p_in=2e5, p_out=1e5, c=0.0002,
                             teeth_a=7, teeth_b=4, nu=0.0):
    """
    3×3 panel grid:
      Rows    — model (Orifice, Kearton, Ueda)
      Columns — displacement (-60%, 0%, +60%)
    Each panel shows the FULL seal (both stages) pressure distribution.
    """
    displacements = [-60, 0, 60]
    d_col  = ['#d7191c', '#000000', '#1a9641']
    d_lbl  = ['disp = −60%', 'disp = 0%', 'disp = +60%']
    model_keys = ['orifice', 'kearton', 'ueda']
    model_names = ['Orifice-flow', 'Kearton (1955)', 'Ueda & Kubo (1967)']

    plt.style.use('bmh')
    fig, axes = plt.subplots(3, 3, figsize=(16, 12), sharey=True)
    fig.suptitle(
        f'Full seal pressure distribution — 3 models × 3 displacements\n'
        f'$p_{{in}}$={p_in/1e5:.1f} bar, $c$={c*1e3:.3f} mm',
        fontsize=12
    )

    # Pre-compute all results
    results = {d: run_comparison(p_in, p_out, c, teeth_a, teeth_b,
                                  axial_disp=d, nu=nu)
               for d in displacements}

    for row, (mkey, mname) in enumerate(zip(model_keys, model_names)):
        for col, (disp, dlbl, dcol) in enumerate(zip(displacements, d_lbl, d_col)):
            ax  = axes[row][col]
            res = results[disp]
            ps  = res[mkey]
            xs  = list(range(len(ps)))

            ax.plot(xs, [p/1e5 for p in ps], 'o-',
                    color=dcol,
                    label=f"ṁ={res[f'mdot_{mkey}']*1e3:.3f} g/s")
            ax.axvline(x=teeth_a, color='gray', linestyle=':', linewidth=1.0)

            if row == 0:
                ax.set_title(dlbl, fontsize=10)
            if col == 0:
                ax.set_ylabel(f'{mname}\nPressure (bar)', fontsize=9)
            if row == 2:
                ax.set_xlabel('Tooth index', fontsize=9)

            ax.set_xticks(xs)
            ax.set_xticklabels(
                ['in'] + [str(i) for i in range(1, teeth_a+1)] +
                [str(i) for i in range(1, teeth_b+1)],
                fontsize=7
            )
            ax.legend(fontsize=8, loc='upper right')
            ax.grid(True, linestyle='dotted', alpha=0.6)

            # Stage labels on bottom row
            if row == 2:
                ylim = ax.get_ylim()
                ax.text(teeth_a/2, ylim[0] + 0.03, '← S1',
                        fontsize=7, color='gray', ha='center')
                ax.text(teeth_a + teeth_b/2, ylim[0] + 0.03, 'S2 →',
                        fontsize=7, color='gray', ha='center')

    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / 'displacement_sweep.png',
                dpi=150, bbox_inches='tight')
    plt.show()


# ─────────────────────────────────────────────────────────────────────────────
# Plot 3: three displacements overlaid, one panel per model
# ─────────────────────────────────────────────────────────────────────────────
def plot_displacement_overlay(p_in=2e5, p_out=1e5, c=0.0002,
                               teeth_a=7, teeth_b=4, nu=0.0):
    """
    1×3 panel figure matching the style of GammaSeal plots:
    Each panel shows one model with three displacements overlaid.
    This makes the sensitivity to displacement immediately visible
    and directly comparable between models.
    """
    displacements = [-60, 0, 60]
    d_col  = ['#d7191c', '#000000', '#1a9641']
    d_lbl  = ['disp = −60%', 'disp = 0%', 'disp = +60%']
    model_keys  = ['orifice', 'kearton', 'ueda']
    model_names = ['Orifice-flow', 'Kearton (1955)', 'Ueda & Kubo (1967)']

    plt.style.use('bmh')
    fig, axes = plt.subplots(1, 3, figsize=(17, 5), sharey=True)
    fig.suptitle(
        f'Full seal — 3 rotor positions overlaid\n'
        f'$p_{{in}}$={p_in/1e5:.1f} bar, $c$={c*1e3:.3f} mm, $\\nu$={nu}',
        fontsize=11
    )

    n_total = teeth_a + teeth_b + 1
    xs = list(range(n_total))
    xlabels = (
        ['in'] +
        [str(i) for i in range(1, teeth_a+1)] +
        [str(i) for i in range(1, teeth_b+1)]
    )

    for ax, mkey, mname in zip(axes, model_keys, model_names):
        for disp, col, lbl in zip(displacements, d_col, d_lbl):
            res = run_comparison(p_in, p_out, c, teeth_a, teeth_b,
                                  axial_disp=disp, nu=nu)
            ps = res[mkey]
            ax.plot(xs, [p/1e5 for p in ps], 'o-', color=col,
                    label=f"{lbl}  ṁ={res[f'mdot_{mkey}']*1e3:.3f} g/s")

        ax.axvline(x=teeth_a, color='gray', linestyle=':', linewidth=1.2)
        ax.set_title(mname, fontsize=10)
        ax.set_xlabel('Tooth index')
        ax.set_xticks(xs)
        ax.set_xticklabels(xlabels, fontsize=7)
        ax.legend(fontsize=8)
        ax.grid(True, linestyle='dotted', alpha=0.6)

        # Annotate stage boundary
        ylim = ax.get_ylim()
        ax.text(teeth_a/2, ylim[0] + 0.02, '← Stage 1',
                fontsize=7, color='gray', ha='center')
        ax.text(teeth_a + teeth_b/2 + 0.5, ylim[0] + 0.02, 'Stage 2 →',
                fontsize=7, color='gray', ha='center')

    axes[0].set_ylabel('Pressure (bar)')
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / 'displacement_overlay.png',
                dpi=150, bbox_inches='tight')
    plt.show()


# ─────────────────────────────────────────────────────────────────────────────
# Plot 4: carry-over sensitivity
# ─────────────────────────────────────────────────────────────────────────────
def plot_nu_sensitivity(p_in=2e5, p_out=1e5, c=0.0002,
                         teeth_a=7, teeth_b=4):
    """
    Left  — full seal pressure distribution for Ueda at nu=0, 0.1, 0.2, 0.3
            vs orifice-flow and Kearton.
    Right — mass flow vs nu for all three models.
    """
    nu_vals  = [0.0, 0.1, 0.2, 0.3]
    nu_cols  = ['#1a9641', '#74c476', '#31a354', '#006d2c']

    plt.style.use('bmh')
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    fig.suptitle(
        f'Carry-over sensitivity  |  $p_{{in}}$={p_in/1e5:.1f} bar, '
        f'$c$={c*1e3:.3f} mm',
        fontsize=11
    )

    res_ref = run_comparison(p_in, p_out, c, teeth_a, teeth_b, axial_disp=0, nu=0)
    n = len(res_ref['orifice'])
    xs = list(range(n))

    ax = axes[0]
    ax.plot(xs, [p/1e5 for p in res_ref['orifice']], 'o-',
            color=_COL['Orifice-flow'], lw=2,
            label=f"Orifice-flow  ṁ={res_ref['mdot_orifice']*1e3:.3f} g/s")
    ax.plot(xs, [p/1e5 for p in res_ref['kearton']], 's--',
            color=_COL['Kearton (1955)'],
            label=f"Kearton (ν=0)  ṁ={res_ref['mdot_kearton']*1e3:.3f} g/s")
    for nu, col in zip(nu_vals, nu_cols):
        res = run_comparison(p_in, p_out, c, teeth_a, teeth_b, axial_disp=0, nu=nu)
        ax.plot(xs, [p/1e5 for p in res['ueda']], '^-.',
                color=col,
                label=f"Ueda ν={nu}  ṁ={res['mdot_ueda']*1e3:.3f} g/s")
    ax.axvline(x=teeth_a, color='gray', linestyle=':', linewidth=1.2)
    ax.set_xlabel('Tooth index'); ax.set_ylabel('Pressure (bar)')
    ax.set_title('Full seal: carry-over sensitivity')
    ax.legend(fontsize=8); ax.grid(True, linestyle='dotted', alpha=0.6)
    ax.set_xticks(xs)
    ax.set_xticklabels(
        ['in'] + [str(i) for i in range(1, teeth_a+1)] +
        [str(i) for i in range(1, teeth_b+1)], fontsize=7
    )

    ax = axes[1]
    mdots_u = [run_comparison(p_in, p_out, c, teeth_a, teeth_b,
                               axial_disp=0, nu=nv)['mdot_ueda']*1e3
               for nv in nu_vals]
    ax.plot(nu_vals, mdots_u, 'o-', color=_COL['Ueda & Kubo (1967)'],
            label='Ueda & Kubo', lw=2)
    ax.axhline(res_ref['mdot_orifice']*1e3, linestyle='--',
               color=_COL['Orifice-flow'], label='Orifice-flow')
    ax.axhline(res_ref['mdot_kearton']*1e3, linestyle=':',
               color=_COL['Kearton (1955)'], label='Kearton')
    ax.set_xlabel('Carry-over factor ν'); ax.set_ylabel('Mass flow (g/s)')
    ax.set_title('Effect of carry-over on leakage')
    ax.legend(fontsize=9); ax.grid(True, linestyle='dotted', alpha=0.6)

    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / 'nu_sensitivity.png',
                dpi=150, bbox_inches='tight')
    plt.show()

def plot_model_quartet(p_in=2e5, p_out=1e5, c=0.00015, teeth_a=7, teeth_b=4,
                       axial_disp=0):
    """
    Single plot with 4 lines:
      1. Orifice-flow
      2. Kearton (1955)
      3. Ueda & Kubo  ν=0.0
      4. Ueda & Kubo  ν=0.2
    """
    # Run models
    res       = run_comparison(p_in, p_out, c, teeth_a, teeth_b, axial_disp=axial_disp, nu=0.0)
    res_u02   = run_comparison(p_in, p_out, c, teeth_a, teeth_b, axial_disp=axial_disp, nu=0.2)

    n      = len(res['orifice'])
    xs     = list(range(n))
    xlabels = (['in']
               + [str(i) for i in range(1, teeth_a + 1)]
               + [str(i) for i in range(1, teeth_b + 1)])

    lines = [
        (res['orifice'],    res['mdot_orifice'],        'Orifice-flow',       '#2c7bb6', 'o', '-'),
        (res['kearton'],    res['mdot_kearton'],        'Kearton',      '#d7191c', 's', '--'),
        (res['ueda'],       res['mdot_ueda'],           'Ueda & Kubo  ν=0.0', '#1a9641', '^', '-.'),
        (res_u02['ueda'],   res_u02['mdot_ueda'],       'Ueda & Kubo  ν=0.2', '#f4a11d', 'D', ':'),
    ]

    #plt.style.use('bmh')
    fig, ax = plt.subplots(figsize=(10, 5))

    for pressures, mdot, label, color, marker, ls in lines:
        ax.plot(xs, [p / 1e5 for p in pressures],
                marker=marker, linestyle=ls, color=color, linewidth=1.8,
                markersize=5, label=f'{label} ')

    ax.axvline(x=teeth_a, color='gray', linestyle=':', linewidth=1.2)
    ylim = ax.get_ylim()
    ax.text(teeth_a / 2,           ylim[0] + 0.02, 'Stage 1', fontsize=14, color='gray', ha='center')
    ax.text(teeth_a + teeth_b / 2, ylim[0] + 0.02, 'Stage 2', fontsize=14, color='gray', ha='center')

    ax.set_xticks(xs)
    ax.set_xticklabels(xlabels, fontsize=14)
    ax.set_xlabel('Tooth index', fontsize=14)
    ax.set_ylabel('Pressure Ratio', fontsize=14)
    ax.set_title('Model comparison', fontsize=14)
    #ax.set_title(f'Model comparison  |  $p_{{in}}$={p_in/1e5:.1f} bar  '
                 #f'$c$={c*1e3:.3f} mm  disp={axial_disp}%')
    ax.legend(fontsize=14)
    ax.grid(True, linestyle='dotted', linewidth=0.7, alpha=0.7)

    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / 'model_quartet.png', dpi=150, bbox_inches='tight')
    plt.show()

def back_calculate_cd(p0_meas, p1_meas, c, teeth_a=7, teeth_b=4,
                      p_out=1e5, cd_bounds=(0.3, 1.2), tol=1e-6):
    """
    Back-calculate the effective discharge coefficient Cd from a single
    steady-state experimental measurement (p0, p1).

    Finds the Cd value such that the orifice-flow model predicts a chamber
    pressure matching p1_meas, given p0_meas as the inlet boundary condition.

    Parameters
    ----------
    p0_meas   : float  — measured inlet pressure, Pa
    p1_meas   : float  — measured chamber pressure at equilibrium, Pa
    c         : float  — nominal clearance, m
    teeth_a   : int    — number of stage 1 teeth
    teeth_b   : int    — number of stage 2 teeth
    p_out     : float  — outlet pressure (atmospheric), Pa
    cd_bounds : tuple  — (lower, upper) bounds for Cd bisection
    tol       : float  — convergence tolerance on Cd

    Returns
    -------
    cd_cal    : float  — calibrated Cd value
    p1_model  : float  — model p1 at calibrated Cd (should match p1_meas)
    mdot_cal  : float  — mass flow at calibrated Cd, kg/s
    """
    def _p1_from_cd(cd_trial):
        import gamma_seal_2 as gs_module
        original_cd = gs_module.Cd
        gs_module.Cd = cd_trial
        try:
            gs = GammaSeal(
                p_in=p0_meas,
                p_out_target=p_out,
                c=c,
                axial_disp=0,
                teeth_a=teeth_a,
                teeth_b=teeth_b
            )
            gs.compute_pressures()
            return gs.chamber_pressure
        finally:
            gs_module.Cd = original_cd

    def residual(cd_trial):
        return _p1_from_cd(cd_trial) - p1_meas

    res_lo = residual(cd_bounds[0])
    res_hi = residual(cd_bounds[1])

    if res_lo * res_hi > 0:
        cd_cal = cd_bounds[0] if abs(res_lo) < abs(res_hi) else cd_bounds[1]
    else:
        cd_cal = bisect(residual, cd_bounds[0], cd_bounds[1], xtol=tol)

    p1_model = _p1_from_cd(cd_cal)

    import gamma_seal_2 as gs_module
    original_cd = gs_module.Cd
    gs_module.Cd = cd_cal
    try:
        gs_final = GammaSeal(p_in=p0_meas, p_out_target=p_out, c=c,
                             axial_disp=0, teeth_a=teeth_a, teeth_b=teeth_b)
        gs_final.compute_pressures()
        mdot_cal = gs_final.mdot_solution
    finally:
        gs_module.Cd = original_cd

    return cd_cal, p1_model, mdot_cal


def back_calculate_cd_dataset(p0_array, p1_array, c_array,
                               teeth_a=7, teeth_b=4, p_out=1e5):
    """
    Back-calculate Cd for an array of steady-state experimental measurements.

    Parameters
    ----------
    p0_array  : array-like — measured inlet pressures, Pa
    p1_array  : array-like — measured chamber pressures, Pa
    c_array   : array-like — clearance for each measurement, m
                             (scalar accepted, applied to all measurements)
    teeth_a   : int
    teeth_b   : int
    p_out     : float

    Returns
    -------
    results   : dict with keys:
                  'cd'       — array of calibrated Cd values
                  'p1_model' — array of model p1 at calibrated Cd, Pa
                  'mdot'     — array of calibrated mass flows, kg/s
                  'p0'       — input p0 array, Pa
                  'p1_meas'  — input p1 array, Pa
                  'clearance'— clearance array, m
                  'cd_mean'  — mean Cd across all measurements
                  'cd_std'   — standard deviation of Cd
                  'residual' — array of (p1_model - p1_meas), Pa
    """
    import numpy as np
    p0_array = np.atleast_1d(np.asarray(p0_array, dtype=float))
    p1_array = np.atleast_1d(np.asarray(p1_array, dtype=float))
    c_array  = np.broadcast_to(
                   np.atleast_1d(np.asarray(c_array, dtype=float)),
                   p0_array.shape).copy()

    cd_vals   = np.zeros(len(p0_array))
    p1_model  = np.zeros(len(p0_array))
    mdot_vals = np.zeros(len(p0_array))

    for i, (p0, p1, c) in enumerate(zip(p0_array, p1_array, c_array)):
        cd_vals[i], p1_model[i], mdot_vals[i] = back_calculate_cd(
            p0, p1, c, teeth_a=teeth_a, teeth_b=teeth_b, p_out=p_out)

    return {
        'cd':        cd_vals,
        'p1_model':  p1_model,
        'mdot':      mdot_vals,
        'p0':        p0_array,
        'p1_meas':   p1_array,
        'clearance': c_array,
        'cd_mean':   float(np.mean(cd_vals)),
        'cd_std':    float(np.std(cd_vals)),
        'residual':  p1_model - p1_array,
    }





# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    """
    print("── Central comparison ──────────────────────────────────────────")
    plot_comparison(p_in=2e5, p_out=1e5, c=0.00015, teeth_a=7, teeth_b=4,
                    axial_disp=0, nu=0.0)

    print("\n── Displacement overlay (GammaSeal-style) ──────────────────────")
    plot_displacement_overlay(p_in=2e5, p_out=1e5, c=0.00015,
                               teeth_a=7, teeth_b=4, nu=0.0)

    print("\n── Carry-over sensitivity ──────────────────────────────────────")
    plot_nu_sensitivity(p_in=2e5, p_out=1e5, c=0.00015,
                         teeth_a=7, teeth_b=4)
    
    plot_model_quartet(p_in=2e5, p_out=1e5, c=0.00015, teeth_a=7, teeth_b=4, axial_disp=0)
    

    cd, p1_model, mdot = back_calculate_cd(
    p0_meas = 2e5,    # your measured p0 in Pa (e.g. 2.1 bar = 2.1e5 Pa)
    p1_meas = 1.7e5,   # your measured p1 in Pa
    c       = 0.0002,   # clearance in metres (0.2 mm)
    )

    print(f"Calibrated Cd  = {cd:.4f}")
    print(f"Model p1       = {p1_model/1e5:.4f} bar")
    print(f"Mass flow      = {mdot*1e3:.4f} g/s")
    """

    plot_model_quartet(p_in=2e5, p_out=1e5, c=0.00015, teeth_a=7, teeth_b=4, axial_disp=0)
