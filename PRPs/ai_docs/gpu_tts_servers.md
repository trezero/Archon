# GPU-Accelerated OpenAI-Compatible TTS Servers

Research date: 2026-03-18

This document covers self-hosted TTS servers that expose an OpenAI-compatible
`POST /v1/audio/speech` endpoint and support NVIDIA CUDA GPU acceleration.

---

## Quick Comparison

| Server | Model | VRAM | GPU RTF | First Token | Voices | Status |
|---|---|---|---|---|---|---|
| **Kokoro-FastAPI** | Kokoro-82M (PyTorch) | ~2GB | 35-96x | ~300ms | 48 | Active |
| **OpenedAI-Speech** | XTTS v2 + Piper | ~4GB (XTTS) | ~3x (XTTS) / CPU (Piper) | slow | 6 configurable | Archived Jan 2026 |
| **Orpheus-FastAPI** | Orpheus-3B (LLM) | ~4-8GB | fast | ~200ms | 8 EN + multilingual | Active |
| **Chatterbox-TTS-Server** | Chatterbox (0.5B diffusion) | ~8GB est. | moderate | unknown | cloning + presets | Active |

---

## Option 1: Kokoro-FastAPI (Recommended for GPU)

**Repository**: https://github.com/remsky/Kokoro-FastAPI

This is the strongest option for GPU-accelerated, OpenAI-compatible TTS. It wraps
the Kokoro-82M model (350MB weights) with a FastAPI server. Crucially, the GPU
path uses native PyTorch (not ONNX), which delivers significantly better GPU
throughput than ONNX runtime.

### Why PyTorch beats ONNX on GPU

Benchmarks on real hardware (RTF = audio_duration / generation_time, higher is faster):

| GPU | PyTorch RTF | ONNX RTF |
|---|---|---|
| NVIDIA A10G | 96x | 32x |
| NVIDIA L4 | 81x | 37x |
| NVIDIA T4 | 36x | 20x |
| CPU (32-core) | 5x | 5x |

The ONNX runtime adds 39 memcpy nodes to the CUDA graph, degrading GPU performance.
Use PyTorch (GPU image) whenever a CUDA GPU is available.

### Docker installation

```bash
# Quick start - GPU (NVIDIA, CUDA 12.8)
docker run --gpus all -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-gpu:latest

# Quick start - CPU fallback
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

### Docker Compose (GPU) - full file

```yaml
name: kokoro-tts-gpu

services:
  kokoro-tts:
    image: ghcr.io/remsky/kokoro-fastapi-gpu:latest
    # build from source alternative:
    # build:
    #   context: ../..
    #   dockerfile: docker/gpu/Dockerfile
    volumes:
      - ../../api:/app/api
    ports:
      - "8880:8880"
    environment:
      - PYTHONPATH=/app:/app/api
      - USE_GPU=true
      - PYTHONUNBUFFERED=1
      - API_LOG_LEVEL=INFO
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

### Build from source

```bash
git clone https://github.com/remsky/Kokoro-FastAPI.git
cd Kokoro-FastAPI
cd docker/gpu   # or docker/cpu
docker compose up --build
```

### API endpoints

| Endpoint | Description |
|---|---|
| `POST /v1/audio/speech` | OpenAI-compatible TTS (primary) |
| `GET /v1/audio/voices` | List available voices |
| `POST /v1/audio/voices/combine` | Combine voices with weights |
| `GET /dev/phonemize` | Text to phonemes |
| `POST /dev/generate_from_phonemes` | Audio from phonemes |
| `POST /dev/captioned_speech` | Audio with word-level timestamps |
| `GET /debug/system` | System stats |

### Request format (OpenAI-compatible)

```bash
curl http://localhost:8880/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kokoro",
    "input": "Hello, this is a test.",
    "voice": "af_bella",
    "response_format": "mp3",
    "speed": 1.0
  }' \
  --output speech.mp3
```

### Voice mixing

```bash
# Blend two voices: 67% af_bella, 33% af_sky
"voice": "af_bella(2)+af_sky(1)"
```

### Available voices (48 total across 8 languages)

Naming convention: `{accent}{gender}_{name}` where `a`=American, `b`=British,
`f`=female, `m`=male.

**American English female**: af, af_bella, af_irulan, af_nicole, af_sarah, af_sky, af_heart
**American English male**: am_adam, am_michael, am_gurney
**British English female**: bf_emma, bf_isabella
**British English male**: bm_george, bm_lewis
**French, Hindi, Spanish, Japanese, Chinese, Portuguese**: additional voices
**Total**: 48 voices across 8 languages

### Performance numbers

- GPU first-token latency: ~300ms at chunk size 400
- CPU first-token latency: ~3500ms (older i7), <1000ms (M3 Pro)
- Throughput: 137.67 tokens/second (RTX 4060Ti 16GB benchmark)
- GPU: NVIDIA with CUDA 12.8 required
- VRAM: ~2GB (82M parameter model is small)

### Output formats

MP3, WAV, Opus, FLAC, M4A, PCM

### Environment variables

```bash
API_LOG_LEVEL=INFO          # DEBUG, INFO, WARNING, ERROR
TARGET_MIN_TOKENS=175       # Minimum chunk size for streaming
TARGET_MAX_TOKENS=250       # Target chunk size
ABSOLUTE_MAX_TOKENS=450     # Hard maximum chunk size
USE_GPU=true                # Enable GPU mode
```

### WSL2 notes

The Docker GPU image works under WSL2 when the NVIDIA Container Toolkit is
installed in WSL2. Standard Docker Desktop with WSL2 backend and CUDA support
enabled will work with `--gpus all`. No WSL2-specific workarounds documented.

---

## Option 2: OpenedAI-Speech (ARCHIVED - use with caution)

**Repository**: https://github.com/matatonic/openedai-speech

**STATUS: Archived January 4, 2026 - read-only, no further updates.**

This was the original "drop-in replacement" for OpenAI TTS. It supports two backends:
- `tts-1` model name -> Piper TTS (CPU-only, very fast)
- `tts-1-hd` model name -> Coqui XTTS v2 (GPU, ~4GB VRAM, voice cloning)

The archive status means no Kokoro support was ever added and no bug fixes will come.
It remains functional for XTTS v2 use cases but Kokoro-FastAPI is the better choice
for GPU-accelerated quality TTS going forward.

### Docker installation

```bash
# Nvidia GPU (CUDA) - XTTS v2 + Piper
docker compose up

# AMD GPU (ROCm)
docker compose -f docker-compose.rocm.yml up

# CPU only / Piper only (minimal, <1GB image)
docker compose -f docker-compose.min.yml up
```

### speech.env configuration

```bash
TTS_HOME=voices
HF_HOME=voices
# PRELOAD_MODEL=xtts          # Preload on startup
# PRELOAD_MODEL=xtts_v2.0.2  # Specific version
# EXTRA_ARGS=--log-level DEBUG --unload-timer 300
# USE_ROCM=1                  # AMD GPU
```

### Server flags

```
--xtts_device cuda     # Device for XTTS (default: cuda; use 'none' for piper-only)
--preload MODEL        # Preload model at startup
--unload-timer SECS    # Unload idle model to free GPU VRAM
--port PORT            # Default: 8000
--host HOST            # Default: 0.0.0.0
--log-level LEVEL      # DEBUG, INFO, WARNING, ERROR, CRITICAL
```

### XTTS v2 performance

- VRAM: ~4GB required
- Real-time factor on GPU: approximately 3x (slow for large texts)
- Maximum 2-3 simultaneous streams before audio underrun
- XTTS on CPU: "very slow" per the docs

### Voice configuration

Voices are configured via `voice_to_speaker.yaml`. Defaults map to the 6 OpenAI
voice names: alloy, echo, fable, onyx, nova, shimmer.

### API port

Default: 8000 (vs Kokoro-FastAPI's 8880)

---

## Option 3: Orpheus-FastAPI (Best voice quality, higher VRAM cost)

**Repository**: https://github.com/Lex-au/Orpheus-FastAPI
**llama.cpp variant**: https://github.com/richardr1126/LlamaCpp-Orpheus-FastAPI

Orpheus is fundamentally different from the others: it is an **LLM-based TTS system**
built on a Llama-3B backbone. Text goes in, speech tokens come out, then SNAC decodes
to audio. This architecture gives it exceptional prosody and emotion expressiveness,
but it requires more VRAM and has a more complex deployment (two services: FastAPI
frontend + llama.cpp inference backend).

### VRAM requirements

- Q8_0 (3B, 8-bit): ~4GB VRAM (typical for 3B @ 8-bit)
- Q4_K_M (3B, 4-bit): ~2-3GB VRAM
- Q2_K (3B, 2-bit): ~1.5-2GB VRAM (50% faster than Q8_0, lower quality)
- High-end GPU mode auto-activates at 16GB+ VRAM (compute 8.0+) or 12GB+ (7.0+)

### Docker installation (GPU)

```bash
git clone https://github.com/Lex-au/Orpheus-FastAPI.git
cd Orpheus-FastAPI
cp .env.example .env
# Edit .env to set model name
docker compose -f docker-compose-gpu.yml up
```

### .env configuration

```bash
ORPHEUS_API_URL=http://llama-cpp-server:5006/v1/completions
ORPHEUS_API_TIMEOUT=120
ORPHEUS_MAX_TOKENS=8192
ORPHEUS_TEMPERATURE=0.6
ORPHEUS_TOP_P=0.9
ORPHEUS_SAMPLE_RATE=24000
ORPHEUS_PORT=5005
ORPHEUS_HOST=0.0.0.0
# Model file to use (downloaded automatically):
ORPHEUS_MODEL_NAME=Orpheus-3b-FT-Q8_0.gguf
```

### Model options

```bash
# High quality (original)
ORPHEUS_MODEL_NAME=Orpheus-3b-FT-Q8_0.gguf

# Balanced (recommended for most GPUs)
ORPHEUS_MODEL_NAME=Orpheus-3b-FT-Q4_K_M.gguf

# Fastest, lowest quality
ORPHEUS_MODEL_NAME=Orpheus-3b-FT-Q2_K.gguf

# Language-specific finetuned models
ORPHEUS_MODEL_NAME=Orpheus-3b-French-FT-Q8_0.gguf
```

### API request format

```bash
curl http://localhost:5005/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "orpheus",
    "input": "Hello! <laugh> This is amazing.",
    "voice": "tara",
    "response_format": "wav",
    "speed": 1.0
  }' \
  --output speech.wav
```

### Emotion tags (unique to Orpheus)

```
<laugh>   <chuckle>  <sigh>   <cough>
<sniffle> <groan>    <yawn>   <gasp>
```

### Available voices

**English (8)**: tara, leah, jess, leo, dan, mia, zac, zoe
**French (3)**: pierre, amelie, marie
**German (3)**: jana, thomas, max
**Korean (2)**: 유나, 준서
**Hindi (1)**: ऋतिका
**Mandarin (2)**: 长乐, 白芷
**Spanish (3)**: javi, sergio, maria
**Italian (3)**: pietro, giulia, carlo

### Latency

- Streaming first-token latency: ~200ms (from canopy/Orpheus-TTS upstream)
- Reducible to ~100ms with input streaming
- GPU requirements: CUDA 12.4+, NVIDIA Container Toolkit

### Processing architecture

- 4 parallel workers on high-end GPUs (16GB+ VRAM)
- 2 parallel workers on CPU mode
- Token batching: 7-token batches, 49-token context window
- Sentence-based batching for long-form with 50ms crossfade stitching

### Access points

- API: `http://localhost:5005`
- Web UI: `http://localhost:5005/`
- Swagger docs: `http://localhost:5005/docs`

---

## Option 4: Chatterbox-TTS-Server (Voice Cloning + Multilingual)

**Repository**: https://github.com/devnen/Chatterbox-TTS-Server

Chatterbox is a 0.5B diffusion-based TTS model from Resemble AI. The notable
differentiator is real-time voice cloning from a reference audio file plus emotion
exaggeration control. It supports NVIDIA CUDA, AMD ROCm, and Apple Silicon MPS.

### Docker installation

```bash
# Standard CUDA 12.1
docker compose up -d

# CUDA 12.8 (RTX 5090/Blackwell series)
docker compose -f docker-compose-cu128.yml up -d

# AMD ROCm
docker compose -f docker-compose-rocm.yml up -d

# CPU only
docker compose -f docker-compose-cpu.yml up -d
```

### GPU requirements

- NVIDIA: Maxwell architecture or newer; Driver 525+ for CUDA 12.1, Driver 570+ for CUDA 12.8
- AMD: RX 6000/7000 series, ROCm 6.4+ (Linux only)
- Apple Silicon: M1/M2/M3/M4, macOS 12.3+
- Estimated VRAM: ~8GB (0.5B diffusion model + voice encoder)

### Model variants

| Model | Parameters | Languages | Notes |
|---|---|---|---|
| Original Chatterbox | 0.5B | English only | Best EN quality, emotion exaggeration |
| Chatterbox Multilingual | 0.5B | 23 languages | Voice cloning + emotion |
| Chatterbox-Turbo | 350M | English | 1-step diffusion, fastest |

### API endpoints

```bash
# OpenAI-compatible endpoint
POST /v1/audio/speech

# Full-featured TTS endpoint
POST /tts

# Health / initial data
GET /api/ui/initial-data
```

### Voice cloning request example

```bash
curl http://localhost:8000/tts \
  -F "text=Hello world" \
  -F "voice_mode=clone" \
  -F "reference_audio=@voice_sample.wav" \
  -F "exaggeration=0.5" \
  --output output.wav
```

---

## Option 5: Dia-TTS-Server (Dialogue Generation)

**Repository**: https://github.com/devnen/Dia-TTS-Server

A specialized server for dialogue generation with voice cloning, safetensors/BF16
support, and OpenAI-compatible API. Good for multi-speaker scenarios. CUDA GPU
support with CPU fallback.

---

## WSL2 General Guidance

All Docker-based options work under WSL2 when properly configured:

1. Install NVIDIA drivers on Windows host (NOT inside WSL2)
2. Install NVIDIA Container Toolkit inside WSL2:
   ```bash
   distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
   curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
   curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | \
     sudo tee /etc/apt/sources.list.d/nvidia-docker.list
   sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
   sudo systemctl restart docker
   ```
3. Verify: `docker run --gpus all nvidia/cuda:12.0-base-ubuntu22.04 nvidia-smi`
4. Docker Compose GPU reservations (`capabilities: [gpu]`) work identically to Linux

---

## Recommendation Summary

### For general-purpose high-quality TTS with minimal VRAM

Use **Kokoro-FastAPI** (GPU image). The 82M model fits in ~2GB VRAM, delivers
35-96x real-time on any modern NVIDIA GPU, has 48 voices across 8 languages,
and voice blending. Port 8880, image `ghcr.io/remsky/kokoro-fastapi-gpu:latest`.

### For best voice expressiveness (natural prosody, emotion)

Use **Orpheus-FastAPI** with Q4_K_M quantization. The LLM backbone produces the
most human-like output. Requires ~2-3GB VRAM at Q4_K_M. Port 5005.

### For voice cloning from reference audio

Use **Chatterbox-TTS-Server**. Upload a `.wav` reference and clone any voice.
Supports 23 languages. Port 8000.

### For drop-in OpenAI TTS compatibility with XTTS v2 voices

Use **OpenedAI-Speech** if you need XTTS v2 voice cloning or exact OpenAI API
compatibility (same voice names: alloy/echo/fable/onyx/nova/shimmer). Be aware
it is archived and unmaintained as of January 2026.

---

## Sources

- [Kokoro-FastAPI GitHub](https://github.com/remsky/Kokoro-FastAPI)
- [Kokoro-FastAPI GPU docker-compose.yml](https://github.com/remsky/Kokoro-FastAPI/blob/master/docker/gpu/docker-compose.yml)
- [Kokoro v1 Benchmark (PyTorch/ONNX, CPU/GPU)](https://gist.github.com/efemaer/23d9a3b949b751dde315192b4dcf0653)
- [OpenedAI-Speech GitHub](https://github.com/matatonic/openedai-speech)
- [Orpheus-FastAPI GitHub](https://github.com/Lex-au/Orpheus-FastAPI)
- [LlamaCpp-Orpheus-FastAPI GitHub](https://github.com/richardr1126/LlamaCpp-Orpheus-FastAPI)
- [canopyai/Orpheus-TTS GitHub](https://github.com/canopyai/Orpheus-TTS)
- [Chatterbox-TTS-Server GitHub](https://github.com/devnen/Chatterbox-TTS-Server)
- [Dia-TTS-Server GitHub](https://github.com/devnen/Dia-TTS-Server)
- [kokoro-onnx GPU performance issue](https://github.com/thewh1teagle/kokoro-onnx/issues/112)
- [Kokoro FastAPI install guide (noted.lol)](https://noted.lol/kokoro-fastapi/)
