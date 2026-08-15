const DEFAULT_WINDOW_SECONDS = 24;
const DEFAULT_MAX_CHARACTERS = 1_600;
const TRANSCRIPT_CACHE_PREFIX = "cravelens:transcript:";
const DEFAULT_TRANSCRIPT_TTL_MS = 30 * 60 * 1_000;
const TIMEDTEXT_PATH = "/api/timedtext";

export async function getTranscriptContext({
  videoId,
  timestamp,
  captionTracks,
  documentRef = globalThis.document,
  fetchImpl = globalThis.fetch,
  performanceRef = globalThis.performance,
  storageRef = safeSessionStorage(),
  preferredLanguage = globalThis.navigator?.language || "en",
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  maxCharacters = DEFAULT_MAX_CHARACTERS,
  ttlMs = DEFAULT_TRANSCRIPT_TTL_MS,
} = {}) {
  if (!videoId || !Number.isFinite(Number(timestamp))) return undefined;
  const cached = readCachedTranscript(videoId, { storageRef, ttlMs });
  if (cached?.length) {
    return buildTranscriptContext(cached, Number(timestamp), { windowSeconds, maxCharacters });
  }
  let tracks = Array.isArray(captionTracks) ? captionTracks : [];
  let cues = [];
  if (tracks.length) {
    cues = await fetchCaptionTrackCues(tracks, { fetchImpl, preferredLanguage });
    if (!cues.length) return undefined;
    writeCachedTranscript(videoId, cues, { storageRef, ttlMs });
    return buildTranscriptContext(cues, Number(timestamp), { windowSeconds, maxCharacters });
  }
  if (!cues.length) {
    try {
      const playerResponse = await findPlayerResponse(videoId, documentRef, fetchImpl);
      tracks = captionTracksFromResponse(playerResponse);
      cues = await fetchCaptionTrackCues(tracks, { fetchImpl, preferredLanguage });
    } catch {
      cues = await captureTimedTextTranscript({ documentRef, fetchImpl, performanceRef });
    }
  }
  if (!cues.length) throw new Error("YouTube did not expose a transcript for the current video");
  writeCachedTranscript(videoId, cues, { storageRef, ttlMs });
  return buildTranscriptContext(cues, Number(timestamp), { windowSeconds, maxCharacters });
}

export async function preloadTranscript({
  videoId,
  captionTracks,
  documentRef = globalThis.document,
  fetchImpl = globalThis.fetch,
  performanceRef = globalThis.performance,
  storageRef = safeSessionStorage(),
  preferredLanguage = globalThis.navigator?.language || "en",
  ttlMs = DEFAULT_TRANSCRIPT_TTL_MS,
} = {}) {
  if (!videoId) return { ok: false, cached: false, reason: "missing-video-id" };
  const cached = readCachedTranscript(videoId, { storageRef, ttlMs });
  if (cached?.length) return { ok: true, cached: true, cues: cached.length };
  let cues = [];
  const tracks = Array.isArray(captionTracks) ? captionTracks : [];
  if (tracks.length) {
    cues = await fetchCaptionTrackCues(tracks, { fetchImpl, preferredLanguage });
    if (!cues.length) return { ok: false, cached: false, reason: "empty-transcript" };
    writeCachedTranscript(videoId, cues, { storageRef, ttlMs });
    return { ok: true, cached: false, cues: cues.length };
  }
  if (!cues.length) {
    try {
      const playerResponse = await findPlayerResponse(videoId, documentRef, fetchImpl);
      cues = await fetchCaptionTrackCues(captionTracksFromResponse(playerResponse), { fetchImpl, preferredLanguage });
    } catch {
      cues = await captureTimedTextTranscript({ documentRef, fetchImpl, performanceRef });
    }
  }
  if (!cues.length) return { ok: false, cached: false, reason: "empty-transcript" };
  writeCachedTranscript(videoId, cues, { storageRef, ttlMs });
  return { ok: true, cached: false, cues: cues.length };
}

async function fetchCaptionTrackCues(tracks, { fetchImpl, preferredLanguage } = {}) {
  if (!tracks.length) return [];
  const track = selectCaptionTrack(tracks, preferredLanguage);
  if (!track?.baseUrl) return [];
  const transcriptUrl = transcriptJsonUrl(track.baseUrl);
  const response = await fetchImpl(transcriptUrl.href, { credentials: "include" });
  if (!response.ok) throw new Error(`YouTube captions request failed (${response.status})`);
  const responseText = await response.text();
  if (!responseText.trim()) return [];
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("YouTube returned an invalid captions payload");
  }
  return normalizeCaptionEvents(payload);
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

export async function captureTimedTextTranscript({
  documentRef = globalThis.document,
  fetchImpl = globalThis.fetch,
  performanceRef = globalThis.performance,
  pollAttempts = 40,
  pollIntervalMs = 250,
} = {}) {
  const ccButton = await waitForCaptionButton(documentRef);
  if (!ccButton) throw new Error("Could not find YouTube captions button");
  const wasEnabled = captionsEnabled(ccButton);
  const before = new Set(getTimedTextRequests(performanceRef));
  try {
    if (!wasEnabled) {
      ccButton.click();
      await sleep(500);
    }
    const timedTextUrl = await waitForNewTimedTextUrl(before, { performanceRef, pollAttempts, pollIntervalMs })
      || getTimedTextRequests(performanceRef).at(-1);
    if (!timedTextUrl) throw new Error("No YouTube timedtext request found");
    const response = await fetchImpl(transcriptJsonUrl(timedTextUrl).href, { credentials: "include" });
    if (!response.ok) throw new Error(`YouTube timedtext request failed (${response.status})`);
    const raw = await response.text();
    if (!raw.trim()) throw new Error("YouTube returned an empty timedtext response");
    let payload;
    try { payload = JSON.parse(raw); }
    catch { throw new Error("YouTube transcript was not returned as JSON3"); }
    const cues = normalizeCaptionEvents(payload);
    if (!cues.length) throw new Error("YouTube transcript was empty");
    return cues;
  } finally {
    await sleep(300);
    if (captionsEnabled(ccButton) !== wasEnabled) {
      ccButton.click();
      await sleep(300);
    }
  }
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
      if (playerResponseMatchesVideo(parsed, videoId) && captionTracksFromResponse(parsed).length) return parsed;
    } catch {}
  }
  for (const script of documentRef?.querySelectorAll?.("script") || []) {
    const parsed = extractAssignedJson(script.textContent, "ytInitialPlayerResponse");
    if (playerResponseMatchesVideo(parsed, videoId) && captionTracksFromResponse(parsed).length) return parsed;
  }
  const response = await fetchImpl(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include" });
  if (!response.ok) throw new Error(`YouTube page request failed (${response.status})`);
  const parsed = extractAssignedJson(await response.text(), "ytInitialPlayerResponse");
  if (!captionTracksFromResponse(parsed).length) {
    throw new Error("Fresh YouTube player metadata contained no caption tracks");
  }
  return parsed;
}

function playerResponseMatchesVideo(response, videoId) {
  const responseVideoId = response?.videoDetails?.videoId;
  return !responseVideoId || !videoId || String(responseVideoId) === String(videoId);
}

function readCachedTranscript(videoId, { storageRef = safeSessionStorage(), ttlMs = DEFAULT_TRANSCRIPT_TTL_MS } = {}) {
  try {
    const payload = JSON.parse(storageRef?.getItem?.(transcriptCacheKey(videoId)) || "null");
    if (!payload || payload.videoId !== videoId || !Array.isArray(payload.cues)) return undefined;
    if (Date.now() - Number(payload.cachedAt || 0) > ttlMs) {
      storageRef?.removeItem?.(transcriptCacheKey(videoId));
      return undefined;
    }
    return payload.cues;
  } catch {
    return undefined;
  }
}

function writeCachedTranscript(videoId, cues, { storageRef = safeSessionStorage(), ttlMs = DEFAULT_TRANSCRIPT_TTL_MS } = {}) {
  if (!videoId || !Array.isArray(cues) || !cues.length) return;
  try {
    storageRef?.setItem?.(transcriptCacheKey(videoId), JSON.stringify({
      videoId,
      cachedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      cues,
    }));
  } catch {
    // Transcript context is an optimization; keep frame verification working if storage is full or unavailable.
  }
}

function transcriptCacheKey(videoId) {
  return `${TRANSCRIPT_CACHE_PREFIX}${videoId}`;
}

function transcriptJsonUrl(value) {
  const url = new URL(value, globalThis.location?.href || "https://www.youtube.com/");
  url.searchParams.set("fmt", "json3");
  return url;
}

async function waitForCaptionButton(documentRef) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const button = getCaptionButton(documentRef);
    if (button) return button;
    await sleep(250);
  }
  return undefined;
}

function getCaptionButton(documentRef) {
  return documentRef?.querySelector?.(".ytp-subtitles-button")
    || documentRef?.querySelector?.('[aria-label*="Subtitles"]')
    || documentRef?.querySelector?.('[aria-label*="Captions"]');
}

function captionsEnabled(button) {
  return button?.getAttribute?.("aria-pressed") === "true"
    || button?.classList?.contains?.("ytp-button-active");
}

function getTimedTextRequests(performanceRef) {
  return (performanceRef?.getEntriesByType?.("resource") || [])
    .map((entry) => entry.name)
    .filter((url) => String(url).includes(TIMEDTEXT_PATH));
}

async function waitForNewTimedTextUrl(before, { performanceRef, pollAttempts, pollIntervalMs }) {
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await sleep(pollIntervalMs);
    const url = getTimedTextRequests(performanceRef).find((candidate) => !before.has(candidate));
    if (url) return url;
  }
  return undefined;
}

function safeSessionStorage() {
  try { return globalThis.sessionStorage; }
  catch { return undefined; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
