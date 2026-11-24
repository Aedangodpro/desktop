/**
 * Word/syllable timing helpers.
 *
 * RichSync sources disagree about what a timed segment is: Musixmatch and Atlas
 * may emit syllables ("morn" + "ing "), LRCMUX emits words. Anything that needs
 * word-shaped units (the touch bar overlay, word-by-word trackers) runs them
 * through `mergeSyllablesIntoWords`, which uses the line text to tell a
 * syllable continuation from a new word without guessing from whitespace in the
 * payload alone.
 */

export interface TimedWord {
  timeMs: number;
  endMs: number;
  text: string;
}

export function mergeSyllablesIntoWords(
  syllables: TimedWord[],
  lineText: string,
): TimedWord[] {
  const words: TimedWord[] = [];
  if (!syllables || syllables.length === 0) return words;

  let charCursor = 0;

  for (const syllable of syllables) {
    if (!syllable || !syllable.text) continue;

    if (syllable.text.trim().length === 0) {
      if (words.length > 0) {
        words[words.length - 1].text += syllable.text;
      }
      continue;
    }

    const cleanText = syllable.text.trim();
    const foundIdx = lineText ? lineText.indexOf(cleanText, charCursor) : -1;

    let isContinuation = false;
    if (words.length > 0) {
      const prev = words[words.length - 1];
      const prevEndsSpace = /\s$/.test(prev.text);
      const currStartsSpace = /^\s/.test(syllable.text);

      if (foundIdx >= 0) {
        const between = lineText.slice(charCursor, foundIdx);
        if (!/\s/.test(between) && !prevEndsSpace && !currStartsSpace) {
          isContinuation = true;
        }
      } else if (!prevEndsSpace && !currStartsSpace) {
        isContinuation = true;
      }
    }

    if (foundIdx >= 0) {
      charCursor = foundIdx + cleanText.length;
    }

    if (isContinuation) {
      const prev = words[words.length - 1];
      prev.text += syllable.text;
      prev.endMs = Math.max(prev.endMs, syllable.endMs);
    } else {
      words.push({
        text: syllable.text,
        timeMs: syllable.timeMs,
        endMs: syllable.endMs,
      });
    }
  }

  return words;
}

/** Index of the word being sung at `positionMs`, or -1 before the first one. */
export function findActiveWordIndex(
  words: TimedWord[],
  positionMs: number,
): number {
  let lo = 0;
  let hi = words.length - 1;
  let active = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (positionMs >= words[mid].timeMs) {
      active = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return active;
}
