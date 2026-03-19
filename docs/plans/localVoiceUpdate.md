# Local GPU Voice Mode — Setup Plan

## Goal

Replace CPU-based Whisper.cpp and unconfigured Kokoro ONNX with GPU-accelerated,
OpenAI-compatible STT and TTS services running on the local RTX A6000 (48GB) and
RTX 3060 Ti (8GB). Voice-mode MCP already supports custom endpoints — we just need
the right backends.

## Current State

| Component | Status | Notes |
|-----------|--------|-------|
| **Voice-mode MCP** | Running | `PREFER_LOCAL=true`, endpoints at 127.0.0.1:8880 (TTS) and 127.0.0.1:2022 (STT) |
| **Whisper.cpp** | Installed, not running | `ggml-base.bin` model only (148MB, CPU) |
| **Kokoro** | Configured, not installed | No models downloaded, ONNX (CPU) path |
| **PulseAudio (WSLg)** | Working | `/mnt/wslg/PulseServer` confirmed |
| **NVIDIA drivers** | Working | Windows host driver 560.94, `nvidia-smi` works in WSL |
| **Docker** | Installed | Needs NVIDIA Container Toolkit verification |

## Hardware

| GPU | VRAM | Use |
|-----|------|-----|
| RTX A6000 | 48 GB | Primary — TTS + STT (plenty of headroom) |
| RTX 3060 Ti | 8 GB | Available as overflow |

## Recommended Stack

### STT: Speaches (formerly faster-whisper-server)

**Why**: Drop-in OpenAI `/v1/audio/transcriptions` compatible, CTranslate2 backend
with native CUDA, dramatically faster than whisper.cpp on GPU.

- **Repo**: https://github.com/speaches-ai/speaches
- **Model**: `Systran/faster-whisper-large-v3-turbo` (fp16, ~2.5GB VRAM, best speed/accuracy)
- **Port**: 2022 (matches current voice-mode config)
- **VRAM**: ~2.5 GB

### TTS: Kokoro-FastAPI (GPU / PyTorch)

**Why**: 48 voices, 82M param model, ~2GB VRAM, 96x real-time factor on A-series GPUs.
PyTorch backend is 2-3x faster than ONNX on GPU. Fully OpenAI `/v1/audio/speech` compatible.
Already configured as port 8880 in voice-mode.

- **Repo**: https://github.com/remsky/Kokoro-FastAPI
- **Model**: Kokoro-82M (PyTorch, ~350MB weights)
- **Port**: 8880 (matches current voice-mode config)
- **VRAM**: ~2 GB

### Total VRAM: ~4.5 GB on A6000 (9% utilization)

### Alternative TTS: Orpheus-FastAPI (if more expressiveness needed later)

- LLM-based TTS (Llama-3B backbone), emotion tags (`<laugh>`, `<sigh>`)
- 2-4GB VRAM (Q4_K_M quantization)
- https://github.com/Lex-au/Orpheus-FastAPI
- Can run alongside Kokoro on a different port if desired

---

## Implementation Steps

### Phase 1: Prerequisites (NVIDIA Container Toolkit)

Docker GPU passthrough may already work. Verify first, install only if needed.

```bash
# Test GPU passthrough
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi

# If the above fails, install NVIDIA Container Toolkit:
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

**Important**: Never install NVIDIA GPU drivers inside WSL2. The Windows host driver
provides `libcuda.so` automatically.

### Phase 2: Deploy Speaches (GPU STT)

```bash
docker run --rm --detach \
  --name speaches-stt \
  --publish 2022:8000 \
  --gpus '"device=0"' \
  -e WHISPER__INFERENCE_DEVICE=cuda \
  -e WHISPER__COMPUTE_TYPE=float16 \
  -e WHISPER__DEVICE_INDEX=0 \
  -e STT_MODEL_TTL=-1 \
  -e 'PRELOAD_MODELS=["Systran/faster-whisper-large-v3-turbo"]' \
  -e ENABLE_UI=false \
  --volume speaches-models:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cuda
```

**Verify**:
```bash
# Wait for model download on first run (~1.5GB), then:
curl -s http://127.0.0.1:2022/v1/audio/transcriptions \
  -F "file=@test.wav" \
  -F "model=Systran/faster-whisper-large-v3-turbo"
```

**Notes**:
- Port mapping `2022:8000` — speaches defaults to 8000 internally, we expose on 2022
  to match voice-mode config
- `device=0` targets the A6000 (verify GPU index with `nvidia-smi`)
- `PRELOAD_MODELS` avoids first-request latency
- `STT_MODEL_TTL=-1` keeps model in VRAM permanently
- Model ID must be full HuggingFace path (e.g. `Systran/faster-whisper-large-v3-turbo`)

### Phase 3: Deploy Kokoro-FastAPI (GPU TTS)

```bash
docker run --rm --detach \
  --name kokoro-tts \
  --publish 8880:8880 \
  --gpus '"device=0"' \
  -e USE_GPU=true \
  ghcr.io/remsky/kokoro-fastapi-gpu:latest
```

**Verify**:
```bash
curl http://127.0.0.1:8880/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"kokoro","input":"Hello from the GPU.","voice":"af_sky","response_format":"mp3"}' \
  --output /tmp/test_tts.mp3 && ls -la /tmp/test_tts.mp3
```

**Notes**:
- Kokoro-FastAPI GPU image uses CUDA 12.8 and PyTorch
- Web UI available at `http://127.0.0.1:8880/web` for testing voices
- 48 voices available: `af_sky`, `af_bella`, `am_adam`, `bf_emma`, `bm_george`, etc.
- Voice blending: `"voice": "af_bella(2)+af_sky(1)"` for 67%/33% mix

### Phase 4: Update Voice-Mode Configuration

Edit `~/.voicemode/voicemode.env`:

```bash
# GPU-accelerated local services (primary), OpenAI cloud (fallback)
export VOICEMODE_TTS_BASE_URLS="http://127.0.0.1:8880/v1,https://api.openai.com/v1"
export VOICEMODE_STT_BASE_URLS="http://127.0.0.1:2022/v1,https://api.openai.com/v1"

# Prefer local GPU services
export VOICEMODE_PREFER_LOCAL="true"
export VOICEMODE_ALWAYS_TRY_LOCAL="true"

# Kokoro voices (instead of OpenAI voice names)
export VOICEMODE_VOICES="af_sky,af_bella"

# Audio formats
export VOICEMODE_TTS_AUDIO_FORMAT="pcm"
export VOICEMODE_STT_AUDIO_FORMAT="mp3"

# Disable auto-start of old CPU whisper
# (we're using speaches Docker container instead)
```

Optionally also update `.mcp.json` if voice-mode env overrides are set there:

```json
{
  "mcpServers": {
    "voice-mode": {
      "command": "uvx",
      "args": ["voice-mode"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "VOICEMODE_TTS_BASE_URLS": "http://127.0.0.1:8880/v1,https://api.openai.com/v1",
        "VOICEMODE_STT_BASE_URLS": "http://127.0.0.1:2022/v1,https://api.openai.com/v1",
        "VOICEMODE_PREFER_LOCAL": "true",
        "VOICEMODE_ALWAYS_TRY_LOCAL": "true",
        "VOICEMODE_VOICES": "af_sky,af_bella",
        "VOICEMODE_TTS_AUDIO_FORMAT": "pcm",
        "VOICEMODE_STT_AUDIO_FORMAT": "mp3"
      }
    }
  }
}
```

### Phase 5: End-to-End Test

1. Restart Claude Code to reload voice-mode config
2. `/voice` to enable voice mode
3. Hold Space, speak, release — verify transcription (STT via speaches)
4. Claude responds with voice — verify audio output (TTS via Kokoro)
5. Check latency is noticeably faster than cloud

### Phase 6: Persistence (Docker Compose)

Once verified, create a `docker-compose.voice.yml` for easy start/stop:

```yaml
name: voice-services
services:
  speaches-stt:
    image: ghcr.io/speaches-ai/speaches:latest-cuda
    ports:
      - "2022:8000"
    environment:
      - WHISPER__INFERENCE_DEVICE=cuda
      - WHISPER__COMPUTE_TYPE=float16
      - WHISPER__DEVICE_INDEX=0
      - STT_MODEL_TTL=-1
      - PRELOAD_MODELS=["Systran/faster-whisper-large-v3-turbo"]
      - ENABLE_UI=false
    volumes:
      - speaches-models:/home/ubuntu/.cache/huggingface/hub
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ["0"]
              capabilities: [gpu]

  kokoro-tts:
    image: ghcr.io/remsky/kokoro-fastapi-gpu:latest
    ports:
      - "8880:8880"
    environment:
      - USE_GPU=true
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ["0"]
              capabilities: [gpu]

volumes:
  speaches-models:
```

Start/stop:
```bash
docker compose -f docker-compose.voice.yml up -d    # Start
docker compose -f docker-compose.voice.yml down      # Stop
docker compose -f docker-compose.voice.yml logs -f    # Tail logs
```

---

## Cleanup (after migration)

- Remove old whisper.cpp installation at `~/.voicemode/services/whisper/` (148MB model + build files)
- Remove `~/.voicemode/models/kokoro/` placeholder directory
- Remove any `VOICEMODE_WHISPER_*` and `VOICEMODE_KOKORO_*` env vars from config (no longer needed)

---

## Future Enhancements

| Enhancement | When | Notes |
|-------------|------|-------|
| **Orpheus-FastAPI** | If more expressive voice needed | LLM-based TTS, emotion tags, 2-4GB VRAM |
| **Chatterbox** | If voice cloning needed | Clone from reference audio, 0.5B diffusion model |
| **Multi-GPU split** | If A6000 gets busy | Move STT to 3060 Ti, keep TTS on A6000 |
| **larger-v3 model** | If turbo accuracy insufficient | `Systran/faster-whisper-large-v3` at ~4.5GB VRAM |

---

## Quick Reference

| Service | URL | GPU | VRAM | Docker Image |
|---------|-----|-----|------|--------------|
| Speaches STT | http://127.0.0.1:2022 | A6000 | ~2.5 GB | `ghcr.io/speaches-ai/speaches:latest-cuda` |
| Kokoro TTS | http://127.0.0.1:8880 | A6000 | ~2.0 GB | `ghcr.io/remsky/kokoro-fastapi-gpu:latest` |
| Voice-mode | MCP (stdio) | N/A | N/A | `uvx voice-mode` |
