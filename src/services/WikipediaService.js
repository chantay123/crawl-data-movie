/**
 * WikipediaService - Wikipedia API Integration
 * 
 * Fetches movie information from Wikipedia API
 * Used as fallback/enrichment when TMDB data is insufficient
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

class WikipediaService {
  constructor() {
    this.enabled = config.wikipedia.enabled;
    this.lang = config.wikipedia.lang || 'en';
    this.baseUrl = `https://${this.lang}.wikipedia.org/w/api.php`;
    this.requestDelay = config.wikipedia.requestDelay || 300;
    this.lastRequestTime = 0;
    
    if (this.enabled) {
      logger.info(`[Wikipedia] ✅ Initialized (lang: ${this.lang})`);
    } else {
      logger.debug('[Wikipedia] Disabled');
    }
  }

  /**
   * Rate limiting
   */
  async _rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.requestDelay) {
      await new Promise(r => setTimeout(r, this.requestDelay - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Search Wikipedia for a movie
   * @param {string} title - Movie title
   * @param {number} year - Release year (optional)
   * @returns {Object|null} Wikipedia data
   */
  async searchWikipedia(title, year = null) {
    if (!this.enabled || !title) return null;

    try {
      await this._rateLimit();
      
      // Build search query
      let searchQuery = title;
      if (year) {
        searchQuery = `${title} ${year}`;
      }
      
      const response = await axios.get(this.baseUrl, {
        params: {
          action: 'query',
          list: 'search',
          srsearch: searchQuery,
          format: 'json',
          origin: '*',
        },
        timeout: 10000,
      });

      const results = response.data?.query?.search || [];
      
      if (results.length === 0) {
        logger.debug(`[Wikipedia] No results for: ${title}`);
        return null;
      }

      // Get first result
      const firstResult = results[0];
      const pageId = firstResult.pageid;
      
      // Get full page content
      const pageData = await this.getPageContent(pageId);
      
      if (!pageData) {
        return null;
      }

      logger.info(`[Wikipedia] ✅ Found: ${pageData.title}`);
      return {
        title: pageData.title,
        pageId: pageData.pageid,
        extract: pageData.extract,
        thumbnail: pageData.thumbnail?.source || null,
        url: `https://${this.lang}.wikipedia.org/wiki/${encodeURIComponent(pageData.title.replace(/ /g, '_'))}`,
      };

    } catch (error) {
      logger.error(`[Wikipedia] ⚠️  Search failed for "${title}": ${error.message}`);
      return null;
    }
  }

  /**
   * Get full page content
   * @param {number} pageId - Wikipedia page ID
   * @returns {Object|null} Page content
   */
  async getPageContent(pageId) {
    if (!this.enabled || !pageId) return null;

    try {
      await this._rateLimit();
      
      const response = await axios.get(this.baseUrl, {
        params: {
          action: 'query',
          pageids: pageId,
          prop: 'extracts|pageimages|info',
          exintro: true,
          explaintext: true,
          piprop: 'thumbnail',
          pithumbsize: 500,
          format: 'json',
          origin: '*',
        },
        timeout: 10000,
      });

      const page = response.data?.query?.pages?.[pageId];
      if (!page || page.missing) {
        return null;
      }

      return page;

    } catch (error) {
      logger.error(`[Wikipedia] ⚠️  Get page failed for ${pageId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Enrich movie data with Wikipedia info
   * @param {Object} movieData - Movie data
   * @returns {Object} Enriched data
   */
  async enrichMovieData(movieData) {
    if (!this.enabled || !movieData?.name) {
      return movieData;
    }

    try {
      const wikiData = await this.searchWikipedia(movieData.name, movieData.year);
      
      if (wikiData) {
        return {
          ...movieData,
          wikipedia: {
            pageId: wikiData.pageId,
            title: wikiData.title,
            extract: wikiData.extract,
            url: wikiData.url,
          },
          // Use Wikipedia image if no poster
          posterUrl: movieData.posterUrl || wikiData.thumbnail,
        };
      }
      
      return movieData;
      
    } catch (error) {
      logger.error(`[Wikipedia] Enrichment failed: ${error.message}`);
      return movieData;
    }
  }
}

module.exports = new WikipediaService();
