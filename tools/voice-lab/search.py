"""Deterministic, finite local search; no models, files or network dependencies."""
import copy
import math
import random
import re
import threading
import time


ACTIVE = ("running", "cancelling")
MAX_AUDIO_BYTES = 10 * 1024 * 1024


def validate_request(body, validate_preset):
    if not isinstance(body, dict) or set(body) != {
            "preset", "referenceId", "trials", "seed", "advancedOffsets"}:
        raise ValueError("Use the exact search request schema.")
    validate_preset(body["preset"])
    if (not isinstance(body["referenceId"], str)
            or not re.fullmatch(r"[a-f0-9]{32}", body["referenceId"])):
        raise ValueError("Provide the current reference ID.")
    for key, low, high in (("trials", 2, 32), ("seed", 0, 2**32 - 1)):
        if type(body[key]) is not int or not low <= body[key] <= high:
            raise ValueError("Invalid trial budget or seed.")
    if type(body["advancedOffsets"]) is not bool:
        raise ValueError("advancedOffsets must be a boolean.")
    if body["preset"]["donorVoice"] is None and not body["advancedOffsets"]:
        raise ValueError("Donor Off requires advanced offset search.")


def finite(value, low, high):
    return type(value) in (int, float) and low <= value <= high and math.isfinite(value)


def candidate_identity(preset):
    """Exact known-schema identity for validated presets, independent of numeric spelling."""
    return (preset["version"], preset["text"], preset["lang"],
            preset["baseVoice"], preset["donorVoice"], float(preset["speed"]),
            float(preset["timbreWeight"]), float(preset["prosodyWeight"]),
            tuple(float(value) for value in preset["offsets"]))


class SearchJob:
    """One bounded job. State lock is never held across evaluation callbacks."""

    def __init__(self, job_id, body, evaluate, metadata):
        self.lock = threading.Lock()
        self.id = job_id
        self.request = copy.deepcopy(body)
        self.evaluate = evaluate
        self.started = time.monotonic()
        self.finished = None
        self.state = "running"
        self.cancelled = False
        self.attempts = 0
        self.history = []
        self.best = None
        self.wav = None
        self.baseline = None
        self.reason = None
        self.metadata = copy.deepcopy(metadata)

    def cancel(self):
        with self.lock:
            if self.state in ACTIVE:
                self.cancelled = True
                self.state = "cancelling"

    def status(self):
        with self.lock:
            return copy.deepcopy({
                "jobId": self.id, "state": self.state,
                "referenceId": self.request["referenceId"],
                "trials": self.request["trials"], "seed": self.request["seed"],
                "advancedOffsets": self.request["advancedOffsets"],
                "attempts": self.attempts, "completed": len(self.history),
                "baselineScore": self.baseline,
                "bestScore": None if self.best is None else self.best[0],
                "bestPreset": None if self.best is None else self.best[1],
                "history": self.history,
                "elapsedSeconds": (self.finished or time.monotonic()) - self.started,
                "error": self.reason, **self.metadata})

    def audio(self):
        with self.lock:
            return self.wav

    def proposal(self, index, rng):
        initial = self.request["preset"]
        with self.lock:
            current = initial if self.best is None else self.best[1]
            preset = copy.deepcopy(initial if index <= 9 else current)
        if index == 0:
            return preset
        if preset["donorVoice"] is not None:
            if index <= 9:
                preset["timbreWeight"] = ((index - 1) // 3) * 0.5
                preset["prosodyWeight"] = ((index - 1) % 3) * 0.5
            else:
                for key in ("timbreWeight", "prosodyWeight"):
                    step = rng.uniform(0.025, 0.1) * rng.choice((-1, 1))
                    if not 0 <= preset[key] + step <= 1:
                        step = -step
                    preset[key] = min(1, max(0, preset[key] + step))
        if self.request["advancedOffsets"]:
            # All 256 components are eligible; a small budget cannot explore all.
            for component in rng.sample(range(256), 4):
                step = rng.choice((0.025, 0.05, 0.1)) * rng.choice((-1, 1))
                value = preset["offsets"][component]
                if not -2 <= value + step <= 2:
                    step = -step
                preset["offsets"][component] = min(2, max(-2, value + step))
        return preset

    def run(self):
        rng = random.Random(self.request["seed"])
        seen = set()
        try:
            # Finite proposal budget includes at most one duplicate baseline/lattice
            # point. Bounded random fallback avoids an unbounded duplicate loop.
            for index in range(self.request["trials"] + 10):
                with self.lock:
                    if self.cancelled or self.attempts >= self.request["trials"]:
                        break
                preset = self.proposal(index, rng)
                identity = candidate_identity(preset)
                if identity in seen:
                    continue
                seen.add(identity)
                with self.lock:
                    if self.cancelled:
                        break
                    self.attempts += 1
                    trial = self.attempts
                wav, result = self.evaluate(copy.deepcopy(preset))
                score = result["cosine"]
                candidate = result["candidate"]
                if (not finite(score, -1, 1)
                        or not finite(candidate["durationSeconds"], 2, 60)
                        or not finite(candidate["usedSeconds"], 2, 60)
                        or candidate["usedSeconds"] > candidate["durationSeconds"] + 0.001
                        or type(candidate["windowCount"]) is not int
                        or not 1 <= candidate["windowCount"] <= 20
                        or not isinstance(wav, bytes) or not 1 <= len(wav) <= MAX_AUDIO_BYTES):
                    raise ValueError("Invalid evaluation.")
                with self.lock:
                    self.history.append({"trial": trial, "cosine": score,
                                         "timbreWeight": preset["timbreWeight"],
                                         "prosodyWeight": preset["prosodyWeight"]})
                    if trial == 1:
                        self.baseline = score
                    if self.best is None or score > self.best[0]:
                        self.best = (score, preset)
                        self.wav = wav
            with self.lock:
                self.state = "cancelled" if self.cancelled else "completed"
        except Exception:
            with self.lock:
                self.state = "failed"
                self.reason = "Candidate evaluation failed; no retry. Check audio duration and local models."
        finally:
            # Drop the callback (and its reference snapshot) after the job.
            with self.lock:
                self.finished = time.monotonic()
                self.evaluate = None
