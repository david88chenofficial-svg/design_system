import numpy as np
from scipy.optimize import bisect
import matplotlib.pyplot as plt

# Constants
gamma = 1.4
R = 287.05
T = 300
Cd = 0.7

# Geometry
dia_a = 0.12
dia_b = 0.165
dia_c = 0.0525*2 # Review this later! (To be optimised)
dia_d = 0.18
tooth_pitch = 0.003


class GammaSeal:
    def __init__(self, p_in=7e5, p_out_target=1e5, c=0.00015, axial_disp=0, teeth_a=8, teeth_b=5):
        self.p_in = p_in
        self.p_out_target = p_out_target
        self.c = c
        self.axial_disp = axial_disp
        self.teeth_a = teeth_a
        self.teeth_b = teeth_b

        # Critical pressure ratio for choking (Pi*), and matching y* = (Pi*)^((gamma-1)/gamma)
        self.critical_ratio = (2 / (gamma + 1)) ** (gamma / (gamma - 1))  # Pi*
        self.y_crit = 2 / (gamma + 1)  # y* because y = Pi^((gamma-1)/gamma)

        # Maximum beta achievable in unchoked regime occurs at Pi = Pi*
        # beta(Pi) = Pi^{2/gamma} - Pi^{(gamma+1)/gamma}
        Pi_star = self.critical_ratio
        self.beta_max = (Pi_star ** (2 / gamma)) - (Pi_star ** ((gamma + 1) / gamma))

        self.diameters = self._generate_diameters()
        self.mdot_solution = None
        self.pressures = None
        self.force_a = 0.0
        self.force_b = 0.0
        self.force_c = 0.0
        self.force_resultant = 0.0
        self.force_axial = None
        self.chamber_pressure = None

    def _generate_diameters(self):
        diameters_a = [dia_a + 0.001 + i * (tooth_pitch * 2) for i in range(self.teeth_a)]
        diameters_b = [dia_c + 0.001 + i * (tooth_pitch * 2) for i in range(self.teeth_b)]
        return diameters_a + diameters_b[::-1]

    def gap_areas(self):
        area_list = []
        for i, d in enumerate(self.diameters):
            if i < self.teeth_a:
                area_list.append(np.pi * d * (self.c + (self.axial_disp / 100) * self.c))
            else:
                area_list.append(np.pi * d * (self.c - (self.axial_disp / 100) * self.c))
        return area_list

    def _beta_from_mdot(self, p1, mdot, A):
        # beta = (mdot/(Cd*A*p1))^2 * R*T*(gamma-1)/(2*gamma)
        return ((mdot / (Cd * A * p1)) ** 2) * (R * T * (gamma - 1) / (2 * gamma))

    def _pressure_ratio_from_beta_unchoked(self, beta):
        """
        Solve y^{2/(gamma-1)}(1-y) = beta for y in (y_crit, 1),
        then Pi = y^{gamma/(gamma-1)}.
        """
        if beta <= 0.0:
            return 1.0  # no flow, no drop

        # If beta is above unchoked maximum, the solution would require Pi < Pi* (choked),
        # so we clamp at Pi* in caller.
        if beta >= self.beta_max:
            return self.critical_ratio

        a = self.y_crit + 1e-12
        b = 1.0 - 1e-12
        exp = 2.0 / (gamma - 1.0)

        def f(y):
            return (y ** exp) * (1.0 - y) - beta

        y = bisect(f, a, b, xtol=1e-12, maxiter=200)
        Pi = y ** (gamma / (gamma - 1.0))
        return Pi

    def next_pressure(self, p1, mdot, A):
        """
        Compute downstream pressure p2 given upstream pressure p1, mdot, and area A,
        using the correct inversion of the unchoked orifice relation.
        """
        beta = self._beta_from_mdot(p1, mdot, A)

        # Choked check via beta (equivalent to checking Pi <= Pi*)
        if beta >= self.beta_max:
            return p1 * self.critical_ratio

        Pi = self._pressure_ratio_from_beta_unchoked(beta)
        p2 = p1 * Pi

        # Safety clamp (should not trigger if logic above is consistent)
        p_crit = p1 * self.critical_ratio
        return max(p2, p_crit)

    def simulate_seal(self, mdot):
        p = self.p_in
        for A in self.gap_areas():
            p = self.next_pressure(p, mdot, A)
        return p

    def _objective(self, mdot):
        return self.simulate_seal(mdot) - self.p_out_target

    def _solve_mdot(self):
        lower = 0.0
        upper = 0.2
        f_lower = self._objective(lower)
        f_upper = self._objective(upper)
        for _ in range(60):
            if f_lower * f_upper <= 0.0:
                break
            upper *= 2.0
            f_upper = self._objective(upper)
        else:
            raise ValueError("Unable to bracket mass flow after 60 upper-bound expansions")
        self.mdot_solution = bisect(self._objective, lower, upper, xtol=1e-7, maxiter=200)

    def compute_pressures(self):
        self._solve_mdot()
        self.pressures = [self.p_in]
        p = self.p_in
        for A in self.gap_areas():
            p = self.next_pressure(p, self.mdot_solution, A)
            self.pressures.append(p)
        self.chamber_pressure = self.pressures[self.teeth_a]
        return self.pressures

    def plot_pressures(self):
        if self.pressures is None:
            raise ValueError("Run .compute_pressures() first to compute pressures.")
        pressures_bar = [p / 1e5 for p in self.pressures]
        plt.style.use('bmh')
        plt.figure(figsize=(8, 5))
        plt.plot(pressures_bar, marker='o')
        plt.axvline(x=self.teeth_a, color='red', linestyle='--', linewidth=1)
        plt.text(0, self.p_out_target/1e5, "\nGamma Seal\n"
                f"Clearance={self.c*1000}mm\n"
                f"Inlet Dia={dia_a*1000}mm, \nOutlet Dia={dia_c*1000}mm\n"
                f"Inlet teeth={self.teeth_a}, Outlet teeth={self.teeth_b}\n"
                f"Balance Pressure={round(self.chamber_pressure, 1)} Pa\n"
                f"Resultant Force={round(self.force_resultant, 1)}N", fontsize=9)

        plt.text(self.teeth_a, self.p_out_target/1e5, 'Seal Midpoint', rotation=90,
                 verticalalignment='bottom', horizontalalignment='right',
                 fontsize=10, color='red')
        plt.title(f'Pressure Distribution. Mass Flow Rate: {self.mdot_solution:.4f} kg/s')
        plt.xlabel('Seal Stages')
        plt.ylabel('Pressure (Bar)')
        plt.text(1, self.p_out_target, "Aligned text", fontsize=12)
        plt.grid(True)
        plt.show()

    
    def compute_force_a(self):
        """Compute the gauge force on the inlet side of the seal (F1)."""
        if self.pressures is None:
            raise ValueError("Run .compute_pressures() first to compute pressures.")
        # reset to avoid accumulation across calls
        self.force_a = 0.0
        inlet_dia = [dia_a] + self.diameters[0:self.teeth_a] + [dia_b]
        for i in range(len(inlet_dia) - 1):
            p_stage = self.pressures[i]  # upstream pressure for this annulus
            gauge_p = p_stage - self.p_out_target  # subtract outlet (1 bar) => gauge
            area = (np.pi * ((inlet_dia[i + 1] ** 2) - (inlet_dia[i] ** 2))) / 4
            self.force_a += gauge_p * area
        # print short summary
        #print(f"F1 (inlet gauge force): {self.force_a:.2f} N")
        return self.force_a

    def compute_force_b(self):
        """Compute the gauge force contribution due to pressures dropping through the outlet teeth (F2)."""
        if self.pressures is None:
            raise ValueError("Run .compute_pressures() first to compute pressures.")
        # reset to avoid accumulation across calls
        self.force_b = 0.0
        outlet_dia = self.diameters[self.teeth_a:] + [dia_c]
        # pressures for outlet segments start at index self.teeth_a in self.pressures
        for i in range(len(outlet_dia) - 1):
            p_stage = self.pressures[i + self.teeth_a]  # pressure acting on this annulus
            gauge_p = p_stage - self.p_out_target
            area = (np.pi * ((outlet_dia[i] ** 2) - (outlet_dia[i + 1] ** 2))) / 4
            self.force_b += gauge_p * area
        #print(f"F2 (outlet teeth gauge force): {self.force_b:.2f} N")
        return self.force_b

    def compute_force_c(self):
        """Compute the chamber balance gauge force (F_balance) using chamber pressure acting on
        the area between the rotor disk (dia_b) and the upper outlet tooth."""
        if self.pressures is None:
            raise ValueError("Run .compute_pressures() first to compute pressures.")
        # reset to avoid accumulation across calls
        self.force_c = 0.0
        # upper tooth in outlet side is at index teeth_a in self.diameters
        d_upper_outlet = self.diameters[self.teeth_a]
        area = (np.pi / 4) * (dia_b ** 2 - d_upper_outlet ** 2)
        gauge_chamber_p = self.chamber_pressure - self.p_out_target
        self.force_c = gauge_chamber_p * area
        #print(f"F_balance (chamber gauge force): {self.force_c:.2f} N")
        return self.force_c

    def compute_resultant_force(self):
        """Resultant is sum of the three gauge forces: F1 + F_balance + F2."""
        f1 = self.compute_force_a()
        f2 = self.compute_force_b()
        fbal = self.compute_force_c()
        self.force_resultant = fbal + f2 - f1
        # short output suppressed except result
        #print(f"Resultant gauge force: {self.force_resultant:.2f} N")
        return self.force_resultant
    

    
if __name__ == "__main__":

    # =============================================================
    # GEOMETRY — tooth diameters [m]
    # =============================================================

    # Stage 1 (fixed from experiment)
    stage1_diameters = [0.1502, 0.1562, 0.1622]   # r = 75.1, 78.1, 81.1 mm

    # Stage 2 (optimised — engage these two teeth only)
    stage2_pad_C6 = [0.0631*2, 0.0601*2, 0.0571*2]
    stage2_pad_C7 = [0.0661*2, 0.0631*2, 0.0601*2]
    stage2_diameters = stage2_pad_C7         

    # Combined series (Stage 1 → balancing chamber → Stage 2 descending)
    #stage2_diameters_desc = sorted(stage2_diameters, reverse=True)  # [0.1202, 0.0962]

    # Boundary conditions
    p_in  = 1.4e5   # Pa absolute
    p_out = 1.0e5   # Pa absolute (atmospheric)
    c     = 0.00015 # m  axial clearance (same both stages)

    seal = GammaSeal(
        p_in        = 1.4e5,
        p_out_target= 1.0e5,
        c           = 0.0002,
        axial_disp  = 0,
        teeth_a     = 3,   # Stage 1
        teeth_b     = 3,   # Stage 2
    )

    # Override the auto-generated diameters with your actual tooth positions
    seal.diameters = stage1_diameters + stage2_diameters

    # Solve
    seal.compute_pressures()
    seal.compute_resultant_force()

    # Results
    print("=" * 50)
    print("PRESSURE PROFILE")
    print("=" * 50)
    labels = (
        ["p_in"]
        + [f"after S1 tooth {i+1} (r={d*500:.1f}mm)" for i, d in enumerate(stage1_diameters)]
        + [f"after S2 tooth {i+1} (r={d*500:.1f}mm)" for i, d in enumerate(stage2_diameters)]
    )
    for label, p in zip(labels, seal.pressures):
        print(f"  {label:<35} {p/1e5:.4f} bar")

    print(f"\n  Chamber pressure (p1)          {seal.chamber_pressure/1e5:.4f} bar")
    print(f"  Mass flow rate                 {seal.mdot_solution*1e3:.4f} g/s")

    print("\n" + "=" * 50)
    print("FORCE BALANCE")
    print("=" * 50)
    print(f"  F1  (inlet stage, opposes)     {seal.force_a:+.3f} N")
    print(f"  F2  (outlet stage)             {seal.force_b:+.3f} N")
    print(f"  F_balance (chamber)            {seal.force_c:+.3f} N")
    print(f"  F_resultant                    {seal.force_resultant:+.4f} N")

    stage1_diameters     = [0.1502, 0.1562, 0.1622]
    

    stage2_diameters_desc = stage2_pad_C7

    axial_displacements = list(range(-90, 90, 1))
    forces_a, forces_b, forces_c, forces_res = [], [], [], []

    for disp in axial_displacements:
        seal = GammaSeal(
            p_in         = 1.4e5,
            p_out_target = 1.0e5,
            c            = 0.0002,
            axial_disp   = disp,
            teeth_a      = 3,
            teeth_b      = 3,
        )
        seal.diameters = stage1_diameters + stage2_diameters_desc
        seal.compute_pressures()
        seal.compute_resultant_force()

        forces_a.append(-seal.force_a)      # plotted negative (opposes)
        forces_b.append(seal.force_b)
        forces_c.append(seal.force_c)
        forces_res.append(seal.force_resultant)

    # --- Plot: all components ---
    plt.style.use('bmh')
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    ax = axes[0]
    ax.plot(axial_displacements, forces_a,   color='tomato',        linestyle='dotted',  linewidth=1.5, label='−F1: inlet force (opposes)')
    ax.plot(axial_displacements, forces_b,   color='cornflowerblue',linestyle='dashed',   linewidth=1.5, label='F2: outlet force')
    ax.plot(axial_displacements, forces_c,   color='mediumseagreen',linestyle='dashdot',  linewidth=1.5, label='F_balance: chamber force')
    ax.plot(axial_displacements, forces_res, color='black',         linestyle='solid',    linewidth=2.5, label='F_resultant')
    ax.axhline(0, color='k', linewidth=0.6)
    ax.axvline(0, color='gray', linewidth=0.6, linestyle='--')
    ax.set_xlabel('Rotor axial displacement (% of gap)')
    ax.set_ylabel('Axial force (N)')
    ax.set_title('All force components vs axial displacement')
    ax.legend(fontsize=8)
    ax.grid(True, linestyle='dotted', linewidth=0.7, alpha=0.7)

    # --- Plot: resultant only ---
    ax2 = axes[1]
    ax2.plot(axial_displacements, forces_res, color='navy', linewidth=2.5, label='F_resultant')
    ax2.axhline(0, color='k', linewidth=0.6)
    ax2.axvline(0, color='gray', linewidth=0.6, linestyle='--')
    ax2.set_xlabel('Rotor axial displacement (% of gap)')
    ax2.set_ylabel('Axial force (N)')
    ax2.set_title('Resultant force vs axial displacement')
    ax2.legend(fontsize=8)
    ax2.grid(True, linestyle='dotted', linewidth=0.7, alpha=0.7)

    # Annotate zero crossing
    ax2.annotate('Equilibrium at 0% disp',
                xy=(0, 0), xytext=(20, max(forces_res)*0.4),
                arrowprops=dict(arrowstyle='->', color='navy'),
                fontsize=9, color='navy')

    # Key parameters as text box
    info = (f"Stage 1: r = 75.1, 78.1, 81.1 mm\n"
            f"Stage 2: r = 48.1, 60.1 mm\n"
            f"p_in = 1.4 bar  |  p_out = 1.0 bar\n"
            f"clearance = 0.15 mm")
    ax2.text(0.02, 0.97, info, transform=ax2.transAxes, fontsize=8,
            verticalalignment='top',
            bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))

    plt.tight_layout()
    plt.show()

