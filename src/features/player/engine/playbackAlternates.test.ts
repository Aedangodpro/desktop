import { describe, expect, it } from "vitest";
import {
  explainRecordingMatch,
  isSameRecordingUpload,
  type UploadCandidate,
} from "./playbackAlternates";
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
  extra: Partial<UploadCandidate> = {},
): UploadCandidate {
  return { title, artists, durationMs, ...extra };
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

  it("accepts another remaster of the same recording", () => {
    // the year and the word "remaster" are release noise, not the song
    const foreigner: PlayableTrack = {
      id: "J4A-_g_iSY0",
      title: "I Want to Know What Love Is (1999 Remaster)",
      artists: "Foreigner",
      durationMs: 301_000,
    };
    expect(
      isSameRecordingUpload(
        foreigner,
        upload("I Want to Know What Love Is (2008 Remaster)", ["Foreigner"], 301_000),
      ),
    ).toBe(true);
  });

  it("accepts an untagged upload of the same recording", () => {
    expect(
      isSameRecordingUpload(
        apollo,
        upload("Astronaut - Apollo", ["Astronaut"], 185_000),
      ),
    ).toBe(true);
  });

  it("accepts a re-upload that search results leave unmeasured", () => {
    expect(
      isSameRecordingUpload(
        apollo,
        upload("Astronaut - Apollo (Radio Edit)", ["Vylen"], 0),
      ),
    ).toBe(true);
  });

  it("rejects a re-performance the catalog credits to another artist", () => {
    // the real "Loser" upload is 4:28; the 3:46 one is an oud rendition, and
    // the catalog says so in its publisher tag
    const loser: PlayableTrack = {
      id: "loserVid",
      title: "Loser",
      artists: "Tame Impala",
      durationMs: 224_000,
    };
    expect(
      isSameRecordingUpload(
        loser,
        upload(
          "Loser - Tame Impala (The Arabic Version/Rendition)",
          ["YAD Oud"],
          226_000,
          { publisher: "YAD Oud", uploader: "YAD Oud" },
        ),
      ),
    ).toBe(false);
    expect(
      isSameRecordingUpload(
        loser,
        upload("Tame Impala - Loser (Live Ver.)", ["doyoon.wav"], 233_000),
      ),
    ).toBe(false);
  });

  it("rejects an arrangement that keeps the length", () => {
    const letItHappen: PlayableTrack = {
      id: "letItHappenVid",
      title: "Let It Happen",
      artists: "Tame Impala",
      durationMs: 467_000,
    };
    // a guitar arrangement in a dropped tuning: same words, same length, and a
    // qualifier the release does not have
    expect(
      isSameRecordingUpload(
        letItHappen,
        upload("Tame Impala - Let It Happen (Full Step Down)", ["Pearson Buck"], 474_000),
      ),
    ).toBe(false);
  });

  it("rejects a bare title uploaded by an account named after the artist", () => {
    const hello: PlayableTrack = {
      id: "helloVid",
      title: "Hello",
      artists: "Adele",
      durationMs: 296_000,
    };
    expect(
      isSameRecordingUpload(
        hello,
        upload("Hello", ["Hello Adele"], 291_000, {
          uploader: "Hello Adele",
          uploaderVerified: false,
        }),
      ),
    ).toBe(false);
  });

  it("rejects a tribute band's upload of the song", () => {
    const bohemian: PlayableTrack = {
      id: "bohemianVid",
      title: "Bohemian Rhapsody",
      artists: "Queen",
      durationMs: 355_000,
    };
    expect(
      isSameRecordingUpload(
        bohemian,
        upload("Bohemian Rhapsody", ["Killer Queen Band Page"], 351_000, {
          uploader: "Killer Queen Band Page",
        }),
      ),
    ).toBe(false);
  });

  it("rejects a verified cover artist's own upload", () => {
    const hello: PlayableTrack = {
      id: "helloVid",
      title: "Hello",
      artists: "Adele",
      durationMs: 296_000,
    };
    // the title quotes the original artist and the length lines up, but the
    // upload is Grace Davies' cover, published on her own verified page
    expect(
      isSameRecordingUpload(
        hello,
        upload("Hello - Adele", ["Grace Davies"], 301_000, {
          uploader: "Grace Davies",
          uploaderVerified: true,
        }),
      ),
    ).toBe(false);
  });

  it("accepts a fan re-upload whose title names the artist", () => {
    const bohemian: PlayableTrack = {
      id: "bohemianVid",
      title: "Bohemian Rhapsody",
      artists: "Queen",
      durationMs: 355_000,
    };
    expect(
      isSameRecordingUpload(
        bohemian,
        upload("Queen - Bohemian Rhapsody", ["rizky.rilos"], 353_000, {
          uploader: "rizky.rilos",
        }),
      ),
    ).toBe(true);
  });

  it("accepts an upload the label still credits to the artist", () => {
    const yellow: PlayableTrack = {
      id: "yellowVid",
      title: "Yellow",
      artists: "Coldplay",
      durationMs: 267_000,
    };
    expect(
      isSameRecordingUpload(
        yellow,
        upload("Coldplay - Yellow", ["Archelle"], 257_000, {
          publisher: "Coldplay",
          uploader: "Archelle",
        }),
      ),
    ).toBe(true);
  });

  it("accepts a correct upload from a channel named after an instrument", () => {
    // "Bass Nation" was read as an instrumental arrangement and threw away the
    // real upload
    expect(
      isSameRecordingUpload(
        apollo,
        upload("Astronaut - Apollo (Radio Edit)", ["Bass Nation"], 186_000, {
          uploader: "Bass Nation",
        }),
      ),
    ).toBe(true);
  });

  it("accepts a correct upload from a channel named after a concert promoter", () => {
    // "Live Nation" used to add a "live" version marker by itself
    expect(
      isSameRecordingUpload(
        apollo,
        upload("Astronaut - Apollo (Radio Edit)", ["Live Nation"], 186_000, {
          uploader: "Live Nation",
        }),
      ),
    ).toBe(true);
  });

  it("still rejects a channel that calls itself a tribute band", () => {
    expect(
      isSameRecordingUpload(
        apollo,
        upload("Astronaut - Apollo (Radio Edit)", ["Absolute Astronaut Tribute"], 186_000, {
          uploader: "Absolute Astronaut Tribute",
        }),
      ),
    ).toBe(false);
  });

  it("rejects an unmeasured video that only shares the song name", () => {
    expect(
      isSameRecordingUpload(
        apollo,
        upload("THE ASTRONAUT (APOLLO 13)", ["GTL Music Promotions"], 0),
      ),
    ).toBe(false);
  });
});

describe("explainRecordingMatch", () => {
  it("names the rule that rejected a candidate", () => {
    const loser: PlayableTrack = {
      id: "loserVid",
      title: "Loser",
      artists: "Tame Impala",
      durationMs: 224_000,
    };
    expect(
      explainRecordingMatch(
        loser,
        upload(
          "Loser - Tame Impala (The Arabic Version/Rendition)",
          ["YAD Oud"],
          226_000,
          { publisher: "YAD Oud", uploader: "YAD Oud" },
        ),
      ),
    ).toMatchObject({
      match: null,
      reason: "publisher",
      detail: "published as YAD Oud",
    });

    const letItHappen: PlayableTrack = {
      id: "letItHappenVid",
      title: "Let It Happen",
      artists: "Tame Impala",
      durationMs: 467_000,
    };
    expect(
      explainRecordingMatch(
        letItHappen,
        upload("Tame Impala - Let It Happen (Full Step Down)", ["Pearson Buck"], 474_000),
      ),
    ).toMatchObject({
      match: null,
      reason: "version",
      detail: "(full step down)",
    });

    expect(
      explainRecordingMatch(
        apollo,
        upload("Astronaut - Apollo", ["Astronaut"], 263_000),
      ),
    ).toMatchObject({ match: null, reason: "duration", detail: "77s off" });
  });
});
