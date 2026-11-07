"""Download fixed open model revisions. Inference never calls this installer."""
import hashlib
import json
import os
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_XET", "0")
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
from huggingface_hub import snapshot_download

root = Path(__file__).resolve().parent.parent
pins = json.loads((root / "worker/document-models.json").read_text())
output = root / ".tools/document-models"
output.mkdir(parents=True, exist_ok=True)
receipt_path = output / "receipt.json"
if receipt_path.exists():
    raise RuntimeError("Models already published; verify their receipt instead of overwriting it")
receipt = {"schemaVersion": pins["schemaVersion"], "models": []}
for pin in pins["models"]:
    print("Downloading pinned model:", pin["repository"], pin["revision"], flush=True)
    folder = output / pin["repository"].replace("/", "--")
    patterns = ["*.json", "*.safetensors", "README.md"]
    if (folder / "model.safetensors").exists():
        # A range-download fallback is acceptable only after comparison with
        # the immutable upstream repository's LFS checksum.
        import requests
        response = requests.get(
            f'https://huggingface.co/api/models/{pin["repository"]}/revision/{pin["revision"]}?blobs=true',
            timeout=45)
        response.raise_for_status()
        metadata = response.json()
        expected = next(f["lfs"]["sha256"] for f in metadata["siblings"] if f["rfilename"] == "model.safetensors")
        h = hashlib.sha256()
        with (folder / "model.safetensors").open("rb") as stream:
            while data := stream.read(1024 * 1024):
                h.update(data)
        if metadata["sha"] != pin["revision"] or h.hexdigest() != expected:
            raise RuntimeError("Existing weight is not the pinned upstream artifact")
        patterns = ["*.json", "README.md"]
    snapshot_download(repo_id=pin["repository"], revision=pin["revision"],
                      local_dir=folder, token=False, max_workers=2,
                      allow_patterns=patterns)
    files = []
    for file in sorted(folder.iterdir()):
        if file.is_file():
            h = hashlib.sha256()
            with file.open("rb") as stream:
                while data := stream.read(1024 * 1024):
                    h.update(data)
            files.append({"path": str(file.relative_to(output)), "sha256": h.hexdigest(),
                          "bytes": file.stat().st_size})
    if not any(f["path"].endswith(".safetensors") for f in files):
        raise RuntimeError("Model weights are missing")
    receipt["models"].append({**pin, "files": files})
with receipt_path.open("x") as file:
    json.dump(receipt, file, indent=2)
print("Published fixed model receipt", receipt_path, flush=True)
