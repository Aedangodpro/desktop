import { describe, expect, it } from "vitest";
import {
  IOS_PROFILE,
  PLAYBACK_PROFILES,
  WEB_PLAYBACK_PROFILES,
} from "./playbackProfiles";

describe("web playback profiles", () => {
  it("offers only clients that work without a PO token or player script", () => {
    for (const profile of WEB_PLAYBACK_PROFILES) {
      expect(profile.requiresJsPlayer ?? false).toBe(false);
    }
  });

  it("tries the clients the relay can fetch bytes for first", () => {
    expect(WEB_PLAYBACK_PROFILES.map((profile) => profile.clientName)).toEqual([
      "VISIONOS",
      "IOS",
      "ANDROID_VR",
    ]);
    expect(WEB_PLAYBACK_PROFILES[1]).toBe(IOS_PROFILE);
    expect(IOS_PROFILE.userAgent).toContain("com.google.ios.youtube");
  });

  it("keeps the desktop chain unchanged", () => {
    expect(PLAYBACK_PROFILES.map((profile) => profile.clientName)).toEqual([
      "TVHTML5",
      "VISIONOS",
      "ANDROID_VR",
    ]);
  });
});
