import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "limits", Path(__file__).parents[1] / "worker/specialist_limits.py")
limits = importlib.util.module_from_spec(spec)
spec.loader.exec_module(limits)


class SpecialistBudgetTest(unittest.TestCase):
    def test_long_valid_prompt_keeps_room_for_completion(self):
        self.assertEqual(limits.completion_budget(12000, 40000), 28960)
        self.assertEqual(limits.completion_budget(12000, 2048), 2048)
        self.assertEqual(limits.completion_budget(40959, 2048), 1)

    def test_prompt_is_never_silently_truncated(self):
        for tokens in [40960, 40961]:
            with self.assertRaises(ValueError):
                limits.completion_budget(tokens, 32768)

    def test_invalid_limits_rejected(self):
        for prompt, output in [(-1, 1), (True, 1), (1, 0), (1, 40001), (1, 1.5)]:
            with self.assertRaises(ValueError):
                limits.completion_budget(prompt, output)


if __name__ == "__main__":
    unittest.main()
