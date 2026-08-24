import assert from "node:assert/strict";
import test from "node:test";

import {
  DELTA_SYNC_STORAGE_KEY,
  mergeVideoData,
  performDeltaSync,
} from "./provider-sync.js";

test("empty Supabase is rebuilt from the complete local history", async () => {
  const writtenWatermarks = [];
  globalThis.chrome = fakeChrome(123_000, writtenWatermarks);
  const requestedRanges = [];
  const imported = [];
  const videos = [video("abcdefghijk"), video("lmnopqrstuv")];

  const result = await performDeltaSync(
    {
      getVideoCount: async () => videos.length,
      getVideosByDateRange: async (start, end) => {
        requestedRanges.push({ start, end });
        return videos;
      },
    },
    {
      isConnected: true,
      getVideoCount: async () => 0,
      importVideos: async (batch) => imported.push(...batch),
    },
  );

  assert.deepEqual(result, { success: true, synced: 2 });
  assert.equal(requestedRanges[0].start, 0);
  assert.deepEqual(imported, videos);
  assert.equal(writtenWatermarks.length, 1);
  assert.ok(writtenWatermarks[0][DELTA_SYNC_STORAGE_KEY] > 123_000);
});

test("populated Supabase keeps using the delta watermark", async () => {
  globalThis.chrome = fakeChrome(123_000, []);
  let requestedStart = null;

  const result = await performDeltaSync(
    {
      getVideoCount: async () => 2,
      getVideosByDateRange: async (start) => {
        requestedStart = start;
        return [];
      },
    },
    {
      isConnected: true,
      getVideoCount: async () => 1,
      importVideos: async () => assert.fail("nothing should be imported"),
    },
  );

  assert.deepEqual(result, { success: true, synced: 0 });
  assert.equal(requestedStart, 123_000);
});

test("bidirectional merges never reduce watched progress", () => {
  const local = {
    ...video("abcdefghijk"),
    intTimestamp: 1_000,
    intCount: 1,
    strTitle: "Local title",
  };
  const remote = {
    ...video("abcdefghijk"),
    intTimestamp: 2_000,
    intCount: 3,
    strTitle: "Remote title",
  };

  assert.deepEqual(mergeVideoData([local], [remote]), [
    {
      ...remote,
      intTimestamp: 2_000,
      intCount: 3,
    },
  ]);
  assert.deepEqual(mergeVideoData([remote], [local])[0], {
    ...remote,
    intTimestamp: 2_000,
    intCount: 3,
  });
});

function fakeChrome(lastSync, writtenWatermarks) {
  return {
    storage: {
      local: {
        get: async () => ({ [DELTA_SYNC_STORAGE_KEY]: lastSync }),
        set: async (value) => writtenWatermarks.push(value),
      },
    },
  };
}

function video(strIdent) {
  return {
    strIdent,
    intTimestamp: 1_785_153_600_000,
    strTitle: strIdent,
    intCount: 1,
  };
}
