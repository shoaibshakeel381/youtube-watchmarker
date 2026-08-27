import assert from "node:assert/strict";
import test from "node:test";

import { VideoTracker } from "./video-tracker.js";

test("marks a direct video URL when only the completed tab title is available", async () => {
  const tracker = new VideoTracker();
  const marked = [];
  tracker.markVideoAsWatched = async (videoId, title) => {
    marked.push({ videoId, title });
  };
  tracker.notifyYouTubeTabs = async () => {};

  await tracker.handleTabNavigation(
    1,
    { status: "complete" },
    {
      url: "https://www.youtube.com/watch?v=abcdefghijk&list=PL123",
      title: "A direct navigation title - YouTube",
    },
  );

  assert.deepEqual(marked, [
    { videoId: "abcdefghijk", title: "A direct navigation title" },
  ]);
});

test("waits when Firefox temporarily uses the video URL as a tab title", async () => {
  const tracker = new VideoTracker();
  const retries = [];
  tracker.markVideoAsWatched = async () => assert.fail("must not mark a URL");
  tracker.scheduleNavigationRetry = (tabId, url) => retries.push({ tabId, url });

  await tracker.handleTabNavigation(
    1,
    { status: "complete" },
    {
      url: "https://www.youtube.com/watch?v=G55HSGpuh1M",
      title: "youtube.com/watch?v=G55HSGpuh1M",
    },
  );

  assert.deepEqual(retries, [
    { tabId: 1, url: "https://www.youtube.com/watch?v=G55HSGpuh1M" },
  ]);
});
