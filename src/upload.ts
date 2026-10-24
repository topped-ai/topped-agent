/**
 * `topped upload <file>`: `upload_media` begin, then the bytes PUT to the
 * signed URL with exactly the headers begin returned (never the Topped
 * credential), then finish. A clip's length goes with begin, which refuses
 * one over 30 seconds before any byte moves: it is read from its MP4 or MOV
 * header, or given with `--duration`. `--poster` sends a clip's JPEG cover,
 * or an image's JPEG thumbnail.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { ToppedApi } from "./api.js";
import { exchange, isRecord, isSafeUrl, NotReached, type Session } from "./http.js";
import { mimeTypeFor, KNOWN_EXTENSIONS } from "./mime.js";
import { mp4DurationSeconds } from "./mp4.js";
import { CliError, EXIT, usageError } from "./output.js";

/** Well above the 100 MB a clip may be, at a slow connection. */
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

export interface UploadOptions {
  file: string;
  demo: boolean;
  duration?: number;
  poster?: string;
  title?: string;
  rightsConfirmed: boolean;
}

type Kind = "image" | "clip" | "demo" | "sound";

async function readLocal(cwd: string, path: string, what: string): Promise<Uint8Array> {
  const full = resolve(cwd, path);
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error("not a file");
    return await readFile(full);
  } catch {
    throw usageError(`Could not read ${what} ${path}. Give the path to a file.`, "file_not_found");
  }
}

interface SignedPut {
  url: string;
  headers: Record<string, string>;
}

function signedPut(value: unknown): SignedPut | null {
  if (!isRecord(value) || typeof value.url !== "string" || !isSafeUrl(value.url)) return null;
  const headers: Record<string, string> = {};
  if (isRecord(value.headers)) {
    for (const [name, header] of Object.entries(value.headers)) {
      if (typeof header === "string") headers[name] = header;
    }
  }
  return { url: value.url, headers };
}

async function put(session: Session, target: SignedPut, bytes: Uint8Array, what: string): Promise<void> {
  const answer = await exchange(
    session,
    { method: "PUT", url: target.url, headers: target.headers, body: bytes, timeoutMs: UPLOAD_TIMEOUT_MS },
    "safe",
  );
  if (answer.status < 200 || answer.status >= 300) {
    throw new CliError(
      EXIT.refused,
      "upload_failed",
      `${what} did not reach Topped's storage (it answered ${answer.status}). Run the same topped upload again.`,
    );
  }
}

export async function runUpload(session: Session, api: ToppedApi, options: UploadOptions): Promise<unknown> {
  const fileName = basename(options.file);
  const mimeType = mimeTypeFor(fileName);
  if (mimeType === null) {
    throw usageError(`topped upload reads the type from the file's extension, one of: ${KNOWN_EXTENSIONS.join(", ")}.`);
  }
  const kind: Kind = mimeType.startsWith("image/")
    ? "image"
    : mimeType.startsWith("audio/")
      ? "sound"
      : options.demo
        ? "demo"
        : "clip";
  if (options.demo && kind !== "demo") throw usageError("--demo is for a video clip: a screen recording of the Product.");
  const video = kind === "clip" || kind === "demo";
  if (!video && options.duration !== undefined) throw usageError("--duration is for a video clip.");
  if (kind === "sound" && options.poster !== undefined) throw usageError("--poster is for a video clip or an image.");
  if (kind !== "sound" && (options.title !== undefined || options.rightsConfirmed)) {
    throw usageError("--title and --rights-confirmed are for a sound.");
  }

  const bytes = await readLocal(session.deps.cwd, options.file, "the file");
  if (bytes.byteLength === 0) throw usageError(`${options.file} is empty.`);
  let durationSeconds: number | undefined;
  if (video) {
    durationSeconds = options.duration ?? mp4DurationSeconds(bytes) ?? undefined;
    if (durationSeconds === undefined || !(durationSeconds > 0)) {
      throw usageError("Could not read the clip's length from its header. Add --duration <seconds>.", "duration_unknown");
    }
  }
  const poster = options.poster === undefined ? null : await readLocal(session.deps.cwd, options.poster, "the poster");

  const begun = await api.callTool(
    "upload_media",
    {
      step: "begin",
      kind,
      fileName,
      mimeType,
      sizeBytes: bytes.byteLength,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.rightsConfirmed ? { rightsConfirmed: true } : {}),
    },
    "once",
  );
  const uploadId = isRecord(begun) ? begun.uploadId : undefined;
  const upload = isRecord(begun) ? signedPut(begun.upload) : null;
  if (typeof uploadId !== "string" || upload === null) {
    throw new CliError(
      EXIT.unreachable,
      "unexpected_response",
      "Topped's answer to starting the upload had no upload address. Run the same topped upload again.",
    );
  }

  await put(session, upload, bytes, "The file");
  let posterUploaded = false;
  if (poster !== null) {
    const posterTarget = isRecord(begun) ? signedPut(begun.poster) : null;
    if (posterTarget !== null) {
      await put(session, posterTarget, poster, "The poster");
      posterUploaded = true;
    } else {
      session.hint("Topped did not ask for a poster for this file; it was not sent.");
    }
  }

  try {
    return await api.callTool(
      "upload_media",
      {
        step: "finish",
        uploadId,
        ...(posterUploaded ? { posterUploaded: true } : {}),
      },
      "once",
    );
  } catch (error) {
    // Begin and the PUT are safe to repeat; a finish whose answer was lost may
    // already have put the file in the Library, and a rerun would add it twice.
    if (error instanceof NotReached) {
      error.thenDo("check topped media before uploading it again, since it may have reached Topped");
    }
    throw error;
  }
}
