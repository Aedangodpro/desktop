import { describe, expect, it } from "vitest";
import { isSameRecordingUpload, type UploadCandidate } from "./playbackAlternates";
import type { PlayableTrack } from "./playbackStream";

const apollo: PlayableTrack = {
  id: "BKVyNI7f9zc",
  title: "Apollo (Radio Edit)",
  artists: "Astronaut",
  durationMs: 186_000,
};

function upload(
  title: string,
  artists: string[],
  durationMs: number,
): UploadCandidate {
  return { title, artists, durationMs };
}

describe("isSameRecordingUpload", () => {
  it("accepts a re-upload with uploader noise in the title", () => {
    expect(
      isSameRecordingUpload(
        apollo,
        upload("Astronaut - Apollo (Radio Edit) | Vylen", ["Vylen"], 186_000),
      ),
    ).toBe(true);
  });

  it("rejects another mix of the same song", () => {
    for (const title of [
      "Astronaut - Apollo (Barely Alive Remix)",
      "Astronaut - Apollo (Radio Edit) | Instrumental | Lyricful",
      "Astronaut - Apollo VIP",
      "Astronaut - Apollo (Radio Edit) live at Tomorrowland",
    ]) {
      expect(isSameRecordingUpload(apollo, upload(title, ["Astronaut"], 186_000))).toBe(false);
    }
  });

  it("rejects an upload of a different length", () => {
    expect(
      isSameRecordingUpload(
        apollo,
        upload("Astronaut - Apollo", ["Astronaut"], 263_000),
      ),
    ).toBe(false);
  });

  it("rejects a same-named song from another artist", () => {
    expect(
      isSameRecordingUpload(
        apollo,
        upload("Apollo (Radio Edit)", ["Someone Else"], 186_000),
      ),
    ).toBe(false);
  });

  it("accepts an untagged upload of the same recording", () => {
    expect(
      isSameRecordingUpload(
        apollo,
        upload("Astronaut - Apollo", ["Astronaut"], 185_000),
      ),
    ).toBe(true);
  });
});
