/**
 * Words that mark an upload as another performance of a song rather than the
 * record itself: a cover, an instrumental, a guitar arrangement, a tutorial.
 *
 * Detection only, and deliberately kept out of `VERSION_PATTERNS`: those are
 * stripped from titles by `cleanBaseTitle`, and plenty of real songs are named
 * after the words below ("While My Guitar Gently Weeps", "Live and Let Die").
 */
const PERFORMANCE_PATTERNS: Array<{ tag: string; regex: RegExp }> = [
  // somebody else performing the song
  { tag: "cover", regex: /\b(covers?|covered|кавер)\b/i },
  { tag: "tribute", regex: /\b(tribute|трибьют)\b/i },
  {
    tag: "ensemble",
    regex: /\b(tribute band|cover band|live band|band page|session band)\b/i,
  },
  { tag: "karaoke", regex: /\b(karaoke|караоке)\b/i },
  {
    tag: "rendition",
    regex:
      /\b(renditions?|re-?works?|re-?makes?|re-?imagined|arrangements?|reprise|demo)\b/i,
  },
  {
    tag: "in_style_of",
    regex:
      /\b(in the style of|made famous by|originally performed by|as performed by|type beat)\b/i,
  },
  // an instrument standing in for the record
  {
    tag: "instrument",
    regex:
      /\b(guitars?|pianos?|keyboards?|bass|drums?|violins?|cello|viola|sax|saxophone|flute|harp|ukulele|banjo|mandolin|orchestra|orchestral|strings?|quartet|choir|organ|synths?)\b/i,
  },
  {
    tag: "instruction",
    regex:
      /\b(fingerstyle|finger style|playthrough|guitar tab|bass tab|tabs?|lesson|tutorial|how to play|synthesia|midi)\b/i,
  },
  { tag: "instrumental", regex: /\b(instrumental|backing track|minus one)\b/i },
  { tag: "acoustic", regex: /\b(acoustic|unplugged)\b/i },
  { tag: "live", regex: /\b(live|in concert|concert)\b/i },
  // novelty renderings that keep the length
  {
    tag: "novelty",
    regex: /\b(8d|8-d|daycore|chipmunk|earrape|lullaby|music box|8-?bit|chiptune)\b/i,
  },
];

export function getPerformanceTags(value: string): Set<string> {
  const tags = new Set<string>();
  for (const { tag, regex } of PERFORMANCE_PATTERNS) {
    if (regex.test(value)) tags.add(tag);
  }
  return tags;
}

/**
 * The markers a channel or account name can establish. The rest of the list is
 * title evidence only: "Bass Nation" and "Live Nation" are ordinary account
 * names, so reading "bass" or "live" off them disqualified correct uploads of
 * the song. What an account calls itself ("covers", "tribute band", "karaoke")
 * still counts.
 */
const CHANNEL_TAGS = new Set([
  "cover",
  "tribute",
  "ensemble",
  "karaoke",
  "rendition",
  "in_style_of",
  "instruction",
  "instrumental",
  "novelty",
]);

export function getChannelPerformanceTags(value: string): Set<string> {
  const tags = new Set<string>();
  for (const { tag, regex } of PERFORMANCE_PATTERNS) {
    if (CHANNEL_TAGS.has(tag) && regex.test(value)) tags.add(tag);
  }
  return tags;
}
