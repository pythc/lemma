"""Bounded range-download fallback for public pinned weights on slow links.

Every HTTP range and the final upstream LFS SHA-256 are checked. Failed partial
files and attempt logs are retained. This does not change proxy configuration.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import time
import uuid
import requests

root = Path(__file__).resolve().parent.parent
pins = json.loads((root / "worker/document-models.json").read_text())
base = root / ".tools/document-models"
base.mkdir(parents=True, exist_ok=True)
run = base / ("download-" + str(uuid.uuid4()))
run.mkdir()

def digest_file(file):
    h = hashlib.sha256()
    with file.open("rb") as stream:
        while data := stream.read(1024 * 1024):
            h.update(data)
    return h.hexdigest()

for pin in pins["models"]:
    repository, revision = pin["repository"], pin["revision"]
    meta_response = requests.get(
        f"https://huggingface.co/api/models/{repository}/revision/{revision}?blobs=true", timeout=45)
    meta_response.raise_for_status()
    metadata = meta_response.json()
    if metadata["sha"] != revision:
        raise RuntimeError("Model repository revision changed")
    weight = next(f for f in metadata["siblings"] if f["rfilename"] == "model.safetensors")
    expected, total = weight["lfs"]["sha256"], weight["lfs"]["size"]
    folder = base / repository.replace("/", "--")
    folder.mkdir(exist_ok=True)
    destination = folder / "model.safetensors"
    if destination.exists():
        if digest_file(destination) != expected:
            raise RuntimeError("Existing model weight has wrong digest; preserved without overwrite")
        continue
    parts = run / repository.replace("/", "--")
    parts.mkdir()
    (parts / "upstream.json").write_text(json.dumps(metadata, indent=2))
    url = f"https://huggingface.co/{repository}/resolve/{revision}/model.safetensors?download=true"
    width = 4 * 1024 * 1024
    reusable = {}
    for prior in base.glob("download-*"):
        previous = prior / repository.replace("/", "--")
        if previous == parts or not (previous / "upstream.json").exists():
            continue
        old = json.loads((previous / "upstream.json").read_text())
        if old.get("sha") != revision:
            continue
        for item in previous.glob("*-attempt-*.json"):
            saved = json.loads(item.read_text())
            partial = item.with_suffix(".partial")
            if (saved.get("status") == "downloaded" and saved.get("source") == url
                    and partial.is_file() and partial.stat().st_size == saved.get("bytes")
                    and digest_file(partial) == saved.get("sha256")):
                reusable[saved["index"]] = (partial, saved)

    def download(index):
        start, end = index * width, min(total - 1, (index + 1) * width - 1)
        if index in reusable:
            previous, receipt = reusable[index]
            if receipt["start"] == start and receipt["end"] == end:
                (parts / f"{index:04d}-reused.json").write_text(json.dumps({
                    "file": str(previous), "sha256": receipt["sha256"], "start": start, "end": end}))
                return previous
        for attempt in range(1, 7):
            partial = parts / f"{index:04d}-attempt-{attempt}.partial"
            receipt = {"index": index, "attempt": attempt, "start": start, "end": end,
                       "startedAt": time.time(), "source": url}
            try:
                # Fresh resolver query avoids reusing an expired signed CDN URL.
                with requests.get(url + f"&part={index}&request={uuid.uuid4()}",
                                  headers={"Range": f"bytes={start}-{end}"},
                                  stream=True, timeout=(15, 120)) as response:
                    receipt["httpStatus"] = response.status_code
                    if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{total}":
                        raise RuntimeError("Server did not return the exact requested byte range")
                    count = 0
                    with partial.open("xb") as output:
                        for chunk in response.iter_content(256 * 1024):
                            count += len(chunk)
                            if count > end - start + 1:
                                raise RuntimeError("HTTP range exceeds requested length")
                            output.write(chunk)
                    if count != end - start + 1:
                        raise RuntimeError("HTTP range incomplete")
                receipt.update(status="downloaded", bytes=count, sha256=digest_file(partial), endedAt=time.time())
                (parts / f"{index:04d}-attempt-{attempt}.json").write_text(json.dumps(receipt))
                print(json.dumps({"repository": repository, "part": index, "bytes": count}), flush=True)
                return partial
            except Exception as error:
                receipt.update(status="failed", error=type(error).__name__,
                               detail="Range request failed; partial bytes retained", endedAt=time.time())
                (parts / f"{index:04d}-attempt-{attempt}.json").write_text(json.dumps(receipt))
                if attempt == 6:
                    raise
                time.sleep(min(10, attempt * 2))
    workers = int(os.environ.get("LEMMA_DOCUMENT_DOWNLOAD_WORKERS", "8"))
    if not 1 <= workers <= 32:
        raise ValueError("Download concurrency must be 1..32")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        files = list(pool.map(download, range((total + width - 1) // width)))
    assembled = parts / "assembled.safetensors"
    with assembled.open("xb") as output:
        for file in files:
            with file.open("rb") as stream:
                while data := stream.read(1024 * 1024):
                    output.write(data)
    actual = digest_file(assembled)
    if actual != expected:
        raise RuntimeError("Final model checksum differs from pinned upstream LFS; assembly retained")
    os.rename(assembled, destination)
    (parts / "verified.json").write_text(json.dumps({"repository": repository, "revision": revision,
        "sha256": actual, "bytes": total, "destination": str(destination)}, indent=2))
    print(json.dumps({"repository": repository, "verified": True, "sha256": actual}), flush=True)
