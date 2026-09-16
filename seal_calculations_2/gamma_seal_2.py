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
dia_c = 0.0925
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

    try_a = 7
    try_b = 0

    # Create three seals with axial_disp = -60, 0, 60
    left_seal = GammaSeal(p_in=2e5, p_out_target=1e5, c=0.00015, axial_disp=-60,
                        teeth_a=try_a, teeth_b=try_b)
    central_seal = GammaSeal(p_in=2e5, p_out_target=1e5, c=0.00015, axial_disp=0,
                            teeth_a=try_a, teeth_b=try_b)
    right_seal = GammaSeal(p_in=2e5, p_out_target=1e5, c=0.00015, axial_disp=60,
                        teeth_a=try_a, teeth_b=try_b)

    # Compute pressures for each seal
    for seal in (left_seal, central_seal, right_seal):
        seal.compute_pressures()

    # Plot all three pressure distributions on the same graph
    plt.style.use('bmh')
    plt.figure(figsize=(9, 5))

    stages = list(range(len(left_seal.pressures)))  # same length for all seals

    plt.plot([p / 1e5 for p in left_seal.pressures], color = "red", marker='o',
            label=f'Left (Displacement={left_seal.axial_disp}%)')
    plt.plot([p / 1e5 for p in central_seal.pressures], color = "black", marker='o',
            label=f'Central (Displacement={central_seal.axial_disp}%)')
    plt.plot([p / 1e5 for p in right_seal.pressures], color = "green", marker='o',
            label=f'Right (Displacement={right_seal.axial_disp}%)')

    # Mark seal midpoint (chamber) line
    #plt.axvline(x=central_seal.teeth_a, color='blue', linestyle='--', linewidth=1)

    # Ensure every stage is labeled on the x-axis
    plt.xticks(stages, [str(s) for s in stages])

    # Add horizontal padding so there's space before the first and after the last marker
    plt.xlim(stages[0] - 0.5, stages[-1] + 0.5)

    plt.xlabel('Seal Stage')
    plt.ylabel('Pressure (bar)')
    plt.title('Pressure Distribution for Different Axial Displacements')
    plt.legend()
    plt.grid(True, linestyle='dotted', linewidth=0.7, color='gray', alpha=0.7)
    plt.show()


    # New block: compute axial forces vs axial displacement and plot force_a (F1), force_b (F2),
    # force_c (F_balance) and resultant. Include +99.
    axial_displacements = list(range(-99, 100, 1))
    forces_a = []
    forces_b = []
    forces_c = []
    forces_res = []

    for disp in axial_displacements:
        seal = GammaSeal(p_in=2e5, p_out_target=1e5, c=0.00015, axial_disp=disp,
                        teeth_a=try_a, teeth_b=try_b)
        seal.compute_pressures()
        fa = seal.compute_force_a()
        fb = seal.compute_force_b()
        fc = seal.compute_force_c()
        # F1 acts opposite to F_balance and F2, so subtract F1 when forming resultant
        fres = -fa + fc + fb
        # update internal resultant too
        seal.force_resultant = fres
        # plot F1 as negative (acts opposite) while keeping stored force_a positive
        forces_a.append(-fa)
        forces_b.append(fb)
        forces_c.append(fc)
        forces_res.append(fres)

    plt.figure(figsize=(10,6))
    plt.plot(axial_displacements, forces_a, label='F1: Inlet Force', color = "red", linestyle = "dotted")
    plt.plot(axial_displacements, forces_b, label='F2: Outlet Force', color = "blue", linestyle = "dashed")
    plt.plot(axial_displacements, forces_c, label='F_balance: Balancing Chamber Force', color = "green", linestyle = "dashdot")
    plt.plot(axial_displacements, forces_res, label='Resultant Force', color='black', linewidth=3, linestyle='solid')

    plt.xlabel('Rotor Axial Displacement (% of axial gap)')
    plt.ylabel('Axial Force (N)')
    plt.title('Axial Forces vs Rotor Axial Displacement')
    plt.legend()
    plt.grid(True, linestyle='dotted', linewidth=0.7, color='gray', alpha=0.7)
    plt.axhline(0, color='k', linewidth=0.6)
    plt.show()

    plt.figure(figsize=(10,6))
    plt.plot(axial_displacements, forces_res, label='Resultant Force', color='blue', linewidth=3, linestyle='solid')
    plt.xlabel('Rotor Axial Displacement (% of axial gap)')
    plt.ylabel('Axial Force (N)')   
    plt.title('Resultant Axial Force vs Rotor Axial Displacement')
    plt.legend()
    plt.grid(True, linestyle='dotted', linewidth=0.7, color='gray', alpha=0.7)
    plt.axhline(0, color='k', linewidth=0.6)
    plt.show()
    """
    print(seal.diameters)
    seal.compute_pressures()
    print("Chamber Pressure:", round(seal.chamber_pressure, 1), "Pa")
    seal.compute_resultant_force()
    print("Resultant Force:", round(seal.force_resultant, 1), "N")
    seal.plot_pressures()
    print(seal.pressures)
    """

    """
    # Example of varying axial displacement and plotting axial forces
    axial_displacements = range(-99, 99, 1)
    axial_forces = []

    for disp in axial_displacements:

        seal = GammaSeal(p_in=3e5, p_out_target=1e5, c=0.0002, axial_disp=disp, 
                        teeth_a=try_a, teeth_b=try_b)

        seal.compute_pressures()
        seal.compute_resultant_force()
        axial_forces.append(seal.force_resultant)

    plt.style.use('bmh')
    plt.plot(axial_displacements, axial_forces)  
    plt.axhline(0, color='black', linewidth=1)  
    plt.axvline(0, color='black', linewidth=1)  
    plt.text(-80, 0, "\nGamma Seal\n"
                    f"Inlet Pressure={seal.p_in/1e5:.2f} bar\n"
                    f"Clearance={seal.c*1000:.2f} mm\n"
                    f"Inlet Dia={dia_a*1000}mm, \nOutlet Dia={dia_c*1000}mm\n"
                    f"Inlet teeth={try_a}, Outlet teeth={try_b}\n", fontsize=9)
    plt.xlabel("Rotor Axial Displacements, % of axial gap")   
    plt.ylabel("Axial Forces (N)")    
    plt.title("Net force on the floating stator at different rotor axial displacements") 
    plt.grid(True)
    plt.show()
    """
