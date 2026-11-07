"""Exercise the real JSON worker transport without starting Lean or a model."""
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).parents[1]


class LargeWorkerTransportTest(unittest.TestCase):
    def test_request_above_former_one_megabyte_cap_is_parsed(self):
        payload = {"id": "large-runtime-fixture", "operation": "inspect_without_session",
                   "padding": "x" * 1200000}
        result = subprocess.run(
            [str(ROOT / ".tools/proving-venv/bin/python"), str(ROOT / "worker/proving.py")],
            input=json.dumps(payload) + "\n", text=True, capture_output=True, timeout=30,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LEMMA_PROVER_REQUEST_BYTES": str(8 * 1024**2)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response["id"], payload["id"])
        self.assertEqual(response["error"], "No active session")


if __name__ == "__main__":
    unittest.main()
