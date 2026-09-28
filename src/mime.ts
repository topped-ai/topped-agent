/**
 * A file's type from its extension: exactly the types Topped's Library
 * stores. An M4V is an MP4 container, so it goes as video/mp4.
 */

const TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

export function mimeTypeFor(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return null;
  return TYPES[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

export const KNOWN_EXTENSIONS = Object.keys(TYPES);
