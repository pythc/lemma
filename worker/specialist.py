"""Offline Goedel inference on Apple Silicon. JSON input/output, one request.

No remote Python execution, no network access needed, no Lean certification here.
The parent owns hard cancellation and bounds total wall time and output bytes.
"""
import json
import sys
import time

import mlx.core as mx
from mlx_lm import load, stream_generate
from mlx_lm.sample_utils import make_sampler
from specialist_limits import CONTEXT_LIMIT, completion_budget

request = json.loads(sys.stdin.readline())
mx.set_memory_limit(28 * 1024**3)
mx.set_cache_limit(1024**3)
mx.random.seed(request.get("seed", 0))
started = time.monotonic()
model, tokenizer = load(request["modelPath"], trust_remote_code=False)
prompt = tokenizer.apply_chat_template(
    [{"role": "user", "content": request["prompt"]}],
    tokenize=True, add_generation_prompt=True,
)
max_tokens = completion_budget(len(prompt), request["maxTokens"])
budget = {"promptTokens": len(prompt), "requestedCompletionTokens": request["maxTokens"],
          "effectiveCompletionTokens": max_tokens, "contextLimit": CONTEXT_LIMIT}
print(json.dumps({"type": "budget", **budget}), flush=True)
last = None
for token in stream_generate(model, tokenizer, prompt, max_tokens=max_tokens, sampler=make_sampler(temp=request.get("temperature", 0.0))):
    last = token
    print(json.dumps({"type": "token", "text": token.text}), flush=True)
if last is None:
    raise ValueError("No specialist output")
print(json.dumps({"type": "done", **budget, "generationTokens": last.generation_tokens,
                  "promptTokens": last.prompt_tokens, "tokensPerSecond": last.generation_tps,
                  "peakMemoryGB": last.peak_memory, "finishReason": last.finish_reason,
                  "elapsedMs": round((time.monotonic()-started)*1000)}), flush=True)
