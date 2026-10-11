import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";

export type CachedAudio = { file: string; sessionID: string; revision: number };
export type AudioStore = Pick<AudioCache, "candidate" | "current" | "promote" | "discard" | "hold" | "forget" | "dispose">;
export const audioCacheRoot = () => join(tmpdir(), "open-vox-audio-v1");
type Liveness = "live" | "dead" | "unknown";
const noncePattern = /^[a-f0-9-]{36}$/;
const wavPattern = /^[a-f0-9-]{36}\.wav$/;

/** A reused PID is conservatively live. Only ESRCH permits dead-owner cleanup. */
export function ownerLiveness(pid: number, kill: (pid: number, signal: number) => unknown = process.kill): Liveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try { kill(pid, 0); return "live"; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "ESRCH" ? "dead" : "unknown"; }
}

/** Reject junctions/symlinks in the entire existing ancestor chain. */
function safeDirectory(path: string): boolean {
  try {
    let at = resolve(path);
    while (true) {
      if (existsSync(at)) {
        const s = lstatSync(at);
        if (s.isSymbolicLink() || !s.isDirectory()) return false;
        const actual = realpathSync(at);
        if (actual.toLowerCase() !== at.toLowerCase()) return false;
      }
      const parent = dirname(at);
      if (parent === at) return true;
      at = parent;
    }
  } catch { return false; }
}

function regularFile(path: string): boolean {
  try { const s = lstatSync(path); return s.isFile() && !s.isSymbolicLink(); } catch { return false; }
}

function validWav(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (size < 44 || size > 64 * 1024 * 1024) return false;
    const b = readFileSync(path);
    if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE" || b.readUInt32LE(4) + 8 !== size) return false;
    let fmt = false, data = false;
    for (let at = 12; at + 8 <= b.length;) {
      const kind = b.toString("ascii", at, at + 4), length = b.readUInt32LE(at + 4);
      if (at + 8 + length > b.length) return false;
      if (kind === "fmt " && length >= 16) {
        const channels = b.readUInt16LE(at + 10), rate = b.readUInt32LE(at + 12), bits = b.readUInt16LE(at + 22);
        const align = channels * bits / 8;
        fmt = b.readUInt16LE(at + 8) === 1 && channels > 0 && rate > 0 && [8, 16, 24, 32].includes(bits) &&
          b.readUInt16LE(at + 20) === align && b.readUInt32LE(at + 16) === rate * align;
      }
      if (kind === "data") data = length > 0;
      at += 8 + length + (length % 2);
    }
    return fmt && data;
  } catch { return false; }
}

/** Never recursively delete: foreign files or linked entries veto the whole cleanup. */
export function cleanupDeadCaches(root: string, alive: (pid: number) => Liveness = ownerLiveness): void {
  if (!safeDirectory(root) || !existsSync(root)) return;
  for (const name of readdirSync(root).slice(0, 128)) {
    if (!name.startsWith("instance-") || !noncePattern.test(name.slice(9))) continue;
    const directory = join(root, name), marker = join(directory, "owner.json");
    try {
      if (!safeDirectory(directory) || !regularFile(marker)) continue;
      const raw = readFileSync(marker, "utf8"), owner = JSON.parse(raw);
      if (owner.version !== 1 || owner.nonce !== name.slice(9) || alive(owner.pid) !== "dead") continue;
      const files = readdirSync(directory);
      if (files.length > 4 || files.some((f) => (f !== "owner.json" && !wavPattern.test(f)) || !regularFile(join(directory, f)))) continue;
      if (!safeDirectory(directory) || readFileSync(marker, "utf8") !== raw || alive(owner.pid) !== "dead") continue;
      for (const file of files) if (file !== "owner.json") unlinkSync(join(directory, file));
      unlinkSync(marker); // Keep ownership evidence if a writer/player still locks an artifact.
      rmdirSync(directory);
    } catch { /* Unknown ownership, access or locking state is never permission to delete. */ }
  }
}

/** One committed artifact plus bounded candidates; held files retire only after player exit. */
export class AudioCache {
  readonly instance = randomUUID();
  readonly directory: string;
  private files = new Set<string>();
  private holds = new Map<string, number>();
  private retired = new Set<string>();
  private last?: CachedAudio;
  private revision = 0;
  private disposed = false;

  constructor(root = audioCacheRoot()) {
    if (!safeDirectory(root)) throw new Error("Unsafe audio cache root");
    mkdirSync(root, { recursive: true });
    cleanupDeadCaches(root);
    this.directory = join(resolve(root), `instance-${this.instance}`);
    mkdirSync(this.directory);
    writeFileSync(join(this.directory, "owner.json"), JSON.stringify({ version: 1, nonce: this.instance, pid: process.pid }), { flag: "wx" });
  }

  candidate(): string {
    if (this.disposed || this.files.size >= 3 || !safeDirectory(this.directory)) throw new Error("Audio cache unavailable");
    const file = join(this.directory, `${randomUUID()}.wav`);
    writeFileSync(file, "", { flag: "wx" });
    this.files.add(file);
    return file;
  }

  current(): CachedAudio | undefined { return this.last && this.owns(this.last.file) ? { ...this.last } : undefined; }

  private owns(file: string): boolean {
    return this.files.has(file) && dirname(file) === this.directory && wavPattern.test(basename(file)) && safeDirectory(this.directory) && regularFile(file);
  }

  promote(file: string, sessionID: string): boolean {
    if (this.disposed || !this.owns(file) || !validWav(file)) { this.discard(file); return false; }
    const previous = this.last;
    this.last = { file, sessionID, revision: ++this.revision };
    if (previous && previous.file !== file) this.discard(previous.file);
    return true;
  }

  hold(file: string): () => void {
    if (this.disposed || this.retired.has(file) || !this.owns(file)) throw new Error("Audio artifact unavailable");
    this.holds.set(file, (this.holds.get(file) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.holds.get(file) ?? 1) - 1;
      if (count) this.holds.set(file, count); else this.holds.delete(file);
      if (this.retired.has(file)) this.discard(file);
      this.finishDisposal();
    };
  }

  discard(file: string): void {
    if (!this.files.has(file)) return;
    this.retired.add(file);
    if (this.holds.has(file)) return;
    try {
      if (!this.owns(file)) return;
      unlinkSync(file);
      this.files.delete(file); this.retired.delete(file);
    } catch { /* A locked artifact remains owned for a later safe cleanup. */ }
  }

  forget(sessionID: string): void {
    if (this.last?.sessionID !== sessionID) return;
    const file = this.last.file;
    this.last = undefined;
    this.discard(file);
  }

  dispose(): void {
    this.disposed = true; this.last = undefined;
    for (const file of this.files) this.discard(file);
    this.finishDisposal();
  }

  private finishDisposal(): void {
    if (!this.disposed || this.files.size || !safeDirectory(this.directory)) return;
    try {
      const marker = join(this.directory, "owner.json");
      if (!regularFile(marker) || readdirSync(this.directory).some((f) => f !== "owner.json")) return;
      const owner = JSON.parse(readFileSync(marker, "utf8"));
      if (owner.nonce !== this.instance || owner.pid !== process.pid) return;
      unlinkSync(marker); rmdirSync(this.directory);
    } catch {}
  }
}
