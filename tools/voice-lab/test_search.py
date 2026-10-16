"""Bounded search tests using only controlled callbacks."""
import copy
import threading
import unittest

from search import SearchJob, validate_request
from test_server import request, voices, server


def payload(**changes):
    return dict(preset=request(), referenceId="a" * 32, trials=12, seed=0,
                advancedOffsets=False, **changes)


def evaluate(preset):
    score = preset["timbreWeight"] * 0.5 + preset["prosodyWeight"] * 0.5
    return repr(preset).encode(), {"cosine": score, "candidate": {
        "durationSeconds": 3, "usedSeconds": 3, "windowCount": 1}}


class SearchTests(unittest.TestCase):
    def job(self, body=None, callback=evaluate):
        body = body or payload()
        validate_request(body, lambda p: server.validate(p, voices()))
        return SearchJob("b" * 32, body, callback, {"revision": "fake", "warnings": []})

    def test_baseline_budget_determinism_and_exact_best(self):
        original = payload()
        frozen = copy.deepcopy(original)
        jobs = [self.job(original) for _ in range(2)]
        for job in jobs:
            job.run()
            data = job.status()
            self.assertEqual(data["state"], "completed")
            self.assertEqual(data["attempts"], 12)
            self.assertEqual(data["completed"], 12)
            self.assertEqual(data["baselineScore"], 0)
            self.assertEqual(job.audio(), evaluate(data["bestPreset"])[0])
            self.assertEqual(data["bestScore"], max(x["cosine"] for x in data["history"]))
        self.assertEqual(jobs[0].status()["history"], jobs[1].status()["history"])
        self.assertEqual(original, frozen)

    def test_advanced_bounds_and_frozen_fields(self):
        body = payload()
        body.update(trials=32, advancedOffsets=True, seed=4294967295)
        body["preset"]["offsets"] = [-2, 2] * 128
        seen = []
        def callback(p):
            server.validate(p, voices())
            for key in ("text", "lang", "speed", "baseVoice", "donorVoice"):
                self.assertEqual(p[key], body["preset"][key])
            seen.append(copy.deepcopy(p))
            return evaluate(p)
        job = self.job(body, callback)
        job.run()
        self.assertEqual(len(seen), 32)
        self.assertEqual(seen[0], body["preset"])
        self.assertTrue(any(p["offsets"] != seen[0]["offsets"] for p in seen))
        self.assertEqual(len({repr(p) for p in seen}), 32)

    def test_integer_baseline_evaluated_once_with_unique_seeded_trials(self):
        for budget in (4, 12, 32):
            for seed in (0, 17):
                runs = []
                for _ in range(2):
                    body = payload()
                    body.update(trials=budget, seed=seed)
                    seen = []
                    def callback(p):
                        seen.append(copy.deepcopy(p))
                        return evaluate(p)
                    job = self.job(body, callback)
                    job.run()
                    with self.subTest(budget=budget, seed=seed):
                        self.assertEqual(job.status()["state"], "completed")
                        self.assertEqual(job.status()["attempts"], budget)
                        self.assertEqual(len(seen), budget)
                        self.assertEqual(seen.count(body["preset"]), 1)
                        for index, preset in enumerate(seen):
                            self.assertNotIn(preset, seen[:index])
                    runs.append(seen)
                self.assertEqual(runs[0], runs[1])

    def test_candidate_identity_numeric_equivalence_without_rounding(self):
        from search import candidate_identity
        integer = request()
        equivalent = copy.deepcopy(integer)
        for key in ("version", "speed", "timbreWeight", "prosodyWeight"):
            equivalent[key] = float(equivalent[key])
        equivalent["offsets"] = [float(value) for value in equivalent["offsets"]]
        self.assertEqual(candidate_identity(integer), candidate_identity(equivalent))
        self.assertEqual(hash(candidate_identity(integer)), hash(candidate_identity(equivalent)))
        for key in ("speed", "timbreWeight", "prosodyWeight", "offsets"):
            for step in (0.01, 1e-12):
                distinct = copy.deepcopy(equivalent)
                if key == "offsets":
                    distinct[key][0] += step
                else:
                    distinct[key] += step
                self.assertNotEqual(candidate_identity(integer), candidate_identity(distinct))
        reordered = dict(reversed(list(equivalent.items())))
        self.assertEqual(candidate_identity(integer), candidate_identity(reordered))

    def test_duplicate_proposals_stop_at_existing_proposal_bound(self):
        body = payload()
        proposals = []
        job = self.job(body)
        def proposal(index, rng):
            proposals.append(index)
            return copy.deepcopy(body["preset"])
        job.proposal = proposal
        job.run()
        self.assertEqual(len(proposals), body["trials"] + 10)
        self.assertEqual(job.status()["state"], "completed")
        self.assertEqual(job.status()["completed"], 1)
        self.assertEqual(job.status()["attempts"], 1)

    def test_cancel_blocked_callback_counts_finished_baseline(self):
        entered, release = threading.Event(), threading.Event()
        def callback(p):
            entered.set()
            self.assertTrue(release.wait(2))
            return evaluate(p)
        job = self.job(callback=callback)
        thread = threading.Thread(target=job.run)
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            job.cancel()
            self.assertEqual(job.status()["state"], "cancelling")
        finally:
            release.set()
            thread.join(3)
        self.assertEqual(job.status()["state"], "cancelled")
        self.assertEqual(job.status()["completed"], 1)
        job.cancel()
        self.assertEqual(job.status()["state"], "cancelled")

    def test_invalid_score_and_failure_no_fake_best(self):
        for score in (float("nan"), float("inf"), 1.1, True):
            job = self.job(callback=lambda p: (b"wav", {"cosine": score, "candidate": {
                "durationSeconds": 3, "usedSeconds": 3, "windowCount": 1}}))
            job.run()
            self.assertEqual(job.status()["state"], "failed")
            self.assertIsNone(job.status()["bestPreset"])
            self.assertEqual(job.status()["completed"], 0)
        job = self.job(callback=lambda p: (_ for _ in ()).throw(RuntimeError("private path")))
        job.run()
        self.assertNotIn("private", repr(job.status()))

    def test_partial_failure_retains_actual_best(self):
        calls = []
        def callback(p):
            calls.append(p)
            if len(calls) == 2:
                raise RuntimeError("private")
            return evaluate(p)
        job = self.job(callback=callback)
        job.run()
        self.assertEqual(job.status()["attempts"], 2)
        self.assertEqual(job.status()["completed"], 1)
        self.assertEqual(job.audio(), evaluate(request())[0])

    def test_exact_request_limits_and_off(self):
        for key, values in {"trials": [True, 1, 33, 2.5], "seed": [True, -1, 2**32, 0.5],
                            "advancedOffsets": [0, "yes"], "referenceId": [None, "../x"]}.items():
            for value in values:
                body = payload()
                body[key] = value
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    self.job(body)
        body = payload()
        body["extra"] = True
        with self.assertRaises(ValueError):
            self.job(body)
        body = payload()
        body["preset"]["donorVoice"] = None
        with self.assertRaises(ValueError):
            self.job(body)
        body["advancedOffsets"] = True
        self.job(body).run()

    def test_invalid_candidate_metadata_and_audio_cap(self):
        metadata = {"durationSeconds": 3, "usedSeconds": 3, "windowCount": 1}
        for changes in ({"durationSeconds": 1}, {"usedSeconds": 4},
                        {"usedSeconds": float("nan")}, {"windowCount": True},
                        {"windowCount": 0}, {"windowCount": 21}):
            job = self.job(callback=lambda p, change=changes: (b"wav", {
                "cosine": 0, "candidate": dict(metadata, **change)}))
            job.run()
            self.assertEqual(job.status()["state"], "failed")
            self.assertIsNone(job.audio())
        job = self.job(callback=lambda p: (b"x" * (10 * 1024 * 1024 + 1), {
            "cosine": 0, "candidate": metadata}))
        job.run()
        self.assertEqual(job.status()["state"], "failed")

    def test_negative_cosine_baseline_remains_a_valid_best(self):
        def callback(p):
            wav, result = evaluate(p)
            result["cosine"] = -0.1 - p["timbreWeight"] - p["prosodyWeight"] * 0.1
            result["cosine"] = max(-1, result["cosine"])
            return wav, result
        job = self.job(callback=callback)
        job.run()
        self.assertEqual(job.status()["bestScore"], -0.1)
        self.assertEqual(job.status()["bestPreset"], request())
