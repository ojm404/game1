/**
 * daily-puzzle.js
 *
 * Meant to run once a day via GitHub Actions (see
 * .github/workflows/daily-puzzle.yml), not on your own machine on demand,
 * though you can run it manually with `TMDB_KEY=xxx node daily-puzzle.js`
 * to test it.
 *
 * Unlike build-graph.js (which crawls a huge actor pool up front and ships
 * the whole graph), this script does the opposite: it picks two actors,
 * then explores outward from both live against TMDB, stopping the moment
 * the two searches meet. The only data that ends up in the output is
 * whatever the search actually touched — typically a few hundred actors
 * and movies, not thousands. That keeps the daily output small (usually
 * well under 500KB) and keeps the TMDB key server-side the whole time,
 * since this runs in GitHub's Actions runner, never in a visitor's browser.
 *
 * Output: out/puzzle-data.js — a single JS file that just assigns to
 * window.SIX_DEGREES_DATA. game.html loads it with a <script src="...">
 * tag (see the comment at the bottom of this file), so there's no fetch(),
 * no CORS to worry about, and nothing to host except this one file.
 *
 * Same Marvel/keyword/non-fiction filters as build-graph.js. If you change
 * those in build-graph.js, mirror the change here too — they're kept
 * separate on purpose so this script has no dependency on the other one,
 * but that does mean they can drift if you only update one.
 */

const fs = require("fs");
const path = require("path");

const TMDB_KEY = process.env.TMDB_KEY;
if (!TMDB_KEY) {
  console.error("Set TMDB_KEY in the environment before running this script.");
  process.exit(1);
}

const CONFIG = {
  baseUrl: "https://api.themoviedb.org/3",
  outDir: path.join(__dirname, "out"),

  maxCastPerMovie: 20,

  excludedGenreIds: new Set([99]), // Documentary

  selfAppearancePattern:
    /^(self|himself|herself|themselves|host|presenter|narrator|interviewee|archive footage)\b/i,

  marvelCompanyIds: new Set([420, 7505]),
  excludedKeywordIds: new Set([180547]),

  excludedMovieIds: new Set([
  ]),

  minPopularity: 3,
  minVoteCount: 50,
  allowUnreleasedMovies: false,

  seedActorNames: [
    "Tom Hanks", "Meryl Streep", "Denzel Washington", "Julia Roberts",
    "Leonardo DiCaprio", "Kate Winslet", "Brad Pitt", "Cate Blanchett",
    "Samuel L. Jackson", "Nicole Kidman", "Will Smith", "Charlize Theron",
    "Matt Damon", "Scarlett Johansson", "George Clooney", "Sandra Bullock",
    "Morgan Freeman", "Emma Stone", "Christian Bale", "Viola Davis",
    "Henry Cavill", "Julia Stiles", "Kurt Russell", "James Spader",
    "Jennifer Lawrence", "Chris Pine", "Simon Pegg", "Zendaya",
    "Idris Elba", "Tom Cruise", "Penelope Cruz", "Javier Bardem",
    "Daniel Craig", "Kirsten Dunst", "Kristen Stewart", "Robert Pattinson",
    "Tom Hardy", "Anne Hathaway", "Chris Evans", "Chris Pratt",
    "Robert Downey Jr.", "Cillian Murphy", "Keanu Reeves", "Willem Defoe",
    "Nicolas Cage", "Oscar Isaac", "Anthony Hopkins", "Jodie Foster",
    "Hilary Swank", "Margot Robbie", "Helen Mirren", "Michael Caine",
    "Ryan Gosling", "Ben Affleck", "Emma Watson"
  ],

  minPairDistance: 2,
  maxPairDistance: 5,

  maxActorsExpanded: 400,

  minDiscoveredMovies: 500,
  maxDiscoveredMovies: 2000,

  maxLeafExpansions: 600,

  targetValidPairs: 1,

  maxAttempts: 8,

  requestsPerBatch: 20,
  batchPauseMs: 10_000,
  maxRetries: 5,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRateLimiter({ requestsPerBatch, batchPauseMs }) {
  let count = 0;
  return async function run(fn) {
    if (count > 0 && count % requestsPerBatch === 0) {
      console.log(`  ...pausing ${batchPauseMs}ms for TMDB rate limit`);
      await sleep(batchPauseMs);
    }
    count += 1;
    return fn();
  };
}
const limiter = makeRateLimiter(CONFIG);

const CACHE_DIR = path.join(__dirname, "cache");

function cachePathFor(urlPath) {
  const safe = urlPath.replace(/[^a-z0-9_-]/gi, "_");
  return path.join(CACHE_DIR, `${safe}.json`);
}

async function loadExcludedMovieIds() {
  const listUrl = "/list/27741?language=en-US";
  const file = cachePathFor(listUrl);
  let data;

  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    const url = `${CONFIG.baseUrl}${listUrl}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TMDB_KEY}` } });
    if (!res.ok) {
      throw new Error(`TMDB X-Men list request failed (${res.status}): ${url}`);
    }
    data = await res.json();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }

  const ids = (data.items || []).map((item) => item.id);
  for (const id of ids) CONFIG.excludedMovieIds.add(id);
}

async function tmdb(urlPath, attempt = 1) {
  const file = cachePathFor(urlPath);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  const url = `${CONFIG.baseUrl}${urlPath}`;
  return limiter(async () => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TMDB_KEY}` },
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt > CONFIG.maxRetries) {
        throw new Error(`TMDB request failed after ${CONFIG.maxRetries} retries (${res.status}): ${url}`);
      }
      const retryAfterHeader = res.headers.get("Retry-After");
      const waitMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : 2 ** attempt * 1000;
      console.log(
        `  TMDB returned ${res.status}, retrying in ${waitMs}ms (attempt ${attempt}/${CONFIG.maxRetries})`
      );
      await sleep(waitMs);
      return tmdb(urlPath, attempt + 1);
    }

    if (!res.ok) {
      const err = new Error(`TMDB request failed (${res.status}): ${url}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  });
}

function isMarvelMovie(movieDetails) {
  if (CONFIG.excludedMovieIds.has(movieDetails.id)) return true;

  const companyIds = (movieDetails.production_companies || []).map((c) => c.id);
  if (companyIds.some((id) => CONFIG.marvelCompanyIds.has(id))) return true;
  const keywordIds = ((movieDetails.keywords && movieDetails.keywords.keywords) || []).map(
    (k) => k.id
  );
  return keywordIds.some((id) => CONFIG.excludedKeywordIds.has(id));
}

function isNonFictionMovie(movieDetails) {
  const genreIds = (movieDetails.genres || []).map((g) => g.id);
  return genreIds.some((id) => CONFIG.excludedGenreIds.has(id));
}

function isUnpopularOrUnreleasedMovie(movieDetails) {
  if (!CONFIG.allowUnreleasedMovies && !movieDetails.release_date) {
    return true;
  }
  // Was `movieDetails.popularity && ... < minPopularity` — that short-
  // circuits to false when popularity is exactly 0, so the MOST obscure
  // movies (zero popularity, zero votes) slipped straight through while
  // slightly-less-obscure ones correctly got caught. Using ?? 0 instead
  // of a truthy guard means a missing/zero value is treated as exactly
  // that — zero — and compared honestly against the threshold.
  if ((movieDetails.popularity ?? 0) < CONFIG.minPopularity) {
    return true;
  }
  if ((movieDetails.vote_count ?? 0) < CONFIG.minVoteCount) {
    return true;
  }
  return false;
}

function isFictionalCastCredit(castMember) {
  const character = castMember.character || "";
  if (!character.trim()) return false;
  return !CONFIG.selfAppearancePattern.test(character.trim());
}

async function resolveActorId(name) {
  const data = await tmdb(`/search/person?query=${encodeURIComponent(name)}&language=en-US`);
  const match = (data.results || []).find((p) => p.known_for_department === "Acting");
  return match ? match.id : (data.results && data.results[0] && data.results[0].id);
}

function makeGraphCache() {
  return { actors: {}, movies: {} };
}

async function expandActor(actorId, cache) {
  if (cache.actors[actorId] && cache.actors[actorId]._expanded) {
    return { movieIds: cache.actors[actorId].movies };
  }

  let credits;
  try {
    credits = await tmdb(`/person/${actorId}/movie_credits?language=en-US`);
  } catch (err) {
    if (err.status === 404) {
      console.log(`  person ${actorId} returned 404 (likely merged on TMDB) — skipping`);
      cache.actors[actorId] = cache.actors[actorId] || { name: null, movies: [] };
      cache.actors[actorId].movies = [];
      cache.actors[actorId]._expanded = true;
      return { movieIds: [] };
    }
    throw err;
  }

  const movieIds = (credits.cast || [])
    .filter(isFictionalCastCredit)
    .map((c) => c.id);

  cache.actors[actorId] = cache.actors[actorId] || { name: null, movies: [] };
  cache.actors[actorId].movies = movieIds;
  cache.actors[actorId]._expanded = true;

  return { movieIds };
}

async function expandMovie(movieId, cache) {
  if (cache.movies[movieId] && cache.movies[movieId]._expanded) return cache.movies[movieId];

  let details;
  try {
    details = await tmdb(`/movie/${movieId}?language=en-US&append_to_response=credits,keywords`);
  } catch (err) {
    if (err.status === 404) {
      console.log(`  movie ${movieId} returned 404 (likely deleted/merged on TMDB) — skipping`);
      cache.movies[movieId] = { title: null, year: null, cast: [], _excluded: true, _expanded: true };
      return cache.movies[movieId];
    }
    throw err;
  }

  if (isMarvelMovie(details) || isNonFictionMovie(details) || isUnpopularOrUnreleasedMovie(details)) {
    cache.movies[movieId] = { title: details.title, year: null, cast: [], _excluded: true, _expanded: true };
    return cache.movies[movieId];
  }

  const cast = ((details.credits && details.credits.cast) || [])
    .filter(isFictionalCastCredit)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, CONFIG.maxCastPerMovie);

  for (const c of cast) {
    if (!cache.actors[c.id]) cache.actors[c.id] = { name: c.name, movies: [] };
    if (!cache.actors[c.id].name) cache.actors[c.id].name = c.name;
  }

  cache.movies[movieId] = {
    title: details.title,
    year: (details.release_date || "").slice(0, 4) || null,
    cast: cast.map((c) => c.id),
    _expanded: true,
  };
  return cache.movies[movieId];
}

async function bidirectionalSearch(startId, endId, cache) {
  let frontA = new Set([startId]);
  let frontB = new Set([endId]);
  const visitedA = new Set([startId]);
  const visitedB = new Set([endId]);
  let actorsExpanded = 0;
  let found = false;
  let connectDistance = null;
  let roundsElapsed = 0;

  cache.actors[startId] = cache.actors[startId] || { name: null, movies: [] };
  cache.actors[endId] = cache.actors[endId] || { name: null, movies: [] };

  while (frontA.size > 0 && frontB.size > 0) {
    roundsElapsed += 1;
    const expandingA = frontA.size <= frontB.size;
    const frontier = expandingA ? frontA : frontB;
    const visitedSame = expandingA ? visitedA : visitedB;
    const visitedOther = expandingA ? visitedB : visitedA;

    const next = new Set();

    for (const actorId of frontier) {
      if (actorsExpanded >= CONFIG.maxActorsExpanded) {
        return { found, connectDistance, cache };
      }
      // Was a raw Object.keys(cache.movies).length check — that counts
      // EXCLUDED movies too (Marvel, non-fiction, and now anything the
      // popularity/vote filters reject), so a high exclusion rate burns
      // through this budget on rejects rather than on actual playable
      // content. Counting only survivors makes the budget track what the
      // player will actually get.
      const survivingSoFar = Object.values(cache.movies).filter((m) => !m._excluded).length;
      if (survivingSoFar >= CONFIG.maxDiscoveredMovies) {
        console.log(
          `  hit maxDiscoveredMovies (${CONFIG.maxDiscoveredMovies}) during main search — stopping here`
        );
        return { found, connectDistance, cache };
      }
      actorsExpanded += 1;

      const { movieIds } = await expandActor(actorId, cache);
      for (const movieId of movieIds) {
        const movie = await expandMovie(movieId, cache);
        if (movie._excluded) continue;

        for (const coStarId of movie.cast) {
          if (visitedOther.has(coStarId) && !found) {
            found = true;
            connectDistance = roundsElapsed;
          }
          if (!visitedSame.has(coStarId)) {
            visitedSame.add(coStarId);
            next.add(coStarId);
          }
        }
      }
    }

    if (expandingA) frontA = next;
    else frontB = next;
  }

  return { found, connectDistance, cache };
}

function pickTwoRandom(list) {
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}

function buildDistractorMap(actors, movies) {
  const neighborIds = {};
  for (const actorId of Object.keys(actors)) {
    neighborIds[actorId] = new Set();
  }

  for (const movie of Object.values(movies)) {
    if (!movie || !Array.isArray(movie.cast)) continue;
    const cast = movie.cast;
    for (const actorId of cast) {
      for (const coStarId of cast) {
        if (actorId !== coStarId) {
          neighborIds[String(actorId)] = neighborIds[String(actorId)] || new Set();
          neighborIds[String(actorId)].add(Number(coStarId));
        }
      }
    }
  }

  const distractorMap = {};
  for (const [actorId, neighbors] of Object.entries(neighborIds)) {
    distractorMap[actorId] = Array.from(neighbors)
      .sort(() => Math.random() - 0.5)
      .slice(0, 6);
  }
  return distractorMap;
}

function trimCacheToVisited(cache) {
  const movies = {};
  for (const [id, m] of Object.entries(cache.movies)) {
    if (m._excluded) continue;
    movies[id] = { title: m.title, year: m.year, cast: m.cast };
  }
  const survivingMovieIds = new Set(Object.keys(movies).map(Number));

  const actors = {};
  for (const [id, a] of Object.entries(cache.actors)) {
    if (!a.name) continue;
    const survivingMovies = (a.movies || []).filter((movieId) =>
      survivingMovieIds.has(movieId)
    );
    actors[id] = { name: a.name, movies: survivingMovies };
  }

  const distractors = buildDistractorMap(actors, movies);
  for (const [id, actor] of Object.entries(actors)) {
    actor.distractors = distractors[id] || [];
  }

  return { actors, movies };
}

async function fillInLeafActors(cache) {
  let totalExpanded = 0;

  while (totalExpanded < CONFIG.maxLeafExpansions) {
    const survivingSoFar = Object.values(cache.movies).filter((m) => !m._excluded).length;
    if (survivingSoFar >= CONFIG.maxDiscoveredMovies) {
      console.log(
        `  hit maxDiscoveredMovies (${CONFIG.maxDiscoveredMovies}) during closure — stopping here`
      );
      break;
    }

    const unexpanded = Object.keys(cache.actors).filter(
      (id) => !cache.actors[id]._expanded
    );

    if (unexpanded.length === 0) {
      console.log("  graph fully closed — every reachable actor has real filmography data");
      return;
    }

    const remainingBudget = CONFIG.maxLeafExpansions - totalExpanded;
    const batch = unexpanded.slice(0, remainingBudget);
    console.log(
      `  closure round: expanding ${batch.length} actor(s) ` +
        `(${totalExpanded + batch.length}/${CONFIG.maxLeafExpansions} budget used)`
    );

    for (const actorId of batch) {
      const { movieIds } = await expandActor(actorId, cache);
      for (const movieId of movieIds) {
        await expandMovie(movieId, cache);
      }
      totalExpanded += 1;
    }
  }

  const stillUnexpanded = Object.keys(cache.actors).filter(
    (id) => !cache.actors[id]._expanded
  ).length;
  if (stillUnexpanded > 0) {
    console.log(
      `  closure ended with ${stillUnexpanded} actor(s) still unexpanded — ` +
        `those specific nodes may reject correct guesses if a player reaches them`
    );
  }
}

async function main() {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
  await loadExcludedMovieIds();

  let validPair = null;

  for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt++) {
    const [nameA, nameB] = pickTwoRandom(CONFIG.seedActorNames);
    console.log(`Attempt ${attempt}: trying ${nameA} <-> ${nameB}`);

    const [idA, idB] = await Promise.all([resolveActorId(nameA), resolveActorId(nameB)]);
    if (!idA || !idB || idA === idB) {
      console.log("  could not resolve both actors, trying a different pair");
      continue;
    }

    const cache = makeGraphCache();
    cache.actors[idA] = { name: nameA, movies: [] };
    cache.actors[idB] = { name: nameB, movies: [] };

    const { found, connectDistance } = await bidirectionalSearch(idA, idB, cache);

    if (!found) {
      console.log("  no connection found within the search budget, trying a different pair");
      continue;
    }

    if (connectDistance < CONFIG.minPairDistance) {
      console.log(
        `  connects too easily (${connectDistance} hop${connectDistance === 1 ? "" : "s"}, ` +
          `need at least ${CONFIG.minPairDistance}) — trying a different pair`
      );
      continue;
    }

    if (connectDistance > CONFIG.maxPairDistance) {
      console.log(
        `  connects too distantly (${connectDistance} hops, ` +
          `max ${CONFIG.maxPairDistance}) — trying a different pair`
      );
      continue;
    }

    console.log(`  true distance: ${connectDistance} hops — within range, accepting this pair`);

    await fillInLeafActors(cache);

    // minDiscoveredMovies wasn't actually checked anywhere before this —
    // it's a MINIMUM, so unlike maxDiscoveredMovies (which stops the
    // search early) this can only be enforced by rejecting the whole pair
    // after the search is done and trying again, the same way
    // minPairDistance rejects a pair that connects too easily. Counts
    // only surviving (non-excluded) movies, since that's what actually
    // ends up playable.
    const survivingMovieCount = Object.values(cache.movies).filter((m) => !m._excluded).length;
    if (survivingMovieCount < CONFIG.minDiscoveredMovies) {
      console.log(
        `  graph too small (${survivingMovieCount} surviving movies, need at least ` +
          `${CONFIG.minDiscoveredMovies}) — trying a different pair`
      );
      continue;
    }

    const { actors, movies } = trimCacheToVisited(cache);
    console.log(
      `  connected. Puzzle graph: ${Object.keys(actors).length} actors, ` +
        `${Object.keys(movies).length} movies.`
    );

    validPair = {
      a: idA,
      b: idB,
      actors,
      movies
    };
    break;
  }

  if (!validPair) {
    console.error(`Failed to generate a puzzle after ${CONFIG.maxAttempts} attempts.`);
    process.exit(1);
  }

  console.log(
    `\nGenerated puzzle: ${validPair.actors[validPair.a].name} <-> ${validPair.actors[validPair.b].name}`
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    a: validPair.a,
    b: validPair.b,
    actors: validPair.actors,
    movies: validPair.movies,
  };

  const js =
    `// Auto-generated by daily-puzzle.js — do not edit by hand.\n` +
    `// Regenerated daily by the GitHub Actions workflow.\n` +
    `window.SIX_DEGREES_DATA = ${JSON.stringify(payload)};\n`;

  fs.writeFileSync(path.join(CONFIG.outDir, "puzzle-data.js"), js);
  const fileSizeMB = (fs.statSync(path.join(CONFIG.outDir, "puzzle-data.js")).size / (1024 * 1024)).toFixed(2);

  const aName = validPair.actors[validPair.a]?.name || `Actor ${validPair.a}`;
  const bName = validPair.actors[validPair.b]?.name || `Actor ${validPair.b}`;

  console.log(`\nWrote out/puzzle-data.js (${aName} <-> ${bName}), ${fileSizeMB} MB.`);

  if (fileSizeMB > 10) {
    console.log(
      `  WARNING: ${fileSizeMB} MB is large for a file served via jsDelivr (hard limit 50MB) ` +
        `and for a browser to download/parse on page load. Consider lowering maxDiscoveredMovies.`
    );
  }
}

main().catch((err) => {
  console.error("daily-puzzle.js failed:", err);
  process.exit(1);
});