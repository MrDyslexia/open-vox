"""Deterministic voice-lab tests: no ONNX model or persistent server required."""
import copy
import http.client
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
import wave

import numpy as np
import comparator
from test_comparator import wav as reference_wav


spec = importlib.util.spec_from_file_location("voice_lab_server", Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def request():
    return dict(version=1, text="Los sistemas claros ayudan a pensar mejor.",
                baseVoice="em_alex", donorVoice="am_onyx", timbreWeight=0,
                prosodyWeight=0, speed=1, lang="es", offsets=[0] * 256)


def voices():
    return {"em_alex": np.ones((4, 1, 256), dtype=np.float32),
            "am_onyx": np.full((4, 1, 256), 3, dtype=np.float32)}


class FakeModel:
    def __init__(self):
        self.calls = []

    def create(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return np.array([0, 0.25, -0.25], dtype=np.float32), 24000


class ValidationTests(unittest.TestCase):
    def test_valid_languages(self):
        for lang in ("es", "en-us", "en-gb"):
            body = request()
            body["lang"] = lang
            self.assertEqual(server.validate(body, voices())["lang"], lang)

    def test_strict_schema(self):
        for body in ([], {}, dict(request(), extra=True), dict(request(), version=True),
                     dict(request(), version=2), dict(request(), version=1.0)):
            with self.subTest(body=body), self.assertRaises(ValueError):
                server.validate(body, voices())

    def test_invalid_fields(self):
        cases = {"text": ["", "  ", "x" * 501, 7, None],
                 "baseVoice": [None, "missing", [], True],
                 "donorVoice": ["missing", [], True], "lang": ["fr", None, []],
                 "timbreWeight": [-0.01, 1.01, True, "0", None, float("nan"), float("inf"), 10 ** 400],
                 "prosodyWeight": [-1, 2, False, float("-inf")],
                 "speed": [0.49, 2.01, True, "1", float("nan")],
                 "offsets": [[], [0] * 255, [0] * 257, "0", None,
                             [True] * 256, [float("nan")] * 256, [float("inf")] * 256,
                             ["0"] * 256, [2.01] * 256, [-2.01] * 256]}
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    server.validate(dict(request(), **{field: value}), voices())

    def test_donor_off_requires_zero_weights(self):
        server.validate(dict(request(), donorVoice=None), voices())
        with self.assertRaises(ValueError):
            server.validate(dict(request(), donorVoice=None, timbreWeight=0.1), voices())

    def test_numeric_boundaries(self):
        for speed in (0.5, 2):
            server.validate(dict(request(), speed=speed, timbreWeight=1,
                                 prosodyWeight=1, offsets=[-2, 2] * 128), voices())


class StyleTests(unittest.TestCase):
    def test_off_equivalence_and_owned_float32(self):
        pack = voices()
        style = server.build_style(request(), pack)
        np.testing.assert_array_equal(style, pack["em_alex"])
        self.assertFalse(np.shares_memory(style, pack["em_alex"]))
        self.assertEqual(style.dtype, np.float32)
        self.assertEqual(style.shape, (4, 1, 256))

    def test_independent_halves_and_broadcast_offsets(self):
        for tw, pw in ((0, 0.5), (0.25, 0), (1, 1)):
            pack = voices()
            before = copy.deepcopy(pack)
            body = dict(request(), timbreWeight=tw, prosodyWeight=pw)
            body["offsets"][0] = -2
            body["offsets"][255] = 0.5
            style = server.build_style(body, pack)
            expected = np.ones((4, 1, 256), dtype=np.float32)
            expected[..., :128] += 2 * tw
            expected[..., 128:] += 2 * pw
            expected[..., 0] -= 2
            expected[..., 255] += 0.5
            np.testing.assert_array_equal(style, expected)
            for name in pack:
                np.testing.assert_array_equal(pack[name], before[name])

    def test_bad_style_shapes_and_nonfinite(self):
        for bad in (np.ones((4, 256)), np.ones((4, 1, 255)),
                    np.full((4, 1, 256), np.nan)):
            pack = voices()
            pack["am_onyx"] = bad
            with self.assertRaises(ValueError):
                server.build_style(dict(request(), timbreWeight=0.5), pack)
        for bad in (np.ones(256), np.ones((1, 255)), np.full((4, 1, 256), np.inf)):
            pack = voices()
            pack["em_alex"] = bad
            with self.assertRaises(ValueError):
                server.build_style(request(), pack)

    def test_inactive_donor_not_accessed(self):
        pack = voices()
        pack["am_onyx"] = np.ones(1)
        np.testing.assert_array_equal(server.build_style(request(), pack), pack["em_alex"])

    def test_float64_assets_produce_float32_styles(self):
        pack = {name: value.astype(np.float64) for name, value in voices().items()}
        style = server.build_style(dict(request(), timbreWeight=0.25, prosodyWeight=0.5), pack)
        self.assertEqual(style.dtype, np.float32)
        np.testing.assert_array_equal(style[..., :128], 1.5)
        np.testing.assert_array_equal(style[..., 128:], 2)


class LabTests(unittest.TestCase):
    def setUp(self):
        self.model = FakeModel()
        self.loads = 0

        def factory():
            self.loads += 1
            return self.model

        self.lab = server.Lab(voices(), factory)

    def test_lazy_cached_model_wav_and_languages(self):
        self.assertEqual(self.loads, 0)
        self.assertIn("em_alex", self.lab.metadata()["voices"])
        self.assertEqual(self.loads, 0)
        for lang in ("es", "en-us", "en-gb"):
            wav = self.lab.synthesize(dict(request(), lang=lang))
            with wave.open(io.BytesIO(wav)) as audio:
                self.assertEqual(audio.getframerate(), 24000)
                self.assertEqual(audio.getsampwidth(), 2)
                self.assertEqual(audio.getnchannels(), 1)
                self.assertEqual(audio.getnframes(), 3)
            self.assertEqual(self.model.calls[-1][1]["lang"], lang)
        self.assertEqual(self.loads, 1)

    def test_busy_and_lock_release_after_exception(self):
        self.lab.lock.acquire()
        try:
            with self.assertRaises(server.Busy):
                self.lab.synthesize(request())
        finally:
            self.lab.lock.release()
        self.model.create = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("private path"))
        with self.assertRaises(RuntimeError):
            self.lab.synthesize(request())
        self.assertTrue(self.lab.lock.acquire(blocking=False))
        self.lab.lock.release()

    def test_pack_frozen_and_model_cannot_overwrite_source(self):
        self.assertFalse(self.lab.voices["em_alex"].flags.writeable)
        def create(*args, **kwargs):
            kwargs["voice"][:] = 0
            return np.zeros(3, dtype=np.float32), 24000
        self.model.create = create
        self.lab.synthesize(request())
        np.testing.assert_array_equal(self.lab.voices["em_alex"], voices()["em_alex"])

    def test_invalid_audio(self):
        for samples, sr in ((np.array([np.nan]), 24000), (np.array([]), 24000),
                            (np.zeros((1, 2)), 24000), (np.zeros(1), 0)):
            self.model.create = lambda *a, pair=(samples, sr), **kw: pair
            with self.assertRaises(ValueError):
                self.lab.synthesize(request())


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.model = FakeModel()
        self.lab = server.Lab(voices(), lambda: self.model)
        self.http = server.make_server(self.lab, port=0)
        self.port = self.http.server_address[1]
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        if self.lab.search_job is not None:
            self.lab.search_job.cancel()
            self.lab.search_thread.join(3)
            self.assertFalse(self.lab.search_thread.is_alive(), "Owned test job must terminate")
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)

    def call(self, method="POST", path="/api/synthesize", body=None, headers=None, send_body=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        data = json.dumps(request()).encode() if body is None else body
        merged = {"Content-Type": "application/json"}
        merged.update(headers or {})
        if method == "POST" and not send_body:
            # Exercise pre-body rejection without Windows racing an unread upload
            # against server close (which can reset the client's TCP connection).
            merged.setdefault("Content-Length", str(len(data)))
        try:
            conn.request(method, path, data if method == "POST" and send_body else None, merged)
            result = conn.getresponse()
            return result.status, dict(result.getheaders()), result.read()
        finally:
            conn.close()

    def test_loopback_static_and_metadata(self):
        self.assertEqual(self.http.server_address[0], "127.0.0.1")
        for path in ("/", "/index.html"):
            status, headers, body = self.call("GET", path)
            self.assertEqual(status, 200)
            self.assertIn(b"Generate", body)
            self.assertNotIn("Access-Control-Allow-Origin", headers)
        status, _, body = self.call("GET", "/api/metadata")
        self.assertEqual(status, 200)
        self.assertIn("em_alex", json.loads(body)["voices"])
        self.assertEqual(self.model.calls, [])

    def test_wav_and_allowed_origins(self):
        for host in ("127.0.0.1", "localhost"):
            status, headers, body = self.call(headers={"Host": f"{host}:{self.port}",
                                                      "Origin": f"http://{host}:{self.port}"})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "audio/wav")
            self.assertEqual(body[:4], b"RIFF")

    def test_foreign_host_origin_before_inference(self):
        for headers in ({"Host": f"evil.example:{self.port}"}, {"Host": "127.0.0.1"},
                        {"Host": "127.0.0.1:1"}, {"Origin": "null"},
                        {"Origin": f"https://localhost:{self.port}"},
                        {"Origin": f"http://localhost:{self.port}/"},
                        {"Origin": "http://evil.example"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.call(headers=headers, send_body=False)[0], 403)
        self.assertEqual(self.model.calls, [])

    def test_exact_routes(self):
        for path in ("/../server.py", "/server.py", "/%2e%2e/index.html", "/?file=x",
                     "/api/metadata?x=1"):
            self.assertEqual(self.call("GET", path)[0], 404)
        self.assertEqual(self.call(path="/index.html")[0], 404)

    def test_malformed_oversized_and_content_type(self):
        for body in (b"{", b"[]", b"null", b"\xff", b'{"version":NaN}'):
            self.assertEqual(self.call(body=body)[0], 400)
        self.assertEqual(self.call(body=b"x" * (server.MAX_BODY + 1))[0], 413)
        for content_type in ("text/plain", "application/x-www-form-urlencoded"):
            self.assertEqual(self.call(headers={"Content-Type": content_type}, send_body=False)[0], 415)
        self.assertEqual(self.call(headers={"Transfer-Encoding": "chunked"}, send_body=False)[0], 400)
        self.assertEqual(self.call(headers={"Content-Length": "bad"}, send_body=False)[0], 400)
        self.assertEqual(self.model.calls, [])

    def test_busy_metadata_and_sanitized_failure(self):
        self.lab.lock.acquire()
        try:
            self.assertEqual(self.call()[0], 429)
            self.assertEqual(self.call("GET", "/api/metadata")[0], 200)
        finally:
            self.lab.lock.release()
        self.model.create = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("C:/private/model.onnx"))
        status, _, body = self.call()
        self.assertEqual(status, 500)
        self.assertNotIn(b"private", body)
        self.assertNotIn(b"Traceback", body)

    def test_running_inference_rejects_second_request(self):
        started = threading.Event()
        release = threading.Event()
        results = []
        def create(*args, **kwargs):
            started.set()
            if not release.wait(timeout=3):
                raise RuntimeError("Test inference timed out")
            return np.zeros(3, dtype=np.float32), 24000
        self.model.create = create
        first = threading.Thread(target=lambda: results.append(self.call()[0]))
        first.start()
        try:
            self.assertTrue(started.wait(timeout=2))
            self.assertEqual(self.call()[0], 429)
            self.assertEqual(self.call("GET", "/api/metadata")[0], 200)
        finally:
            release.set()
            first.join(timeout=3)
        self.assertFalse(first.is_alive())
        self.assertEqual(results, [200])

    def test_duplicate_headers_missing_length_and_duplicate_json(self):
        for name, values in (("Host", [f"127.0.0.1:{self.port}"] * 2),
                             ("Origin", [f"http://localhost:{self.port}"] * 2),
                             ("Content-Length", ["2", "2"]), ("Content-Length", [])):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
            try:
                conn.putrequest("POST", "/api/synthesize", skip_host=True)
                if name != "Host":
                    conn.putheader("Host", f"127.0.0.1:{self.port}")
                conn.putheader("Content-Type", "application/json")
                if name != "Content-Length":
                    conn.putheader("Content-Length", "2")
                for value in values:
                    conn.putheader(name, value)
                # Rejection must happen before reading any request body.
                conn.endheaders()
                response = conn.getresponse()
                self.assertEqual(response.status, 403 if name in ("Host", "Origin") else 400)
                response.read()
            finally:
                conn.close()
        body = json.dumps(request()).replace('"version": 1', '"version": 1, "version": 1').encode()
        self.assertEqual(self.call(body=body)[0], 400)
        self.assertEqual(self.model.calls, [])

    def fake_comparator(self, embedder=None):
        self.lab.comparator = comparator.Comparator(embedder=embedder or (lambda x: np.ones(192)))

    def upload(self, raw=None, send_body=True, **headers):
        return self.call(path="/api/reference", body=reference_wav() if raw is None else raw,
                         headers={"Content-Type": "audio/wav", **headers}, send_body=send_body)

    def test_reference_compare_replace_clear(self):
        self.fake_comparator()
        status, _, body = self.upload()
        self.assertEqual(status, 200)
        reference_id = json.loads(body)["referenceId"]
        self.assertEqual(len(reference_id), 32)
        status, _, body = self.call(path="/api/compare", body=reference_wav(),
                                   headers={"Content-Type": "audio/wav", "X-Reference-Id": reference_id})
        self.assertEqual(status, 200)
        self.assertAlmostEqual(json.loads(body)["cosine"], 1)
        replacement = json.loads(self.upload()[2])["referenceId"]
        self.assertNotEqual(reference_id, replacement)
        for stale in (reference_id, "not-current"):
            self.assertEqual(self.call(path="/api/compare", body=reference_wav(),
                                      headers={"Content-Type": "audio/wav", "X-Reference-Id": stale})[0], 409)
        self.assertEqual(self.call(path="/api/reference/clear", body=b"{}")[0], 200)
        status, _, body = self.call("GET", "/api/comparator/status")
        self.assertEqual(status, 200)
        self.assertIsNone(json.loads(body)["reference"])
        self.assertEqual(self.call(path="/api/compare", body=reference_wav(),
                                  headers={"Content-Type": "audio/wav", "X-Reference-Id": replacement})[0], 409)

    def test_comparator_unavailable_and_synthesis_unchanged(self):
        self.lab.comparator = comparator.Comparator(model_path=Path(".models/not-present.ckpt"))
        status, _, body = self.upload()
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["code"], "comparator_unavailable")
        self.assertNotIn(b"not-present", body)
        self.assertEqual(self.call()[0], 200)

    def test_comparator_routes_boundary_and_request_limits(self):
        self.fake_comparator()
        for path in ("/api/reference", "/api/compare", "/api/reference/clear"):
            for headers in ({"Origin": "http://evil.example"}, {"Host": "evil.example"}):
                self.assertEqual(self.call(path=path, body=b"{}", headers=headers, send_body=False)[0], 403)
        self.assertEqual(self.call("GET", "/api/comparator/status", headers={"Origin": "null"})[0], 403)
        self.assertEqual(self.upload(Content_Length="0")[0], 200)  # Unknown header has no authority.
        for raw in (reference_wav()[:-1], reference_wav(1), reference_wav(silence=True), b"{}"):
            self.assertEqual(self.upload(raw)[0], 400)
        self.assertEqual(self.upload(send_body=False, **{"Content-Type": "application/json"})[0], 415)
        self.assertEqual(self.upload(send_body=False, **{"Content-Length": str(comparator.MAX_WAV_BYTES + 1)})[0], 413)
        self.assertEqual(self.upload(send_body=False, **{"Transfer-Encoding": "chunked"})[0], 400)
        self.assertEqual(self.upload(send_body=False, **{"Content-Length": "bad"})[0], 400)
        self.assertEqual(self.call(path="/api/compare", body=reference_wav(),
                                  headers={"Content-Type": "audio/wav"}, send_body=False)[0], 400)
        self.assertEqual(self.call(path="/api/reference/clear", body=b'{"path":"private"}')[0], 400)
        self.assertEqual(self.call("GET", "/api/comparator/status?x=1")[0], 404)

    def test_comparator_busy_shared_lock_and_failure_release(self):
        self.fake_comparator(lambda x: (_ for _ in ()).throw(RuntimeError("C:/private")))
        self.lab.lock.acquire()
        try:
            self.assertEqual(self.upload(send_body=False)[0], 429)
            self.assertEqual(self.call(path="/api/reference/clear", body=b"{}")[0], 429)
            self.assertEqual(self.call("GET", "/api/comparator/status")[0], 200)
        finally:
            self.lab.lock.release()
        status, _, body = self.upload()
        self.assertEqual(status, 503)
        self.assertNotIn(b"private", body)
        self.assertEqual(self.call()[0], 200)

    def test_comparator_active_work_rejects_synthesis(self):
        started, release = threading.Event(), threading.Event()
        def embed(samples):
            started.set()
            if not release.wait(3):
                raise RuntimeError("Test timed out")
            return np.ones(192)
        self.fake_comparator(embed)
        results = []
        worker = threading.Thread(target=lambda: results.append(self.upload()[0]))
        worker.start()
        try:
            self.assertTrue(started.wait(2))
            self.assertEqual(self.call()[0], 429)
            self.assertEqual(self.upload(send_body=False)[0], 429)
        finally:
            release.set()
            worker.join(3)
        self.assertEqual(results, [200])

    def test_comparator_duplicate_headers_and_truncated_body(self):
        self.fake_comparator()
        for name in ("Host", "Origin", "Content-Length", "Content-Type", "X-Reference-Id"):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
            value = {"Host": f"127.0.0.1:{self.port}", "Origin": f"http://localhost:{self.port}",
                     "Content-Length": "2", "Content-Type": "audio/wav", "X-Reference-Id": "id"}[name]
            conn.putrequest("POST", "/api/compare", skip_host=True)
            for key, default in (("Host", f"127.0.0.1:{self.port}"), ("Content-Length", "2"),
                                 ("Content-Type", "audio/wav"), ("X-Reference-Id", "id")):
                if key != name:
                    conn.putheader(key, default)
            conn.putheader(name, value)
            conn.putheader(name, value)
            # No body: duplicate-header rejection must not wait for one.
            conn.endheaders()
            response = conn.getresponse()
            self.assertEqual(response.status, 403 if name in ("Host", "Origin") else
                             415 if name == "Content-Type" else 400)
            response.read()
            conn.close()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        conn.request("POST", "/api/reference", b"short", {"Content-Type": "audio/wav", "Content-Length": "44"})
        import socket
        conn.sock.shutdown(socket.SHUT_WR)
        response = conn.getresponse()
        self.assertEqual(response.status, 400)
        response.read()
        conn.close()


    def search_setup(self):
        self.fake_comparator()
        reference_id = json.loads(self.upload()[2])["referenceId"]
        self.model.create = lambda *a, **kw: (np.tile([0.2, -0.2], 36000), 24000)
        return dict(preset=request(), referenceId=reference_id, trials=2, seed=0,
                    advancedOffsets=False)

    def start_search(self, body):
        return self.call(path="/api/search/start", body=json.dumps(body).encode())

    def finish_search(self, job_id):
        self.lab.search_thread.join(3)
        self.assertFalse(self.lab.search_thread.is_alive())
        status, _, raw = self.call("GET", "/api/search/" + job_id)
        self.assertEqual(status, 200)
        return json.loads(raw)

    def test_search_exact_audio_baseline_and_replacement(self):
        body = self.search_setup()
        evaluated = []
        synthesize = self.lab.synthesize_owned
        def captured(preset):
            wav = synthesize(preset)
            evaluated.append((copy.deepcopy(preset), wav))
            return wav
        self.lab.synthesize_owned = captured
        status, _, raw = self.start_search(body)
        self.assertEqual(status, 202)
        job_id = json.loads(raw)["jobId"]
        data = self.finish_search(job_id)
        self.assertEqual(data["state"], "completed")
        self.assertEqual(data["attempts"], 2)
        self.assertEqual(data["completed"], 2)
        self.assertAlmostEqual(data["bestScore"], 1)
        self.assertEqual(data["bestPreset"], evaluated[0][0])
        self.assertNotIn("wav", data)
        status, headers, wav = self.call("GET", f"/api/search/{job_id}/audio")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(wav, evaluated[0][1])
        terminal = self.call(path=f"/api/search/{job_id}/cancel", body=b"{}")[2]
        self.assertEqual(json.loads(terminal), data)
        replacement = json.loads(self.start_search(body)[2])["jobId"]
        self.finish_search(replacement)
        for suffix in ("", "/audio"):
            self.assertEqual(self.call("GET", f"/api/search/{job_id}{suffix}")[0], 404)
        self.assertEqual(self.call(path=f"/api/search/{job_id}/cancel", body=b"{}")[0], 404)

    def test_search_shared_gate_cancel_responsive_status_and_frozen_reference(self):
        body = self.search_setup()
        entered, release = threading.Event(), threading.Event()
        def create(*a, **kw):
            entered.set()
            if not release.wait(3):
                raise RuntimeError("timeout")
            return np.tile([0.2, -0.2], 36000), 24000
        self.model.create = create
        job_id = json.loads(self.start_search(body)[2])["jobId"]
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.start_search(body)[0], 429)
            self.assertEqual(self.call()[0], 429)
            self.assertEqual(self.upload(send_body=False)[0], 429)
            self.assertEqual(self.call(path="/api/reference/clear", body=b"{}")[0], 429)
            self.assertEqual(self.call(path="/api/compare", body=reference_wav(), headers={
                "Content-Type": "audio/wav", "X-Reference-Id": body["referenceId"]})[0], 429)
            data = json.loads(self.call("GET", "/api/comparator/status")[2])
            self.assertEqual(data["search"]["jobId"], job_id)
            self.assertEqual(self.call("GET", f"/api/search/{job_id}/audio")[0], 409)
            self.assertEqual(self.call(path=f"/api/search/{job_id}/cancel", body=b"[]")[0], 400)
            cancelled = json.loads(self.call(path=f"/api/search/{job_id}/cancel", body=b"{}")[2])
            self.assertEqual(cancelled["state"], "cancelling")
            body["preset"]["speed"] = 2
        finally:
            release.set()
            data = self.finish_search(job_id)
        self.assertEqual(data["state"], "cancelled")
        self.assertEqual(data["completed"], 1)
        self.assertEqual(data["bestPreset"]["speed"], 1)
        self.assertEqual(self.lab.reference[0], body["referenceId"])
        self.assertTrue(self.lab.lock.acquire(blocking=False))
        self.lab.lock.release()

    def test_search_failure_releases_resource_and_preserves_server(self):
        body = self.search_setup()
        for create in (lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("C:/private")),
                       lambda *a, **kw: (np.array([0.1, -0.1]), 24000)):
            self.model.create = create
            job_id = json.loads(self.start_search(body)[2])["jobId"]
            data = self.finish_search(job_id)
            self.assertEqual(data["state"], "failed")
            self.assertEqual(data["attempts"], 1)
            self.assertEqual(data["completed"], 0)
            self.assertIsNone(data["bestScore"])
            self.assertNotIn("private", repr(data))
            self.assertEqual(self.call("GET", f"/api/search/{job_id}/audio")[0], 409)
            self.assertTrue(self.lab.lock.acquire(blocking=False))
            self.lab.lock.release()
        self.search_setup()
        job_id = json.loads(self.start_search(self.search_setup())[2])["jobId"]
        self.assertEqual(self.finish_search(job_id)["state"], "completed")

    def test_search_validation_boundaries_stale_and_unavailable(self):
        body = self.search_setup()
        for key, values in {"trials": [True, 1, 33, 2.5, float("nan"), 10**100],
                            "seed": [True, -1, 2**32, 1.5], "advancedOffsets": [1, None],
                            "referenceId": [None, "../private"]}.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self.assertEqual(self.start_search(dict(body, **{key: value}))[0], 400)
        self.assertEqual(self.start_search(dict(body, extra=True))[0], 400)
        self.assertEqual(self.start_search(dict(body, referenceId="f" * 32))[0], 409)
        for raw in (b"{", b"[]", b"null", b"\xff", b'{"trials":NaN}', b'{"x":1,"x":2}'):
            self.assertEqual(self.call(path="/api/search/start", body=raw)[0], 400)
        self.assertEqual(self.call(path="/api/search/start", body=b"x" * (server.MAX_BODY + 1))[0], 413)
        for headers, status in (({"Transfer-Encoding": "chunked"}, 400),
                                ({"Content-Length": "bad"}, 400),
                                ({"Content-Type": "audio/wav"}, 415)):
            self.assertEqual(self.call(path="/api/search/start", headers=headers, send_body=False)[0], status)
        for method, path in (("POST", "/api/search/start"), ("GET", "/api/search/" + "a" * 32),
                             ("GET", "/api/search/" + "a" * 32 + "/audio"),
                             ("POST", "/api/search/" + "a" * 32 + "/cancel")):
            for headers in ({"Host": "evil.example"}, {"Origin": "null"}):
                self.assertEqual(self.call(method, path, headers=headers, send_body=False)[0], 403)
        for path in ("/api/search/../server.py", "/api/search/" + "a" * 32 + "?x=1"):
            self.assertEqual(self.call("GET", path)[0], 404)
        self.lab.comparator = comparator.Comparator(model_path=Path("not-present"))
        self.assertEqual(self.start_search(body)[0], 503)
        self.assertTrue(self.lab.lock.acquire(blocking=False))
        self.lab.lock.release()

    def test_search_rejects_incompatible_active_styles_before_acceptance(self):
        body = self.search_setup()
        self.lab.voices["am_onyx"] = np.ones((1, 256), dtype=np.float32)
        self.assertEqual(self.start_search(body)[0], 400)
        self.assertIsNone(self.lab.search_thread)


class BrowserScriptTests(unittest.TestCase):
    def test_script_exact_blob_and_stale_results_without_browser(self):
        """Execute actual UI script in a small DOM harness, not a browser acceptance claim."""
        import shutil
        import subprocess
        if not shutil.which("bun"):
            self.skipTest("Bun unavailable for offline UI script harness")
        page = Path(__file__).with_name("index.html").read_text(encoding="utf-8")
        script = page.split("<script>", 1)[1].split("</script>", 1)[0]
        harness = r'''
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const elements = new Map();
function element(id = '') {
  return {id, value: id === 'text' ? 'Sample text' : '', files: [], checked: false,
    hidden: true, disabled: true, textContent: '', dataset: {}, children: [], events: {},
    addEventListener(name, callback) { this.events[name] = callback; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    removeAttribute() {}, setAttribute() {}, pause() {}, load() {},
    play() { return Promise.resolve(); }, remove() {}, click() {},
    get childElementCount() { return this.children.length; }};
}
const document = {getElementById(id) {
  if (!elements.has(id)) elements.set(id, element(id));
  return elements.get(id);
}, createElement: () => element(), createDocumentFragment: () => element(), body: element()};
const window = {addEventListener() {}};
const get = id => document.getElementById(id);
let completeCompare;
let comparedBlob;
let generatedBlob;
let referenceNumber = 0;
let searchNumber = 0;
let searchState = 'running';
let searchPolls = 0;
let searchPreset;
let foreignSearchResponse = false;
let downloadedBlob;
const searchId = () => String(searchNumber).padStart(32, 'b');
const searchData = () => ({jobId: searchId(), referenceId: String(referenceNumber).padStart(32, 'a'),
  state: searchState, trials: 2, attempts: 1, completed: 1, baselineScore: 0.75, bestScore: 0.75,
  bestPreset: searchPreset, history: [{trial: 1, cosine: 0.75}], elapsedSeconds: 1, warnings: []});
const response = data => ({ok: true, json: async () => data});
const fetch = async (path, options) => {
  if (path === '/api/metadata') return response({voices: ['em_alex', 'am_onyx']});
  if (path === '/api/comparator/status') return response({available: true, reference: null, message: 'Local', model: 'fake', revision: 'fake'});
  if (path === '/api/reference') return response({referenceId: String(++referenceNumber).padStart(32, 'a'), durationSeconds: 3, windowCount: 1});
  if (path === '/api/reference/clear') return response({reference: null});
  if (path === '/api/synthesize') {
    generatedBlob = new Blob(['exact generated WAV']);
    return {ok: true, blob: async () => generatedBlob};
  }
  if (path === '/api/search/start') {
    searchNumber++; searchState = 'running';
    const body = JSON.parse(options.body); searchPreset = body.preset;
    assert(body.trials === 2 && body.seed === 0 && body.advancedOffsets === false, 'Exact search schema');
    return response({jobId: searchId()});
  }
  if (path === '/api/search/' + searchId() + '/cancel') { searchState = 'cancelled'; return response(searchData()); }
  if (path === '/api/search/' + searchId() + '/audio') return {ok: true, blob: async () => generatedBlob};
  if (path === '/api/search/' + searchId()) {
    searchPolls++;
    return response(foreignSearchResponse ? {...searchData(), jobId: 'stale-job'} : searchData());
  }
  if (path === '/api/compare') {
    comparedBlob = options.body;
    return await new Promise(resolve => { completeCompare = () => resolve(response({
      referenceId: options.headers['X-Reference-Id'], cosine: 0.75,
      reference: {durationSeconds: 3, windowCount: 1}, candidate: {durationSeconds: 3, windowCount: 1},
      pairWindowSpread: {min: 0.75, max: 0.75, std: 0, count: 1}, model: 'fake', revision: 'fake', warnings: ['Not probability']
    })); });
  }
  throw new Error('Unexpected request: ' + path);
};
const source = await Bun.stdin.text();
new Function('document', 'window', 'fetch', 'URL', source)(document, window, fetch,
  {createObjectURL: blob => { downloadedBlob = blob; return 'blob:fake'; }, revokeObjectURL() {}});
await new Promise(resolve => setTimeout(resolve, 0));
assert(get('compareAudio').disabled, 'No comparison without reference/audio');
get('referenceFile').files = [new Blob(['local reference'])];
get('referenceConsent').checked = true;
get('referenceConsent').events.change();
await get('uploadReference').events.click();
await get('generate').events.click();
assert(!get('compareAudio').disabled, 'Current audio and reference enable explicit compare');
let pending = get('compareAudio').events.click();
assert(comparedBlob === generatedBlob, 'Comparison must send the retained exact generated Blob');
get('reset').events.click();
completeCompare(); await pending;
assert(get('comparisonResult').hidden, 'Reset must suppress an in-flight stale score');
await get('generate').events.click();
pending = get('compareAudio').events.click(); completeCompare(); await pending;
assert(!get('comparisonResult').hidden, 'Current matching result is visible');
assert(get('cosineResult').textContent.includes('0.7500'), 'Raw cosine shown');
get('speed').value = '1.25'; get('speed').events.input();
assert(!get('comparisonResult').hidden, 'Settings do not change existing audio score');
await get('uploadReference').events.click();
assert(get('comparisonResult').hidden, 'Replacement invalidates the score');
await get('clearReference').events.click();
assert(get('compareAudio').disabled, 'Clear removes reference and comparison eligibility');
await get('uploadReference').events.click();
get('searchTrials').value = '2'; get('searchSeed').value = '0';
pending = get('compareAudio').events.click();
assert(get('startSearch').disabled, 'Manual comparison blocks search start');
completeCompare(); await pending;
await get('startSearch').events.click();
assert(get('generate').disabled && get('reset').disabled && get('clearReference').disabled && get('uploadReference').disabled,
  'Active search protects generation, reset and reference');
assert(!get('cancelSearch').disabled, 'Cancellation remains available');
get('reset').events.click();
assert(get('comparisonResult').hidden, 'Search start invalidates manual comparison score');
get('speed').value = '1.9'; get('speed').events.input();
await get('cancelSearch').events.click();
await new Promise(resolve => setTimeout(resolve, 800));
assert(!get('applyBest').disabled, 'Terminal actual best is available');
const pollsAtTerminal = searchPolls;
await new Promise(resolve => setTimeout(resolve, 800));
assert(searchPolls === pollsAtTerminal, 'Terminal state stops polling');
get('exportBest').events.click();
assert(JSON.stringify(JSON.parse(await downloadedBlob.text())) === JSON.stringify(searchPreset),
  'Best export contains exact evaluated preset, not edited controls');
await get('applyBest').events.click();
assert(get('speed').value === String(searchPreset.speed), 'Apply uses evaluated frozen preset, not edited controls');
assert(!get('compareAudio').disabled, 'Apply loads exact best WAV for explicit manual comparison');
pending = get('compareAudio').events.click();
assert(comparedBlob === generatedBlob, 'Applied best retains exact returned WAV');
completeCompare(); await pending;
await get('startSearch').events.click();
assert(get('applyBest').disabled, 'New job invalidates old best');
await get('cancelSearch').events.click();
await new Promise(resolve => setTimeout(resolve, 800));
foreignSearchResponse = true;
await get('startSearch').events.click();
assert(get('applyBest').disabled, 'Foreign/stale job status cannot expose an old best');
const pollsAfterMismatch = searchPolls;
await new Promise(resolve => setTimeout(resolve, 800));
assert(searchPolls === pollsAfterMismatch, 'Mismatched status stops polling, without retry');
foreignSearchResponse = false;
await get('cancelSearch').events.click();
await get('refreshSearch').events.click();
assert(!get('applyBest').disabled, 'Explicit refresh recovers matching terminal best');
'''
        result = subprocess.run(["bun", "-e", harness], input=script, text=True, encoding="utf-8",
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
