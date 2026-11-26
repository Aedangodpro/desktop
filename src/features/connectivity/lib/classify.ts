export type ConnectionVerdict =
  "online" | "offline" | "server_error" | "server_unreachable";

export type YoutubeReach = "ok" | "blocked" | "unreachable" | "unknown";

export type ConnectionIssue =
  | "youtube_blocked"
  | "youtube_unreachable"
  | "youtube_refused"
  | "server"
  | "offline";

export type IssueGroup = "youtube" | "server" | "offline";

export interface ConnectionProbe {
  deviceOnline: boolean;
  api: { ok: boolean; status?: number };
  internet: boolean | null;
  youtube: boolean | null;
  youtubeFailure?: "timeout" | "blocked" | null;
  country: string | null;
}

export function classifyConnection(probe: ConnectionProbe): ConnectionVerdict {
  if (probe.api.ok) return "online";
  if (!probe.deviceOnline) return "offline";
  if (probe.api.status !== undefined && probe.api.status >= 500)
    return "server_error";
  // Any HTTP answer, even a refusal, proves a network path to the API exists.
  // Calling a 4xx "offline" hides the real server-side failure behind an
  // offline library message.
  if (probe.api.status !== undefined) return "server_unreachable";
  if (probe.internet === true) return "server_unreachable";
  return "offline";
}

export function youtubeReach(probe: ConnectionProbe): YoutubeReach {
  if (probe.youtube === true) return "ok";
  if (probe.youtube === false && probe.internet === true)
    return probe.youtubeFailure === "timeout" ? "unreachable" : "blocked";
  return "unknown";
}

export function connectionIssue(
  verdict: ConnectionVerdict,
  youtube: YoutubeReach,
): Exclude<ConnectionIssue, "youtube_refused"> | null {
  if (verdict === "offline") return "offline";
  if (verdict !== "online") return "server";
  if (youtube === "blocked") return "youtube_blocked";
  if (youtube === "unreachable") return "youtube_unreachable";
  return null;
}

export function issueGroup(issue: ConnectionIssue): IssueGroup {
  if (issue === "server" || issue === "offline") return issue;
  return "youtube";
}

export function issueResolved(
  group: IssueGroup,
  verdict: ConnectionVerdict,
  youtube: YoutubeReach,
): boolean {
  if (verdict !== "online") return false;
  return group !== "youtube" || youtube === "ok";
}
