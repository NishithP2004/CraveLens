const DEFAULT_WINDOW_SECONDS = 24;
const DEFAULT_MAX_CHARACTERS = 1_600;

export async function getTranscriptContext({
  videoId,
  timestamp,
  captionTracks,
  documentRef = document,
  fetchImpl = fetch,
  preferredLanguage = navigator.language,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  maxCharacters = DEFAULT_MAX_CHARACTERS,
} = {}) {
  if (!videoId || !Number.isFinite(Number(timestamp))) return undefined;
  let tracks = Array.isArray(captionTracks) ? captionTracks : [];
  if (!tracks.length) {
    const playerResponse = await findPlayerResponse(videoId, documentRef, fetchImpl);
    tracks = captionTracksFromResponse(playerResponse);
  }
  if (!tracks.length) throw new Error("YouTube did not expose a caption track for the current video");
  const track = selectCaptionTrack(tracks, preferredLanguage);
  if (!track?.baseUrl) return undefined;
  const transcriptUrl = new URL(track.baseUrl);
  transcriptUrl.searchParams.set("fmt", "json3");
  const response = await fetchImpl(transcriptUrl.href, { credentials: "include" });
  if (!response.ok) throw new Error(`YouTube captions request failed (${response.status})`);
  const cues = normalizeCaptionEvents(await response.json());
  return buildTranscriptContext(cues, Number(timestamp), { windowSeconds, maxCharacters });
}

export function selectCaptionTrack(tracks, preferredLanguage = "") {
  const preferred = String(preferredLanguage).toLowerCase();
  const baseLanguage = preferred.split("-")[0];
  return tracks.find((track) => String(track.languageCode || "").toLowerCase() === preferred)
    || tracks.find((track) => String(track.languageCode || "").toLowerCase().split("-")[0] === baseLanguage)
    || tracks.find((track) => track.kind !== "asr")
    || tracks[0];
}

export function normalizeCaptionEvents(payload) {
  return (Array.isArray(payload?.events) ? payload.events : [])
    .map((event) => {
      const text = (Array.isArray(event.segs) ? event.segs : [])
        .map((segment) => String(segment?.utf8 || ""))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      const start = Number(event.tStartMs) / 1_000;
      const duration = Math.max(0, Number(event.dDurationMs) / 1_000 || 0);
      return { start, end: start + duration, text };
    })
    .filter((cue) => cue.text && Number.isFinite(cue.start));
}

export function buildTranscriptContext(cues, timestamp, {
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  maxCharacters = DEFAULT_MAX_CHARACTERS,
} = {}) {
  const start = Math.max(0, timestamp - windowSeconds);
  const end = timestamp + windowSeconds;
  const sections = { before: [], at: [], after: [] };
  for (const cue of cues) {
    if (cue.end < start || cue.start > end) continue;
    const entry = { start: roundTime(cue.start), end: roundTime(cue.end), text: cue.text };
    if (cue.end < timestamp) sections.before.push(entry);
    else if (cue.start > timestamp) sections.after.push(entry);
    else sections.at.push(entry);
  }
  sections.before = sections.before.slice(-6);
  sections.at = sections.at.slice(0, 4);
  sections.after = sections.after.slice(0, 6);
  trimContext(sections, maxCharacters);
  if (!sections.before.length && !sections.at.length && !sections.after.length) return undefined;
  return { timestamp: roundTime(timestamp), windowSeconds, ...sections };
}

export function formatTranscriptContext(context) {
  if (!context) return "No transcript context was available.";
  const render = (label, cues) => `${label}: ${cues.length
    ? cues.map((cue) => `[${formatTime(cue.start)}] ${cue.text}`).join(" ")
    : "(none)"}`;
  return [
    `Target timestamp: ${formatTime(context.timestamp)}`,
    render("Before", context.before || []),
    render("At", context.at || []),
    render("After", context.after || []),
  ].join("\n");
}

async function findPlayerResponse(videoId, documentRef, fetchImpl) {
  const direct = documentRef?.querySelector?.("script#ytInitialPlayerResponse")?.textContent;
  if (direct) {
    try {
      const parsed = JSON.parse(direct);
      if (captionTracksFromResponse(parsed).length) return parsed;
    } catch {}
  }
  for (const script of documentRef?.querySelectorAll?.("script") || []) {
    const parsed = extractAssignedJson(script.textContent, "ytInitialPlayerResponse");
    if (captionTracksFromResponse(parsed).length) return parsed;
  }
  const response = await fetchImpl(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include" });
  if (!response.ok) throw new Error(`YouTube page request failed (${response.status})`);
  const parsed = extractAssignedJson(await response.text(), "ytInitialPlayerResponse");
  if (!captionTracksFromResponse(parsed).length) {
    throw new Error("Fresh YouTube player metadata contained no caption tracks");
  }
  return parsed;
}

function captionTracksFromResponse(response) {
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? tracks : [];
}

export function extractAssignedJson(source, variableName) {
  const marker = new RegExp(`(?:var\\s+)?${variableName}\\s*=\\s*`, "g");
  const match = marker.exec(String(source || ""));
  if (!match) return undefined;
  const start = source.indexOf("{", match.index + match[0].length);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

function trimContext(sections, maxCharacters) {
  const length = () => Object.values(sections).flat().reduce((sum, cue) => sum + cue.text.length, 0);
  while (length() > maxCharacters) {
    if (sections.before.length > sections.after.length && sections.before.length) sections.before.shift();
    else if (sections.after.length) sections.after.pop();
    else if (sections.before.length) sections.before.shift();
    else if (sections.at.length > 1) sections.at.pop();
    else break;
  }
}

function roundTime(value) { return Math.round(Number(value) * 10) / 10; }
function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
