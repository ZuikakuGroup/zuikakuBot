import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";

const RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_MS = (RATE * CHANNELS * 2) / 1_000;
const SILENCE = Buffer.alloc(64 * 1024);

export class PcmTrack {
  private readonly output;
  private bytesWritten = 0;
  private closed = false;
  constructor(readonly userId: string, readonly path: string, private readonly startedAt: number) { this.output = createWriteStream(path); }
  write(chunk: Buffer): void {
    if (this.closed) return;
    this.pad(Math.max(0, Math.floor((Date.now() - this.startedAt) * BYTES_PER_MS) - this.bytesWritten));
    this.output.write(chunk); this.bytesWritten += chunk.length;
  }
  async close(durationMs: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pad(Math.max(0, Math.ceil(durationMs * BYTES_PER_MS) - this.bytesWritten));
    this.output.end(); await finished(this.output);
  }
  private pad(bytes: number): void {
    for (let remaining = bytes; remaining > 0;) {
      const size = Math.min(remaining, SILENCE.length);
      this.output.write(size === SILENCE.length ? SILENCE : SILENCE.subarray(0, size));
      this.bytesWritten += size; remaining -= size;
    }
  }
}

export async function createRecordingDirectory(id: string): Promise<string> {
  const directory = join(process.cwd(), "recordings", id); await mkdir(directory, { recursive: true }); return directory;
}
export async function removeRecordingDirectory(directory: string): Promise<void> { await rm(directory, { recursive: true, force: true }); }
export const trackPath = (directory: string, userId: string): string => join(directory, `${basename(userId)}.pcm`);
export const outputPath = (directory: string): string => join(directory, "recording.mp3");

export async function mixTracks(ffmpegPath: string, tracks: readonly PcmTrack[], durationMs: number, destination: string): Promise<void> {
  const seconds = Math.max(1, durationMs / 1_000).toFixed(3);
  const args = ["-y"];
  if (tracks.length === 0) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", seconds);
  else {
    for (const track of tracks) args.push("-f", "s16le", "-ar", String(RATE), "-ac", String(CHANNELS), "-i", track.path);
    args.push("-filter_complex", `amix=inputs=${tracks.length}:duration=longest:normalize=0`, "-t", seconds);
  }
  args.push("-c:a", "libmp3lame", "-b:a", "128k", destination);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] }); let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-1500)}`)));
  });
}
