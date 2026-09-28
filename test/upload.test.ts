import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { KNOWN_EXTENSIONS, mimeTypeFor } from "../src/mime.js";
import { mp4DurationSeconds } from "../src/mp4.js";

import { FakeTopped } from "./fakeTopped.js";
import { Harness } from "./harness.js";

/** One ISO BMFF box. */
function box(type: string, ...content: Uint8Array[]): Buffer {
  const body = Buffer.concat(content);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const body = Buffer.alloc(100);
  body.writeUInt8(0, 0); // version
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return box("mvhd", body);
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  const body = Buffer.alloc(112);
  body.writeUInt8(1, 0);
  body.writeUInt32BE(timescale, 20);
  body.writeBigUInt64BE(duration, 24);
  return box("mvhd", body);
}

/** A file shaped like a recording: ftyp, the media, then moov at the end (as a simulator writes it). */
function movie(mvhd: Buffer, mediaBytes = 64): Buffer {
  return Buffer.concat([
    box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2mp41", "latin1")),
    box("free"),
    box("mdat", Buffer.alloc(mediaBytes, 7)),
    box("moov", mvhd, box("trak", box("tkhd", Buffer.alloc(84)))),
  ]);
}

/** The types Topped's Library stores; it refuses the bytes of any other. */
const LIBRARY_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/vnd.wave",
  "audio/ogg",
];

describe("a file's type", () => {
  it("is always one the Library stores", () => {
    for (const extension of KNOWN_EXTENSIONS) expect(LIBRARY_TYPES, extension).toContain(mimeTypeFor(`clip.${extension}`));
  });

  it("sends an M4V as the MP4 it is, and takes no HEIC", () => {
    expect(mimeTypeFor("demo.M4V")).toBe("video/mp4");
    expect(mimeTypeFor("photo.heic")).toBeNull();
  });
});

describe("reading a clip's length from its header", () => {
  it("MP4, version 0 movie header", () => {
    expect(mp4DurationSeconds(movie(mvhdV0(600, 7_230)))).toBe(12.05);
  });

  it("MOV with a version 1 (64-bit) movie header", () => {
    expect(mp4DurationSeconds(movie(mvhdV1(90_000, 2_700_000n)))).toBe(30);
  });

  it("a 64-bit box size", () => {
    const large = Buffer.alloc(16);
    large.writeUInt32BE(1, 0);
    large.write("mdat", 4, "latin1");
    large.writeBigUInt64BE(16n + 10n, 8);
    const file = Buffer.concat([large, Buffer.alloc(10), box("moov", mvhdV0(1000, 4500))]);
    expect(mp4DurationSeconds(file)).toBe(4.5);
  });

  it("no answer when there is no movie header, or it says nothing", () => {
    expect(mp4DurationSeconds(Buffer.from("not a movie at all"))).toBeNull();
    expect(mp4DurationSeconds(movie(mvhdV0(600, 0)))).toBeNull();
    expect(mp4DurationSeconds(box("moov", box("trak")))).toBeNull();
    // A truncated file.
    expect(mp4DurationSeconds(movie(mvhdV0(600, 6000)).subarray(0, 120))).toBeNull();
  });
});

describe("topped upload", () => {
  const fake = new FakeTopped();
  const harness = new Harness(fake);
  let dir = "";

  beforeAll(async () => {
    await fake.start();
    dir = await mkdtemp(join(tmpdir(), "topped-cli-upload-"));
    await writeFile(join(dir, "demo.mov"), movie(mvhdV0(600, 12_000)));
    await writeFile(join(dir, "clip.mp4"), movie(mvhdV0(1000, 0)));
    await writeFile(join(dir, "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await writeFile(join(dir, "song.mp3"), Buffer.alloc(32, 1));
    await writeFile(join(dir, "notes.txt"), "hello");
  });
  afterAll(async () => {
    await fake.stop();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await harness.setUp();
    fake.calls.length = 0;
    fake.puts.length = 0;
    fake.on("upload_media", (input) => {
      if (input.step === "begin") {
        const video = input.kind === "clip" || input.kind === "demo";
        return {
          changed: true,
          uploadId: `ticket-${String(input.kind)}`,
          upload: { method: "PUT", url: `${fake.url}/storage/upload/1?sig=abc`, headers: { "content-type": input.mimeType } },
          ...(video ? { poster: { method: "PUT", url: `${fake.url}/storage/poster/1`, headers: { "content-type": "image/jpeg" } } } : {}),
        };
      }
      return { changed: true, message: "Uploaded to the Library.", mediaId: "33333333-3333-4333-8333-333333333333" };
    });
  });
  afterEach(async () => {
    await harness.tearDown();
  });

  const env = () => ({ TOPPED_API_KEY: fake.apiKey });

  it("an image: begin, PUT with only the headers begin gave, finish; the new media id comes back", async () => {
    const result = await harness.run(["upload", "test/fixtures/tiny.png"], { env: env() });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json.mediaId).toBe("33333333-3333-4333-8333-333333333333");
    const [begin, finish] = fake.toolCalls("upload_media");
    expect(begin!.input).toEqual({ step: "begin", kind: "image", fileName: "tiny.png", mimeType: "image/png", sizeBytes: 70 });
    expect(finish!.input).toEqual({ step: "finish", uploadId: "ticket-image" });
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]!.headers["content-type"]).toBe("image/png");
    // The Topped credential never goes to the storage URL.
    expect(fake.puts[0]!.headers.authorization).toBeUndefined();
    expect(fake.puts[0]!.bytes.length).toBe(70);
  });

  it("a Demo: its length read from the MOV header, the poster sent, finish told both", async () => {
    const result = await harness.run(["upload", "demo.mov", "--demo", "--poster", "cover.jpg"], { env: env(), cwd: dir });
    expect(result.code, result.stdout).toBe(0);
    const [begin, finish] = fake.toolCalls("upload_media");
    expect(begin!.input).toMatchObject({ kind: "demo", mimeType: "video/quicktime" });
    expect(finish!.input).toEqual({ step: "finish", uploadId: "ticket-demo", durationSeconds: 20, posterUploaded: true });
    expect(fake.puts.map((put) => put.path)).toEqual(["/storage/upload/1", "/storage/poster/1"]);
    expect(fake.puts[1]!.headers["content-type"]).toBe("image/jpeg");
  });

  it("a clip whose header doesn't say its length needs --duration", async () => {
    const refused = await harness.run(["upload", "clip.mp4"], { env: env(), cwd: dir });
    expect(refused.code).toBe(2);
    expect(refused.json.fix).toContain("--duration");
    expect(fake.calls).toHaveLength(0);
    const result = await harness.run(["upload", "clip.mp4", "--duration", "8.5"], { env: env(), cwd: dir });
    expect(result.code).toBe(0);
    expect(fake.toolCalls("upload_media")[1]!.input).toEqual({ step: "finish", uploadId: "ticket-clip", durationSeconds: 8.5 });
  });

  it("a sound carries the founder's rights confirmation and its title", async () => {
    const result = await harness.run(["upload", "song.mp3", "--rights-confirmed", "--title", "Launch day"], { env: env(), cwd: dir });
    expect(result.code).toBe(0);
    expect(fake.toolCalls("upload_media")[0]!.input).toMatchObject({
      kind: "sound",
      mimeType: "audio/mpeg",
      rightsConfirmed: true,
      title: "Launch day",
    });
  });

  it("a sound without it: Topped's refusal passes through, nothing is PUT", async () => {
    fake.on("upload_media", () => ({
      status: 422,
      body: { error: "A sound needs the founder's confirmation first.", fix: "Once they agree, send rightsConfirmed: true." },
    }));
    const result = await harness.run(["upload", "song.mp3"], { env: env(), cwd: dir });
    expect(result.code).toBe(1);
    expect(fake.puts).toHaveLength(0);
  });

  it.each([
    [["upload", "notes.txt"], "extension"],
    [["upload", "missing.png"], "missing.png"],
    [["upload", "test/fixtures/tiny.png", "--demo"], "--demo"],
    [["upload", "song.mp3", "--poster", "cover.jpg"], "--poster"],
  ])("bad usage %j is exit 2 before anything is sent", async (argv, mention) => {
    const cwd = (argv as string[])[1]!.startsWith("test/") ? process.cwd() : dir;
    const result = await harness.run(argv as string[], { env: env(), cwd });
    expect(result.code).toBe(2);
    expect(result.json.fix).toContain(mention);
    expect(fake.calls).toHaveLength(0);
  });

  it("a lost answer to finish says to check the Library before uploading again, never to rerun", async () => {
    const answer = fake.handlers.get("upload_media")!;
    fake.on("upload_media", (input, call) => (input.step === "finish" ? { status: 502 } : answer(input, call)));
    const result = await harness.run(["upload", "test/fixtures/tiny.png"], { env: env() });
    expect(result.code).toBe(4);
    expect(result.json.fix).toContain("topped media");
    expect(result.json.fix).not.toContain("run the same command again");
    expect(fake.puts).toHaveLength(1);
  });

  it("a lost answer to begin can be run again as it was", async () => {
    fake.failures.push({ status: 502, raw: "<html>Bad gateway</html>" });
    const result = await harness.run(["upload", "test/fixtures/tiny.png"], { env: env() });
    expect(result.code).toBe(4);
    expect(result.json.fix).toContain("run the same command again");
    expect(fake.puts).toHaveLength(0);
  });

  it("a storage refusal says the file didn't arrive, and finish never runs", async () => {
    fake.on("upload_media", (input) => ({
      changed: true,
      uploadId: "t",
      upload: { method: "PUT", url: `${fake.url}/elsewhere/nope`, headers: {} },
      ...(input.step === "finish" ? { mediaId: "x" } : {}),
    }));
    const result = await harness.run(["upload", "test/fixtures/tiny.png"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.json.error).toBe("upload_failed");
    expect(fake.toolCalls("upload_media")).toHaveLength(1);
  });
});
