"""Pinned upstream BEq+ evaluator, separate from all product certificates."""
import ast
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from lean_interact import LeanServer, LeanREPLConfig, Command

cfg = json.loads(Path(sys.argv[1]).read_text())
source = Path(cfg['upstream']).read_bytes()
if hashlib.sha256(source).hexdigest() != '3981daf6b342b9959c183a55df53818f57cf83dba8c67376105ec2d76d9a80c6':
    raise ValueError('Pinned BEq+ source changed')
# Keep pinned upstream bytes unchanged. A versioned local compatibility patch
# preserves separators and expands the upstream congruence configuration fields.
patches = [
    ('formal_2_code + proof_all_have', 'formal_2_code + "\\n" + indent_code(proof_all_have, 2)'),
    ('(config := .unfoldSameFun)', '(config := {{partialApp := false, sameFun := true, transparency := .default, preTransparency := .default, postTransparency := .default}})'),
]
original = source.decode()
patched = original
for old, new in patches:
    if patched.count(old) != 1:
        raise ValueError('BEq compatibility patch no longer applies uniquely')
    patched = patched.replace(old, new)
Path(cfg['directory'], 'beq-compatibility.json').write_text(json.dumps({
    'upstreamSha256': hashlib.sha256(source).hexdigest(),
    'patchedSha256': hashlib.sha256(patched.encode()).hexdigest(),
    'patches': patches, 'algorithm': 'BEq+ with local Lean 4.35 compatibility patch',
    'semanticCertificate': False}, indent=2))
Path(cfg['directory'], 'beq-patched.py').write_text(patched)
source = patched
# Exclude dataset download and reporting CLI; load only reviewed functions.
tree = ast.parse(source)
functions = {'extract_exact_proof', 'check_proof_sub', 'beq_plus'}
nodes = [n for n in tree.body if
         isinstance(n, ast.FunctionDef) and n.name in functions or
         isinstance(n, ast.Import) and all(a.name == 'json' for a in n.names) or
         isinstance(n, ast.ImportFrom) and n.module and n.module.split('.')[0] in {'rich', 'lean_interact'} or
         isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {'console', 'DEFAULT_TIMEOUT'} for t in n.targets)]
namespace = {}
exec(compile(ast.Module(body=nodes, type_ignores=[]), cfg['upstream'], 'exec'), namespace)

class Isolated(LeanServer):
    def start(self):
        self._proc = subprocess.Popen(['/usr/bin/sandbox-exec', '-p', cfg['sandbox'], cfg['replBinary']],
            cwd=cfg['directory'], env=cfg['environment'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8', text=True, bufsize=1)

repl = Isolated(LeanREPLConfig(local_repl_path=cfg['replRoot'], build_repl=False))
class Journal:
    def run(self, command, **kwargs):
        request = {'command':command.model_dump(), 'options':kwargs}
        try:
            result = repl.run(command, **kwargs)
            request['response'] = result.model_dump()
            return result
        except Exception as e:
            request['error'] = {'type':type(e).__name__, 'message':str(e)}
            raise
        finally:
            with open(cfg['journal'], 'a') as f:
                f.write(json.dumps(request, ensure_ascii=False)+'\n')

rows=[]
try:
    # Loading the pinned environment is separate from each bounded proof search.
    warmup=Journal().run(Command(cmd=cfg['header']), timeout=30)
    for case in cfg['cases']:
        try:
            found=namespace['beq_plus'](case['left'],case['right'],cfg['header'],Journal(),timeout_per_proof=cfg.get("timeoutPerProof", 5))
            rows.append({'id':case['id'],'beqPlus':found,'status':'metric_match' if found else 'not_established',
                         'semanticCertificate':False})
        except Exception as e:
            rows.append({'id':case['id'],'status':'error','error':str(e),'semanticCertificate':False})
        Path(cfg['result']).write_text(json.dumps(rows,ensure_ascii=False,indent=2))
finally:
    repl.kill()
