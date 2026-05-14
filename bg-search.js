import { logger } from "./logger.js";
import { YOUTUBE } from "./constants.js";
import { Youtube } from "./bg-youtube.js";

/**
 * Search management class
 * Handles video search and deletion operations
 */
export class SearchManager {
  constructor() {
    this.isInitialized = false;
    this.providerFactory = null;
  }

  /**
   * Set the provider factory for dependency injection
   * @param {Object} factory - Database provider factory instance
   */
  setProviderFactory(factory) {
    this.providerFactory = factory;
  }

  /**
   * Get the current database provider
   * @returns {Object} Database provider
   * @throws {Error} If provider factory not set
   */
  getProvider() {
    if (!this.providerFactory) {
      throw new Error(
        "Provider factory not set. Call setProviderFactory() first.",
      );
    }
    const provider = this.providerFactory.getCurrentProvider();
    if (!provider) {
      throw new Error("No current database provider available");
    }
    return provider;
  }

  /**
   * Initialize the Search module
   * @returns {Promise<void>}
   */
  async init() {
    if (this.isInitialized) {
      return;
    }

    this.isInitialized = true;
    logger.debug("Search module initialized");
  }

  /**
   * Search for videos in the database
   * @param {string} [query=''] - Search query (searches in ID and title)
   * @param {number} [skip=0] - Number of results to skip
   * @param {number} [length=0] - Number of results to return (0 = all)
   * @returns {Promise<Object>} Object with videos array and totalResults count
   */
  async lookup(query = "", skip = 0, length = 0) {
    try {
      const currentProvider = this.getProvider();

      // Get all videos from the current provider
      const allVideos = await currentProvider.getAllVideos();

      // Filter videos based on search query
      let filteredVideos = [];

      if (!query || query.trim() === "") {
        // Empty query - show all videos
        filteredVideos = allVideos;
      } else {
        // Non-empty query - search in both ID and title (case-insensitive)
        const searchTerm = query.toLowerCase().trim();
        filteredVideos = allVideos.filter((video) => {
          const videoId = (video.strIdent || "").toLowerCase();
          const videoTitle = (video.strTitle || "").toLowerCase();
          return (
            videoId.includes(searchTerm) || videoTitle.includes(searchTerm)
          );
        });
      }

      // Sort by timestamp (newest first)
      filteredVideos.sort(
        (a, b) => (b.intTimestamp || 0) - (a.intTimestamp || 0),
      );

      // Store total count before pagination
      const totalResults = filteredVideos.length;

      // Apply pagination
      const actualLength = length || filteredVideos.length;
      const paginatedVideos = filteredVideos.slice(skip, skip + actualLength);

      return {
        videos: paginatedVideos,
        totalResults: totalResults,
      };
    } catch (error) {
      logger.error("Search lookup error:", error);
      throw error;
    }
  }

  /**
   * Delete a video from database, browser history, and best-effort YouTube history
   * @param {string} videoId - Video ID to delete
   * @param {Function} [onProgress] - Optional progress callback
   * @returns {Promise<Object>} Deletion result
   */
  async delete(videoId, onProgress = null) {
    try {
      const currentProvider = this.getProvider();

      // Step 1: Delete from database
      if (onProgress) {
        onProgress({
          strProgress: "1/3 - deleting it from the database",
        });
      }

      await currentProvider.deleteVideo(videoId);

      // Step 2: Delete from browser history
      if (onProgress) {
        onProgress({
          strProgress: "2/3 - deleting it from the history in the browser",
        });
      }

      // Search for YouTube URLs containing this video ID
      const historyResults = await new Promise((resolve) => {
        chrome.history.search(
          {
            text: videoId,
            startTime: 0,
            maxResults: 1000000,
          },
          resolve,
        );
      });

      // Delete matching URLs from browser history
      for (let historyResult of historyResults) {
        // Check if URL is a valid YouTube video URL
        if (
          !historyResult.url.startsWith(YOUTUBE.URLS.WATCH) &&
          !historyResult.url.startsWith(YOUTUBE.URLS.SHORTS) &&
          !historyResult.url.startsWith(YOUTUBE.URLS.MOBILE_WATCH)
        ) {
          continue;
        }

        if (!historyResult.title) {
          continue;
        }

        chrome.history.deleteUrl({
          url: historyResult.url,
        });
      }

      const youtubeHistory = await this.deleteFromYouTubeHistory(videoId, {
        onProgress,
      });

      logger.info(`Deleted video ${videoId} from local history`);
      return {
        deleted: true,
        youtubeHistory,
      };
    } catch (error) {
      logger.error("Search delete error:", error);
      throw error;
    }
  }

  async deleteFromYouTubeHistory(videoId, { onProgress } = {}) {
    if (onProgress) {
      onProgress({
        strProgress: "3/3 - deleting it from the first page of YouTube history",
      });
    }

    try {
      await Youtube.deleteFromHistoryFirstPage(videoId);
      return { success: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown YouTube error";
      logger.warn(
        `Could not delete video ${videoId} from YouTube history:`,
        message,
      );
      return {
        success: false,
        error: message,
      };
    }
  }
}

// Global instance
export const Search = new SearchManager();
