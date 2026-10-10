"""Data Ledger's self-hosted model server (#39).

One open-weight model, served by vLLM behind an OpenAI-compatible API, in
the owner's own Modal container. Every AI feature in the app goes through
it (src/lib/model/). No AI company processes the data: the weights are
open, and this container is ours — the same trust level as Vercel and Neon.

Deploy (see README, "Model service"):

    modal secret create data-ledger-model VLLM_API_KEY=<openssl rand -base64 32>
    modal deploy model/serve.py

Then set MODEL_BASE_URL (the printed URL + /v1) and MODEL_API_KEY in Vercel.

Based on Modal's vLLM inference example, with three deliberate changes:
  - an API key is required (vLLM reads VLLM_API_KEY); the example's
    endpoint is open to anyone who finds the URL;
  - a short idle window: every wake-up bills at least the full window of
    GPU time, and this app's traffic is a nightly batch plus occasional
    chat, so a 15-minute window would mostly pay for idling;
  - no speculative-decoding companion model: less memory, faster cold
    start, and throughput isn't the bottleneck for one user.
"""

import os

import modal

# The model is chosen with `npm run model:eval` on synthetic data — see the
# PR that changes it for the numbers. Pin the revision so a repo update
# can't silently change behaviour.
MODEL_NAME = "google/gemma-4-26B-A4B-it"
MODEL_REVISION = "47b6801b24d15ff9bcd8c96dfaea0be9ed3a0301"
# vLLM's parsers for this model family's tool-call and reasoning formats.
TOOL_CALL_PARSER = "gemma4"
REASONING_PARSER = "gemma4"

# What the app sends as `model`, independent of which weights are behind it.
SERVED_NAME = "ledger"

# 26B parameters in bf16 is ~52 GB of weights; an 80 GB card leaves room
# for the KV cache at the context length below.
GPU = "H100"
MAX_MODEL_LEN = 32768

MINUTES = 60  # seconds
VLLM_PORT = 8000

# Trades some throughput for a faster cold start (skips torch.compile and
# CUDA graph capture). Worth it at single-user volume, where the wait for
# the first token after idle is what's felt.
FAST_BOOT = True

vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.9.0-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    # Pinned to releases from vLLM 0.21.0's own week (May 2026), not
    # "whatever resolves today": xgrammar 0.2.4/0.2.5 (Sept 2026) added a
    # transformers<5 cap, so an unpinned install now pulls Transformers 4.x,
    # which predates Gemma 4, and vLLM dies at startup ("Transformers does
    # not recognize this architecture"). Bump these together, deliberately.
    .uv_pip_install("vllm==0.21.0", "transformers==5.8.1", "xgrammar==0.2.1")
    .env({"HF_XET_HIGH_PERFORMANCE": "1"})
)

# Weights and compiled artifacts persist across cold starts, so only the
# first-ever boot downloads ~52 GB.
hf_cache = modal.Volume.from_name("data-ledger-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("data-ledger-vllm-cache", create_if_missing=True)

app = modal.App("data-ledger-model")


@app.server(
    image=vllm_image,
    gpu=GPU,
    secrets=[modal.Secret.from_name("data-ledger-model")],
    scaledown_window=3 * MINUTES,
    startup_timeout=10 * MINUTES,
    volumes={"/root/.cache/huggingface": hf_cache, "/root/.cache/vllm": vllm_cache},
    port=VLLM_PORT,
    target_concurrency=8,
    # Modal's own proxy auth is off because vLLM enforces the API key
    # itself (standard `Authorization: Bearer`, which any OpenAI-compatible
    # client sends). The server refuses to start without that key — see
    # start() — so this is never actually open.
    unauthenticated=True,
)
class Server:
    @modal.enter()
    def start(self):
        import json
        import subprocess

        if len(os.environ.get("VLLM_API_KEY", "")) < 24:
            raise RuntimeError("VLLM_API_KEY is missing or short; refusing to serve the model unauthenticated")

        cmd = [
            "vllm",
            "serve",
            MODEL_NAME,
            "--revision",
            MODEL_REVISION,
            "--served-model-name",
            SERVED_NAME,
            "--host",
            "0.0.0.0",
            "--port",
            str(VLLM_PORT),
            "--max-model-len",
            str(MAX_MODEL_LEN),
            "--limit-mm-per-prompt",
            json.dumps({"image": 0, "video": 0, "audio": 0}),
            "--enable-auto-tool-choice",
            "--tool-call-parser",
            TOOL_CALL_PARSER,
            "--reasoning-parser",
            REASONING_PARSER,
            # Request bodies are financial data and must not be logged.
            # Recent vLLM doesn't log them by default; never add
            # --enable-log-requests here.
            "--enforce-eager" if FAST_BOOT else "--no-enforce-eager",
        ]
        print(*cmd)
        # VLLM_API_KEY is read from the environment by vLLM itself, so the
        # key never appears on a command line or in the printout above.
        self.process = subprocess.Popen(cmd)

    @modal.exit()
    def stop(self):
        self.process.terminate()
