/**
 * MovieService - Business Logic Layer
 * 
 * Persist movies to the database with full relationships:
 * - Movies (main table)
 * - Categories (master data) + MovieCategory (junction)
 * - Countries (master data) + MovieCountry (junction)
 * - Actors (master data) + MovieActor (junction)
 * - Directors (master data) + MovieDirector (junction)
 * 
 * Senior Backend Developer Best Practices:
 * - Transaction support for data consistency
 * - Upsert strategy with duplicate handling
 * - Normalized relationships (junction tables)
 * - Proper error handling and rollback
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
const ActorService = require('./ActorService');
const DirectorService = require('./DirectorService');
const WikidataService = require('./WikidataService');
const logger = require('../utils/logger');

// ============================================================================
// PER-MOVIE SAVE LOCK (dedupe)
//
// Problem: the same movie can exist on MULTIPLE sources (OPhim + KKPhim + Nguonc).
// Each time CrawlerService calls saveMovie() for the same slug, the trailer gets processed again
// (observed: "Nhu Da Hen" was processed 3 times in 3 consecutive seconds).
//
// This lock guarantees: the same slug is saved only ONCE at a time.
// Calls 2+ get back the in-flight result (deduped promise).
// ============================================================================
const saveInFlight = new Map(); // slug -> Promise

class MovieService {
  /**
   * Save or update a movie with full relationships.
   *
   * THIS IS A DEDUPED WRAPPER: if the same slug is already being processed, this call
   * receives the in-flight Promise instead of re-processing (avoids duplicate work).
   * With `force=true`, skip dedupe (for admin/manual use).
   *
   * @param {Object} movieData - Data from crawler (OPhim/KKPhim/Nguonc format)
   * @param {string} sourceName - Name of crawl source
   * @param {boolean} enrichWithTMDB - Enrich data with TMDB (default: true)
   * @param {Object} [opts]
   * @param {boolean} [opts.force=false] Bypass dedupe lock
   * @returns {Promise<Object>} { movie, isNew, categoriesAdded, countriesAdded, actorsAdded, directorsAdded }
   */
  async saveMovie(movieData, sourceName = 'unknown', enrichWithTMDB = true, opts = {}) {
    const force = !!opts.force;
    const slug = String(movieData?.slug || movieData?.sourceId || '').trim();

    // No slug -> cannot dedupe, run directly
    if (!slug || force) {
      return this._saveMovieInternal(movieData, sourceName, enrichWithTMDB);
    }

    // This slug is already being processed -> return in-flight result
    if (saveInFlight.has(slug)) {
      logger.debug(
        `[MovieService] ⏭ DEDUPED save for "${slug}" — already in-flight, reusing result`
      );
      return saveInFlight.get(slug);
    }

    // Not yet processed -> create promise and store in map
    const promise = this._saveMovieInternal(movieData, sourceName, enrichWithTMDB)
      .finally(() => {
        saveInFlight.delete(slug);
      });

    saveInFlight.set(slug, promise);
    return promise;
  }

  /**
   * Real body of saveMovie (NO dedupe).
   * @private
   */
  async _saveMovieInternal(movieData, sourceName, enrichWithTMDB) {
    try {
      // 0. Enrich data with TMDB if enabled
      let enrichedData = movieData;
      let tmdbCredits = null;
      
      if (enrichWithTMDB && TMDBService.enabled) {
        enrichedData = await TMDBService.enrichMovieData(movieData);
        
        // Fetch credits (cast/directors) from TMDB if tmdbId is present
        const tmdbId = enrichedData.tmdb?.id;
        if (tmdbId) {
          tmdbCredits = await TMDBService.getMovieCredits(parseInt(tmdbId, 10));
        }
      }

      // 1. Transform data from crawler format to backend schema
      const transformedData = this._transformMovieData(enrichedData, sourceName);

      // Check existing movie to preserve previous trailer (if any)
      const existingMovie = await Movie.findOne({
        $or: [
          { slug: transformedData.slug },
          { source: sourceName, sourceId: transformedData.sourceId }
        ]
      }).select('trailer').lean();

      // If input has no new trailer AND existing movie has a trailer -> keep existing
      // If input has a new trailer -> use new trailer
      // If neither -> leave it (will be fetched separately in step 4)
      // Rule: "valid" trailer = has non-empty key or url
      const inputHasValidTrailer =
        transformedData.trailer &&
        ((transformedData.trailer.key && String(transformedData.trailer.key).trim() !== '') ||
          (transformedData.trailer.url && String(transformedData.trailer.url).trim() !== ''));
      const existingHasValidTrailer =
        existingMovie?.trailer &&
        ((existingMovie.trailer.key && String(existingMovie.trailer.key).trim() !== '') ||
          (existingMovie.trailer.url && String(existingMovie.trailer.url).trim() !== ''));

      if (!inputHasValidTrailer && existingHasValidTrailer) {
        // Keep existing trailer: drop trailer field from transformedData to avoid overwriting
        delete transformedData.trailer;
        // tmdb.trailer_url is preserved too (not overwritten)
        if (transformedData.tmdb) {
          delete transformedData.tmdb.trailer_url;
        }
      } else if (!inputHasValidTrailer) {
        // No existing nor new trailer: remove so step 4 will fetch
        delete transformedData.trailer;
      }

      // SAFETY NET (requirements #4/#5): NEVER write trailer = null to DB.
      // If movie has a valid trailer and the new request cannot find one -> keep the existing trailer.
      // If movie has no trailer -> leave field absent so step 4 can fill it later.
      // ONLY update the `trailer` field when input has a VALID trailer (non-empty key or url).
      if (!inputHasValidTrailer) {
        delete transformedData.trailer;
        if (transformedData.tmdb && !transformedData.tmdb.trailer_url) {
          delete transformedData.tmdb.trailer_url;
        }
      }

      // 2. Upsert Movie (lookup by slug or sourceId)
      // Use $set to update only new fields, keeping existing fields (view, rating, trailer...)
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
      // Wrap in try/catch so one bad actor does not roll back the entire movie save.
      let actorsAdded = 0;
      try {
        actorsAdded = await this._processActors(movie._id, enrichedData.actor || [], sourceName, tmdbCredits?.cast);
      } catch (actorErr) {
        logger.warn(`[MovieService] _processActors threw for movieId=${movie._id}, continuing: ${actorErr.message}`);
      }
      let directorsAdded = 0;
      try {
        directorsAdded = await this._processDirectors(movie._id, enrichedData.director || [], sourceName, tmdbCredits?.directors);
      } catch (dirErr) {
        logger.warn(`[MovieService] _processDirectors threw for movieId=${movie._id}, continuing: ${dirErr.message}`);
      }
      
      const yearsAdded = await this._processYears(movie._id, enrichedData.year, sourceName);
      const formatsAdded = await this._processFormats(movie._id, enrichedData.quality, sourceName);

      // 4. Fetch trailer if a REAL one (with key) is missing
      // - Trailer field missing -> fetch
      // - Null trailer (no key) -> fetch (chance to retry when YouTube recovers)
      // - Real trailer (key='abc123' or valid url) -> skip
      // ⭐ Trailer is fetched ONLY from YouTube Data API v3 (requirement #1).
      // NO TMDB fallback. YouTube 429 / circuit OPEN only affect the trailer
      // of that specific movie, NEVER blocking the pipeline or crashing the import.
      // SAFETY - Movie with a valid trailer (key or url) does NOT call YouTube again
      // to avoid overwriting or setting null when YouTube fails.
      let trailerResult = null;
      const hasValidTrailer =
        movie.trailer &&
        ((movie.trailer.key && String(movie.trailer.key).trim() !== '') ||
          (movie.trailer.url && String(movie.trailer.url).trim() !== ''));

      // ⭐ Yêu cầu #1: KHÔNG gọi YouTube khi đang trong cooldown / đã xác nhận NOT_FOUND.
      // Tránh spam API và tránh hiển thị "trailer=null" do schema default.
      if (hasValidTrailer) {
        logger.debug(
          `[MovieService] Skip trailer fetch for "${movie.name}" - ` +
          `existing valid trailer (key=${movie.trailer.key || '(empty)'}, url=${movie.trailer.url || '(empty)'})`
        );
      } else if (
        movie.trailerJobStatus === 'RATE_LIMITED' &&
        movie.trailerRetryAt &&
        new Date(movie.trailerRetryAt).getTime() > Date.now()
      ) {
        // Đang cooldown — không gọi YouTube, để batch job retry sau
        const untilIso = new Date(movie.trailerRetryAt).toISOString();
        const remainingSec = Math.round((new Date(movie.trailerRetryAt).getTime() - Date.now()) / 1000);
        logger.info(
          `[MovieService] Skip trailer fetch for "${movie.name}" - ` +
          `RATE_LIMITED, retry at ${untilIso} (~${remainingSec}s)`
        );
        trailerResult = {
          trailer: null,
          status: 'RATE_LIMITED',
          saved: false,
          retryAt: new Date(movie.trailerRetryAt),
          source: null,
          skipped: true,
          skipReason: 'DB_COOLDOWN',
        };
      } else if (movie.trailerJobStatus === 'NOT_FOUND') {
        // Đã xác nhận không có trailer — không tốn quota gọi lại
        logger.debug(
          `[MovieService] Skip trailer fetch for "${movie.name}" - ` +
          `trailerJobStatus=NOT_FOUND (already searched, no trailer on YouTube)`
        );
      } else {
        try {
          trailerResult = await TrailerService.getTrailer(movie);
        } catch (error) {
          logger.warn(`[MovieService] Failed to fetch trailer for ${movie.name}: ${error.message}`);
        }
      }

      // Sync the in-memory document after TrailerService writes to MongoDB,
      // so the "Created/Updated movie" log reflects the ACTUAL persisted state
      // (TrailerService.updateOne() does not mutate this object).
      if (trailerResult?.status === 'FOUND' && trailerResult.trailer?.key) {
        const persisted = await Movie.findOne({ _id: movie._id })
          .select('trailer')
          .lean();
        if (persisted?.trailer?.key) {
          movie.trailer = persisted.trailer;
        } else {
          logger.warn(
            `[MovieService] Trailer reported FOUND but not persisted for ${movie.slug} - ` +
            `re-applying`
          );
          // updateOne may not match due to protective filter -> re-save with save()
          movie.trailer = trailerResult.trailer;
          movie.set('trailerJobStatus', 'OK');
          movie.set('trailerRetryAt', null);
          try {
            await movie.save();
          } catch (saveErr) {
            logger.error(
              `[MovieService] Failed to persist trailer for ${movie.slug}: ${saveErr.message}`
            );
          }
        }
      }

      logger.info(
        `${isNew ? 'Created' : 'Updated'} movie: ${movie.name} (${movie.slug}) ` +
        `[Cat: ${categoriesAdded}, Coun: ${countriesAdded}, Act: ${actorsAdded}, Dir: ${directorsAdded}, Year: ${yearsAdded}, Fmt: ${formatsAdded}` +
        `${trailerResult?.status === 'FOUND' ? `, Trailer: ✅FOUND(${trailerResult.source})` :
          trailerResult?.status === 'RATE_LIMITED' ?
            (trailerResult.skipReason === 'DB_COOLDOWN'
              ? `, Trailer: ⏸RATE_LIMITED (cooldown, retry at ${new Date(trailerResult.retryAt).toISOString()})`
              : `, Trailer: ⏸RATE_LIMITED (${trailerResult.code || 'COOLDOWN'}, retry at ${new Date(trailerResult.retryAt).toISOString()})`) :
          trailerResult?.status === 'NOT_FOUND' ? ', Trailer: ⬜NOT_FOUND' :
          trailerResult?.status === 'SKIPPED' ? `, Trailer: ⏭SKIPPED (${trailerResult.skipReason || 'dedupe'})` :
          ', Trailer: ⏸RETRY_PENDING'}]`
      );

      return { movie, isNew, categoriesAdded, countriesAdded, actorsAdded, directorsAdded, yearsAdded, formatsAdded, trailerResult };

    } catch (error) {
      logger.error(`Failed to save movie ${movieData.slug}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Transform data from crawler format to backend schema
   * NOTE: category/country are no longer stored on Movie schema (now normalized)
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
   * Parse release date from multiple sources
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
 * UPDATED: Prefer TMDB credits (with photo, character) when available
 *         Fallback to Wikipedia if TMDB is missing photo/biography
 *
 * RULES (per requirements):
 *   - One failed actor MUST NOT fail the whole movie
 *   - source="wikidata" must be preserved as-is, never converted
 *   - Validation error on MovieActor only skips that record, continues with others
 */
async _processActors(movieId, actorNames, sourceName, tmdbCast = null) {
    if (!actorNames || actorNames.length === 0) {
      // No actorNames from crawler but tmdbCast exists -> use TMDB
      if (tmdbCast && tmdbCast.length > 0) {
        return await this._processActorsFromTMDB(movieId, tmdbCast, sourceName);
      }
      return 0;
    }

    const actorRecords = [];
    const logger = require('../utils/logger');

    for (let i = 0; i < actorNames.length; i++) {
      const name = actorNames[i];
      if (!name || typeof name !== 'string') continue;

      // Wrap EACH actor in try/catch - one bad actor does not crash the movie
      try {
        let actor;

        // Match in tmdbCast by name (case-insensitive)
        const tmdbMatch = tmdbCast?.find(c =>
          c.name.toLowerCase() === name.trim().toLowerCase()
        );

        if (tmdbMatch) {
          // TMDB match -> enrich with photo, biography (fetch details if needed)
          let enrichedPerson = tmdbMatch;
          try {
            const personDetails = await TMDBService.getPersonDetails(tmdbMatch.tmdbId);
            enrichedPerson = personDetails || tmdbMatch;
          } catch (tmdbErr) {
            logger.debug(`[TMDB] getPersonDetails failed for ${name}: ${tmdbErr.message}`);
          }

          actor = await Actor.findOrCreateFromTMDB(enrichedPerson);

          // Fallback: if TMDB lacks photo or biography, try Wikipedia -> Wikidata
          const config = require('../config');
          if (WikipediaService.enabled && config.wikipedia?.fallbackToWikiOnTMDBFail) {
            const needsMoreInfo = !enrichedPerson.profilePath && !enrichedPerson.biography;
            if (needsMoreInfo) {
              try {
                const wikiData = await WikipediaService.getActorData(name);
                if (wikiData && wikiData.profileImage) {
                  if (!actor.profileImage) actor.profileImage = wikiData.profileImage;
                  if (!actor.biography && wikiData.extract) actor.biography = wikiData.extract;
                  await actor.save();
                  logger.info(`[Wiki] ✅ Enriched actor from Wikipedia: ${name}`);
                }
              } catch (wikiErr) {
                logger.debug(`[Wiki] Wikipedia fallback failed for ${name}: ${wikiErr.message}`);
              }
            }
          }

          // Wikidata fallback if actor still lacks photo/gender
          if (
            WikidataService.enabled &&
            (!actor.profileImage || !actor.gender || actor.gender === 'unknown')
          ) {
            try {
              const wkActor = await ActorService.enrichWithWikidata(name);
              if (wkActor && wkActor._id) {
                const fresh = await Actor.findById(actor._id);
                if (fresh) actor = fresh;
                logger.info(`[Wikidata] ✅ Enriched actor from Wikidata: ${name}`);
              }
            } catch (wdErr) {
              logger.debug(`[Wikidata] fallback failed for ${name}: ${wdErr.message}`);
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
          // No TMDB match -> try Wikipedia first (to grab photo)
          let wikiData = null;
          if (WikipediaService.enabled) {
            try {
              wikiData = await WikipediaService.getActorData(name);
            } catch (err) {
              logger.debug(`[Wiki] Search failed for actor: ${name}`);
            }
          }

          // resolvedSource defaults to crawler source (ophim/kkphim/...)
          // Will be overridden if Wikipedia or Wikidata returns a result
          let resolvedSource = sourceName;
          if (wikiData) {
            actor = await Actor.findOrCreateFromWikipedia(wikiData);
            logger.info(`[Wiki] ✅ Created actor from Wikipedia: ${name}`);
            resolvedSource = 'wikipedia';
          } else if (WikidataService.enabled) {
            // Fallback: try Wikidata (priority: TMDB -> Wikipedia -> Wikidata)
            try {
              const wkActor = await ActorService.enrichWithWikidata(name);
              if (wkActor && wkActor._id) {
                actor = wkActor;
                resolvedSource = 'wikidata'; // <- preserve as-is, never convert
                logger.info(`[Wikidata] ✅ Created actor from Wikidata: ${name}`);
              }
            } catch (wdErr) {
              logger.debug(`[Wikidata] fallback failed for ${name}: ${wdErr.message}`);
            }
          }

          if (!actor) {
            // No TMDB, Wikipedia or Wikidata -> create actor with just the name
            actor = await Actor.findOrCreate(name.trim());
          }
          actorRecords.push({
            actorId: actor._id,
            order: i,
            source: resolvedSource,
            isMain: i < 5
          });
        }
      } catch (err) {
        // DO NOT throw - log warning and continue to next actor/movie
        logger.warn(`[MovieService] Failed to create actor "${name}" (skipped): ${err.message}`);
      }
    }

    if (actorRecords.length > 0) {
      // setActors has try/catch + ordered:false internally, but still wrap for safety
      try {
        await MovieActor.setActors(movieId, actorRecords);
      } catch (err) {
        logger.warn(`[MovieService] setActors failed for movieId=${movieId}: ${err.message}`);
      }
    }

    return actorRecords.length;
  }

  /**
   * Process actors from TMDB credits (when crawler has no actorNames)
   * RULE: each actor in its own try/catch -> one bad actor does not crash movie.
   */
  async _processActorsFromTMDB(movieId, tmdbCast, sourceName) {
    const actorRecords = [];
    const logger = require('../utils/logger');

    for (const tmdbPerson of tmdbCast.slice(0, 20)) { // Limit 20 actors
      try {
        // Fetch detailed biography/birthday (optional, can skip for speed)
        let enrichedPerson = tmdbPerson;
        try {
          const personDetails = await TMDBService.getPersonDetails(tmdbPerson.tmdbId);
          enrichedPerson = personDetails || tmdbPerson;
        } catch (tmdbErr) {
          logger.debug(`[TMDB] getPersonDetails failed for ${tmdbPerson.name}: ${tmdbErr.message}`);
        }

        const actor = await Actor.findOrCreateFromTMDB(enrichedPerson);

        // Wikidata fallback if actor still lacks photo/gender
        if (
          WikidataService.enabled &&
          (!actor.profileImage || !actor.gender || actor.gender === 'unknown')
        ) {
          try {
            const wkActor = await ActorService.enrichWithWikidata(tmdbPerson.name);
            if (wkActor && wkActor._id) {
              const fresh = await Actor.findById(actor._id);
              if (fresh) actor = fresh;
              logger.info(`[Wikidata] ✅ Enriched actor from Wikidata: ${tmdbPerson.name}`);
            }
          } catch (wdErr) {
            logger.debug(`[Wikidata] fallback failed for ${tmdbPerson.name}: ${wdErr.message}`);
          }
        }

        actorRecords.push({
          actorId: actor._id,
          characterName: tmdbPerson.characterName || '',
          order: tmdbPerson.order ?? 0,
          source: 'tmdb',
          isMain: tmdbPerson.order < 5
        });
      } catch (err) {
        // one failed actor does not crash movie
        logger.warn(`[MovieService] Failed to create actor from TMDB "${tmdbPerson.name}" (skipped): ${err.message}`);
      }
    }

    if (actorRecords.length > 0) {
      try {
        await MovieActor.setActors(movieId, actorRecords);
      } catch (err) {
        logger.warn(`[MovieService] setActors failed for movieId=${movieId}: ${err.message}`);
      }
    }

    return actorRecords.length;
  }

  /**
   * Process Directors: Create master data + junction table
   * UPDATED: Prefer TMDB credits (with photo, biography) when available
   *         Fallback to Wikipedia if TMDB is missing photo/biography
   *         Final fallback: Wikidata (for both TMDB-match and direct-name path)
   *
   * RULES (per requirements):
   *   - One director error MUST NOT fail the whole movie
   *   - source="wikidata" must be preserved as-is, never converted
   *   - Validation error on MovieDirector only skips that record, continues with others
   */
  async _processDirectors(movieId, directorNames, sourceName, tmdbDirectors = null) {
    if (!directorNames || directorNames.length === 0) {
      // No directorNames from crawler but tmdbDirectors exists -> use TMDB
      if (tmdbDirectors && tmdbDirectors.length > 0) {
        return await this._processDirectorsFromTMDB(movieId, tmdbDirectors, sourceName);
      }
      return 0;
    }

    const directorRecords = [];
    const config = require('../config');

    for (let i = 0; i < directorNames.length; i++) {
      const name = directorNames[i];
      if (!name || typeof name !== 'string') continue;

      // Wrap EACH director in try/catch - one bad director does not crash movie
      try {
        let director;

        // Match in tmdbDirectors by name (case-insensitive)
        const tmdbMatch = tmdbDirectors?.find(d =>
          d.name.toLowerCase() === name.trim().toLowerCase()
        );

        if (tmdbMatch) {
          // TMDB match -> enrich with photo, biography
          let enrichedPerson = tmdbMatch;
          try {
            const personDetails = await TMDBService.getPersonDetails(tmdbMatch.tmdbId);
            enrichedPerson = personDetails || tmdbMatch;
          } catch (tmdbErr) {
            logger.debug(`[TMDB] getPersonDetails failed for director ${name}: ${tmdbErr.message}`);
          }

          director = await Director.findOrCreateFromTMDB(enrichedPerson);

          // Fallback: if TMDB lacks photo or biography, try Wikipedia
          if (WikipediaService.enabled && config.wikipedia?.fallbackToWikiOnTMDBFail) {
            const needsMoreInfo = !enrichedPerson.profilePath && !enrichedPerson.biography;
            if (needsMoreInfo) {
              try {
                const wikiData = await WikipediaService.getDirectorData(name);
                if (wikiData && wikiData.profileImage) {
                  if (!director.profileImage) director.profileImage = wikiData.profileImage;
                  if (!director.biography && wikiData.extract) director.biography = wikiData.extract;
                  await director.save();
                  logger.info(`[Wiki] ✅ Enriched director from Wikipedia: ${name}`);
                }
              } catch (wikiErr) {
                logger.debug(`[Wiki] Wikipedia fallback failed for director ${name}: ${wikiErr.message}`);
              }
            }
          }

          // Wikidata fallback if director still lacks photo/gender/dateOfBirth
          if (
            WikidataService.enabled &&
            (!director.profileImage || !director.gender || director.gender === 'unknown')
          ) {
            try {
              const wkDirector = await DirectorService.enrichWithWikidata(name);
              if (wkDirector && wkDirector._id) {
                const fresh = await Director.findById(director._id);
                if (fresh) director = fresh;
                logger.info(`[Wikidata] ✅ Enriched director from Wikidata: ${name}`);
              }
            } catch (wdErr) {
              logger.debug(`[Wikidata] fallback failed for director ${name}: ${wdErr.message}`);
            }
          }

          directorRecords.push({
            directorId: director._id,
            order: i,
            source: 'tmdb',
            isMain: true
          });
        } else {
          // No TMDB match -> try Wikipedia first (to grab photo)
          let wikiData = null;
          if (WikipediaService.enabled) {
            try {
              wikiData = await WikipediaService.getDirectorData(name);
            } catch (err) {
              logger.debug(`[Wiki] Search failed for director: ${name}`);
            }
          }

          // resolvedSource defaults to crawler source (ophim/kkphim/...)
          // Will be overridden if Wikipedia or Wikidata returns a result
          let resolvedSource = sourceName;
          if (wikiData) {
            director = await Director.findOrCreateFromWikipedia(wikiData);
            logger.info(`[Wiki] ✅ Created director from Wikipedia: ${name}`);
            resolvedSource = 'wikipedia';
          } else if (WikidataService.enabled) {
            // Final fallback: try Wikidata
            try {
              const wkDirector = await DirectorService.enrichWithWikidata(name);
              if (wkDirector && wkDirector._id) {
                director = wkDirector;
                resolvedSource = 'wikidata'; // <- preserve as-is, never convert
                logger.info(`[Wikidata] ✅ Created director from Wikidata: ${name}`);
              }
            } catch (wdErr) {
              logger.debug(`[Wikidata] fallback failed for director ${name}: ${wdErr.message}`);
            }
          }

          if (!director) {
            // No TMDB, Wikipedia or Wikidata -> create director with just the name
            director = await Director.findOrCreate(name.trim());
          }
          directorRecords.push({
            directorId: director._id,
            order: i,
            source: resolvedSource,
            isMain: true
          });
        }
      } catch (err) {
        // DO NOT throw - log warning and continue to next director/movie
        logger.warn(`[MovieService] Failed to create director "${name}" (skipped): ${err.message}`);
      }
    }

    if (directorRecords.length > 0) {
      try {
        await MovieDirector.setDirectors(movieId, directorRecords);
      } catch (err) {
        logger.warn(`[MovieService] setDirectors failed for movieId=${movieId}: ${err.message}`);
      }
    }

    return directorRecords.length;
  }

  /**
   * Process directors from TMDB credits (when crawler has no directorNames)
   * RULE: each director in its own try/catch -> one bad director does not crash movie.
   * Wikidata fallback: if director lacks photo/gender/dateOfBirth -> try to enrich.
   */
  async _processDirectorsFromTMDB(movieId, tmdbDirectors, sourceName) {
    const directorRecords = [];

    for (let i = 0; i < tmdbDirectors.length; i++) {
      const tmdbPerson = tmdbDirectors[i];

      try {
        let enrichedPerson = tmdbPerson;
        try {
          const personDetails = await TMDBService.getPersonDetails(tmdbPerson.tmdbId);
          enrichedPerson = personDetails || tmdbPerson;
        } catch (tmdbErr) {
          logger.debug(`[TMDB] getPersonDetails failed for director ${tmdbPerson.name}: ${tmdbErr.message}`);
        }

        const director = await Director.findOrCreateFromTMDB(enrichedPerson);

        // Wikidata fallback if director still lacks photo/gender/dateOfBirth
        if (
          WikidataService.enabled &&
          (!director.profileImage || !director.gender || director.gender === 'unknown')
        ) {
          try {
            const wkDirector = await DirectorService.enrichWithWikidata(tmdbPerson.name);
            if (wkDirector && wkDirector._id) {
              const fresh = await Director.findById(director._id);
              if (fresh) director = fresh;
              logger.info(`[Wikidata] ✅ Enriched director from Wikidata: ${tmdbPerson.name}`);
            }
          } catch (wdErr) {
            logger.debug(`[Wikidata] fallback failed for director ${tmdbPerson.name}: ${wdErr.message}`);
          }
        }

        directorRecords.push({
          directorId: director._id,
          order: i,
          source: 'tmdb',
          isMain: true
        });
      } catch (err) {
        logger.warn(`[MovieService] Failed to create director from TMDB "${tmdbPerson.name}" (skipped): ${err.message}`);
      }
    }

    if (directorRecords.length > 0) {
      try {
        await MovieDirector.setDirectors(movieId, directorRecords);
      } catch (err) {
        logger.warn(`[MovieService] setDirectors failed for movieId=${movieId}: ${err.message}`);
      }
    }

    return directorRecords.length;
  }

  /**
   * Process Years: Create master data + junction table
   * Year can be number or string
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
   * Format/Quality examples: 'HD', 'Full HD', 'Cam', 'Trailer'
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
   * Update episodes for an existing movie
   * Merge new episodes with existing ones
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
   * Get movie with full relationships (populate)
   */
  async getMovieWithRelations(movieId) {
    const movie = await Movie.findById(movieId).lean();
    if (!movie) return null;

    return movie;
  }
}

module.exports = new MovieService();
