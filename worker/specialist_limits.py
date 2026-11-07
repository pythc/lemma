"""Token accounting independent of model loading."""

CONTEXT_LIMIT = 40960
OUTPUT_LIMIT = 40000


def completion_budget(prompt_tokens, requested_tokens):
    if (type(prompt_tokens) is not int or prompt_tokens < 0
            or type(requested_tokens) is not int
            or not 1 <= requested_tokens <= OUTPUT_LIMIT):
        raise ValueError("Invalid specialist token budget")
    remaining = CONTEXT_LIMIT - prompt_tokens
    if remaining < 1:
        raise ValueError("Specialist prompt exceeds context budget")
    return min(requested_tokens, remaining)
