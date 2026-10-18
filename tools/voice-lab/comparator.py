"""Optional CPU speaker embeddings. Importing this module never downloads assets."""
from dataclasses import dataclass
import hashlib
import importlib.util
import math
import os
from pathlib import Path
import struct

import numpy as np


MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
REVISION = "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286"
WEIGHT_SHA256 = "0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2"
WEIGHT_BYTES = 83316686
MODEL_PATH = Path(__file__).with_name(".models") / "embedding_model.ckpt"
MAX_WAV_BYTES = 10 * 1024 * 1024
RATE = 16000
WARNINGS = [
    "Raw cosine is not a probability, identity proof, quality score or perceptual resemblance rating.",
    "Phrase, language, recording channel and synthetic/real domain differences affect this score.",
    "Short clips are less representative; window spread is observed variation, not statistical confidence.",
    "Energy filtering is a heuristic, not VAD, diarization or automatic single-speaker cleaning.",
]


class Unavailable(Exception):
    """Optional model or runtime cannot provide valid embeddings."""


class StaleReference(Exception):
    """The requested reference has been replaced or cleared."""


def decode_wav(raw):
    """Validate bounded RIFF PCM structure before allocating decoded samples."""
    if not 44 <= len(raw) <= MAX_WAV_BYTES or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("Send a bounded RIFF PCM WAV.")
    if struct.unpack_from("<I", raw, 4)[0] + 8 != len(raw):
        raise ValueError("Incomplete or trailing WAV data.")
    position, fmt, data = 12, None, None
    while position < len(raw):
        if position + 8 > len(raw):
            raise ValueError("Incomplete WAV chunk.")
        kind = raw[position:position + 4]
        size = struct.unpack_from("<I", raw, position + 4)[0]
        start, end = position + 8, position + 8 + size
        if end + (size % 2) > len(raw):
            raise ValueError("Truncated WAV chunk.")
        if kind == b"fmt ":
            if fmt is not None or size < 16:
                raise ValueError("Invalid WAV format chunk.")
            fmt = struct.unpack_from("<HHIIHH", raw, start)
        elif kind == b"data":
            if data is not None:
                raise ValueError("Duplicate audio chunk.")
            data = memoryview(raw)[start:end]
        position = end + (size % 2)
    if fmt is None or data is None:
        raise ValueError("Missing WAV format or audio.")
    encoding, channels, rate, byte_rate, block, bits = fmt
    if (encoding != 1 or channels not in (1, 2) or not 8000 <= rate <= 192000
            or bits not in (8, 16, 24, 32) or block != channels * bits // 8
            or byte_rate != rate * block or len(data) % block):
        raise ValueError("Use PCM WAV, one or two channels, 8–192 kHz, 8/16/24/32 bits.")
    frames = len(data) // block
    if not 2 <= frames / rate <= 60:
        raise ValueError("Audio must be between 2 and 60 seconds.")
    if bits == 8:
        samples = (np.frombuffer(data, dtype=np.uint8).astype(np.float32) - 128) / 128
    elif bits == 24:
        triples = np.frombuffer(data, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        values = triples[:, 0] | (triples[:, 1] << 8) | (triples[:, 2] << 16)
        samples = ((values ^ 0x800000) - 0x800000).astype(np.float32) / 8388608
    else:
        samples = np.frombuffer(data, dtype=f"<i{bits // 8}").astype(np.float32) / (2 ** (bits - 1))
    mono = samples.reshape(-1, channels).mean(axis=1, dtype=np.float32)
    if not np.isfinite(mono).all():
        raise ValueError("Nonfinite audio.")
    return mono, rate


def resample(samples, rate):
    if rate == RATE:
        return np.array(samples, dtype=np.float32, copy=True)
    try:
        from scipy.signal import resample_poly
    except ImportError as error:
        raise Unavailable("Install the isolated comparator runtime.") from error
    divisor = math.gcd(rate, RATE)
    return resample_poly(samples, RATE // divisor, rate // divisor).astype(np.float32)


def windows(samples):
    if (samples.ndim != 1 or not 2 * RATE <= len(samples) <= 60 * RATE
            or not np.isfinite(samples).all()):
        raise ValueError("Invalid mono audio.")
    # Require at least one second of samples above the near-zero threshold.
    # This deliberately does not infer speech, consent or speaker count.
    if np.count_nonzero(np.abs(samples) > 1e-4) < RATE:
        raise ValueError("Insufficient non-silent audio.")
    output = []
    for start in range(0, len(samples), 3 * RATE):
        chunk = samples[start:start + 3 * RATE]
        if len(chunk) >= 2 * RATE and float(np.sqrt(np.mean(chunk ** 2))) > 1e-4:
            output.append(chunk)
        if len(output) == 20:
            break
    if not output:
        raise ValueError("No usable 2–3 second windows.")
    return output


def unit(vector):
    vector = np.asarray(vector, dtype=np.float64).reshape(-1)
    norm = np.linalg.norm(vector)
    if vector.shape != (192,) or not np.isfinite(vector).all() or not np.isfinite(norm) or norm < 1e-12:
        raise Unavailable("The embedding model returned invalid data.")
    return vector / norm


@dataclass(frozen=True)
class Summary:
    vector: np.ndarray
    embeddings: np.ndarray
    duration: float
    used_duration: float

    def metadata(self):
        return {"durationSeconds": self.duration, "usedSeconds": self.used_duration,
                "windowCount": len(self.embeddings)}


def compare_summaries(reference, candidate, reference_id):
    pairs = np.clip(reference.embeddings @ candidate.embeddings.T, -1, 1)
    return {"cosine": float(np.clip(reference.vector @ candidate.vector, -1, 1)),
            "referenceId": reference_id, "reference": reference.metadata(),
            "candidate": candidate.metadata(), "model": MODEL_ID, "revision": REVISION,
            "pairWindowSpread": {"min": float(pairs.min()), "max": float(pairs.max()),
                                 "mean": float(pairs.mean()), "std": float(pairs.std()),
                                 "count": int(pairs.size)}, "warnings": list(WARNINGS)}


class Comparator:
    def __init__(self, embedder=None, model_path=MODEL_PATH):
        self.embedder = embedder
        self.model_path = Path(model_path)
        self.failed = False

    def status(self):
        present = self.embedder is not None or (
            self.model_path.is_file() and all(importlib.util.find_spec(name) is not None
                                             for name in ("torch", "torchaudio", "speechbrain", "scipy")))
        return {"available": bool(present and not self.failed),
                "state": "unavailable" if self.failed or not present else (
                    "ready" if self.embedder is not None else "not_loaded"),
                "model": MODEL_ID, "revision": REVISION, "maxBytes": MAX_WAV_BYTES,
                "minSeconds": 2, "maxSeconds": 60, "maxWindows": 20,
                "message": "Model loads locally on first use; no network during serving." if present and not self.failed
                else "Comparator unavailable. Run explicit setup and use the isolated environment.",
                "warnings": list(WARNINGS)}

    def load(self):
        if self.embedder is not None:
            return
        try:
            if self.failed or not self.status()["available"]:
                raise Unavailable("Comparator unavailable.")
            if self.model_path.stat().st_size != WEIGHT_BYTES:
                raise Unavailable("Checkpoint size mismatch.")
            with self.model_path.open("rb") as f:
                digest = hashlib.file_digest(f, "sha256").hexdigest()
            if digest != WEIGHT_SHA256:
                raise Unavailable("Checkpoint hash mismatch.")
            # Defense in depth: never permit Hugging Face's implicit online fallback.
            os.environ["HF_HUB_OFFLINE"] = "1"
            import torch
            from speechbrain.lobes.features import Fbank
            from speechbrain.lobes.models.ECAPA_TDNN import ECAPA_TDNN
            from speechbrain.processing.features import InputNormalization
            torch.set_num_threads(2)
            features = Fbank(n_mels=80).cpu().eval()
            normalization = InputNormalization(norm_type="sentence", std_norm=False).cpu().eval()
            model = ECAPA_TDNN(input_size=80, channels=[1024, 1024, 1024, 1024, 3072],
                               kernel_sizes=[5, 3, 3, 3, 1], dilations=[1, 2, 3, 4, 1],
                               attention_channels=128, lin_neurons=192).cpu().eval()
            state = torch.load(self.model_path, weights_only=True, map_location="cpu")
            model.load_state_dict(state, strict=True)
            def embed(samples):
                with torch.inference_mode():
                    wav = torch.from_numpy(np.array(samples, dtype=np.float32, copy=True)).unsqueeze(0)
                    lengths = torch.ones(1)
                    return model(normalization(features(wav), lengths), lengths).cpu().numpy()
            self.embedder = embed
        except Exception as error:
            self.failed = True
            raise Unavailable("Comparator unavailable. Check the isolated runtime and verified checkpoint.") from error

    def analyze(self, raw):
        samples, rate = decode_wav(raw)
        chunks = windows(resample(samples, rate))
        self.load()
        try:
            embeddings = np.stack([unit(self.embedder(chunk)) for chunk in chunks])
            vector = unit(embeddings.mean(axis=0))
        except Exception as error:
            raise Unavailable("Embedding inference failed; no score was produced.") from error
        return Summary(vector, embeddings, len(samples) / rate, sum(len(x) for x in chunks) / RATE)
