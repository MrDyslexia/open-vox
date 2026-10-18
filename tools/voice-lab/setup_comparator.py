"""Explicit optional bootstrap. No install or download happens on import."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import venv


ROOT = Path(__file__).resolve().parent
APPROVED_TEMP = Path.home() / "AppData/Local/Temp/opencode"
BUDGET = 1_000_000_000
PACKAGE_HOSTS = {"files.pythonhosted.org", "download.pytorch.org", "download-r2.pytorch.org"}


def checked_parent(path):
    if not path.is_dir():
        raise RuntimeError("Expected bootstrap parent directory is missing.")


def wheel_size(item):
    url = item["download_info"]["url"]
    if urlparse(url).scheme != "https" or urlparse(url).hostname not in PACKAGE_HOSTS:
        raise RuntimeError("Package source is not an approved public wheel host.")
    with urlopen(Request(url, method="HEAD"), timeout=30) as response:
        length = response.headers.get("Content-Length")
    if not length or not length.isdigit():
        # Some official CPU wheel CDN responses omit HEAD Content-Length.
        with urlopen(Request(url, headers={"Range": "bytes=0-0"}), timeout=30) as response:
            content_range = response.headers.get("Content-Range", "")
            length = content_range.rsplit("/", 1)[-1]
    if not length.isdigit():
        raise RuntimeError("Unknown download size; stop for an explicit cost decision.")
    return int(length)


def estimate(report, provenance):
    items = json.loads(report.read_text(encoding="utf-8"))["install"]
    normalize = lambda name: name.lower().replace("_", "-").replace(".", "-")
    expected = {}
    for line in (ROOT / "requirements-comparator.txt").read_text(encoding="utf-8").splitlines():
        if "==" in line and not line.startswith("#"):
            name, version = line.split("==", 1)
            expected[normalize(name)] = version
    observed = {normalize(x["metadata"]["name"]): x["metadata"]["version"] for x in items}
    if expected != observed or len(observed) != len(items):
        raise RuntimeError("Dry-run report does not match the complete pinned requirements.")
    with ThreadPoolExecutor(max_workers=4) as pool:
        sizes = list(pool.map(wheel_size, items))
    total = sum(sizes) + provenance["bytes"]
    print(json.dumps({"wheelBytes": sum(sizes), "modelBytes": provenance["bytes"],
                      "totalDownloadBytes": total, "budgetBytes": BUDGET,
                      "packages": {x["metadata"]["name"]: x["metadata"]["version"] for x in items}}, indent=2))
    if total > BUDGET:
        raise RuntimeError("Download estimate exceeds 1 GB; stop for a cost decision.")
    return total


def download_model(provenance):
    checked_parent(ROOT)
    folder = ROOT / ".models"
    folder.mkdir(exist_ok=True)
    target = folder / provenance["filename"]
    if target.is_file():
        with target.open("rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        if target.stat().st_size == provenance["bytes"] and digest == provenance["sha256"]:
            print("Existing checkpoint verified; no download.")
            return
        raise RuntimeError("Existing checkpoint is invalid; not overwriting it.")
    partial = target.with_suffix(".part")
    created = False
    try:
        digest, size = hashlib.sha256(), 0
        with urlopen(provenance["url"], timeout=60) as response, partial.open("xb") as f:
            created = True
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > provenance["bytes"]:
                    raise RuntimeError("Model exceeded its reviewed byte count.")
                digest.update(chunk)
                f.write(chunk)
        if size != provenance["bytes"] or digest.hexdigest() != provenance["sha256"]:
            raise RuntimeError("Model size or SHA256 verification failed.")
        partial.replace(target)
        print(f"Checkpoint verified: {size} bytes, SHA256 {digest.hexdigest()}")
    finally:
        if created:
            partial.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="Create only the isolated lab environment and install pinned wheels")
    parser.add_argument("--download-model", action="store_true", help="Download only the reviewed public embedding checkpoint")
    parser.add_argument("--report", type=Path, help="Existing trusted pip dry-run JSON report (CLI only)")
    parser.add_argument("--estimate", action="store_true", help="Resolve and measure public downloads without installing")
    args = parser.parse_args()
    if not any((args.install, args.download_model, args.estimate)):
        parser.print_help()
        return 0
    if sys.version_info[:2] != (3, 13) or sys.platform != "win32":
        parser.error("This verified pin set requires Windows CPython 3.13.")
    checked_parent(ROOT)
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    if not all(name in ignore.splitlines() for name in (".venv-comparator/", ".models/")):
        raise RuntimeError("Runtime ignore rules must exist before bootstrap.")
    provenance = json.loads((ROOT / "model-provenance.json").read_text(encoding="utf-8"))
    if args.install or args.estimate:
        checked_parent(APPROVED_TEMP)
        report = args.report
        if report is None:
            with tempfile.NamedTemporaryFile(dir=APPROVED_TEMP, suffix=".json", delete=False) as f:
                report = Path(f.name)
            subprocess.run([sys.executable, "-B", "-m", "pip", "--isolated", "install",
                            "--dry-run", "--ignore-installed", "--only-binary=:all:", "--report", str(report),
                            "-r", str(ROOT / "requirements-comparator.txt")], check=True)
        estimate(report, provenance)
    if args.install:
        environment = ROOT / ".venv-comparator"
        if not environment.exists():
            venv.EnvBuilder(with_pip=True).create(environment)
        python = environment / "Scripts/python.exe"
        subprocess.run([str(python), "-B", "-m", "pip", "--isolated", "install", "--only-binary=:all:",
                        "-r", str(ROOT / "requirements-comparator.txt")], check=True)
        subprocess.run([str(python), "-B", "-m", "pip", "check"], check=True)
        size = sum(f.stat().st_size for f in environment.rglob("*") if f.is_file())
        print(f"Isolated environment file bytes: {size}")
    if args.download_model:
        download_model(provenance)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Bootstrap stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
