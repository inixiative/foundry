#!/usr/bin/env bash
# Install the Warden pre-filter model: Laya (ConvAI, Apache-2.0, ModernBERT-large decision model),
# served on TypeSafe's System One API by `laya-serve`. Everything lands under ~/.foundry/models
# (override with FOUNDRY_MODELS): the virtual environment and the weights. Nothing goes into a
# repository. Needs uv (brew install uv).
#
#   bash scripts/evals/warden-prefilter-setup.sh          # install
#   bash scripts/evals/warden-prefilter-setup.sh serve    # serve on 127.0.0.1:${LAYA_PORT:-8600}
#
# 8600 is the port registry's `decisions` service (default 8100) in Foundry's block (5).
set -euo pipefail

MODELS="${FOUNDRY_MODELS:-$HOME/.foundry/models}"
VENV="$MODELS/venvs/laya"
export HF_HOME="$MODELS/hf"
export UV_CACHE_DIR="$MODELS/uv-cache"

if [ "${1:-}" = serve ]; then
  export LAYA_DEVICE="${LAYA_DEVICE:-mps}" LAYA_PRELOAD=1 LAYA_MODELS="${LAYA_MODELS:-english}"
  export LAYA_HOST=127.0.0.1 LAYA_PORT="${LAYA_PORT:-8600}" LAYA_LOG_LEVEL="${LAYA_LOG_LEVEL:-warning}"
  exec "$VENV/bin/laya-serve"
fi

command -v uv >/dev/null || { echo "uv is required (brew install uv)" >&2; exit 1; }
mkdir -p "$MODELS/venvs" "$HF_HOME"
[ -x "$VENV/bin/python" ] || uv venv --python 3.12 "$VENV"
VIRTUAL_ENV="$VENV" uv pip install "laya[serve]" huggingface_hub
"$VENV/bin/hf" download convaiinnovations/laya >/dev/null
echo "Laya installed under $MODELS; serve it with: bash $0 serve"
