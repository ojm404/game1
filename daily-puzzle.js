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

  marvelCompanyIds: new Set([420, 19551]),
  excludedKeywordIds: new Set([180547]),

  // Individual films to exclude, by TMDB id (the number in the film's
  // themoviedb.org address, e.g. themoviedb.org/movie/12345-some-title
  // is 12345). Separate ids with commas. The X-Men list is added to this
  // automatically at startup.
  excludedMovieIds: new Set([
  ]),

  // Any film whose title matches this is excluded, whatever companies or
  // keywords TMDB lists for it. Catches the Fox-era Deadpool films
  // (Deadpool, Deadpool 2, Once Upon a Deadpool), which carry neither of
  // the company IDs above nor the MCU keyword. To block another franchise
  // by name, add it inside the brackets with a | between names,
  // e.g. /\b(deadpool|venom)\b/i
  excludedTitlePattern: /\b(deadpool)\b/i,

  minPopularity: 3,
  minVoteCount: 50,
  allowUnreleasedMovies: false,

  // These names are only used to SEARCH TMDB. The name shown in the game
  // is the one TMDB sends back (see resolveActor), so a small spelling
  // slip here no longer ends up on the START / FINISH ticket — but a
  // badly wrong spelling can still find nobody, or the wrong person.
  seedActorNames: [
    "Tom Hanks", "Meryl Streep", "Denzel Washington", "Julia Roberts",
    "Leonardo DiCaprio", "Kate Winslet", "Brad Pitt", "Cate Blanchett",
    "Samuel L. Jackson", "Nicole Kidman", "Will Smith", "Charlize Theron",
    "Matt Damon", "Scarlett Johansson", "George Clooney", "Sandra Bullock",
    "Morgan Freeman", "Emma Stone", "Christian Bale", "Viola Davis",
    "Henry Cavill", "Julia Stiles", "Kurt Russell", "James Spader",
    "Jennifer Lawrence", "Chris Pine", "Simon Pegg", "Zendaya",
    "Idris Elba", "Tom Cruise", "Penélope Cruz", "Javier Bardem",
    "Daniel Craig", "Kirsten Dunst", "Kristen Stewart", "Robert Pattinson",
    "Tom Hardy", "Anne Hathaway", "Chris Evans", "Chris Pratt",
    "Robert Downey Jr.", "Cillian Murphy", "Keanu Reeves", "Willem Dafoe",
    "Nicolas Cage", "Oscar Isaac", "Anthony Hopkins", "Jodie Foster",
    "Hilary Swank", "Margot Robbie", "Helen Mirren", "Michael Caine",
    "Ryan Gosling", "Ben Affleck", "Emma Watson",
    // Actors with a nickname shortcut in the game
    "Timothée Chalamet", "Benedict Cumberbatch", "Owen Wilson", "Matthew McConaughey",
    // Current names
    "Florence Pugh", "Saoirse Ronan", "Adam Driver", "Joaquin Phoenix",
    "Amy Adams", "Jake Gyllenhaal", "Emily Blunt", "Jessica Chastain",
    "Natalie Portman", "Michael B. Jordan", "Daniel Kaluuya", "Mahershala Ali",
    "Michelle Yeoh", "Pedro Pascal", "Ana de Armas", "Dev Patel"
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
  if (CONFIG.excludedTitlePattern && CONFIG.excludedTitlePattern.test(movieDetails.title || "")) return true;

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

// Looks a seed name up on TMDB and returns the person's id, the name as
// TMDB spells it (accents and all — this is the name the game shows and
// the one players' guesses are matched against, so it has to agree with
// the spelling used in every film's cast list), and their profile photo
// path (null if TMDB has none). Returns null if nobody was found.
async function resolveActor(name) {
  const data = await tmdb(`/search/person?query=${encodeURIComponent(name)}&language=en-US`);
  const results = data.results || [];
  const match = results.find((p) => p.known_for_department === "Acting") || results[0];
  if (!match) return null;
  return { id: match.id, name: match.name || name, photo: match.profile_path || null };
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
    // Cast lists carry each person's photo path for free, so keep it as a
    // backup in case the search result for a seed actor had none.
    if (!cache.actors[c.id].photo && c.profile_path) cache.actors[c.id].photo = c.profile_path;
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

// photoIds: the actors whose photo should be written to the output. The
// game only shows photos on the START and FINISH tickets, so only those
// two get one — putting a photo path on every actor in the graph would
// add a lot of weight to the file for pictures nobody ever sees.
function trimCacheToVisited(cache, photoIds = new Set()) {
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
    if (photoIds.has(String(id)) && a.photo) actors[id].photo = a.photo;
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

    const [actorA, actorB] = await Promise.all([resolveActor(nameA), resolveActor(nameB)]);
    if (!actorA || !actorB || actorA.id === actorB.id) {
      console.log("  could not resolve both actors, trying a different pair");
      continue;
    }
    const idA = actorA.id, idB = actorB.id;
    if (actorA.name !== nameA) console.log(`  note: seed "${nameA}" resolved to "${actorA.name}" on TMDB`);
    if (actorB.name !== nameB) console.log(`  note: seed "${nameB}" resolved to "${actorB.name}" on TMDB`);

    const cache = makeGraphCache();
    cache.actors[idA] = { name: actorA.name, movies: [], photo: actorA.photo };
    cache.actors[idB] = { name: actorB.name, movies: [], photo: actorB.photo };

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

    const { actors, movies } = trimCacheToVisited(cache, new Set([String(idA), String(idB)]));
    console.log(
      `  connected. Puzzle graph: ${Object.keys(actors).length} actors, ` +
        `${Object.keys(movies).length} movies.`
    );
    for (const id of [idA, idB]) {
      if (!actors[id].photo) console.log(`  note: no TMDB photo for ${actors[id].name} — the game will show initials`);
    }

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
