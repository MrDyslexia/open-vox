"""Offline deterministic comparator tests; no model weights or network."""
import io
import struct
import unittest
import wave

import numpy as np

import comparator as c


def wav(seconds=3, rate=16000, channels=1, silence=False):
    t = np.arange(int(seconds * rate)) / rate
    samples = np.zeros(t.size) if silence else 0.2 * np.sin(2 * np.pi * 220 * t)
    samples = np.repeat(samples[:, None], channels, axis=1)
    out = io.BytesIO()
    with wave.open(out, "wb") as f:
        f.setnchannels(channels)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes((samples * 32767).astype("<i2").tobytes())
    return out.getvalue()


class ComparatorTests(unittest.TestCase):
    def setUp(self):
        self.calls = 0
        def embed(samples):
            self.calls += 1
            result = np.zeros(192)
            result[:2] = [3, 4]
            return result
        self.comparator = c.Comparator(embedder=embed)

    def test_normalized_mean_and_cosine(self):
        summary = self.comparator.analyze(wav(8))
        self.assertAlmostEqual(np.linalg.norm(summary.vector), 1)
        np.testing.assert_allclose(summary.vector[:2], [0.6, 0.8])
        result = c.compare_summaries(summary, summary, "opaque")
        self.assertAlmostEqual(result["cosine"], 1)
        self.assertEqual(result["referenceId"], "opaque")
        self.assertEqual(result["reference"]["windowCount"], 3)
        self.assertEqual(result["pairWindowSpread"]["count"], 9)
        self.assertNotIn("probability", result)

    def test_cosine_negative_and_zero_embedding_rejected(self):
        positive = self.comparator.analyze(wav())
        negative = c.Comparator(embedder=lambda x: -positive.vector).analyze(wav())
        self.assertAlmostEqual(c.compare_summaries(positive, negative, "id")["cosine"], -1)
        for embedding in (np.zeros(192), np.full(192, np.nan), np.ones(191)):
            with self.subTest(embedding=embedding.shape), self.assertRaises(c.Unavailable):
                c.Comparator(embedder=lambda x, e=embedding: e).analyze(wav())

    def test_wave_bounds_truncation_and_silence(self):
        for raw in (b"bad", wav()[:-1], wav(1.9), wav(60.01), wav(channels=3),
                    wav(rate=192001), wav(silence=True), b"x" * (c.MAX_WAV_BYTES + 1)):
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                self.comparator.analyze(raw)

    def test_riff_size_and_pcm_only(self):
        raw = bytearray(wav())
        raw[4:8] = struct.pack("<I", len(raw) + 100)
        with self.assertRaises(ValueError):
            c.decode_wav(raw)
        raw = bytearray(wav())
        raw[20:22] = struct.pack("<H", 3)
        with self.assertRaises(ValueError):
            c.decode_wav(raw)

    def test_windows_bounded_and_nonfinite(self):
        windows = c.windows(np.ones(60 * 16000, dtype=np.float32))
        self.assertLessEqual(len(windows), 20)
        self.assertTrue(all(32000 <= len(x) <= 48000 for x in windows))
        with self.assertRaises(ValueError):
            c.windows(np.full(48000, np.inf))
        with self.assertRaises(ValueError):
            c.windows(np.zeros(48000))

    def test_stereo_downmix(self):
        samples, rate = c.decode_wav(wav(channels=2))
        self.assertEqual(samples.shape, (48000,))
        self.assertEqual(rate, 16000)

    def test_resampling_identical_processing(self):
        try:
            import scipy.signal
        except ImportError:
            self.skipTest("Optional SciPy only installed in comparator environment")
        mono, sr = c.decode_wav(wav(rate=44100, channels=2))
        output = c.resample(mono, sr)
        self.assertEqual(output.shape, (48000,))
        self.assertTrue(np.isfinite(output).all())
        a = self.comparator.analyze(wav(rate=44100, channels=2))
        b = self.comparator.analyze(wav(rate=44100, channels=2))
        self.assertAlmostEqual(c.compare_summaries(a, b, "id")["cosine"], 1)

    def test_unavailable_never_produces_score(self):
        from pathlib import Path
        model = c.Comparator(model_path=Path(".models/definitely-not-present.ckpt"))
        self.assertFalse(model.status()["available"])
        with self.assertRaises(c.Unavailable):
            model.analyze(wav())

    def test_missing_dependency_without_importing_optional_packages(self):
        from unittest.mock import patch
        with patch.object(c.Path, "is_file", return_value=True), patch.object(c.importlib.util, "find_spec", return_value=None):
            self.assertFalse(c.Comparator().status()["available"])

    def test_cancelled_mean_is_not_a_fake_score(self):
        index = 0
        def embed(samples):
            nonlocal index
            index += 1
            return np.ones(192) * (1 if index == 1 else -1)
        with self.assertRaises(c.Unavailable):
            c.Comparator(embedder=embed).analyze(wav(6))

    def test_pcm_depths_and_odd_chunk_padding(self):
        for width in (1, 2, 3, 4):
            raw = io.BytesIO()
            with wave.open(raw, "wb") as f:
                f.setnchannels(1)
                f.setsampwidth(width)
                f.setframerate(16000)
                f.writeframes(bytes(32000 * width))
            decoded, rate = c.decode_wav(raw.getvalue())
            self.assertEqual(len(decoded), 32000)
            self.assertEqual(rate, 16000)
            self.assertTrue(np.isfinite(decoded).all())
        raw = bytearray(wav())
        raw[12:12] = b"JUNK" + struct.pack("<I", 1) + b"x\x00"
        struct.pack_into("<I", raw, 4, len(raw) - 8)
        self.assertEqual(len(c.decode_wav(raw)[0]), 48000)

    def test_setup_is_explicit_and_public_sources_are_bounded(self):
        import setup_comparator as setup
        from unittest.mock import patch
        with patch.object(setup, "urlopen") as network:
            with self.assertRaises(RuntimeError):
                setup.wheel_size({"download_info": {"url": "https://unapproved.example/package.whl"}})
            network.assert_not_called()
        self.assertEqual(setup.BUDGET, 1_000_000_000)

    def test_setup_report_must_match_pins_and_budget(self):
        import json
        import setup_comparator as setup
        from types import SimpleNamespace
        from unittest.mock import patch
        pins = []
        for line in (setup.ROOT / "requirements-comparator.txt").read_text(encoding="utf-8").splitlines():
            if "==" in line and not line.startswith("#"):
                name, version = line.split("==", 1)
                pins.append({"metadata": {"name": name, "version": version}})
        report = SimpleNamespace(read_text=lambda **kwargs: json.dumps({"install": pins}))
        with patch.object(setup, "wheel_size", return_value=100), patch("sys.stdout", io.StringIO()):
            self.assertEqual(setup.estimate(report, {"bytes": 83}), len(pins) * 100 + 83)
        with patch.object(setup, "wheel_size", return_value=setup.BUDGET), patch("sys.stdout", io.StringIO()):
            with self.assertRaises(RuntimeError):
                setup.estimate(report, {"bytes": 83})
        bad = SimpleNamespace(read_text=lambda **kwargs: '{"install": []}')
        with patch.object(setup, "wheel_size") as network, self.assertRaises(RuntimeError):
            setup.estimate(bad, {"bytes": 83})
        network.assert_not_called()


def real_smoke(path):
    """Explicit local-only pipeline sanity check, never a perceptual acceptance test."""
    import ctypes
    from ctypes import wintypes
    import json
    from pathlib import Path
    import socket
    import time
    from unittest.mock import patch
    raw = Path(path).read_bytes()
    model = c.Comparator()
    def blocked(*args, **kwargs):
        raise AssertionError("Network is prohibited in the real embedding smoke test")
    with patch.object(socket.socket, "connect", blocked), patch.object(socket.socket, "connect_ex", blocked):
        start = time.perf_counter()
        reference = model.analyze(raw)
        cold = time.perf_counter() - start
        start = time.perf_counter()
        candidate = model.analyze(raw)
        warm = time.perf_counter() - start
    result = c.compare_summaries(reference, candidate, "self-sanity-only")
    if abs(result["cosine"] - 1) > 1e-6:
        raise AssertionError("Identical audio did not produce cosine near one")
    class MemoryCounters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize",
            "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
    memory = MemoryCounters()
    memory.cb = ctypes.sizeof(memory)
    ctypes.windll.kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
    ok = ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(),
                                                ctypes.byref(memory), memory.cb)
    print(json.dumps({"result": result, "coldSeconds": cold, "warmSeconds": warm,
                      "networkBlocked": True, "peakWorkingSetBytes": memory.PeakWorkingSetSize if ok else None,
                      "workingSetBytes": memory.WorkingSetSize if ok else None}, indent=2))


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == "--real-reference":
        real_smoke(sys.argv[2])
    else:
        unittest.main()
