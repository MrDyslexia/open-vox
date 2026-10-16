"""Standalone, loopback-only experimental Kokoro style laboratory."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import copy
import re
from pathlib import Path
import socket
import threading
import uuid

import numpy as np
import soundfile as sf
from comparator import Comparator, MAX_WAV_BYTES, StaleReference, Unavailable, compare_summaries
from search import SearchJob, validate_request


MAX_BODY = 32 * 1024
LANGUAGES = ("es", "en-us", "en-gb")
FIELDS = {"version", "text", "baseVoice", "donorVoice", "timbreWeight",
          "prosodyWeight", "speed", "lang", "offsets"}
ASSETS = Path.home() / "AppData/Local/open-vox/kokoro"
DEFAULT_TEXT = "Los sistemas claros nos ayudan a pensar mejor y a construir con confianza."


class Busy(Exception):
    """Inference is already running; callers must retry explicitly."""


def number(value, low, high):
    return (type(value) in (int, float) and low <= value <= high
            and math.isfinite(value))


def validate(body, voices):
    """Validate the exact versioned preset/request schema without coercion."""
    if not isinstance(body, dict) or set(body) != FIELDS:
        raise ValueError("Use the complete version 1 preset schema.")
    if type(body["version"]) is not int or body["version"] != 1:
        raise ValueError("Unsupported preset version.")
    text = body["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > 500:
        raise ValueError("Text must contain 1 to 500 characters.")
    if not isinstance(body["baseVoice"], str) or body["baseVoice"] not in voices:
        raise ValueError("Choose an available base voice.")
    donor = body["donorVoice"]
    if donor is not None and (not isinstance(donor, str) or donor not in voices):
        raise ValueError("Choose an available donor voice or Off.")
    if not isinstance(body["lang"], str) or body["lang"] not in LANGUAGES:
        raise ValueError("Choose Spanish, US English or UK English.")
    for name, low, high in (("timbreWeight", 0, 1), ("prosodyWeight", 0, 1),
                           ("speed", 0.5, 2)):
        if not number(body[name], low, high):
            raise ValueError(f"{name} must be a finite number from {low} to {high}.")
    if donor is None and (body["timbreWeight"] or body["prosodyWeight"]):
        raise ValueError("Donor Off requires both blend weights to be zero.")
    offsets = body["offsets"]
    if (not isinstance(offsets, list) or len(offsets) != 256
            or not all(number(value, -2, 2) for value in offsets)):
        raise ValueError("Provide exactly 256 finite offsets from -2 to 2.")
    return body


def checked_style(value):
    style = np.asarray(value)
    if (style.ndim < 2 or style.shape[-1] != 256 or style.size == 0
            or style.dtype.kind not in "fi" or not np.isfinite(style).all()):
        raise ValueError("Incompatible voice style data.")
    return style


def build_style(body, voices):
    validate(body, voices)
    # Always own the output, including Off: the model must not mutate the cache.
    style = checked_style(voices[body["baseVoice"]]).astype(np.float32, copy=True)
    if body["timbreWeight"] or body["prosodyWeight"]:
        donor = checked_style(voices[body["donorVoice"]])
        if donor.shape != style.shape:
            raise ValueError("Base and donor style shapes must match.")
        for start, end, weight in ((0, 128, body["timbreWeight"]),
                                   (128, 256, body["prosodyWeight"])):
            if weight:
                style[..., start:end] = (style[..., start:end] * (1 - weight)
                                         + donor[..., start:end] * weight)
    if any(body["offsets"]):
        style += np.asarray(body["offsets"], dtype=np.float32)
    if not np.isfinite(style).all():
        raise ValueError("Style adjustment produced invalid data.")
    return style


class Lab:
    def __init__(self, voices, model_factory, comparator=None):
        self.voices = {}
        for name, value in voices.items():
            cached = np.array(value, copy=True)
            cached.flags.writeable = False
            self.voices[name] = cached
        self.model_factory = model_factory
        self.model = None
        self.lock = threading.Lock()
        self.comparator = comparator if comparator is not None else Comparator()
        self.reference = None
        self.search_lock = threading.Lock()
        self.search_job = None
        self.search_thread = None

    def start_search(self, body):
        validate_request(body, lambda p: validate(p, self.voices))
        if not self.lock.acquire(blocking=False):
            raise Busy()
        try:
            preset = body["preset"]
            base = checked_style(self.voices[preset["baseVoice"]])
            if preset["donorVoice"] is not None:
                donor = checked_style(self.voices[preset["donorVoice"]])
                if donor.shape != base.shape:
                    raise ValueError("Search requires compatible base and donor shapes.")
            if not self.comparator.status()["available"]:
                raise Unavailable()
            if self.reference is None or self.reference[0] != body["referenceId"]:
                raise StaleReference()
            reference_id, summary = self.reference
            reference = copy.deepcopy(summary)
            reference.vector.flags.writeable = False
            reference.embeddings.flags.writeable = False
            def evaluate(preset):
                wav = self.synthesize_owned(preset)
                candidate = self.comparator.analyze(wav)
                return wav, compare_summaries(reference, candidate, reference_id)
            metadata = self.comparator.status()
            job = SearchJob(uuid.uuid4().hex, body, evaluate,
                            {key: metadata[key] for key in ("model", "revision", "warnings")})
            def run():
                try:
                    job.run()
                finally:
                    self.lock.release()
            with self.search_lock:
                # A terminal state can precede the worker's finally block. Join
                # that already-terminal worker before replacing retained results.
                if self.search_thread is not None:
                    self.search_thread.join()
                self.search_job = job
                self.search_thread = threading.Thread(target=run, daemon=True)
                self.search_thread.start()
            return {"jobId": job.id, "referenceId": reference_id}
        except Exception:
            self.lock.release()
            raise

    def get_search(self, job_id):
        with self.search_lock:
            if self.search_job is None or self.search_job.id != job_id:
                raise KeyError(job_id)
            return self.search_job

    def comparator_status(self):
        reference = self.reference
        with self.search_lock:
            job = self.search_job
            search = None if job is None else {"jobId": job.id,
                "referenceId": job.request["referenceId"], "state": job.status()["state"]}
        return {**self.comparator.status(), "search": search, "reference": None if reference is None else
                {"referenceId": reference[0], **reference[1].metadata()}}

    def reference_action(self, action, read_body, reference_id=None):
        # The same nonblocking gate covers uploads, decoding, embedding and synthesis.
        # Read only after acquiring it, so busy uploads do not allocate a WAV buffer.
        if not self.lock.acquire(blocking=False):
            raise Busy()
        try:
            raw = read_body()
            if action == "/api/reference/clear":
                if strict_json(raw) != {}:
                    raise ValueError("Clear requires an empty JSON object.")
                self.reference = None
                return {"reference": None}
            if action == "/api/compare":
                reference = self.reference
                if reference is None or reference[0] != reference_id:
                    raise StaleReference()
                candidate = self.comparator.analyze(raw)
                return compare_summaries(reference[1], candidate, reference_id)
            summary = self.comparator.analyze(raw)
            reference_id = uuid.uuid4().hex
            self.reference = (reference_id, summary)
            return {"referenceId": reference_id, **summary.metadata()}
        finally:
            self.lock.release()

    def metadata(self):
        return {"version": 1, "voices": sorted(self.voices), "languages": list(LANGUAGES),
                "maxText": 500, "defaultText": DEFAULT_TEXT}

    def synthesize(self, body):
        validate(body, self.voices)
        if not self.lock.acquire(blocking=False):
            raise Busy()
        try:
            return self.synthesize_owned(body)
        finally:
            self.lock.release()

    def synthesize_owned(self, body):
        """Internal seam: caller must own the shared work gate."""
        style = build_style(body, self.voices)
        if self.model is None:
            self.model = self.model_factory()
        samples, sr = self.model.create(body["text"], voice=style,
                                       speed=body["speed"], lang=body["lang"])
        samples = np.asarray(samples)
        if (samples.ndim != 1 or not samples.size or not np.isfinite(samples).all()
                or isinstance(sr, bool) or not isinstance(sr, (int, np.integer))
                or not 8000 <= sr <= 192000):
            raise ValueError("Invalid synthesized audio.")
        wav = io.BytesIO()
        sf.write(wav, samples, int(sr), format="WAV", subtype="PCM_16")
        return wav.getvalue()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON field.")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("Invalid JSON number.")

    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)


class Handler(BaseHTTPRequestHandler):
    server_version = "VoiceLab"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        # Do not log text, browser input or filesystem details.
        pass

    def send(self, status, data, content_type="application/json"):
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; "
                         "style-src 'unsafe-inline'; connect-src 'self'; media-src blob:; "
                         "base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        if status == 429:
            self.send_header("Retry-After", "2")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass

    def error(self, status, message, code=None):
        body = {"error": message}
        if code is not None:
            body["code"] = code
        self.send(status, json.dumps(body).encode())

    def boundary(self):
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origins = {f"http://{host}" for host in hosts}
        host = self.headers.get_all("Host", [])
        origin = self.headers.get_all("Origin", [])
        if len(host) != 1 or host[0] not in hosts or (origin and (len(origin) != 1 or origin[0] not in origins)):
            self.error(403, "Use this lab's local loopback URL and origin.")
            return False
        return True

    def do_GET(self):
        if not self.boundary():
            return
        if self.path in ("/", "/index.html"):
            self.send(200, self.server.page, "text/html; charset=utf-8")
        elif self.path == "/api/metadata":
            self.send(200, json.dumps(self.server.lab.metadata()).encode())
        elif self.path == "/api/comparator/status":
            self.send(200, json.dumps(self.server.lab.comparator_status()).encode())
        elif re.fullmatch(r"/api/search/[a-f0-9]{32}(/audio)?", self.path):
            self.search_result()
        else:
            self.error(404, "Route not found.")

    def do_POST(self):
        if not self.boundary():
            return
        if self.path == "/api/search/start" or re.fullmatch(r"/api/search/[a-f0-9]{32}/cancel", self.path):
            self.search_request()
            return
        if self.path in ("/api/reference", "/api/compare", "/api/reference/clear"):
            self.comparison_request()
            return
        if self.path != "/api/synthesize":
            self.error(404, "Route not found.")
            return
        types = self.headers.get_all("Content-Type", [])
        if len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json":
            self.error(415, "Send application/json.")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if (self.headers.get_all("Transfer-Encoding") or len(lengths) != 1
                or not lengths[0].isascii() or not lengths[0].isdigit()):
            self.error(400, "Provide one bounded Content-Length; chunked requests are unsupported.")
            return
        # Bound digit count before int conversion, including enormous headers.
        if len(lengths[0]) > 6 or int(lengths[0]) > MAX_BODY:
            self.error(413, "Request exceeds the 32 KiB limit.")
            return
        length = int(lengths[0])
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request.")
            body = strict_json(raw)
            validate(body, self.server.lab.voices)
        except socket.timeout:
            self.error(408, "Request body timed out.")
            return
        except (ValueError, UnicodeError, RecursionError, OverflowError):
            self.error(400, "Invalid request. Check the version, text, voices and numeric limits.")
            return
        try:
            wav = self.server.lab.synthesize(body)
        except Busy:
            self.error(429, "The model is busy. Wait for the current generation, then try again.")
        except Exception:
            self.error(500, "Synthesis failed. Check the local model environment or reduce adjustments.")
        else:
            self.send(200, wav, "audio/wav")

    def comparison_request(self):
        is_clear = self.path == "/api/reference/clear"
        expected = "application/json" if is_clear else "audio/wav"
        types = self.headers.get_all("Content-Type", [])
        if len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != expected:
            self.error(415, f"Send {expected}.")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if (self.headers.get_all("Transfer-Encoding") or len(lengths) != 1
                or not lengths[0].isascii() or not lengths[0].isdigit()):
            self.error(400, "Provide one bounded Content-Length; chunked requests are unsupported.")
            return
        limit = MAX_BODY if is_clear else MAX_WAV_BYTES
        if len(lengths[0]) > 8 or int(lengths[0]) > limit:
            self.error(413, "Request exceeds the JSON 32 KiB or WAV 10 MiB limit.")
            return
        length = int(lengths[0])
        if length == 0:
            self.error(400, "A request body is required.")
            return
        reference_id = None
        if self.path == "/api/compare":
            ids = self.headers.get_all("X-Reference-Id", [])
            if len(ids) != 1 or not 1 <= len(ids[0]) <= 64:
                self.error(400, "Provide one current X-Reference-Id.")
                return
            reference_id = ids[0]
        def read_body():
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request.")
            return raw
        try:
            result = self.server.lab.reference_action(self.path, read_body, reference_id)
        except Busy:
            self.error(429, "The lab is busy. Wait for current work, then retry.", "busy")
        except socket.timeout:
            self.error(408, "Request body timed out.", "body_timeout")
        except StaleReference:
            self.error(409, "Reference was replaced or cleared. Upload or select the current reference.", "stale_reference")
        except Unavailable:
            self.error(503, "Comparator unavailable. Check explicit setup and the isolated environment.", "comparator_unavailable")
        except (ValueError, UnicodeError, RecursionError, OverflowError):
            self.error(400, "Invalid input. Use a non-silent 2–60 second PCM WAV or an empty clear object.", "invalid_input")
        except Exception:
            self.error(503, "Comparator failed; no score was produced.", "comparator_unavailable")
        else:
            self.send(200, json.dumps(result, allow_nan=False).encode())

    def search_result(self):
        try:
            job = self.server.lab.get_search(self.path.split("/")[3])
        except KeyError:
            self.error(404, "Unknown or replaced search job.", "unknown_job")
            return
        if self.path.endswith("/audio"):
            wav = job.audio()
            if wav is None:
                self.error(409, "No successful candidate audio yet.", "no_best")
            elif job.status()["state"] in ("running", "cancelling"):
                self.error(409, "Wait for terminal results before loading best audio.", "job_active")
            else:
                self.send(200, wav, "audio/wav")
        else:
            self.send(200, json.dumps(job.status(), allow_nan=False).encode())

    def search_request(self):
        types = self.headers.get_all("Content-Type", [])
        if len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json":
            self.error(415, "Send application/json.")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if (self.headers.get_all("Transfer-Encoding") or len(lengths) != 1
                or not lengths[0].isascii() or not lengths[0].isdigit()):
            self.error(400, "Provide one bounded Content-Length.")
            return
        if len(lengths[0]) > 6 or int(lengths[0]) > MAX_BODY:
            self.error(413, "Request exceeds the 32 KiB limit.")
            return
        try:
            length = int(lengths[0])
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError()
            body = strict_json(raw)
            if self.path == "/api/search/start":
                result = self.server.lab.start_search(body)
                self.send(202, json.dumps(result).encode())
            else:
                if body != {}:
                    raise ValueError()
                job = self.server.lab.get_search(self.path.split("/")[3])
                job.cancel()
                self.send(200, json.dumps(job.status(), allow_nan=False).encode())
        except Busy:
            self.error(429, "The shared lab resource is busy.", "busy")
        except StaleReference:
            self.error(409, "Select the current reference.", "stale_reference")
        except Unavailable:
            self.error(503, "Comparator unavailable.", "comparator_unavailable")
        except KeyError:
            self.error(404, "Unknown or replaced search job.", "unknown_job")
        except socket.timeout:
            self.error(408, "Request body timed out.", "body_timeout")
        except (ValueError, UnicodeError, RecursionError, OverflowError):
            self.error(400, "Invalid search schema, preset, reference ID, trials or seed.", "invalid_search")
        except Exception:
            self.error(500, "Search could not start.", "search_failed")


def make_server(lab, port=8765):
    http = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    http.daemon_threads = True
    http.lab = lab
    http.page = Path(__file__).with_name("index.html").read_bytes()
    return http


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", type=Path, default=ASSETS / "kokoro-v1.0.onnx")
    parser.add_argument("--voices", type=Path, default=ASSETS / "voices-v1.0.bin")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        # Trusted CLI asset only; never unpickle a voicepack or accept browser paths.
        with np.load(args.voices, allow_pickle=False) as pack:
            voices = {name: pack[name] for name in pack.files}
        if not voices:
            raise ValueError("Empty voicepack")

        def model_factory():
            from kokoro_onnx import Kokoro
            return Kokoro(str(args.model), str(args.voices))

        http = make_server(Lab(voices, model_factory), args.port)
    except Exception:
        print("Voice lab could not start. Check trusted local assets, dependencies and port availability.")
        return 1
    print(f"Voice lab: http://127.0.0.1:{args.port}/ (Ctrl+C to stop)")
    print("Model initialization is deferred until the first Generate request.")
    try:
        http.serve_forever()
    except KeyboardInterrupt:
        print("Stopping voice lab.")
    finally:
        http.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
