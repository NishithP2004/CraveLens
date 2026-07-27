import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTranscriptContext,
  extractAssignedJson,
  formatTranscriptContext,
  getTranscriptContext,
  normalizeCaptionEvents,
  selectCaptionTrack,
} from "./transcript.js";

test("extracts a balanced ytInitialPlayerResponse assignment", () => {
  const value = extractAssignedJson('var ytInitialPlayerResponse = {"captions":{"value":"brace } in string"}};', "ytInitialPlayerResponse");
  assert.equal(value.captions.value, "brace } in string");
});

test("selects preferred captions and normalizes segmented events", () => {
  assert.equal(selectCaptionTrack([{ languageCode: "hi" }, { languageCode: "en-US" }], "en-GB").languageCode, "en-US");
  assert.deepEqual(normalizeCaptionEvents({ events: [
    { tStartMs: 9_000, dDurationMs: 2_000, segs: [{ utf8: "Miso " }, { utf8: "ramen" }] },
    { tStartMs: 11_000, segs: [] },
  ] }), [{ start: 9, end: 11, text: "Miso ramen" }]);
});

test("builds and labels transcript context before, at, and after the frame", () => {
  const context = buildTranscriptContext([
    { start: 7, end: 9, text: "First prepare the broth." },
    { start: 9, end: 11, text: "This is miso ramen." },
    { start: 11, end: 13, text: "Add the noodles next." },
  ], 10);
  assert.deepEqual(context.before.map((cue) => cue.text), ["First prepare the broth."]);
  assert.deepEqual(context.at.map((cue) => cue.text), ["This is miso ramen."]);
  assert.deepEqual(context.after.map((cue) => cue.text), ["Add the noodles next."]);
  assert.match(formatTranscriptContext(context), /Before:.*First prepare the broth[\s\S]*At:.*miso ramen[\s\S]*After:.*noodles/);
});

test("loads the preferred YouTube caption track around the selected frame", async () => {
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=abc" }],
      },
    },
  };
  const documentRef = {
    querySelector: () => ({ textContent: JSON.stringify(playerResponse) }),
    querySelectorAll: () => [],
  };
  const context = await getTranscriptContext({
    videoId: "abc",
    timestamp: 10,
    preferredLanguage: "en",
    documentRef,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ events: [
        { tStartMs: 8_000, dDurationMs: 1_000, segs: [{ utf8: "before" }] },
        { tStartMs: 9_500, dDurationMs: 1_000, segs: [{ utf8: "at" }] },
        { tStartMs: 11_000, dDurationMs: 1_000, segs: [{ utf8: "after" }] },
      ] }),
      url,
    }),
  });
  assert.deepEqual(context.before.map((cue) => cue.text), ["before"]);
  assert.deepEqual(context.at.map((cue) => cue.text), ["at"]);
  assert.deepEqual(context.after.map((cue) => cue.text), ["after"]);
});

test("uses live-player caption tracks without relying on stale page metadata", async () => {
  const context = await getTranscriptContext({
    videoId: "abc",
    timestamp: 5,
    preferredLanguage: "en",
    captionTracks: [{ languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=abc" }],
    documentRef: {
      querySelector: () => ({ textContent: JSON.stringify({ videoDetails: { videoId: "stale" } }) }),
      querySelectorAll: () => [],
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ events: [
        { tStartMs: 4_000, dDurationMs: 2_000, segs: [{ utf8: "live captions" }] },
      ] }),
    }),
  });
  assert.deepEqual(context.at.map((cue) => cue.text), ["live captions"]);
});
