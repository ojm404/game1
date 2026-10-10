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

  maxCastPerMovie: 25,

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

  // ---- Always-included films --------------------------------------
  // Every puzzle starts with a pool of well-known films already loaded,
  // before the search spends any budget, so a major film can't be left
  // out just because none of its cast happened to be loaded in full.
  // The pool is: TMDB's most-voted films of all time, plus the most-voted
  // films of the last couple of years (so new hits get in before they
  // have had time to climb the all-time list), plus anything you list by
  // hand. The Marvel / documentary / popularity filters still apply.
  popularPoolPages: 40,      // 20 films a page: the 800 most-voted films ever
  recentPoolPages: 10,       // the 200 most-voted films of the last...
  recentPoolMonths: 24,      // ...this many months
  // Films to force in by TMDB id (the number in the film's themoviedb.org
  // address). Use this if a film you care about still isn't showing up.
  alwaysIncludeMovieIds: new Set([
  ]),

  // ---- How long saved TMDB answers are trusted ---------------------
  // Answers used to be kept forever, so a film first seen before it had
  // enough votes stayed excluded for good, and an actor's saved list of
  // films never gained their new releases. Now each saved answer is
  // re-fetched once it is older than this many days.
  cacheDaysLists: 7,         // an actor's film list, name searches, the lists above
  cacheDaysMovies: 30,       // a film's details and cast
  cacheDaysNewMovies: 3,     // ...when the film is new or not out yet
  newReleaseWindowDays: 120, // "new" = released within this many days

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
  // Total playable films in the shipped graph. Raised from 2000: at 2000
  // the budget ran out after only ~50 actors had their full filmography
  // loaded, so most actors a player landed on were missing well-known
  // films. Bigger number = fuller filmographies, bigger file, longer run.
  maxDiscoveredMovies: 4000,

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
  // The X-Men list, fetched through the shared cache like everything else.
  const data = await tmdb("/list/27741?language=en-US");
  for (const item of data.items || []) CONFIG.excludedMovieIds.add(item.id);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// How many days a saved answer for this request stays good. Spread by up
// to a quarter either way (always the same for the same request) so that
// files saved on the same day don't all expire on the same day.
function cacheMaxAgeDays(urlPath, data) {
  let days = CONFIG.cacheDaysLists;
  if (urlPath.startsWith("/movie/")) {
    const released = data && data.release_date ? Date.parse(data.release_date) : NaN;
    const isNew = !Number.isFinite(released) || Date.now() - released < CONFIG.newReleaseWindowDays * DAY_MS;
    days = isNew ? CONFIG.cacheDaysNewMovies : CONFIG.cacheDaysMovies;
  }
  let hash = 0;
  for (let i = 0; i < urlPath.length; i++) hash = (hash * 31 + urlPath.charCodeAt(i)) % 1000;
  return days * (0.75 + hash / 2000);
}

async function tmdb(urlPath, attempt = 1) {
  const file = cachePathFor(urlPath);
  let stale = null; // an out-of-date saved answer, kept as a fallback
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    const ageDays = (Date.now() - fs.statSync(file).mtimeMs) / DAY_MS;
    if (ageDays <= cacheMaxAgeDays(urlPath, cached)) return cached;
    stale = cached;
  }

  const url = `${CONFIG.baseUrl}${urlPath}`;
  return limiter(async () => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TMDB_KEY}` },
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt > CONFIG.maxRetries) {
        if (stale) {
          console.log(`  TMDB still failing (${res.status}) — using the older saved answer for ${urlPath}`);
          return stale;
        }
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

// A person's credits list already carries each film's popularity, vote
// count, release date and genres. Checking those here means films that
// would be thrown out anyway are never fetched at all, which roughly
// halves the number of TMDB requests and leaves the run time for films
// that will actually be playable.
function creditLooksExcluded(credit) {
  if (!CONFIG.allowUnreleasedMovies && credit.release_date === "") return true;
  if (typeof credit.popularity === "number" && credit.popularity < CONFIG.minPopularity) return true;
  if (typeof credit.vote_count === "number" && credit.vote_count < CONFIG.minVoteCount) return true;
  if (Array.isArray(credit.genre_ids) && credit.genre_ids.some((id) => CONFIG.excludedGenreIds.has(id))) return true;
  return false;
}

// The ids of the always-included films (see CONFIG). Best effort: if
// TMDB's lists can't be fetched the puzzle is still generated, just
// without the guarantee for that day.
async function loadPopularPoolIds() {
  const ids = new Set(CONFIG.alwaysIncludeMovieIds);
  const base =
    "/discover/movie?include_adult=false&language=en-US&sort_by=vote_count.desc" +
    `&without_genres=${[...CONFIG.excludedGenreIds].join(",")}`;
  // First of the month, so the request (and its saved answer) only
  // changes once a month rather than every day.
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCMonth(since.getUTCMonth() - CONFIG.recentPoolMonths);
  const sinceStr = since.toISOString().slice(0, 10);
  try {
    for (let page = 1; page <= CONFIG.popularPoolPages; page++) {
      const data = await tmdb(`${base}&page=${page}`);
      for (const m of data.results || []) ids.add(m.id);
    }
    for (let page = 1; page <= CONFIG.recentPoolPages; page++) {
      const data = await tmdb(`${base}&primary_release_date.gte=${sinceStr}&page=${page}`);
      for (const m of data.results || []) ids.add(m.id);
    }
  } catch (err) {
    console.log(`  WARNING: could not load the full popular-film pool (${err.message}) — continuing with ${ids.size}`);
  }
  console.log(`Always-included film pool: ${ids.size} films (before filters).`);
  return [...ids];
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
    .filter((c) => !creditLooksExcluded(c))
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
    // TMDB's popularity score, used to decide whose full filmography to
    // load first when the budget can't cover everyone.
    cache.actors[c.id].popularity = Math.max(cache.actors[c.id].popularity || 0, c.popularity ?? 0);
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

    // Most popular actors first, so if a budget runs out part-way through
    // a round it has been spent on the names players are likeliest to use.
    const ordered = [...frontier].sort(
      (x, y) => ((cache.actors[y] && cache.actors[y].popularity) || 0) - ((cache.actors[x] && cache.actors[x].popularity) || 0)
    );

    for (const actorId of ordered) {
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

      // The search's only job is to prove the two actors connect and how
      // far apart they are. It used to keep going after that until a
      // budget ran out, spending the whole film budget on whichever
      // co-stars happened to be listed first. Stopping here (once this
      // actor's films are all loaded) hands the rest of the budget to
      // fillInLeafActors, which spends it on the most popular actors.
      if (found) return { found, connectDistance, cache };
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

    // Most popular first: a full filmography matters most for the actors
    // players are likeliest to route through.
    const unexpanded = Object.keys(cache.actors)
      .filter((id) => !cache.actors[id]._expanded)
      .sort((x, y) => (cache.actors[y].popularity || 0) - (cache.actors[x].popularity || 0));

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

    let playable = survivingSoFar;
    for (const actorId of batch) {
      // Checked per actor, not just once per round: a round can hold
      // hundreds of actors, which would otherwise overshoot the film
      // budget many times over.
      if (playable >= CONFIG.maxDiscoveredMovies) break;
      const { movieIds } = await expandActor(actorId, cache);
      for (const movieId of movieIds) {
        const alreadyLoaded = Boolean(cache.movies[movieId]);
        const movie = await expandMovie(movieId, cache);
        if (!alreadyLoaded && !movie._excluded) playable += 1;
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
  const poolIds = await loadPopularPoolIds();

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

    // Load the always-included films first, so they are never crowded out
    // by the film budget. Their casts join the graph as actors, and the
    // most popular of them get their full filmographies in fillInLeafActors.
    for (const movieId of poolIds) await expandMovie(movieId, cache);

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
