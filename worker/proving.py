"""LeanInteract transport. Search states are untrusted; only the JS checker certifies.

One process owns one theorem and all its coupled metavariables. Checkpoints are
replayable tactic journals, never untrusted native pickle files.
"""
import json
import os
import subprocess
import sys
import re
import textwrap
import threading
import time
import psutil
from pathlib import Path

from lean_interact import Command, LeanREPLConfig, LeanServer, ProofStep

MAX_REQUEST_BYTES = int(os.environ.get("LEMMA_PROVER_REQUEST_BYTES", 8 * 1024**2))
if not 1 <= MAX_REQUEST_BYTES <= 16 * 1024**2:
    raise ValueError("Invalid prover transport limit")

class IsolatedServer(LeanServer):
    def start(self):
        started = time.monotonic()
        cfg = self.config.lemma
        self._proc = subprocess.Popen(
            ["/usr/bin/sandbox-exec", "-p", cfg["sandbox"], cfg["replBinary"]],
            cwd=cfg["directory"], env=cfg["environment"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding="utf-8", text=True, bufsize=1,
        )
        # A sampled RSS guard, not an OS allocation guarantee. The parent also
        # enforces wall time and kills the complete worker process group.
        self.startup_ms = round((time.monotonic() - started) * 1000)
        self.peak_rss_bytes = 0
        self.memory_exhausted = False
        proc = self._proc
        limit = cfg['memoryLimitMB'] * 1024**2
        def watch_memory():
            while proc.poll() is None:
                try:
                    tracked = psutil.Process(proc.pid)
                    used = sum(p.memory_info().rss for p in [tracked, *tracked.children(recursive=True)])
                    self.peak_rss_bytes = max(self.peak_rss_bytes, used)
                    if used > limit:
                        self.memory_exhausted = True
                        proc.kill()
                        return
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    return
                threading.Event().wait(0.25)
        threading.Thread(target=watch_memory, daemon=True).start()


server = None
states = {}
current = None
initial = None
initial_env = None


def run(request):
    global server, states, current, initial, initial_env
    operation = request["operation"]
    if operation == "createSession":
        if server is not None:
            raise ValueError("A worker can own only one immutable target")
        cfg = LeanREPLConfig(local_repl_path=request["replRoot"], build_repl=False)
        cfg.lemma = request
        server = IsolatedServer(cfg)
        # Reuse the actual import environment within this immutable worker only.
        # No pickle, cross-target pool, auto-resume policy or kernel certificate.
        lines = request["source"].splitlines(keepends=True)
        split = 0
        while split < len(lines) and lines[split].startswith("import "):
            split += 1
        if split == 0:
            raise ValueError("Controlled import prefix missing")
        import_started = time.monotonic()
        imported = server.run(Command(cmd="".join(lines[:split])), timeout=request["timeoutSeconds"]).model_dump()
        imports_ms = round((time.monotonic() - import_started) * 1000)
        if "env" not in imported or any(m.get("severity") == "error" for m in imported.get("messages", [])):
            return {"status": "initialization_failed", "response": imported, "phase": "imports"}
        target_started = time.monotonic()
        result = server.run(Command(cmd="".join(lines[split:]), env=imported["env"]), timeout=request["timeoutSeconds"])
        timing = {"startupMs": server.startup_ms, "importsMs": imports_ms, "elaborationMs": round((time.monotonic()-target_started)*1000), "peakRssBytes": server.peak_rss_bytes, "scope": "one_worker_one_target_leaninteract_env_reuse"}
        value = result.model_dump()
        if any(m.get("severity") == "error" for m in value.get("messages", [])) or len(value.get("sorries", [])) != 1:
            return {"status": "initialization_failed", "response": value}
        initial = current = value["sorries"][0]["proof_state"]
        initial_env = value['env']
        states[current] = {"goals": [value["sorries"][0]["goal"]], "journal": [], "completed": False}
        return {"status": "ready", "state": current, **states[current], "response": value, "timing": timing}
    if server is None:
        raise ValueError("No active session")
    if operation == "queryPremises":
        queries = request['queries']
        if len(queries) > 8 or any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]{1,79}', q) for q in queries):
            raise ValueError('Invalid premise queries')
        terms = '[' + ', '.join(json.dumps(q.lower()) for q in queries) + ']'
        code = '''open Lean Elab Command in
run_elab do
  let env ← getEnv
  let queries : List String := TERMS
  let mut ranked : Array (Nat × Name) := #[]
  for (name, info) in env.constants.toList do
    let n := name.toString
    if !n.startsWith "lemma_" && !n.startsWith "LeanCopilot" && !n.startsWith "Lean." && !n.startsWith "Aesop." && !n.startsWith "_" && queries.any (fun q => (n.toLower.splitOn q).length > 1) then
      let score := queries.foldl (fun acc q => max acc (if n.toLower == q then 1000 else if (n.toLower.splitOn ".").getLast! == q then 900 else 1)) 0
      ranked := ranked.push (score, name)
  ranked := ranked.qsort (fun a b => if a.1 == b.1 then a.2.toString < b.2.toString else a.1 > b.1)
  let mut results : Array Json := #[]
  for (score, name) in ranked.toList.take 48 do
    if let some info := env.find? name then
      let ty ← Lean.Meta.ppExpr info.type
      results := results.push (Json.mkObj [("name", toJson name.toString), ("signature", toJson ty.pretty), ("nameMatchScore", toJson score)])
  logInfo ("LEMMA_PREMISES:" ++ (Json.arr results).compress)
'''.replace('TERMS', terms)
        response = server.run(Command(cmd=code, env=initial_env), timeout=request['timeoutSeconds']).model_dump()
        for message in response.get('messages', []):
            if message.get('data', '').startswith('LEMMA_PREMISES:'):
                return {'entries': json.loads(message['data'][len('LEMMA_PREMISES:'):]), 'status':'resolved', 'source':'live_lean_environment'}
        return {'entries':[], 'status':'lookup_failed', 'response':response}
    state = request.get("state", current)
    if state not in states:
        raise ValueError("Unknown proof state")
    if operation in ("inspectGoal", "checkpoint"):
        return {"state": state, **states[state]}
    if operation == "rollback":
        current = state
        return {"state": current, **states[current]}
    if operation in ("applyTactic", "runSearch"):
        # The pinned Copilot macro carries hygienic rule names. Its pinned
        # Aesop defaults bound the tree to 200 rule applications, depth 30.
        tactic = request["tactic"] if operation == "applyTactic" else "search_proof"
        if operation == "runSearch":
            Path(request["suggestionFile"]).write_text(json.dumps(request["suggestions"]), encoding="utf-8")
        response = server.run(ProofStep(proof_state=state, tactic=tactic), timeout=request["timeoutSeconds"])
        value = response.model_dump()
        if "proof_state" not in value:
            return {"status": "rejected", "state": state, "response": value, **states[state]}
        completed = value.get("proof_status") == "Completed" and not value.get("goals") and not value.get("sorries")
        errors = any(m.get("severity") == "error" for m in value.get("messages", []))
        if errors or value.get("proof_status", "").startswith("Error"):
            return {"status": "rejected", "state": state, "response": value, **states[state]}
        exported = tactic
        if operation == "runSearch":
            exported = next((m["data"].split("Try this:", 1)[1].strip() for m in value.get("messages", []) if "Try this:" in m.get("data", "")), None)
            if exported is not None:
                exported = textwrap.dedent(re.sub(r"^\s*\[apply\] ", "", exported)).strip()
        current = value["proof_state"]
        states[current] = {
            "goals": value.get("goals", []),
            "journal": states[state]["journal"] + ([exported] if exported else []),
            "completed": completed,
            "exportable": exported is not None and states[state].get("exportable", True),
        }
        return {"status": "candidate_complete" if completed else "advanced", "state": current, **states[current], "response": value}
    if operation == "cancel":
        server.kill()
        return {"status": "cancelled"}
    raise ValueError("Unsupported operation")


try:
    while True:
        line = sys.stdin.readline(MAX_REQUEST_BYTES + 1)
        if not line:
            break
        if len(line.encode("utf-8")) > MAX_REQUEST_BYTES:
            raise ValueError("Request too large")
        req = json.loads(line)
        try:
            result = run(req)
            print(json.dumps({"id": req["id"], "result": result}), flush=True)
        except Exception as error:
            reason = 'Prover memory budget exhausted' if getattr(server, 'memory_exhausted', False) else str(error)[:4000]
            print(json.dumps({"id": req.get("id"), "error": reason, "errorType": type(error).__name__}), flush=True)
finally:
    if server is not None:
        server.kill()
