import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PcmTrack, removeRecordingDirectory } from "../src/audio.js";

test("a silent track is padded to the requested recording duration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zuikaku-recorder-"));
  try {
    const path = join(directory, "speaker.pcm");
    const track = new PcmTrack("speaker", path, Date.now());
    await track.close(10);
    assert.equal((await stat(path)).size, 1_920);
  } finally {
    await removeRecordingDirectory(directory);
  }
});
