/**
 * TMDB Service - The Movie Database API Integration (Refactored)
 * 
 * Features:
 * - Search movies by title
 * - Get movie details (actors, crew, etc.)
 * - Get movie videos (trailers)
 * - NO Keep-Alive (tắt connection reuse để tránh ECONNRESET từ Cloudflare/TMDB)
 * - Retry with exponential backoff + agent reset (1s → 2s → 4s → 8s)
 * - Rate limiting: 300-500ms delay giữa các request
 * - Concurrency limit (1 request tại một thời điểm)
 * - Graceful error handling (TMDB errors don't crash crawler)
 * 
 * API Documentation: https://developers.themoviedb.org/3
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

class TMDBService {
  constructor() {
    this.apiKey = config.tmdb.apiKey;
    this.baseUrl = config.tmdb.baseUrl;
    this.enabled = config.tmdb.enabled && this.apiKey;
    
    // Tạo HTTP/HTTPS Agent với keepAlive=false
    const http = require('http');
    const https = require('https');
    
    this.httpAgent = new http.Agent({ 
      keepAlive: false, // TẮT keep-alive để tránh socket reuse bị Cloudflare đóng
      timeout: 12000,
    });
    
    this.httpsAgent = new https.Agent({ 
      keepAlive: false, // TẮT keep-alive để tránh ECONNRESET
      timeout: 12000,
    });

    // Axios client - TẠO MỚI mỗi lần request để đảm bảo fresh connection
    this.getClient = () => axios.create({
      baseURL: this.baseUrl,
      timeout: 12000, // Timeout 12 giây (hợp lý)
      params: {
        api_key: this.apiKey,
        language: 'vi-VN',
      },
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      maxRedirects: 5,
      maxContentLength: 50 * 1024 * 1024, // 50MB
      validateStatus: (status) => status < 500, // Don't throw on 4xx
      headers: {
        'Connection': 'close', // Đóng connection sau mỗi request
        'Accept-Encoding': 'gzip, deflate',
      },
    });

    // Request queue với concurrency limit = 1
    this.requestQueue = [];
    this.activeRequests = 0;
    this.maxConcurrency = 1; // CHỈ 1 concurrent request tại một thời điểm
    
    // Rate limiting: 400ms delay giữa các request
    this.lastRequestTime = 0;
    this.minRequestDelay = config.tmdb.requestDelay || 400; // 400ms (có thể config)
    this.maxRetries = config.tmdb.maxRetries || 4; // 4 lần retry

    if (!this.enabled) {
      logger.warn('[TMDB] Enrichment disabled. Set ENABLE_TMDB_ENRICHMENT=true and TMDB_API_KEY');
    } else {
      logger.info(`[TMDB] ✅ Initialized: timeout=12s, retry=${this.maxRetries}, concurrency=${this.maxConcurrency}, delay=${this.minRequestDelay}ms, keepAlive=false`);
    }
  }

  /**
   * FIXED: Concurrency-controlled request queue
   */
  async _queueRequest(requestFn) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ requestFn, resolve, reject });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this.activeRequests >= this.maxConcurrency || this.requestQueue.length === 0) {
      return;
    }

    this.activeRequests++;
    const { requestFn, resolve, reject } = this.requestQueue.shift();

    try {
      const result = await this._retryRequest(requestFn);
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.activeRequests--;
      this._processQueue(); // Process next in queue
    }
  }

  /**
   * Rate limiter - Wait before calling API
   */
  async _waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestDelay) {
      const waitTime = this.minRequestDelay - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * REFACTORED: Retry with exponential backoff + agent reset on ECONNRESET
   * Retry: network errors, timeout, 429 (rate limit), 5xx
   * NO retry: 400, 401, 403, 404
   * 
   * STRATEGY: Tạo lại HTTP agent và Axios client sau mỗi lỗi ECONNRESET
   */
  async _retryRequest(requestFn) {
    const maxRetries = this.maxRetries;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this._waitForRateLimit();
        
        // Tạo fresh Axios client cho mỗi request (keepAlive=false nên không tốn kém)
        const client = this.getClient();
        
        return await requestFn(client);
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        
        // Network errors: ECONNRESET, ETIMEDOUT, ENOTFOUND, EHOSTUNREACH, etc.
        const isNetworkError = [
          'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 
          'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ECONNABORTED',
          'ESOCKETTIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'
        ].includes(error.code);
        
        const statusCode = error.response?.status;
        
        // 5xx server errors
        const is5xxError = statusCode >= 500;
        
        // 429 rate limit
        const isRateLimitError = statusCode === 429;
        
        // 4xx client errors - DON'T RETRY (except 429)
        const is4xxError = statusCode >= 400 && statusCode < 500;
        
        if (is4xxError && !isRateLimitError) {
          // Don't retry 400, 401, 403, 404
          if (statusCode === 401) {
            logger.error('[TMDB] ❌ Invalid API key (401). Check TMDB_API_KEY in .env');
          } else if (statusCode === 404) {
            logger.debug('[TMDB] Resource not found (404)');
          } else if (statusCode === 403) {
            logger.error('[TMDB] ❌ Forbidden (403). Check API key permissions');
          } else {
            logger.warn(`[TMDB] Client error: ${statusCode}`);
          }
          throw error;
        }
        
        // Retry for network errors, 429, or 5xx errors
        const shouldRetry = (isNetworkError || isRateLimitError || is5xxError) && !isLastAttempt;
        
        if (shouldRetry) {
          // Exponential backoff: 1s → 2s → 4s → 8s
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          
          if (isNetworkError) {
            logger.warn(`[TMDB] ⚠️  Network error (${error.code}), reset agent & retry ${attempt}/${maxRetries} in ${backoffDelay}ms`);
            
            // RESET HTTP agents nếu gặp ECONNRESET (đóng tất cả socket cũ)
            if (error.code === 'ECONNRESET') {
              this.httpAgent.destroy();
              this.httpsAgent.destroy();
              
              // Tạo lại agents mới
              const http = require('http');
              const https = require('https');
              
              this.httpAgent = new http.Agent({ 
                keepAlive: false,
                timeout: 12000,
              });
              
              this.httpsAgent = new https.Agent({ 
                keepAlive: false,
                timeout: 12000,
              });
              
              logger.debug('[TMDB] 🔄 HTTP agents reset (closed old sockets)');
            }
          } else if (isRateLimitError) {
            logger.warn(`[TMDB] ⚠️  Rate limited (429), retry ${attempt}/${maxRetries} in ${backoffDelay}ms`);
          } else {
            logger.warn(`[TMDB] ⚠️  Server error (${statusCode}), retry ${attempt}/${maxRetries} in ${backoffDelay}ms`);
          }
          
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          continue;
        }
        
        // Last attempt or non-retryable error
        if (isNetworkError) {
          logger.error(`[TMDB] ❌ Failed after ${maxRetries} retries: ${error.code}`);
        }
        throw error;
      }
    }
  }

  /**
   * REFACTORED: Search movie by title and year (with fresh client per request)
   * @param {string} title - Movie title
   * @param {number} year - Release year (optional)
   * @returns {Object|null} First matching movie (null if error or not found)
   */
  async searchMovie(title, year = null) {
    if (!this.enabled) return null;
    if (!title) return null;

    try {
      return await this._queueRequest(async (client) => {
        const params = { query: title };
        if (year) params.year = year;

        const response = await client.get('/search/movie', { params });
        
        // Handle non-200 status codes
        if (response.status !== 200) {
          logger.warn(`[TMDB] Search returned status ${response.status} for: ${title}`);
          return null;
        }

        const results = response.data.results || [];

        if (results.length === 0) {
          logger.debug(`[TMDB] No results for: ${title}${year ? ` (${year})` : ''}`);
          return null;
        }

        // Return first result (best match)
        const movie = results[0];
        logger.info(`[TMDB] ✅ Found: ${movie.title} (ID: ${movie.id})`);
        
        return {
          tmdbId: movie.id,
          title: movie.title,
          originalTitle: movie.original_title,
          overview: movie.overview,
          releaseDate: movie.release_date,
          posterPath: movie.poster_path,
          backdropPath: movie.backdrop_path,
          voteAverage: movie.vote_average,
          voteCount: movie.vote_count,
        };
      });
    } catch (error) {
      // FIXED: Don't crash crawler, just log and return null
      logger.error(`[TMDB] ⚠️  Search failed for "${title}": ${error.message}`);
      return null;
    }
  }

  /**
   * REFACTORED: Get movie videos (trailers) with fresh client per request
   * @param {number} tmdbId - TMDB movie ID
   * @returns {Array} Array of trailer objects (empty if error)
   */
  async getMovieVideos(tmdbId) {
    if (!this.enabled) {
      logger.debug(`[TMDB] Service disabled, skip videos for ${tmdbId}`);
      return [];
    }

    if (!tmdbId) {
      logger.warn('[TMDB] Missing tmdbId for video fetch');
      return [];
    }

    try {
      return await this._queueRequest(async (client) => {
        logger.debug(`[TMDB] Fetching videos for movie: ${tmdbId}`);
        
        // Use English language to get more trailers
        const response = await client.get(`/movie/${tmdbId}/videos`, {
          params: {
            language: 'en-US',
          },
        });
        
        // Handle non-200 status codes
        if (response.status === 404) {
          logger.warn(`[TMDB] Movie ${tmdbId} not found (404)`);
          return [];
        }
        
        if (response.status !== 200) {
          logger.warn(`[TMDB] Videos API returned status ${response.status} for movie: ${tmdbId}`);
          return [];
        }

        const videos = response.data.results || [];

        if (videos.length === 0) {
          logger.debug(`[TMDB] No videos found for movie: ${tmdbId}`);
          return [];
        }

        // Filter YouTube videos only
        const youtubeVideos = videos.filter(v => v.site === 'YouTube');
        
        if (youtubeVideos.length === 0) {
          logger.debug(`[TMDB] No YouTube videos (total: ${videos.length}) for movie: ${tmdbId}`);
          return [];
        }

        // Map all YouTube videos
        const trailers = youtubeVideos.map(v => ({
          key: v.key || '',
          name: v.name || '',
          type: v.type || 'Trailer',
          site: v.site || 'YouTube',
          official: v.official || false,
          publishedAt: v.published_at || null,
          url: v.key ? `https://www.youtube.com/watch?v=${v.key}` : '',
        }));

        logger.info(`[TMDB] ✅ Found ${trailers.length} YouTube videos for movie: ${tmdbId}`);
        return trailers;
      });
    } catch (error) {
      // FIXED: Don't crash crawler, just log and return empty array
      const isNetworkError = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code);
      
      if (isNetworkError) {
        logger.error(`[TMDB] ⚠️  Network error fetching videos for ${tmdbId}: ${error.code}`);
      } else if (error.response?.status === 404) {
        logger.debug(`[TMDB] Movie not found: ${tmdbId}`);
      } else if (error.response?.status === 401) {
        logger.error('[TMDB] ❌ Invalid API key');
      } else {
        logger.error(`[TMDB] ⚠️  Get videos failed for ${tmdbId}: ${error.message}`);
      }
      
      return []; // Return empty array, don't crash
    }
  }

  /**
   * Get best trailer from videos array
   * Priority: Official Trailer > Trailer > Official Teaser > Other
   * @param {Array} videos - Array of video objects
   * @returns {Object|null} Best trailer object
   */
  getBestTrailer(videos) {
    if (!videos || videos.length === 0) return null;

    // Priority order
    const priorities = [
      { type: 'Trailer', official: true },
      { type: 'Trailer', official: false },
      { type: 'Teaser', official: true },
      { type: 'Teaser', official: false },
      { type: 'Clip', official: true },
    ];

    for (const priority of priorities) {
      const match = videos.find(
        v => v.type === priority.type && v.official === priority.official
      );
      if (match) {
        logger.info(`[TMDB] ✅ Trailer selected: "${match.name}" (${match.type}, official: ${match.official})`);
        return match;
      }
    }

    // Fallback: return first video
    logger.info(`[TMDB] ✅ Trailer selected (fallback): "${videos[0].name}"`);
    return videos[0];
  }

  /**
   * Get movie credits (cast + crew) - dùng để lấy diễn viên/đạo diễn kèm ảnh
   * @param {number} tmdbId - TMDB movie ID
   * @returns {Object} { cast: [...], directors: [...] } (empty arrays if error)
   */
  async getMovieCredits(tmdbId) {
    if (!this.enabled || !tmdbId) return { cast: [], directors: [] };

    try {
      return await this._queueRequest(async (client) => {
        const response = await client.get(`/movie/${tmdbId}/credits`);

        if (response.status !== 200) {
          logger.warn(`[TMDB] Credits API returned status ${response.status} for movie: ${tmdbId}`);
          return { cast: [], directors: [] };
        }

        const cast = (response.data.cast || []).map(p => ({
          tmdbId: p.id,
          name: p.name,
          characterName: p.character || '',
          order: p.order ?? 0,
          profilePath: p.profile_path,
          gender: p.gender === 1 ? 'female' : p.gender === 2 ? 'male' : 'unknown',
        }));

        const directors = (response.data.crew || [])
          .filter(p => p.job === 'Director')
          .map(p => ({
            tmdbId: p.id,
            name: p.name,
            profilePath: p.profile_path,
            gender: p.gender === 1 ? 'female' : p.gender === 2 ? 'male' : 'unknown',
          }));

        logger.info(`[TMDB] ✅ Credits for movie ${tmdbId}: ${cast.length} cast, ${directors.length} directors`);
        return { cast, directors };
      });
    } catch (error) {
      logger.error(`[TMDB] ⚠️  Get credits failed for ${tmdbId}: ${error.message}`);
      return { cast: [], directors: [] };
    }
  }

  /**
   * Get person details (biography, ảnh, ngày sinh...) từ TMDB
   * @param {number} personId - TMDB person ID
   * @returns {Object|null} Person detail object (null if error/not found)
   */
  async getPersonDetails(personId) {
    if (!this.enabled || !personId) return null;

    try {
      return await this._queueRequest(async (client) => {
        const response = await client.get(`/person/${personId}`);

        if (response.status !== 200) {
          logger.debug(`[TMDB] Person API returned status ${response.status} for person: ${personId}`);
          return null;
        }

        const p = response.data;
        return {
          tmdbId: p.id,
          name: p.name,
          biography: p.biography || '',
          birthday: p.birthday || null, // "YYYY-MM-DD"
          deathday: p.deathday || null,
          placeOfBirth: p.place_of_birth || '',
          profilePath: p.profile_path,
          knownForDepartment: p.known_for_department || '',
          gender: p.gender === 1 ? 'female' : p.gender === 2 ? 'male' : 'unknown',
          popularity: p.popularity || 0,
          imdbId: p.imdb_id || '',
        };
      });
    } catch (error) {
      logger.debug(`[TMDB] Get person details failed for ${personId}: ${error.message}`);
      return null;
    }
  }

  /**
   * FIXED: Enrich movie data with TMDB information
   * @param {Object} movieData - Movie data from crawler
   * @returns {Object} Enriched movie data (original data if TMDB fails)
   */
  async enrichMovieData(movieData) {
    if (!this.enabled) {
      logger.debug('[TMDB] Enrichment disabled, skipping');
      return movieData;
    }

    if (!movieData || !movieData.name) {
      logger.warn('[TMDB] Invalid movie data for enrichment');
      return movieData;
    }

    try {
      // Step 1: Search TMDB by title and year
      logger.debug(`[TMDB] Searching for: ${movieData.name}${movieData.year ? ` (${movieData.year})` : ''}`);
      let searchResult = await this.searchMovie(movieData.name, movieData.year);
      
      // Fallback: try originName if main search fails
      if (!searchResult && movieData.originName) {
        logger.debug(`[TMDB] Trying originName: ${movieData.originName}`);
        searchResult = await this.searchMovie(movieData.originName, movieData.year);
      }
      
      // Fallback for Chinese anime/series: try English transliteration
      if (!searchResult && movieData.originName && /[\u4e00-\u9fa5]/.test(movieData.originName)) {
        logger.debug(`[TMDB] Trying cleaned originName: ${movieData.originName.replace(/[^\w\s]/g, '')}`);
        searchResult = await this.searchMovie(movieData.originName.replace(/[^\w\s]/g, ''), movieData.year);
      }
      
      if (!searchResult) {
        logger.debug(`[TMDB] No match for: ${movieData.name}`);
        return movieData; // Return original data, don't crash
      }

      // Step 2: Get videos (trailers) using tmdbId
      logger.debug(`[TMDB] Fetching videos for tmdbId: ${searchResult.tmdbId}`);
      const videos = await this.getMovieVideos(searchResult.tmdbId);
      
      // Step 3: Get best trailer
      const bestTrailer = this.getBestTrailer(videos);

      // Step 4: Enrich movie data
      const enriched = {
        ...movieData,
        
        // TMDB data in nested object
        tmdb: {
          type: 'movie',
          id: searchResult.tmdbId.toString(),
          season: null,
          vote_average: searchResult.voteAverage || 0,
          vote_count: searchResult.voteCount || 0,
          trailer_url: bestTrailer ? bestTrailer.url : ''
        },
        
        // Trailer structured data
        trailer: bestTrailer ? {
          name: bestTrailer.name,
          key: bestTrailer.key,
          site: bestTrailer.site,
          type: bestTrailer.type,
          official: bestTrailer.official,
          publishedAt: bestTrailer.publishedAt,
          url: bestTrailer.url,
        } : null, // null if no trailer found
        
        // Content
        content: searchResult.overview || movieData.content,
        
        // Images (use TMDB if better quality)
        posterUrl: searchResult.posterPath 
          ? `https://image.tmdb.org/t/p/w500${searchResult.posterPath}`
          : movieData.posterUrl,
        backdropUrl: searchResult.backdropPath
          ? `https://image.tmdb.org/t/p/original${searchResult.backdropPath}`
          : movieData.backdropUrl,
      };

      logger.info(
        `[TMDB] ✅ Enriched "${movieData.name}": ` +
        `tmdbId=${searchResult.tmdbId}, videos=${videos.length}, trailer=${bestTrailer ? 'YES' : 'NO'}`
      );

      return enriched;
      
    } catch (error) {
      // FIXED: TMDB error should NOT crash crawler
      logger.error(`[TMDB] ⚠️  Enrichment failed for "${movieData.name}": ${error.message}`);
      logger.debug(`[TMDB] Continuing with original movie data (no TMDB enrichment)`);
      return movieData; // Return original data
    }
  }

  /**
   * Get full TMDB image URL
   * @param {string} path - Image path from TMDB
   * @param {string} size - Image size (w500, original, etc.)
   * @returns {string} Full URL
   */
  getImageUrl(path, size = 'w500') {
    if (!path) return '';
    return `https://image.tmdb.org/t/p/${size}${path}`;
  }
}

module.exports = new TMDBService();
