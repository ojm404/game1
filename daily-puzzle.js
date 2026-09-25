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

  // Keep these in sync with build-graph.js's CONFIG of the same names.
  marvelCompanyIds: new Set([420]),
  excludedKeywordIds: new Set([180547]), // "Marvel Cinematic Universe (MCU)"

  // Pool to pick today's two actors from. Same list you're using in
  // build-graph.js's seedActorNames works fine here.
  seedActorNames: [
    "Tom Hanks", "Meryl Streep", "Denzel Washington", "Julia Roberts",
    "Leonardo DiCaprio", "Kate Winslet", "Brad Pitt", "Cate Blanchett",
    "Samuel L. Jackson", "Nicole Kidman", "Will Smith", "Charlize Theron",
    "Matt Damon", "Scarlett Johansson", "George Clooney", "Sandra Bullock",
    "Morgan Freeman", "Emma Stone", "Christian Bale", "Viola Davis",
    "Kaya Scodelario", "Henry Cavill", "Julia Stiles", "Kurt Russell",
    "James Spader", "Jennifer Lawrence", "James Corden", "Chris Pine",
    "Simon Pegg", "Zendaya", "Idris Elba", "Tom Cruise", "Penelope Cruz",
    "Javier Bardem", "Daniel Craig", "Kirsten Dunst", "Kristen Stewart",
    "Robert Pattinson", "Tom Hardy", "Anne Hathaway", "Chris Evans",
    "Chris Pratt",
  ],

  // A puzzle must have a true shortest path in this range to be accepted.
  minPairDistance: 3,
  maxPairDistance: 5,

  // Hard ceiling on how many actors the bidirectional search will expand
  // before giving up on a pair and trying a different one. This is what
  // keeps a single day's run inside a reasonable number of API calls —
  // without it, a pair of very popular actors could pull in tens of
  // thousands of requests before connecting. The search always spends
  // this whole budget now, rather than winding down shortly after the two
  // actors connect — a puzzle with a short true answer used to stop with
  // very little real depth built around it, so a player deliberately
  // trying a longer (but still valid, still within the guess limit) chain
  // would walk off the edge of what was ever fetched. Spending the full
  // budget regardless of how fast the direct connection is found gives
  // every puzzle the same real breadth to explore, not just the hard ones.
  maxActorsExpanded: 600,

  // After the search connects the two actors, some nodes in the discovered
  // graph were only ever seen as someone else's co-star — their own
  // filmography was never fetched, which means every guess made FROM that
  // node would fail even when correct. fillInLeafActors() now closes this
  // iteratively (each round of newly-discovered actors gets expanded too,
  // not just the first), so this is a TOTAL budget shared across every
  // round, not a single pass. Raising it means fewer real dead ends
  // further out in the graph, at the cost of more requests/runtime.
  maxLeafExpansions: 250,

  // How many different random pairs to try before giving up for the day.
  maxAttempts: 8,

  requestsPerBatch: 20,
  batchPauseMs: 10_000,
  maxRetries: 5, // for 429s and transient 5xx errors, with backoff
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

async function tmdb(urlPath, attempt = 1) {
  const url = `${CONFIG.baseUrl}${urlPath}`;
  return limiter(async () => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TMDB_KEY}` },
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt > CONFIG.maxRetries) {
        throw new Error(`TMDB request failed after ${CONFIG.maxRetries} retries (${res.status}): ${url}`);
      }
      // TMDB sends Retry-After on 429s; fall back to exponential backoff if
      // it's missing (also covers transient 5xx errors, which don't send it).
      const retryAfterHeader = res.headers.get("Retry-After");
      const waitMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : 2 ** attempt * 1000; // 2s, 4s, 8s, ...
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
    return res.json();
  });
}

// ---------------------------------------------------------------------------
// Filters — mirrors build-graph.js
// ---------------------------------------------------------------------------

function isMarvelMovie(movieDetails) {
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

function isFictionalCastCredit(castMember) {
  const character = castMember.character || "";
  if (!character.trim()) return false;
  return !CONFIG.selfAppearancePattern.test(character.trim());
}

// ---------------------------------------------------------------------------
// Live, bounded, bidirectional BFS
// ---------------------------------------------------------------------------

async function resolveActorId(name) {
  const data = await tmdb(`/search/person?query=${encodeURIComponent(name)}&language=en-US`);
  const match = (data.results || []).find((p) => p.known_for_department === "Acting");
  return match ? match.id : (data.results && data.results[0] && data.results[0].id);
}

// A shared cache across one run, so the two frontiers never re-fetch the
// same actor or movie twice even if both sides reach it.
function makeGraphCache() {
  return { actors: {}, movies: {} }; // id -> { name, movies:[] } / { title, year, cast:[] }
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
      // TMDB occasionally merges duplicate person records, which can
      // leave a stale ID behind. Treat as an actor with no further
      // credits rather than crashing the whole run over one dead ID.
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
      // TMDB periodically deletes or merges duplicate entries, so a movie
      // ID that was valid when an actor's credits were fetched can later
      // 404. Treat it the same as an excluded (Marvel/non-fiction) movie —
      // empty cast, filtered out of the final output — instead of letting
      // one stale ID crash the whole run.
      console.log(`  movie ${movieId} returned 404 (likely deleted/merged on TMDB) — skipping`);
      cache.movies[movieId] = { title: null, year: null, cast: [], _excluded: true, _expanded: true };
      return cache.movies[movieId];
    }
    throw err; // anything else (network failure, retries exhausted) is still fatal
  }

  if (isMarvelMovie(details) || isNonFictionMovie(details)) {
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

/**
 * Alternately expands the smaller of two frontiers outward from startId and
 * endId, one hop at a time. This always spends the full maxActorsExpanded
 * budget, rather than winding down shortly after the two actors connect —
 * stopping early meant an easy, short-answer puzzle ended up with very
 * little real depth built around it, so a player deliberately trying a
 * longer (but still valid, still within the guess limit) chain would walk
 * off the edge of what was ever fetched. Whether the true shortest
 * connection is 2 hops or 5, the same budget now gets spent building real
 * breadth either way.
 *
 * Returns { found: bool, cache } — cache holds every actor/movie visited,
 * which becomes the puzzle's shipped graph regardless of outcome. `found`
 * just records whether a real connection exists at all, for main() to
 * decide whether this pair is usable — it no longer affects how much
 * gets expanded.
 */
async function bidirectionalSearch(startId, endId, cache) {
  let frontA = new Set([startId]);
  let frontB = new Set([endId]);
  const visitedA = new Set([startId]);
  const visitedB = new Set([endId]);
  let actorsExpanded = 0;
  let found = false;

  cache.actors[startId] = cache.actors[startId] || { name: null, movies: [] };
  cache.actors[endId] = cache.actors[endId] || { name: null, movies: [] };

  while (frontA.size > 0 && frontB.size > 0) {
    const expandingA = frontA.size <= frontB.size;
    const frontier = expandingA ? frontA : frontB;
    const visitedSame = expandingA ? visitedA : visitedB;
    const visitedOther = expandingA ? visitedB : visitedA;

    const next = new Set();

    for (const actorId of frontier) {
      if (actorsExpanded >= CONFIG.maxActorsExpanded) {
        return { found, cache };
      }
      actorsExpanded += 1;

      const { movieIds } = await expandActor(actorId, cache);
      for (const movieId of movieIds) {
        const movie = await expandMovie(movieId, cache);
        if (movie._excluded) continue;

        for (const coStarId of movie.cast) {
          if (visitedOther.has(coStarId)) {
            found = true; // a real connection exists — keep expanding regardless
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

  return { found, cache };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function pickTwoRandom(list) {
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}

function trimCacheToVisited(cache) {
  // Build the surviving movies first — this is what actors' movie lists
  // need to be filtered against below, since an actor's raw credit list
  // can reference a movie (Marvel, documentary) that never makes it into
  // this output. Without that filter, the game would later try to look up
  // a movie ID that doesn't exist and crash on every single guess.
  const movies = {};
  for (const [id, m] of Object.entries(cache.movies)) {
    if (m._excluded) continue;
    movies[id] = { title: m.title, year: m.year, cast: m.cast };
  }
  const survivingMovieIds = new Set(Object.keys(movies).map(Number));

  const actors = {};
  for (const [id, a] of Object.entries(cache.actors)) {
    if (!a.name) continue; // never actually resolved — skip
    const survivingMovies = (a.movies || []).filter((movieId) =>
      survivingMovieIds.has(movieId)
    );
    actors[id] = { name: a.name, movies: survivingMovies };
  }

  return { actors, movies };
}

/**
 * The search stops the instant the two frontiers meet, to save API calls.
 * That means some actors in the discovered graph were only ever added via
 * expandMovie's co-star population (name only, empty .movies) — they were
 * never personally the actor being searched from, so their own filmography
 * was never fetched. Left as-is, any guess made from one of those nodes
 * would fail regardless of whether it's actually correct.
 *
 * A single follow-up pass isn't enough: expanding those actors' own
 * filmographies surfaces a NEW wave of undiscovered co-stars (whoever was
 * in the movies they were in), and that new wave needs expanding too, or
 * you just push the dead-end one hop further out instead of removing it —
 * which is exactly why the second hop kept failing even after the first
 * pass. So this keeps expanding newly-discovered actors in rounds — the
 * closure loop only stops when either nothing new turns up (the graph is
 * fully closed — every reachable actor has real data) or the total budget
 * runs out. Actors get expanded in the order they were first discovered,
 * which naturally spends the budget on nodes closer to the core of the
 * puzzle before it ever reaches obscure, unlikely-to-be-guessed ones.
 */
async function fillInLeafActors(cache) {
  let totalExpanded = 0;

  while (totalExpanded < CONFIG.maxLeafExpansions) {
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
      `  closure budget exhausted with ${stillUnexpanded} actor(s) still unexpanded — ` +
        `those specific nodes may reject correct guesses if a player reaches them`
    );
  }
}

async function main() {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });

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

    const { found } = await bidirectionalSearch(idA, idB, cache);

    if (!found) {
      console.log("  no connection found within the search budget, trying a different pair");
      continue;
    }

    await fillInLeafActors(cache);

    const { actors, movies } = trimCacheToVisited(cache);
    console.log(
      `  connected. Puzzle graph: ${Object.keys(actors).length} actors, ` +
        `${Object.keys(movies).length} movies.`
    );

    const payload = {
      generatedAt: new Date().toISOString(),
      pairs: [{ a: idA, b: idB }],
      actors,
      movies,
    };

    const js =
      `// Auto-generated by daily-puzzle.js — do not edit by hand.\n` +
      `// Regenerated daily by the GitHub Actions workflow.\n` +
      `window.SIX_DEGREES_DATA = ${JSON.stringify(payload)};\n`;

    fs.writeFileSync(path.join(CONFIG.outDir, "puzzle-data.js"), js);
    console.log(`\nWrote out/puzzle-data.js (${nameA} <-> ${nameB}).`);
    return;
  }

  console.error(`Failed to generate a puzzle after ${CONFIG.maxAttempts} attempts.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("daily-puzzle.js failed:", err);
  process.exit(1);
});

/**
 * ---------------------------------------------------------------------
 * How game.html should load this:
 *
 * Add this BEFORE your existing game <script> tag, pointing at wherever
 * this repo is hosted (jsDelivr example shown):
 *
 *   <script src="https://cdn.jsdelivr.net/gh/YOUR_USERNAME/YOUR_REPO@main/puzzle-data.js"></script>
 *
 * Then in game.html's init(), replace the three fetch() calls with:
 *
 *   async function init() {
 *     const data = window.SIX_DEGREES_DATA;
 *     if (!data) {
 *       document.getElementById('status').textContent =
 *         'Could not load today\'s puzzle. Try refreshing.';
 *       document.getElementById('status').className = 'status err';
 *       return;
 *     }
 *     actors = data.actors;
 *     movies = data.movies;
 *     pairs = data.pairs;
 *     newPuzzle();
 *   }
 *
 * No fetch(), no CORS, nothing else to change — <script src> tags load
 * cross-origin without any CORS restriction, unlike fetch().
 * ---------------------------------------------------------------------
 */
