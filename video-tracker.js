// @ts-check

/**
 * Video Tracker
 * Handles tracking video views from tabs and requests
 */

import { logger } from "./logger.js";
import { sendMessageToTab } from "./browser-utils.js";
import { isValidVideoTitle, VIDEO_ID_LENGTH } from "./validation.js";
import { decodeHtmlEntitiesAndFixEncoding } from "./text-utils.js";
import { TIMEOUTS } from "./constants.js";

/**
 * Video Tracker class
 */
export class VideoTracker {
  constructor() {
    this.isInitialized = false;
    this.logger = logger;
    this.titleCache = new Map();
    this.maxCacheSize = 10000;
    this.listenersBound = false;
    this.progressTrackingEnabled = true;
    this.trackedNavigationUrls = new Map();
    this.pendingNavigationRetries = new Map();
    this.navigationRetryAttempts = new Map();
  }

  /**
   * Initialize video tracker
   * @param {Object} youtubeModule - Reference to Youtube module
   */
  async initialize(youtubeModule) {
    this.youtubeModule = youtubeModule;

    if (!this.listenersBound) {
      this.bindListeners();
    }

    await this.refreshSettings();
    this.isInitialized = true;
    this.logger.info("Video tracker initialized successfully");
  }

  /**
   * Keep local tracking flags in sync with extension settings.
   */
  async refreshSettings() {
    const result = await chrome.storage.sync.get(["idCondition_Youprog"]);
    this.progressTrackingEnabled = result.idCondition_Youprog === true;
  }

  /**
   * Bind extension event listeners once for the worker lifecycle.
   */
  bindListeners() {
    this.setupTabHook();
    this.setupRequestHook();
    this.setupStorageHook();
    this.listenersBound = true;
  }

  /**
   * Setup tab update hook for tracking navigation
   */
  setupTabHook() {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      try {
        if (tabId < 0 || !this.isYouTubeUrl(tab.url)) {
          return;
        }

        const result = await chrome.storage.sync.get(["idCondition_Brownav"]);
        const shouldTrackNavigation = result.idCondition_Brownav === true;

        if (shouldTrackNavigation) {
          await this.handleTabNavigation(tabId, changeInfo, tab);
        }
      } catch (error) {
        this.logger.error("Error in tab hook:", error);
      }
    });
  }

  /**
   * Setup request hook for tracking video progress
   */
  setupRequestHook() {
    chrome.webRequest.onSendHeaders.addListener(
      (details) => this.handleProgressRequest(details),
      { urls: ["https://www.youtube.com/api/stats/watchtime*"] },
    );
  }

  setupStorageHook() {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== "sync" || !changes.idCondition_Youprog) {
        return;
      }

      this.progressTrackingEnabled =
        changes.idCondition_Youprog.newValue === true;
    });
  }

  /**
   * Check if URL is a YouTube URL
   * @param {string} url - URL to check
   * @returns {boolean} True if YouTube URL
   */
  isYouTubeUrl(url) {
    return (
      url &&
      (url.startsWith("https://www.youtube.com") ||
        url.startsWith("https://m.youtube.com"))
    );
  }

  /**
   * Check if URL is a YouTube video URL
   * @param {string} url - URL to check
   * @returns {boolean} True if YouTube video URL
   */
  isYouTubeVideoUrl(url) {
    return (
      url &&
      (url.startsWith("https://www.youtube.com/watch?v=") ||
        url.startsWith("https://www.youtube.com/shorts/") ||
        url.startsWith("https://m.youtube.com/watch?v="))
    );
  }

  /**
   * Extract a video ID from a watch or Shorts URL.
   * @param {string} url - YouTube URL
   * @returns {string|null} Video ID when present
   */
  getVideoIdFromUrl(url) {
    try {
      const parsedUrl = new URL(url);
      const shortsMatch = parsedUrl.pathname.match(
        /^\/shorts\/([a-zA-Z0-9_-]{11})/,
      );
      return shortsMatch?.[1] || parsedUrl.searchParams.get("v");
    } catch (_error) {
      return null;
    }
  }

  /**
   * Normalize a browser title before storing it.
   * @param {string} title - Browser tab title
   * @returns {string} Normalized title
   */
  normalizeNavigationTitle(title) {
    const withoutSuffix = title.endsWith(" - YouTube")
      ? title.slice(0, -10)
      : title;
    return decodeHtmlEntitiesAndFixEncoding(withoutSuffix);
  }

  /**
   * Firefox can temporarily use the page URL as a tab title during navigation.
   * That is not useful watch-history metadata, so wait for YouTube's title.
   * @param {string} title - Normalized browser tab title
   * @returns {boolean} Whether the title is a URL placeholder
   */
  isUrlPlaceholderTitle(title) {
    return /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:watch\?|shorts\/)/i.test(
      title.trim(),
    );
  }

  scheduleNavigationRetry(tabId, expectedUrl) {
    const pendingRetry = this.pendingNavigationRetries.get(tabId);
    if (pendingRetry?.url === expectedUrl) {
      return;
    }

    if (pendingRetry) {
      clearTimeout(pendingRetry.timer);
    }

    const attempts = this.navigationRetryAttempts.get(tabId) || 0;
    if (attempts >= 3) {
      this.logger.debug("Giving up waiting for a YouTube video title");
      return;
    }
    this.navigationRetryAttempts.set(tabId, attempts + 1);

    const timer = setTimeout(async () => {
      this.pendingNavigationRetries.delete(tabId);
      try {
        const updatedTab = await chrome.tabs.get(tabId);
        if (updatedTab?.url !== expectedUrl) {
          return;
        }
        await this.handleTabNavigation(
          tabId,
          { status: "complete" },
          updatedTab,
        );
      } catch (error) {
        this.logger.debug(
          "Tab navigation retry failed (tab may have been closed):",
          error.message,
        );
      }
    }, TIMEOUTS.VIEW_COUNT_COOLDOWN / 15);

    this.pendingNavigationRetries.set(tabId, { url: expectedUrl, timer });
  }

  /**
   * Handle tab navigation to YouTube videos
   * @param {number} tabId - Tab ID
   * @param {Object} changeInfo - Change information
   * @param {Object} tab - Tab object
   */
  async handleTabNavigation(tabId, changeInfo, tab) {
    if (!this.isYouTubeVideoUrl(tab.url)) {
      return;
    }

    if (changeInfo.url) {
      this.trackedNavigationUrls.delete(tabId);
      this.navigationRetryAttempts.delete(tabId);
    }

    if (this.trackedNavigationUrls.get(tabId) === tab.url) {
      return;
    }

    // Direct URL loads commonly report a URL/status update before a title
    // update. On completion, use the tab's current title as a fallback.
    const rawTitle =
      changeInfo.title ||
      (changeInfo.status === "complete" ? tab.title : "");
    const title = rawTitle ? this.normalizeNavigationTitle(rawTitle) : "";

    if (!isValidVideoTitle(title) || this.isUrlPlaceholderTitle(title)) {
      this.logger.debug("Skipping video with invalid/generic title:", title);
      this.scheduleNavigationRetry(tabId, tab.url);
      return;
    }

    const videoId = this.getVideoIdFromUrl(tab.url);
    if (!videoId || videoId.length !== VIDEO_ID_LENGTH) {
      return;
    }

    try {
      // Mark video as watched
      await this.markVideoAsWatched(videoId, title);
      this.trackedNavigationUrls.set(tabId, tab.url);
      this.navigationRetryAttempts.delete(tabId);

      const pendingRetry = this.pendingNavigationRetries.get(tabId);
      if (pendingRetry) {
        clearTimeout(pendingRetry.timer);
        this.pendingNavigationRetries.delete(tabId);
      }

      // Notify all YouTube tabs
      await this.notifyYouTubeTabs(videoId, title);
    } catch (error) {
      this.logger.error("Error handling tab navigation:", error);
    }
  }

  /**
   * Handle progress tracking requests
   * @param {Object} details - Request details
   */
  async handleProgressRequest(details) {
    try {
      if (!this.progressTrackingEnabled) {
        return;
      }

      if (details.url.includes("muted=1")) {
        return;
      }

      const urlParams = new URLSearchParams(details.url.split("?")[1]);
      const elapsedTimes = urlParams.get("et")?.split(",") || [];
      const videoId = urlParams.get("docid");

      if (!videoId || videoId.length !== VIDEO_ID_LENGTH) {
        return;
      }

      const title = this.titleCache.get(videoId) || "";
      if (!title) {
        return;
      }

      // Check if any elapsed time is significant (> 3 seconds)
      const hasSignificantProgress = elapsedTimes.some(
        (time) => parseFloat(time) >= 3.0,
      );

      if (hasSignificantProgress) {
        await this.ensureVideoTracked(videoId, title);
        await this.notifyYouTubeTabs(videoId, title);
      }
    } catch (error) {
      this.logger.error("Error handling progress request:", error);
    }
  }

  /**
   * Mark a video as watched
   * @param {string} videoId - Video ID
   * @param {string} title - Video title
   */
  async markVideoAsWatched(videoId, title) {
    const response = await this.youtubeModule.mark(videoId, title);
    if (response) {
      this.logger.debug("Video marked as watched:", videoId);
      return response;
    }
    throw new Error("Failed to mark video as watched");
  }

  /**
   * Ensure a video is tracked in the database
   * @param {string} videoId - Video ID
   * @param {string} title - Video title
   */
  async ensureVideoTracked(videoId, title) {
    try {
      const response = await this.youtubeModule.ensure(videoId, title);
      if (response) {
        this.logger.debug("Video ensured:", videoId);
        return response;
      }
      this.logger.error(
        "Youtube.ensure returned null response for:",
        videoId,
        title,
      );
      throw new Error("Failed to ensure video");
    } catch (error) {
      this.logger.error("Error in Youtube.ensure call:", error);
      throw error;
    }
  }

  /**
   * Notify all YouTube tabs about a marked video
   * @param {string} videoId - Video ID
   * @param {string} title - Video title
   */
  async notifyYouTubeTabs(videoId, title) {
    return new Promise((resolve) => {
      chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
        tabs.forEach((tab) => {
          sendMessageToTab(tab.id, {
            action: "youtube-mark",
            videoId: videoId,
            timestamp: 0,
            title: title,
            count: 0,
          });
        });
        resolve();
      });
    });
  }

  /**
   * Add title to cache
   * @param {string} videoId - Video ID
   * @param {string} title - Video title
   */
  cacheTitle(videoId, title) {
    // Implement LRU-like cache with size limit
    if (this.titleCache.size >= this.maxCacheSize) {
      // Remove oldest entries (first 20%)
      const keysToDelete = Array.from(this.titleCache.keys()).slice(
        0,
        Math.floor(this.maxCacheSize * 0.2),
      );
      keysToDelete.forEach((key) => this.titleCache.delete(key));
    }

    this.titleCache.set(videoId, title);
  }

  /**
   * Get title from cache
   * @param {string} videoId - Video ID
   * @returns {string|undefined} Cached title
   */
  getCachedTitle(videoId) {
    return this.titleCache.get(videoId);
  }

  /**
   * Clear title cache
   */
  clearCache() {
    this.titleCache.clear();
    this.logger.debug("Title cache cleared");
  }
}

/**
 * Create and export default video tracker instance
 */
export const videoTracker = new VideoTracker();
