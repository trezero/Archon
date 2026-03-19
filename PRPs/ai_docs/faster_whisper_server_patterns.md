# faster-whisper-server (speaches) Patterns

## Overview

The canonical OpenAI-compatible speech-to-text server built on faster-whisper is
**speaches** (formerly known as faster-whisper-server by fedirz, now continued as
speaches-ai/speaches). It exposes `/v1/audio/transcriptions` compatible with the
OpenAI SDK and accepts any HuggingFace `Systran/faster-whisper-*` model ID at
request time — no server restart needed.

- GitHub: https://github.com/speaches-ai/speaches
- Docs: https://speaches.ai/
- License: MIT
- Active as of v0.9.0 (Dec 2025)

## Docker Installation (GPU/CUDA — Recommended)

### One-liner (CUDA 12.6)

```bash
docker run --rm --detach \
  --publish 8000:8000 \
  --gpus=all \
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cuda
```

### Docker Compose (CUDA) — recommended for persistent use

```bash
# Download the compose files
curl -sO https://raw.githubusercontent.com/speaches-ai/speaches/main/compose.yaml
curl -sO https://raw.githubusercontent.com/speaches-ai/speaches/main/compose.cuda.yaml

# Launch
COMPOSE_FILE=compose.cuda.yaml docker compose up --detach
```

The `compose.cuda.yaml` content:
```yaml
services:
  speaches:
    extends:
      file: compose.yaml
      service: speaches
    image: ghcr.io/speaches-ai/speaches:latest-cuda-12.6.3
    build:
      args:
        BASE_IMAGE: nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04
    volumes:
      - hf-hub-cache:/home/ubuntu/.cache/huggingface/hub
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
volumes:
  hf-hub-cache:
```

### Alternative image tags
- `ghcr.io/speaches-ai/speaches:latest-cuda-12.6.3` — CUDA 12.6 + cuDNN 9
- `ghcr.io/speaches-ai/speaches:latest-cuda-12.4.1` — CUDA 12.4 + cuDNN 9
- `ghcr.io/speaches-ai/speaches:latest-cpu` — CPU only

### CPU-only (no GPU)

```bash
docker run --rm --detach \
  --publish 8000:8000 \
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu
```

## pip / uv Installation (Local Python)

Requires CUDA 12 + cuDNN 9 libraries on host, or install via pip:

```bash
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*
export LD_LIBRARY_PATH=$(python3 -c \
  'import os; import nvidia.cublas.lib; import nvidia.cudnn.lib; \
   print(os.path.dirname(nvidia.cublas.lib.__file__) + ":" + \
         os.path.dirname(nvidia.cudnn.lib.__file__))')

# Install speaches
git clone https://github.com/speaches-ai/speaches && cd speaches
uv python install && uv venv && source .venv/bin/activate
uv sync
uvicorn --factory --host 0.0.0.0 speaches.main:create_app
```

Note: ctranslate2 requires CUDA 12 + cuDNN 9. For older setups:
- CUDA 11 + cuDNN 8: pin `ctranslate2==3.24.0`
- CUDA 12 + cuDNN 8: pin `ctranslate2==4.4.0`

## Available Models

Models are specified by their HuggingFace ID. The server downloads them on first use.

| Model ID | VRAM (fp16) | VRAM (int8) | Speed | Notes |
|----------|-------------|-------------|-------|-------|
| `Systran/faster-whisper-tiny` | ~0.4 GB | ~0.2 GB | Fastest | Low accuracy |
| `Systran/faster-whisper-base` | ~0.6 GB | ~0.3 GB | Very fast | |
| `Systran/faster-whisper-small` | ~1.2 GB | ~0.7 GB | Fast | |
| `Systran/faster-whisper-medium` | ~2.5 GB | ~1.4 GB | Moderate | |
| `Systran/faster-whisper-large-v2` | ~4.5 GB | ~2.9 GB | Slow | High accuracy |
| `Systran/faster-whisper-large-v3` | ~4.5 GB | ~3.0 GB | Slow | Best accuracy |
| `Systran/faster-distil-whisper-large-v3` | ~2.4 GB | ~1.5 GB | 2x faster | Excellent accuracy |
| `Systran/faster-whisper-large-v3-turbo` | ~2.5 GB | ~1.5 GB | 2.7x faster | Best speed/accuracy |

VRAM figures are for a 13-minute audio clip on an RTX 3070 Ti (from benchmarks):
- `large-v3` fp16: 4521 MB, 52s transcription time
- `large-v3` int8: 2953 MB, 53s transcription time
- `distil-large-v3` fp16: 2409 MB, 26s transcription time
- `distil-large-v3` int8: 1481 MB, 22s transcription time
- `large-v3-turbo` fp16: 2537 MB, 19s transcription time
- `large-v3-turbo` int8: 1545 MB, 19s transcription time

Model weights size (fp16): large-v3 = 2.87 GB, int8 quantized = 1.44 GB

## OpenAI API Compatibility

### Endpoint
`POST /v1/audio/transcriptions`

### curl example
```bash
curl http://localhost:8000/v1/audio/transcriptions \
  -F "file=@audio.wav" \
  -F "model=Systran/faster-whisper-large-v3"
```

### With response_format
```bash
curl http://localhost:8000/v1/audio/transcriptions \
  -F "file=@audio.wav" \
  -F "model=Systran/faster-whisper-large-v3" \
  -F "response_format=text"
```

### Python with OpenAI SDK
```python
import openai

client = openai.OpenAI(
    base_url="http://localhost:8000/v1",
    api_key="cant-be-empty",  # required by SDK but not validated
)

with open("audio.wav", "rb") as f:
    transcript = client.audio.transcriptions.create(
        model="Systran/faster-whisper-large-v3",
        file=f,
    )
print(transcript.text)
```

### Python with httpx (no OpenAI SDK)
```python
import httpx

with open("audio.wav", "rb") as f:
    response = httpx.post(
        "http://localhost:8000/v1/audio/transcriptions",
        files={"file": ("audio.wav", f)},
        data={"model": "Systran/faster-whisper-large-v3"},
    )
print(response.json()["text"])
```

### Also supported
- `/v1/audio/translations` — translate audio to English
- Streaming transcription via SSE (not in OpenAI spec, speaches extension)
- WebSocket live transcription (WIP)

## Environment Variables / Configuration

All config via environment variables (double-underscore for nested fields):

| Env Var | Default | Description |
|---------|---------|-------------|
| `UVICORN_HOST` | `0.0.0.0` | Bind address |
| `UVICORN_PORT` | `8000` | Port |
| `WHISPER__INFERENCE_DEVICE` | `auto` | `auto`, `cuda`, `cpu` |
| `WHISPER__COMPUTE_TYPE` | `default` | `float16`, `int8`, `int8_float16`, `bfloat16`, `float32` |
| `WHISPER__DEVICE_INDEX` | `0` | GPU device index (int or list) |
| `WHISPER__CPU_THREADS` | `0` | CPU thread count (0 = auto) |
| `WHISPER__NUM_WORKERS` | `1` | Parallel worker count |
| `STT_MODEL_TTL` | `300` | Seconds before model unloaded (-1 = never) |
| `API_KEY` | `None` | Optional API key auth |
| `PRELOAD_MODELS` | `[]` | JSON list of model IDs to preload on startup |
| `ENABLE_UI` | `true` | Gradio web UI |
| `LOG_LEVEL` | `debug` | Logging level |
| `ALLOW_ORIGINS` | `None` | JSON list for CORS, e.g. `'["*"]'` |

### Example .env for GPU with large-v3-turbo preloaded

```bash
UVICORN_PORT=8000
WHISPER__INFERENCE_DEVICE=cuda
WHISPER__COMPUTE_TYPE=float16
STT_MODEL_TTL=-1
PRELOAD_MODELS=["Systran/faster-whisper-large-v3-turbo"]
ENABLE_UI=false
```

### Docker run with env vars

```bash
docker run --rm --detach \
  --publish 8000:8000 \
  --gpus=all \
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  -e WHISPER__INFERENCE_DEVICE=cuda \
  -e WHISPER__COMPUTE_TYPE=float16 \
  -e STT_MODEL_TTL=-1 \
  -e PRELOAD_MODELS='["Systran/faster-whisper-large-v3-turbo"]' \
  ghcr.io/speaches-ai/speaches:latest-cuda
```

## WSL2-Specific Considerations

### Key Rule
**Do NOT install an NVIDIA GPU driver inside WSL2.** The Windows NVIDIA driver is
automatically stubbed as `libcuda.so` inside WSL2. Only install the CUDA toolkit
(not the full driver).

### Requirements
1. Windows 10 (21H2+) or Windows 11
2. NVIDIA Windows driver with WSL CUDA support (download from nvidia.com/download)
3. WSL2 kernel 5.10.43.3 or higher (`wsl cat /proc/version` to check)
4. NVIDIA Container Toolkit inside WSL2:

```bash
# Install NVIDIA Container Toolkit inside WSL2 Ubuntu
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo service docker restart
```

5. Verify GPU is accessible inside WSL2:
```bash
nvidia-smi        # should show your GPU
docker run --rm --gpus=all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
```

### Docker daemon config in WSL2 (`/etc/docker/daemon.json`)
```json
{
  "runtimes": {
    "nvidia": {
      "args": [],
      "path": "nvidia-container-runtime"
    }
  },
  "default-runtime": "nvidia"
}
```

## VRAM Requirements Summary

For GPU inference (actual runtime VRAM, not model file size):

| Model | fp16 VRAM | int8 VRAM | Min GPU |
|-------|-----------|-----------|---------|
| tiny | ~0.4 GB | ~0.2 GB | Any |
| base | ~0.6 GB | ~0.3 GB | Any |
| small | ~1.2 GB | ~0.7 GB | 4 GB+ |
| medium | ~2.5 GB | ~1.4 GB | 4 GB+ |
| large-v3 | ~4.5 GB | ~3.0 GB | 6 GB+ (int8), 8 GB+ (fp16) |
| distil-large-v3 | ~2.4 GB | ~1.5 GB | 4 GB+ |
| large-v3-turbo | ~2.5 GB | ~1.5 GB | 4 GB+ |

Recommendation: For 8 GB VRAM, use `large-v3` with `int8` or `large-v3-turbo` with `float16`.

## Gotchas

- **Model ID format**: Must use the full HuggingFace ID `Systran/faster-whisper-large-v3`, not just `large-v3`. The server fetches models from HuggingFace Hub on first use.
- **API key**: OpenAI SDK requires `api_key` to be non-empty. Pass any placeholder value like `"cant-be-empty"`. Server does not validate it unless `API_KEY` env var is set.
- **CUDA versions**: ctranslate2 (the inference engine) requires CUDA 12 + cuDNN 9 in latest versions. Older CUDA requires pinning ctranslate2 version.
- **WSL2 driver**: Never install NVIDIA Linux drivers inside WSL2; the Windows driver provides the GPU stub automatically.
- **Model download on first request**: Without `PRELOAD_MODELS`, the first request will block while downloading the model. Large models (large-v3) are ~3 GB. Use `PRELOAD_MODELS` to download at container startup.
- **Port conflict**: Default port 8000 may conflict with other services. Use `UVICORN_PORT=8001` or `-p 8001:8000` to remap.
- **VAD filter**: `_unstable_vad_filter=True` by default. This deviates slightly from the OpenAI spec but prevents hallucinations on silent audio segments.

## Related Projects

- **fedirz/faster-whisper-server**: The original project (now superseded by speaches). Still functional with same Docker command pattern: `docker run --gpus=all --publish 8000:8000 fedirz/faster-whisper-server:latest-cuda`
- **linuxserver/faster-whisper**: Wyoming protocol adapter (port 10300, not OpenAI compatible — used for Home Assistant)
- **SYSTRAN/faster-whisper**: The core inference library (not a server)
