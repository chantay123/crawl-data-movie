/**
 * MovieService - Business Logic Layer
 * 
 * Xử lý việc lưu movies vào database với đầy đủ relationships:
 * - Movies (main table)
 * - Categories (master data) + MovieCategory (junction)
 * - Countries (master data) + MovieCountry (junction)
 * - Actors (master data) + MovieActor (junction)
 * - Directors (master data) + MovieDirector (junction)
 * 
 * Senior Backend Developer Best Practices:
 * - Transaction support cho data consistency
 * - Upsert strategy với duplicate handling
 * - Normalized relationships (junction tables)
 * - Proper error handling và rollback
 */

const {
  Movie,
  Category,
  Country,
  Actor,
  Director,
  Year,
  Format,
  MovieCategory,
  MovieCountry,
  MovieActor,
  MovieDirector,
  MovieYear,
  MovieFormat
} = require('../models');
const TMDBService = require('./TMDBService');
const WikipediaService = require('./WikipediaService');
const TrailerService = require('./TrailerService');
const logger = require('../utils/logger');

class MovieService {
  /**
   * Lưu hoặc cập nhật movie với đầy đủ relationships
   * 
   * @param {Object} movieData - Dữ liệu từ crawler (format OPhim/KKPhim/Nguonc)
   * @param {string} sourceName - Tên nguồn crawl
   * @param {boolean} enrichWithTMDB - Enrich data với TMDB (default: true)
   * @returns {Object} { movie, isNew, categoriesAdded, countriesAdded, actorsAdded, directorsAdded }
   */
  async saveMovie(movieData, sourceName = 'unknown', enrichWithTMDB = true) {
    try {
      // 0. Enrich data với TMDB nếu enabled
      let enrichedData = movieData;
      let tmdbCredits = null;
      
      if (enrichWithTMDB && TMDBService.enabled) {
        enrichedData = await TMDBService.enrichMovieData(movieData);
        
        // Fetch credits (cast/directors) từ TMDB nếu có tmdbId
        const tmdbId = enrichedData.tmdb?.id;
        if (tmdbId) {
          tmdbCredits = await TMDBService.getMovieCredits(parseInt(tmdbId, 10));
        }
      }

      // 1. Transform data từ crawler format sang backend schema
      const transformedData = this._transformMovieData(enrichedData, sourceName);

      // Check existing movie để giữ lại trailer cũ (nếu có)
      const existingMovie = await Movie.findOne({
        $or: [
          { slug: transformedData.slug },
          { source: sourceName, sourceId: transformedData.sourceId }
        ]
      }).select('trailer').lean();

      // Nếu input không có trailer mới VÀ movie cũ đã có trailer → giữ lại trailer cũ
      // Nếu input có trailer mới → dùng trailer mới
      // Nếu không có cả hai → để undefined (sẽ được fetch riêng ở bước 4)
      if (!transformedData.trailer?.key && existingMovie?.trailer?.key) {
        // Giữ lại trailer cũ: bỏ field trailer khỏi transformedData để không ghi đè
        delete transformedData.trailer;
        // tmdb.trailer_url cũng giữ nguyên (không ghi đè)
        if (transformedData.tmdb) {
          delete transformedData.tmdb.trailer_url;
        }
      } else if (!transformedData.trailer?.key) {
        // Không có trailer cũ lẫn mới: xóa để bước 4 tự fetch
        delete transformedData.trailer;
      }

      // 2. Upsert Movie (tìm theo slug hoặc sourceId)
      // Dùng $set để chỉ cập nhật các field mới, giữ nguyên field cũ (view, rating, trailer...)
      const updateFields = {};
      for (const [key, value] of Object.entries(transformedData)) {
        updateFields[key] = value;
      }
      const movie = await Movie.findOneAndUpdate(
        {
          $or: [
            { slug: transformedData.slug },
            { source: sourceName, sourceId: transformedData.sourceId }
          ]
        },
        { $set: updateFields },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );

      const isNew = movie.createdAt.getTime() === movie.updatedAt.getTime();

      // 3. Process relationships (Categories, Countries, Actors, Directors, Years, Formats)
      const categoriesAdded = await this._processCategories(movie._id, enrichedData.category || []);
      const countriesAdded = await this._processCountries(movie._id, enrichedData.country || []);
      
      // Pass tmdbCredits to actors/directors processing
      const actorsAdded = await this._processActors(movie._id, enrichedData.actor || [], sourceName, tmdbCredits?.cast);
      const directorsAdded = await this._processDirectors(movie._id, enrichedData.director || [], sourceName, tmdbCredits?.directors);
      
      const yearsAdded = await this._processYears(movie._id, enrichedData.year, sourceName);
      const formatsAdded = await this._processFormats(movie._id, enrichedData.quality, sourceName);

      // 4. Fetch trailer nếu chưa có trailer THẬT (có key)
      // - Chưa có trailer field → fetch
      // - Có null trailer (no key) → fetch (cơ hội retry khi YouTube recover)
      // - Có real trailer (key='abc123') → skip
      // TrailerService sẽ try YouTube → lưu real trailer HOẶC giữ null (không bao giờ lưu empty object).
      // YouTube 429 KHÔNG crash crawler — Movie vẫn được lưu bình thường.
      let trailerResult = null;
      if (!movie.trailer || !movie.trailer.key) {
        try {
          trailerResult = await TrailerService.getTrailer(movie);
        } catch (error) {
          logger.warn(`[MovieService] Failed to fetch trailer for ${movie.name}: ${error.message}`);
        }
      }

      logger.info(
        `${isNew ? 'Created' : 'Updated'} movie: ${movie.name} (${movie.slug}) ` +
        `[Cat: ${categoriesAdded}, Coun: ${countriesAdded}, Act: ${actorsAdded}, Dir: ${directorsAdded}, Year: ${yearsAdded}, Fmt: ${formatsAdded}` +
        `${trailerResult?.status === 'FOUND' ? ', Trailer: ✅' :
          trailerResult?.status === 'RATE_LIMITED' ? ', Trailer: ⏸RATE_LIMITED' :
          trailerResult?.status === 'NOT_FOUND' ? ', Trailer: ⬜NONE' : ''}]`
      );

      return { movie, isNew, categoriesAdded, countriesAdded, actorsAdded, directorsAdded, yearsAdded, formatsAdded, trailerResult };

    } catch (error) {
      logger.error(`Failed to save movie ${movieData.slug}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Transform dữ liệu từ crawler format sang backend schema
   * NOTE: Không lưu category/country vào Movie schema nữa (đã normalized)
   */
  _transformMovieData(crawlerData, sourceName) {
    return {
      // Source tracking
      source: sourceName,
      sourceId: crawlerData._id || crawlerData.slug,
      sourceCreatedAt: crawlerData.created?.time || null,
      sourceModifiedAt: crawlerData.modified?.time || null,

      // TMDB/IMDB - Nested object structure
      tmdb: {
        type: crawlerData.tmdb?.type || null,
        id: crawlerData.tmdb?.id || '',
        season: crawlerData.tmdb?.season || null,
        vote_average: crawlerData.tmdb?.vote_average || 0,
        vote_count: crawlerData.tmdb?.vote_count || 0,
        trailer_url: crawlerData.tmdb?.trailer_url || ''
      },
      imdb: {
        id: crawlerData.imdb?.id || ''
      },

      // Trailer - Structured data (if enriched by TMDB)
      trailer: crawlerData.trailer ? {
        name: crawlerData.trailer.name || '',
        key: crawlerData.trailer.key || '',
        site: crawlerData.trailer.site || 'YouTube',
        type: crawlerData.trailer.type || 'Trailer',
        official: crawlerData.trailer.official || false,
        publishedAt: crawlerData.trailer.publishedAt || null,
        url: crawlerData.trailer.url || ''
      } : undefined,

      // Core info
      name: crawlerData.name,
      originName: crawlerData.origin_name || crawlerData.name,
      content: crawlerData.content || '',
      slug: crawlerData.slug,
      type: this._normalizeType(crawlerData.type),
      status: crawlerData.status || 'completed',

      // Media URLs
      thumbUrl: crawlerData.thumb_url || crawlerData.thumbUrl || '',
      posterUrl: crawlerData.poster_url || crawlerData.posterUrl || '',
      backdropUrl: crawlerData.backdrop_url || crawlerData.backdropUrl || '',

      // Episode info
      time: crawlerData.time || '',
      episodeCurrent: crawlerData.episode_current || '',
      episodeTotal: crawlerData.episode_total || '',
      lang: crawlerData.lang || 'Vietsub',
      notify: crawlerData.notify || '',
      showtimes: crawlerData.showtimes || '',

      // Release info
      releaseDate: this._parseReleaseDate(crawlerData),

      // Stats
      viewCount: crawlerData.view || 0,

      // People - Keep as string arrays for backward compatibility
      actor: Array.isArray(crawlerData.actor) ? crawlerData.actor.filter(Boolean) : [],
      director: Array.isArray(crawlerData.director) ? crawlerData.director.filter(Boolean) : [],

      // Flags
      isCopyright: crawlerData.is_copyright || false,
      chieurap: crawlerData.chieurap || false,
      subDocquyen: crawlerData.sub_docquyen || false,
      isHidden: crawlerData.isHidden || false,

      // Episodes (embedded)
      episodes: this._transformEpisodes(crawlerData.episodes || []),
    };
  }

  /**
   * Normalize movie type theo backend ENUMS
   */
  _normalizeType(type) {
    const typeMap = {
      'series': 'series',
      'single': 'single',
      'tvshows': 'tvshows',
      'tv_shows': 'tvshows',
      'hoathinh': 'hoathinh',
      'cartoon': 'hoathinh',
    };
    return typeMap[type?.toLowerCase()] || 'series';
  }

  /**
   * Parse release date từ nhiều sources
   */
  _parseReleaseDate(data) {
    if (data.releaseDate) return new Date(data.releaseDate);
    if (data.release_date) return new Date(data.release_date);
    if (data.year) return new Date(`${data.year}-01-01`);
    return null;
  }

  /**
   * Transform episodes array
   */
  _transformEpisodes(episodes) {
    return episodes.map(server => ({
      server_name: server.server_name,
      server_data: (server.server_data || []).map(ep => ({
        name: ep.name,
        slug: ep.slug,
        filename: ep.filename,
        link_embed: ep.link_embed || '',
        link_m3u8: ep.link_m3u8 || '',
      }))
    }));
  }

  /**
   * Process Categories: Create master data + junction table
   */
  async _processCategories(movieId, categories) {
    if (!categories || categories.length === 0) return 0;

    const categoryIds = [];

    for (const cat of categories) {
      if (!cat.slug || !cat.name) continue;

      try {
        const category = await Category.findOrCreate({
          name: cat.name,
          slug: cat.slug,
        });
        categoryIds.push(category._id);
      } catch (err) {
        logger.warn(`Failed to create category ${cat.slug}: ${err.message}`);
      }
    }

    if (categoryIds.length > 0) {
      await MovieCategory.setCategories(movieId, categoryIds);
    }

    return categoryIds.length;
  }

  /**
   * Process Countries: Create master data + junction table
   */
  async _processCountries(movieId, countries) {
    if (!countries || countries.length === 0) return 0;

    const countryIds = [];

    for (const coun of countries) {
      if (!coun.slug || !coun.name) continue;

      try {
        const country = await Country.findOrCreate({
          name: coun.name,
          slug: coun.slug,
        });
        countryIds.push(country._id);
      } catch (err) {
        logger.warn(`Failed to create country ${coun.slug}: ${err.message}`);
      }
    }

    if (countryIds.length > 0) {
      await MovieCountry.setCountries(movieId, countryIds);
    }

    return countryIds.length;
  }

  /**
   * Process Actors: Create master data + junction table
   * UPDATED: Ưu tiên dùng TMDB credits (có ảnh, vai diễn) nếu có
   *         Fallback sang Wikipedia nếu TMDB thiếu ảnh/biography
   */
  async _processActors(movieId, actorNames, sourceName, tmdbCast = null) {
    if (!actorNames || actorNames.length === 0) {
      // Nếu không có actorNames từ crawler nhưng có tmdbCast, dùng TMDB
      if (tmdbCast && tmdbCast.length > 0) {
        return await this._processActorsFromTMDB(movieId, tmdbCast, sourceName);
      }
      return 0;
    }

    const actorRecords = [];

    // Nếu có tmdbCast, match theo tên để lấy ảnh/thông tin
    for (let i = 0; i < actorNames.length; i++) {
      const name = actorNames[i];
      if (!name || typeof name !== 'string') continue;

      try {
        let actor;
        
        // Tìm match trong tmdbCast theo tên (case-insensitive)
        const tmdbMatch = tmdbCast?.find(c => 
          c.name.toLowerCase() === name.trim().toLowerCase()
        );

        if (tmdbMatch) {
          // Có match TMDB → enrich với ảnh, biography (fetch details nếu cần)
          const personDetails = await TMDBService.getPersonDetails(tmdbMatch.tmdbId);
          const enrichedPerson = personDetails || tmdbMatch;
          
          actor = await Actor.findOrCreateFromTMDB(enrichedPerson);
          
          // Fallback: Nếu TMDB không có ảnh hoặc biography, thử Wikipedia
          const config = require('../config');
          if (WikipediaService.enabled && config.wikipedia?.fallbackToWikiOnTMDBFail) {
            const needsMoreInfo = !enrichedPerson.profilePath && !enrichedPerson.biography;
            if (needsMoreInfo) {
              try {
                const wikiData = await WikipediaService.getActorData(name);
                if (wikiData && wikiData.profileImage) {
                  // Cập nhật Wikipedia data nếu TMDB thiếu
                  if (!actor.profileImage) {
                    actor.profileImage = wikiData.profileImage;
                  }
                  if (!actor.biography && wikiData.extract) {
                    actor.biography = wikiData.extract;
                  }
                  await actor.save();
                  logger.info(`[Wiki] ✅ Enriched actor from Wikipedia: ${name}`);
                }
              } catch (wikiErr) {
                logger.debug(`[Wiki] Wikipedia fallback failed for ${name}: ${wikiErr.message}`);
              }
            }
          }
          
          actorRecords.push({
            actorId: actor._id,
            characterName: tmdbMatch.characterName || '',
            order: tmdbMatch.order ?? i,
            source: 'tmdb',
            isMain: i < 5
          });
        } else {
          // Không match TMDB → thử Wikipedia trước (để lấy ảnh)
          let wikiData = null;
          if (WikipediaService.enabled) {
            try {
              wikiData = await WikipediaService.getActorData(name);
            } catch (err) {
              logger.debug(`[Wiki] Search failed for actor: ${name}`);
            }
          }
          
          if (wikiData) {
            actor = await Actor.findOrCreateFromWikipedia(wikiData);
            logger.info(`[Wiki] ✅ Created actor from Wikipedia: ${name}`);
          } else {
            // Không có cả TMDB và Wikipedia → tạo actor bình thường (chỉ có tên)
            actor = await Actor.findOrCreate(name.trim());
          }
          actorRecords.push({
            actorId: actor._id,
            order: i,
            source: wikiData ? 'wikipedia' : sourceName,
            isMain: i < 5
          });
        }
      } catch (err) {
        logger.warn(`Failed to create actor ${name}: ${err.message}`);
      }
    }

    if (actorRecords.length > 0) {
      await MovieActor.setActors(movieId, actorRecords);
    }

    return actorRecords.length;
  }

  /**
   * Process actors từ TMDB credits (khi crawler không có actorNames)
   */
  async _processActorsFromTMDB(movieId, tmdbCast, sourceName) {
    const actorRecords = [];

    for (const tmdbPerson of tmdbCast.slice(0, 20)) { // Giới hạn 20 diễn viên
      try {
        // Fetch chi tiết biography/ngày sinh (optional, có thể bỏ để tăng tốc)
        const personDetails = await TMDBService.getPersonDetails(tmdbPerson.tmdbId);
        const enrichedPerson = personDetails || tmdbPerson;

        const actor = await Actor.findOrCreateFromTMDB(enrichedPerson);
        actorRecords.push({
          actorId: actor._id,
          characterName: tmdbPerson.characterName || '',
          order: tmdbPerson.order ?? 0,
          source: 'tmdb',
          isMain: tmdbPerson.order < 5
        });
      } catch (err) {
        logger.warn(`Failed to create actor from TMDB ${tmdbPerson.name}: ${err.message}`);
      }
    }

    if (actorRecords.length > 0) {
      await MovieActor.setActors(movieId, actorRecords);
    }

    return actorRecords.length;
  }

  /**
   * Process Directors: Create master data + junction table
   * UPDATED: Ưu tiên dùng TMDB credits (có ảnh, biography) nếu có
   *         Fallback sang Wikipedia nếu TMDB thiếu ảnh/biography
   */
  async _processDirectors(movieId, directorNames, sourceName, tmdbDirectors = null) {
    if (!directorNames || directorNames.length === 0) {
      // Nếu không có directorNames từ crawler nhưng có tmdbDirectors, dùng TMDB
      if (tmdbDirectors && tmdbDirectors.length > 0) {
        return await this._processDirectorsFromTMDB(movieId, tmdbDirectors, sourceName);
      }
      return 0;
    }

    const directorRecords = [];

    for (let i = 0; i < directorNames.length; i++) {
      const name = directorNames[i];
      if (!name || typeof name !== 'string') continue;

      try {
        let director;
        
        // Tìm match trong tmdbDirectors theo tên
        const tmdbMatch = tmdbDirectors?.find(d => 
          d.name.toLowerCase() === name.trim().toLowerCase()
        );

        if (tmdbMatch) {
          // Có match TMDB → enrich với ảnh, biography
          const personDetails = await TMDBService.getPersonDetails(tmdbMatch.tmdbId);
          const enrichedPerson = personDetails || tmdbMatch;
          
          director = await Director.findOrCreateFromTMDB(enrichedPerson);
          
          // Fallback: Nếu TMDB không có ảnh hoặc biography, thử Wikipedia
          const config = require('../config');
          if (WikipediaService.enabled && config.wikipedia?.fallbackToWikiOnTMDBFail) {
            const needsMoreInfo = !enrichedPerson.profilePath && !enrichedPerson.biography;
            if (needsMoreInfo) {
              try {
                const wikiData = await WikipediaService.getDirectorData(name);
                if (wikiData && wikiData.profileImage) {
                  if (!director.profileImage) {
                    director.profileImage = wikiData.profileImage;
                  }
                  if (!director.biography && wikiData.extract) {
                    director.biography = wikiData.extract;
                  }
                  await director.save();
                  logger.info(`[Wiki] ✅ Enriched director from Wikipedia: ${name}`);
                }
              } catch (wikiErr) {
                logger.debug(`[Wiki] Wikipedia fallback failed for director ${name}: ${wikiErr.message}`);
              }
            }
          }
          
          directorRecords.push({
            directorId: director._id,
            order: i,
            source: 'tmdb',
            isMain: true
          });
        } else {
          // Không match TMDB → thử Wikipedia trước (để lấy ảnh)
          let wikiData = null;
          if (WikipediaService.enabled) {
            try {
              wikiData = await WikipediaService.getDirectorData(name);
            } catch (err) {
              logger.debug(`[Wiki] Search failed for director: ${name}`);
            }
          }
          
          if (wikiData) {
            director = await Director.findOrCreateFromWikipedia(wikiData);
            logger.info(`[Wiki] ✅ Created director from Wikipedia: ${name}`);
          } else {
            // Không có cả TMDB và Wikipedia → tạo director bình thường (chỉ có tên)
            director = await Director.findOrCreate(name.trim());
          }
          directorRecords.push({
            directorId: director._id,
            order: i,
            source: wikiData ? 'wikipedia' : sourceName,
            isMain: true
          });
        }
      } catch (err) {
        logger.warn(`Failed to create director ${name}: ${err.message}`);
      }
    }

    if (directorRecords.length > 0) {
      await MovieDirector.setDirectors(movieId, directorRecords);
    }

    return directorRecords.length;
  }

  /**
   * Process directors từ TMDB credits (khi crawler không có directorNames)
   */
  async _processDirectorsFromTMDB(movieId, tmdbDirectors, sourceName) {
    const directorRecords = [];

    for (let i = 0; i < tmdbDirectors.length; i++) {
      const tmdbPerson = tmdbDirectors[i];
      
      try {
        const personDetails = await TMDBService.getPersonDetails(tmdbPerson.tmdbId);
        const enrichedPerson = personDetails || tmdbPerson;

        const director = await Director.findOrCreateFromTMDB(enrichedPerson);
        directorRecords.push({
          directorId: director._id,
          order: i,
          source: 'tmdb',
          isMain: true
        });
      } catch (err) {
        logger.warn(`Failed to create director from TMDB ${tmdbPerson.name}: ${err.message}`);
      }
    }

    if (directorRecords.length > 0) {
      await MovieDirector.setDirectors(movieId, directorRecords);
    }

    return directorRecords.length;
  }

  /**
   * Process Years: Create master data + junction table
   * Year có thể là number hoặc string
   */
  async _processYears(movieId, year, sourceName) {
    if (!year) return 0;
    
    // Parse year to integer
    const yearValue = typeof year === 'string' ? parseInt(year, 10) : year;
    if (!yearValue || isNaN(yearValue) || yearValue < 1900 || yearValue > 2100) {
      logger.warn(`Invalid year value: ${year}`);
      return 0;
    }

    try {
      // Year.findOrCreate accepts yearValue (number) directly
      const yearDoc = await Year.findOrCreate(yearValue);
      await MovieYear.setYear(movieId, yearDoc._id);
      return 1;
    } catch (err) {
      logger.warn(`Failed to create year ${yearValue}: ${err.message}`);
      return 0;
    }
  }

  /**
   * Process Formats: Create master data + junction table
   * Format/Quality ví dụ: 'HD', 'Full HD', 'Cam', 'Trailer'
   */
  async _processFormats(movieId, quality, sourceName) {
    if (!quality || typeof quality !== 'string') return 0;
    
    try {
      const qualityTrimmed = quality.trim();
      
      // Generate slug for format
      const slug = qualityTrimmed
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      
      // Format.findOrCreate accepts object {name, slug}
      const format = await Format.findOrCreate({
        name: qualityTrimmed,
        slug: slug
      });
      
      // MovieFormat uses addFormat(movieId, formatId) for single format
      await MovieFormat.addFormat(movieId, format._id);
      return 1;
    } catch (err) {
      logger.warn(`Failed to create format ${quality}: ${err.message}`);
      return 0;
    }
  }

  /**
   * Update episodes cho movie đã tồn tại
   * Merge episodes mới với episodes cũ
   */
  async updateEpisodes(movieId, newEpisodes) {
    if (!newEpisodes || newEpisodes.length === 0) {
      return { changed: false, added: 0 };
    }

    const movie = await Movie.findById(movieId);
    if (!movie) {
      throw new Error(`Movie not found: ${movieId}`);
    }

    const existingEpisodes = movie.episodes || [];
    let added = 0;
    let changed = false;

    // Merge episodes by server_name
    for (const newServer of newEpisodes) {
      const existingServer = existingEpisodes.find(s => s.server_name === newServer.server_name);

      if (!existingServer) {
        // New server - add all episodes
        existingEpisodes.push(newServer);
        added += newServer.server_data.length;
        changed = true;
      } else {
        // Existing server - merge episodes
        for (const newEp of newServer.server_data) {
          const exists = existingServer.server_data.some(ep => ep.slug === newEp.slug);
          if (!exists) {
            existingServer.server_data.push(newEp);
            added++;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      movie.episodes = existingEpisodes;
      await movie.save();
    }

    return { changed, added };
  }

  /**
   * Lấy movie với đầy đủ relationships (populate)
   */
  async getMovieWithRelations(movieId) {
    const movie = await Movie.findById(movieId).lean();
    if (!movie) return null;

    return movie;
  }
}

module.exports = new MovieService();
