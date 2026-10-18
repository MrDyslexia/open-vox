import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AudioCache, cleanupDeadCaches, ownerLiveness } from "../src/audio-cache";
import { createSpeechSink, type Engine, type SpeechProcess } from "../src/speech-sink";

export function wavBytes() {
  const b = Buffer.alloc(46);
  b.write("RIFF"); b.writeUInt32LE(38, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(2, 40);
  return b;
}

test("one valid audio is retained; handles defer replacement/deletion and bad candidates preserve it", () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-"));
  try {
    const cache = new AudioCache(root);
    const a = cache.candidate(); writeFileSync(a, wavBytes());
    expect(cache.promote(a, "s")).toBe(true);
    const release = cache.hold(a);
    const bad = cache.candidate(); writeFileSync(bad, "not audio");
    expect(cache.promote(bad, "s")).toBe(false);
    expect(cache.current()?.file).toBe(a);
    const b = cache.candidate(); writeFileSync(b, wavBytes());
    expect(cache.promote(b, "other")).toBe(true);
    expect(existsSync(a)).toBe(true);
    release(); expect(existsSync(a)).toBe(false);
    expect(readFileSync(b)).toEqual(wavBytes());
    cache.forget("s"); expect(cache.current()?.file).toBe(b);
    const releaseB = cache.hold(b);
    cache.dispose(); expect(existsSync(b)).toBe(true);
    releaseB(); expect(existsSync(cache.directory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sink promotion binds successful audio to its response and failure preserves older ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-")), cache = new AudioCache(root);
  let fail = false, syntheses = 0;
  const played: string[] = [];
  const done = () => ({ exited: Promise.resolve(0), kill() {} });
  const engine = Object.assign(done, { synthesize(_text: string, _language: string, file: string) {
    syntheses++; if (fail) throw Error("failed generation"); writeFileSync(file, wavBytes()); return done();
  } });
  const sink = createSpeechSink({ cache, engine, player: file => { played.push(file); return done(); } });
  try {
    await sink({ sessionID: "s", messageID: "a", text: "Answer A" });
    expect(sink.status!()).toMatchObject({ messageID: "a", revision: 1 });
    fail = true; await sink({ sessionID: "s", messageID: "b", text: "Answer B" });
    expect(sink.status!()).toMatchObject({ messageID: "a", revision: 1 });
    fail = false; await sink({ sessionID: "s", messageID: "b", text: "Answer B" });
    expect(cache.current()).toMatchObject({ messageID: "b", revision: 2 });
    await sink.repeat!("s", 2);
    expect(syntheses).toBe(3); expect(played[2]).toBe(played[1]);
  } finally { await sink.dispose!(); rmSync(root, { recursive: true, force: true }); }
});

const retain = (cache: AudioCache, sessionID = "s") => {
  const file = cache.candidate(); writeFileSync(file, wavBytes());
  expect(cache.promote(file, sessionID)).toBe(true);
  return cache.current()!;
};

test("clear retires held audio until every holder releases and keeps revisions monotonic", () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-"));
  try {
    const cache = new AudioCache(root);
    const first = retain(cache);
    const releaseA = cache.hold(first.file), releaseB = cache.hold(first.file);
    cache.clear();
    expect(cache.current()).toBeUndefined();
    expect(() => cache.hold(first.file)).toThrow();
    expect(cache.promote(first.file, "s")).toBe(false);
    releaseA(); releaseA();
    expect(existsSync(first.file)).toBe(true);
    releaseB();
    expect(existsSync(first.file)).toBe(false);
    cache.clear(); cache.clear();
    const next = retain(cache);
    expect(next.revision).toBeGreaterThan(first.revision);
    cache.clear();
    expect(existsSync(next.file)).toBe(false);
    expect(existsSync(join(cache.directory, "owner.json"))).toBe(true);
    cache.dispose();
    expect(existsSync(cache.directory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clear invalidates held and idle candidates without exhausting future candidate slots", () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-"));
  try {
    const cache = new AudioCache(root);
    const running = cache.candidate(), idle = cache.candidate();
    writeFileSync(running, wavBytes()); writeFileSync(idle, wavBytes());
    const release = cache.hold(running);
    cache.clear();
    expect(existsSync(idle)).toBe(false);
    expect(existsSync(running)).toBe(true);
    expect(cache.promote(running, "s")).toBe(false);
    expect(cache.promote(idle, "s")).toBe(false);
    expect(cache.current()).toBeUndefined();
    release();
    expect(existsSync(running)).toBe(false);
    for (let i = 0; i < 4; i++) { const file = cache.candidate(); cache.discard(file); }
    expect(retain(cache).file).toBe(cache.current()!.file);
    cache.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clear preserves another instance and foreign files even inside its own directory", () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-"));
  try {
    const mine = new AudioCache(root), other = new AudioCache(root);
    const first = retain(mine), second = retain(other);
    const foreign = join(mine.directory, "00000000-0000-0000-0000-000000000000.wav");
    writeFileSync(foreign, wavBytes());
    mine.clear();
    expect(existsSync(first.file)).toBe(false);
    expect(other.current()).toEqual(second);
    expect(readFileSync(second.file)).toEqual(wavBytes());
    expect(readFileSync(foreign)).toEqual(wavBytes());
    expect(existsSync(join(other.directory, "owner.json"))).toBe(true);
    mine.dispose(); other.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clear handles vanished or non-file artifacts and retains forget/dispose semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-"));
  try {
    const cache = new AudioCache(root);
    cache.clear();
    const gone = retain(cache); rmSync(gone.file);
    expect(() => cache.clear()).not.toThrow();
    for (let i = 0; i < 4; i++) { const file = cache.candidate(); cache.discard(file); }
    const odd = retain(cache); rmSync(odd.file); mkdirSync(odd.file);
    expect(() => cache.clear()).not.toThrow();
    expect(cache.current()).toBeUndefined();
    expect(existsSync(odd.file)).toBe(true);
    expect(cache.promote(odd.file, "s")).toBe(false);
    const kept = retain(cache);
    cache.forget("other"); expect(cache.current()).toEqual(kept);
    cache.forget("s"); expect(cache.current()).toBeUndefined();
    const last = retain(cache), release = cache.hold(last.file);
    cache.dispose(); cache.clear();
    expect(existsSync(last.file)).toBe(true);
    release(); expect(existsSync(last.file)).toBe(false);
    expect(existsSync(odd.file)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clearing retained audio makes Repeat unavailable without synthesis or playback", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-"));
  try {
    const cache = new AudioCache(root);
    const retained = retain(cache);
    let syntheses = 0, plays = 0;
    const engine: Engine = Object.assign(() => { throw new Error("legacy path forbidden"); }, {
      synthesize() { syntheses++; throw new Error("Repeat must not synthesize"); },
    });
    const sink = createSpeechSink({ cache, engine, player: () => {
      plays++; return { exited: Promise.resolve(0), kill() {} };
    } });
    cache.clear();
    await sink.repeat!("s", retained.revision);
    expect(cache.current()).toBeUndefined();
    expect(syntheses).toBe(0); expect(plays).toBe(0);
    await sink.dispose!();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup removes only confirmed-dead owned caches, preserving live, unknown and foreign content", () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-"));
  try {
    const dead = new AudioCache(root), live = new AudioCache(root), unknown = new AudioCache(root);
    const rewrite = (c: AudioCache, pid: number) => {
      const path = join(c.directory, "owner.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), pid }));
    };
    rewrite(dead, 101); rewrite(live, 102); rewrite(unknown, 103);
    mkdirSync(join(root, "foreign")); writeFileSync(join(root, "foreign", "keep"), "x");
    cleanupDeadCaches(root, (pid) => pid === 101 ? "dead" : pid === 102 ? "live" : "unknown");
    expect(existsSync(dead.directory)).toBe(false);
    expect(existsSync(live.directory)).toBe(true);
    expect(existsSync(unknown.directory)).toBe(true);
    expect(existsSync(join(root, "foreign", "keep"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only ESRCH confirms death; access failures and reused live PIDs are not deletable", () => {
  expect(ownerLiveness(1, () => {})).toBe("live");
  expect(ownerLiveness(1, () => { throw Object.assign(new Error(), { code: "ESRCH" }); })).toBe("dead");
  expect(ownerLiveness(1, () => { throw Object.assign(new Error(), { code: "EPERM" }); })).toBe("unknown");
  expect(ownerLiveness(1, () => { throw new Error(); })).toBe("unknown");
});

test("cache rejects linked roots and never deletes linked entries or external paths", () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-"));
  try {
    const target = join(root, "target"); mkdirSync(target);
    const link = join(root, "linked"); symlinkSync(target, link, "junction");
    expect(() => new AudioCache(link)).toThrow();
    const cache = new AudioCache(root);
    const external = join(target, "keep.wav"); writeFileSync(external, wavBytes());
    expect(cache.promote(external, "s")).toBe(false);
    cache.discard(external); expect(existsSync(external)).toBe(true);
    cache.dispose(); expect(existsSync(external)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sink replays identical WAV bytes without synthesis and defers owner deletion until fake player closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-vox-test-"));
  try {
    const cache = new AudioCache(root);
    let syntheses = 0, bad = false, paused = false, holdPlayer = false;
    let finish!: (code: number) => void;
    const played: Buffer[] = [];
    const success = (): SpeechProcess => ({ exited: Promise.resolve(0), kill() {} });
    const engine: Engine = Object.assign(() => { throw new Error("legacy path forbidden"); }, {
      synthesize(_text: string, _lang: string, file: string) {
        syntheses++; writeFileSync(file, bad ? Buffer.from("invalid") : wavBytes()); return success();
      },
    });
    const sink = createSpeechSink({ cache, engine, isPaused: () => paused, player: (file) => {
      played.push(readFileSync(file));
      if (!holdPlayer) return success();
      return { exited: new Promise<number>((r) => { finish = r; }), kill() { finish(1); } };
    } });
    await sink({ sessionID: "s", messageID: "m", text: "Original synthesized audio." });
    const first = cache.current()!;
    bad = true;
    await sink({ sessionID: "s", messageID: "bad", text: "Invalid candidate preserves original." });
    expect(cache.current()).toEqual(first);
    await sink.repeat!("other", first.revision);
    paused = true; await sink.repeat!("s", first.revision); paused = false;
    await sink.repeat!("s", first.revision);
    expect(syntheses).toBe(2);
    expect(played).toHaveLength(2);
    expect(played[0]).toEqual(played[1]);
    holdPlayer = true;
    const replay = sink.repeat!("s", first.revision);
    await Bun.sleep(0);
    sink.removeSession!("s");
    expect(existsSync(first.file)).toBe(true);
    await replay;
    expect(existsSync(first.file)).toBe(false);
    await sink.dispose!();
    expect(existsSync(cache.directory)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
