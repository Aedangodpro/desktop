// YouTube titles carry release noise that lyrics databases do not index
const NOISE =
  /\b(official|video|audio|lyric|lyrics|visuali[sz]er|remaster|remastered|hd|hq|4k|mv|m\/v|explicit)\b/i;

export function cleanLyricsTitle(title: string): string {
  const stripped = title.replace(/\s*[[(][^\])]*[\])]/g, (segment) =>
    NOISE.test(segment) ? "" : segment,
  );
  const withoutSuffix = stripped.replace(
    /\s*[-–]\s*(official|video|audio|lyrics?|visuali[sz]er).*$/i,
    "",
  );
  return withoutSuffix.trim() || title.trim();
}
