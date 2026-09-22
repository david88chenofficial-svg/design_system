import math
import unittest

from beam_models import RectangularBeam, euler_bernoulli_frequency_hz


class EulerBernoulliVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.beam = RectangularBeam(
            length_m=0.4,
            width_m=0.025,
            thickness_m=0.003,
            youngs_modulus_pa=69.0e9,
            density_kg_m3=2700.0,
        )

    def test_reference_frequency(self) -> None:
        self.assertTrue(
            math.isclose(
                euler_bernoulli_frequency_hz(self.beam),
                15.31172767216716,
                rel_tol=1.0e-12,
            )
        )

    def test_frequency_scales_with_thickness(self) -> None:
        twice_as_thick = RectangularBeam(
            length_m=self.beam.length_m,
            width_m=self.beam.width_m,
            thickness_m=2.0 * self.beam.thickness_m,
            youngs_modulus_pa=self.beam.youngs_modulus_pa,
            density_kg_m3=self.beam.density_kg_m3,
        )
        ratio = euler_bernoulli_frequency_hz(twice_as_thick) / (
            euler_bernoulli_frequency_hz(self.beam)
        )
        self.assertTrue(math.isclose(ratio, 2.0, rel_tol=1.0e-12))

    def test_frequency_scales_with_inverse_length_squared(self) -> None:
        twice_as_long = RectangularBeam(
            length_m=2.0 * self.beam.length_m,
            width_m=self.beam.width_m,
            thickness_m=self.beam.thickness_m,
            youngs_modulus_pa=self.beam.youngs_modulus_pa,
            density_kg_m3=self.beam.density_kg_m3,
        )
        ratio = euler_bernoulli_frequency_hz(twice_as_long) / (
            euler_bernoulli_frequency_hz(self.beam)
        )
        self.assertTrue(math.isclose(ratio, 0.25, rel_tol=1.0e-12))

    def test_non_positive_input_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            RectangularBeam(0.0, 0.025, 0.003, 69.0e9, 2700.0)


if __name__ == "__main__":
    unittest.main()
