import numpy as np
from scipy.optimize import bisect
import matplotlib.pyplot as plt

# Constants
gamma = 1.4  # specific heat ratio for air  
R = 287.05   # specific gas constant for air, J/(kg·K)
T = 300      # temperature in K
Cd = 0.6     # discharge coefficient

# Gamma shaped floating stator dimensions
dia_a = 0.12  # Inner diameter of the inlet side [m]
dia_b = 0.165  # Rotor Disk Diameter [m]
dia_c = 0.0925  # Inner diameter of the outlet side [m]

tooth_pitch = 0.003 # Tooth pitch [m]


class GammaSeal:
    def __init__(self, p_in=7e5, p_out_target=1e5, c=0.00015, axial_disp=0, teeth_a=8, teeth_b=5):
        """Initialize the radial seal parameters."""
        self.p_in = p_in
        self.p_out_target = p_out_target
        self.c = c  # Tooth clearance [m] 
        self.axial_disp = axial_disp  # Rotor axial displacement, % of axial gap [%]  
        self.teeth_a = teeth_a  # number of teeth on inlet side
        self.teeth_b = teeth_b  # number of teeth on outlet side

        # Critical pressure ratio for choked flow
        self.critical_ratio = (2 / (gamma + 1)) ** (gamma / (gamma - 1))
        self.diameters = self._generate_diameters()
        self.mdot_solution = None
        self.pressures = None
        self.force_a = 0.0  # Force on the inlet side of the seal [N]
        self.force_b = 0.0  # Force on the outlet side of the seal [N]
        self.force_c = 0.0  # External force on the floating stator [N]
        self.force_resultant = 0.0  # Resultant force on the floating stator [N]
        self.force_axial = None
        self.chamber_pressure = None
    
    def __str__(self):
        return (f"\nGammaSeal(p_in={self.p_in/1e5}bar, p_out={self.p_out_target/1e5}bar, "
                f"c={self.c*1000}mm, axial_disp={self.axial_disp}, "
                f"teeth_a={self.teeth_a}, teeth_b={self.teeth_b}) \n")

    def _generate_diameters(self):
        diameters_a = [dia_a + 0.001 + (i) * (tooth_pitch*2) for i in range(self.teeth_a)]
        diameters_b = [dia_c + 0.001 + (i) * (tooth_pitch*2) for i in range(self.teeth_b)]
        return diameters_a + diameters_b[::-1]  # Combine and reverse for outlet side

    def gap_areas(self):
        """Calculate the gap areas for given diameters, and rotor axial displacement."""
        area_list = []
        for i, d in enumerate(self.diameters):
            if i < self.teeth_a:
                # Inlet side
                area_list.append(np.pi * d * (self.c + (self.axial_disp / 100) * self.c))
            else:
                # Outlet side
                area_list.append(np.pi * d * (self.c - (self.axial_disp / 100) * self.c))
        return area_list
    
    def next_pressure(self, p1, mdot, A):
        """Compute downstream pressure p2 given upstream pressure, mdot, and area."""
        p_crit = p1 * self.critical_ratio
        term = ((mdot / (Cd * A * p1)) ** 2) * R * T * (gamma - 1) / (2 * gamma)
        if term < 1:
            pr = (1 - term) ** (gamma / (gamma - 1))
            p2 = p1 * pr
            return max(p2, p_crit)
        else:
            return p_crit  # choked flow

    def simulate_seal(self, mdot):
        """Run simulation through all stages using current mdot and A_list."""
        p = self.p_in
        for A in self.gap_areas():
            p = self.next_pressure(p, mdot, A)
        return p
    

    def _objective(self, mdot):
        """Difference between simulated and target outlet pressure."""
        return self.simulate_seal(mdot) - self.p_out_target


    def _solve_mdot(self):
        """Use adaptive bisection to solve for the required mass flow."""
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
        """Compute pressures at each stage for the final mdot."""
        self._solve_mdot()
        self.pressures = [self.p_in]
        p = self.p_in
        for A in self.gap_areas():
            p = self.next_pressure(p, self.mdot_solution, A)
            self.pressures.append(p)
        self.chamber_pressure = self.pressures[self.teeth_a]  # Pressure at the midpoint
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
        """Compute the force on the inlet side of the seal."""
        if self.pressures is None:
            raise ValueError("Run .compute_pressures() first to compute pressures.")
        inlet_dia = [dia_a] + self.diameters[0:self.teeth_a] + [dia_b]
        for i in range(len(inlet_dia) - 1):
            self.force_a += self.pressures[i] * (np.pi * ((inlet_dia[i + 1] ** 2) - (inlet_dia[i] ** 2))) / 4
        print(f"Force on inlet side: {self.force_a:.2f} N")
        return self.force_a

    def compute_force_b(self):
        """Compute the force on the outlet side of the seal."""
        if self.pressures is None:
            raise ValueError("Run .compute_pressures() first to compute pressures.")
        outlet_dia = [dia_b] + self.diameters[self.teeth_a:] + [dia_c]
        for i in range(len(outlet_dia) - 1):
            self.force_b += self.pressures[i + self.teeth_a] * (np.pi * ((outlet_dia[i] ** 2) - (outlet_dia[i + 1] ** 2))) / 4
        print(f"Force on outlet side: {self.force_b:.2f} N")
        return self.force_b

    def compute_force_c(self):
        """Compute the external force on the floating stator."""
        if self.pressures is None:
            raise ValueError("Run .compute_pressures() first to compute pressures.")
        self.force_c = self.p_out_target * (np.pi / 4) * (dia_a**2 - dia_c**2)
        print(f"External force on floating stator: {self.force_c:.2f} N")
        return self.force_c
    
    def compute_resultant_force(self):
        self.compute_force_a()
        self.compute_force_b()
        self.compute_force_c()
        
        self.force_resultant = self.force_b - self.force_a - self.force_c
        #print(f"Resultant Force on Floating Stator: {self.force_resultant:.2f} N")
        return self.force_resultant

try_a = 7
try_b = 4

# Create three seals with axial_disp = -60, 0, 60
left_seal = GammaSeal(p_in=2e5, p_out_target=1e5, c=0.0002, axial_disp=-60,
                      teeth_a=try_a, teeth_b=try_b)
central_seal = GammaSeal(p_in=2e5, p_out_target=1e5, c=0.0002, axial_disp=0,
                         teeth_a=try_a, teeth_b=try_b)
right_seal = GammaSeal(p_in=2e5, p_out_target=1e5, c=0.0002, axial_disp=60,
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
plt.grid(True)
plt.show()


# New block: compute axial forces vs axial displacement and plot force_a, force_b, force_c and resultant
axial_displacements = list(range(-99, 99, 1))
forces_a = []
forces_b = []
forces_c = []
forces_res = []

for disp in axial_displacements:
    seal = GammaSeal(p_in=2e5, p_out_target=1e5, c=0.0002, axial_disp=disp,
                     teeth_a=try_a, teeth_b=try_b)
    seal.compute_pressures()
    fa = seal.compute_force_a()
    fb = seal.compute_force_b()
    fc = seal.compute_force_c()
    fres = seal.compute_resultant_force()
    forces_a.append(fa)
    forces_b.append(fb)
    forces_c.append(fc)
    forces_res.append(fres)

plt.figure(figsize=(10,6))
plt.plot(axial_displacements, forces_a, label='Force A (inlet)', color='tab:blue')
plt.plot(axial_displacements, forces_b, label='Force B (outlet)', color='tab:orange')
plt.plot(axial_displacements, forces_c, label='Force C (chamber)', color='tab:green')
plt.plot(axial_displacements, forces_res, label='Resultant Force', color='tab:red', linewidth=2)

plt.xlabel('Rotor Axial Displacement (% of axial gap)')
plt.ylabel('Axial Force (N)')
plt.title('Axial Forces vs Rotor Axial Displacement')
plt.legend()
plt.grid(True)
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
