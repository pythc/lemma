"""Reproducible macOS arm64 proving tools; never modifies the trusted Mathlib tree.

Run with the project's Python 3.12. Add --specialist to download the pinned 8B
weights. Every archive is checked before extraction. No credentials are needed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / '.tools'
DEST = TOOLS / 'proving'
LEAN = TOOLS / 'lean-4.35.0-darwin_aarch64/bin/lake'
MATHLIB = TOOLS / 'mathlib4-4.35.0'
ARCHIVES = {
    'repl': ('https://codeload.github.com/augustepoiroux/repl/tar.gz/refs/tags/v1.3.19_lean-toolchain-v4.35.0', '55844a93f1dbab5593ce8f802ef65c1596a35f09a84393ed342b4ba39bd8412e'),
    'LeanCopilot': ('https://codeload.github.com/lean-dojo/LeanCopilot/tar.gz/refs/tags/v4.35.0', '4a790661d61b4d17e62897539afcd4171452a7c5fa6a078be7932b55f1ed2d37'),
    'copilotArm64': ('https://github.com/lean-dojo/LeanCopilot/releases/download/v4.35.0/arm64-macOS.tar.gz', '34172b2f7d4d9a78185d61748efcb1f6cf981fa4b4855ea0347d442ac35f0583'),
}


def digest_file(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(4*1024*1024), b''):
            h.update(data)
    return h.hexdigest()


def archive(name, destination):
    url, expected = ARCHIVES[name]
    file = DEST / (name + '-pinned.tar.gz')
    if not file.exists():
        temp = file.with_suffix('.part')
        with urllib.request.urlopen(url, timeout=90) as response, temp.open('wb') as out:
            shutil.copyfileobj(response, out)
        if digest_file(temp) != expected:
            raise ValueError('Archive hash mismatch: ' + name)
        temp.rename(file)
    if digest_file(file) != expected:
        raise ValueError('Archive hash mismatch: ' + name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='lemma-prover-install-', dir=destination.parent) as tmp:
        staged = Path(tmp)/'content'
        staged.mkdir()
        with tarfile.open(file) as data:
            for member in data.getmembers():
                parts = Path(member.name).parts if name == 'copilotArm64' else Path(member.name).parts[1:]
                if not parts:
                    continue
                member.name = str(Path(*parts))
                data.extract(member, staged, filter='data')
        if destination.exists():
            # Never silently trust a partial install or overwrite local edits.
            for item in staged.rglob('*'):
                if item.is_file():
                    installed=destination/item.relative_to(staged)
                    if not installed.is_file() or digest_file(installed)!=digest_file(item):
                        raise ValueError('Existing tool differs from pinned archive: '+str(installed))
        else:
            staged.rename(destination)


def setup_search():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('This pinned distribution requires macOS arm64')
    if not LEAN.exists() or not MATHLIB.exists():
        raise ValueError('Install the pinned Lean and analysis library first')
    DEST.mkdir(parents=True, exist_ok=True)
    uv = shutil.which('uv') or str(Path.home()/'.local/bin/uv')
    venv = TOOLS / 'proving-venv'
    if not venv.exists():
        subprocess.run([uv, 'venv', '--python', '3.12', str(venv)], check=True)
    subprocess.run([uv, 'pip', 'sync', '--python', str(venv/'bin/python'), str(ROOT/'worker/proving-requirements.lock')], check=True)
    archive('repl', DEST/'repl')
    archive('LeanCopilot', DEST/'LeanCopilot')
    archive('copilotArm64', DEST/'LeanCopilot/.lake/build')
    subprocess.run([str(LEAN), 'build'], cwd=DEST/'repl', check=True)
    batteries = DEST/'batteries'
    if not batteries.exists():
        shutil.copytree(MATHLIB/'.lake/packages/batteries', batteries, ignore=shutil.ignore_patterns('.git'))
    subprocess.run([str(LEAN), 'build', 'Batteries.Data.HashMap', 'Batteries.Data.String.Basic', 'Batteries.Data.String.Matcher'], cwd=batteries, check=True)
    files = [DEST/'repl/.lake/build/bin/repl']
    for base in [DEST/'LeanCopilot/.lake/build/lib', batteries/'.lake/build/lib/lean']:
        files += [p for p in base.rglob('*') if p.is_file() and (p.suffix in ['.olean','.ir','.ilean','.dylib','.so'] or p.name.endswith(('.olean.private','.olean.server')))]
    manifest = {'schemaVersion':'lemma.prover-toolchain.v1','lean':'4.35.0','leanInteract':'0.11.6','replTag':'v1.3.19_lean-toolchain-v4.35.0','copilotTag':'v4.35.0','archives':{name:v[1] for name,v in ARCHIVES.items()},'files':[{'path':str(p.relative_to(ROOT)),'sha256':digest_file(p)} for p in sorted(set(files))]}
    (DEST/'manifest.json').write_text(json.dumps(manifest, indent=2))
    print('Pinned LeanInteract and LeanCopilot installed', flush=True)


def setup_specialist():
    from huggingface_hub import snapshot_download, model_info
    repo='Goedel-LM/Goedel-Prover-V2-8B'
    revision='dfd02e6271a58375dfbf3ece0175277cf6b6a89a'
    folder=TOOLS/'models/Goedel-Prover-V2-8B'
    snapshot_download(repo, revision=revision, local_dir=folder, allow_patterns=['*.json','*.safetensors','*.txt','README.md'], max_workers=4)
    info=model_info(repo, revision=revision, files_metadata=True)
    records=[]
    for item in info.siblings:
        file=folder/item.rfilename
        if not file.is_file():continue
        hashed=digest_file(file)
        if item.lfs and item.lfs.sha256 != hashed:raise ValueError('Model LFS hash mismatch: '+item.rfilename)
        records.append({'name':item.rfilename,'size':file.stat().st_size,'mtimeMs':file.stat().st_mtime_ns/1000000,'sha256':hashed})
    if len([r for r in records if r['name'].endswith('.safetensors')])!=4:raise ValueError('Missing model shards')
    (folder/'lemma-manifest.json').write_text(json.dumps({'repo':repo,'revision':revision,'precision':'bfloat16','files':records},indent=2))
    print('Specialist weights checked against pinned Hub LFS hashes',flush=True)


if __name__ == '__main__':
    args=argparse.ArgumentParser()
    args.add_argument('--specialist',action='store_true')
    args.add_argument('--model-only',action='store_true')
    opts=args.parse_args()
    if not opts.model_only:setup_search()
    if opts.specialist or opts.model_only:
        venv_python=TOOLS/'proving-venv/bin/python'
        if Path(sys.prefix).resolve() != (TOOLS/'proving-venv').resolve():
            subprocess.run([str(venv_python), str(Path(__file__).resolve()), '--model-only'], check=True)
        else:
            setup_specialist()
