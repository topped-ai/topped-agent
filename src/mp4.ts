/**
 * A clip's length from its MP4 or MOV header - the movie header box
 * (`moov` > `mvhd`), read without ffmpeg. `null` when the file has no usable
 * one (a fragmented or unfinished recording), and `--duration` says it instead.
 */

interface Box {
  /** Where the box's content starts. */
  start: number;
  end: number;
}

function findBox(view: DataView, from: number, to: number, type: string): Box | null {
  let offset = from;
  while (offset + 8 <= to) {
    let size = view.getUint32(offset);
    const name = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) return null;
      const large = view.getBigUint64(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) return null;
    if (name === type) return { start: offset + header, end: offset + size };
    offset += size;
  }
  return null;
}

export function mp4DurationSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = findBox(view, 0, bytes.byteLength, "moov");
  if (moov === null) return null;
  const mvhd = findBox(view, moov.start, moov.end, "mvhd");
  if (mvhd === null) return null;
  const version = view.getUint8(mvhd.start);
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (mvhd.start + 32 > mvhd.end) return null;
    timescale = view.getUint32(mvhd.start + 20);
    const long = view.getBigUint64(mvhd.start + 24);
    if (long === 0xffffffffffffffffn || long > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    duration = Number(long);
  } else if (version === 0) {
    if (mvhd.start + 20 > mvhd.end) return null;
    timescale = view.getUint32(mvhd.start + 12);
    duration = view.getUint32(mvhd.start + 16);
    if (duration === 0xffffffff) return null;
  } else {
    return null;
  }
  if (timescale === 0 || duration === 0) return null;
  return Math.round((duration / timescale) * 1000) / 1000;
}
