/**
 * daily-loop.js
 *
 * Daily generator for the third game ("Full Circle"): the player starts
 * on one actor and has to link back to that SAME actor in 3 to 6 films,
 * never reusing a film or an actor along the way.
 *
 * Runs once a day via .github/workflows/daily-loop.yml. To test by hand:
 *   TMDB_KEY=xxx node daily-loop.js
 *
 * This file is fully standalone on purpose: it does not require or change
 * daily-puzzle.js. The TMDB client, cache layout and Marvel / non-fiction /
 * popularity filters are copied from that script, and the TMDB URL paths
 * are identical, so both scripts read and write the same cache/ entries.
 * If you change a filter or the seed list in daily-puzzle.js, mirror it here.
 *
 * How it differs from daily-puzzle.js:
 *   - One actor, not two. The graph is grown outward from that actor,
 *     expanding their best-known co-stars first.
 *   - Before a puzzle is accepted, a solver proves that a loop back to the
 *     start actually exists inside the shipped graph. The loops it finds
 *     are only used for that check and for the log: they are NOT written
 *     to the output, because the game never reveals an answer.
 *
 * Output: out/loop-data.js, which assigns window.LOOP_DATA.
 */

const fs = require("fs");
const path = require("path");

const TMDB_KEY = process.env.TMDB_KEY;

const CONFIG = {
  baseUrl: "https://api.themoviedb.org/3",
  outDir: path.join(__dirname, "out"),
  outFile: "loop-data.js",

  // The player may close the loop at any length in this range. Set both
  // to the same number for a "loop of exactly N" day.
  minSteps: 3,
  maxSteps: 6,

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
  // (Deadpool, Deadpool 2, Once Upon a Deadpool) and every Spider-Man
  // film, including the original 2002-2007 trilogy, the Amazing
  // Spider-Man pair and the animated Spider-Verse films. To block another franchise
  // by name, add it inside the brackets with a | between names,
  // e.g. /\b(deadpool|venom)\b/i
  excludedTitlePattern: /\b(deadpool|spider-?man)\b/i,

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

  // Same list as daily-puzzle.js. These names are only used to SEARCH
  // TMDB; the name shown in the game is the one TMDB sends back (see
  // resolveActor).
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
    "Michelle Yeoh", "Pedro Pascal", "Ana de Armas", "Dev Patel",
    // Long, well-connected careers
    "Robert De Niro", "Al Pacino", "Harrison Ford", "Jeff Bridges",
    "Sigourney Weaver", "Michelle Pfeiffer", "Susan Sarandon", "Julianne Moore",
    "Frances McDormand", "Gary Oldman", "Ralph Fiennes", "Emma Thompson",
    "Judi Dench", "Bill Murray", "Woody Harrelson", "Steve Buscemi",
    // Household names
    "Bradley Cooper", "Jennifer Aniston", "Reese Witherspoon", "Cameron Diaz",
    "Hugh Grant", "Colin Firth", "Jack Nicholson", "Dustin Hoffman",
    "Robin Williams", "Jim Carrey", "Eddie Murphy", "Ben Stiller",
    "Adam Sandler", "Angelina Jolie", "Johnny Depp", "Russell Crowe",
    "Liam Neeson", "Ewan McGregor", "Keira Knightley", "Rachel McAdams",
    "Mark Wahlberg", "Jamie Foxx", "Octavia Spencer", "Glenn Close"
  ],

  // Graph budget. Expansion stops at whichever cap is hit first.
  // Raised from 120 actors / 1500 films: at those caps only the first
  // few dozen co-stars had their full filmography loaded, so well-known
  // films were missing for most actors a player landed on.
  maxActorsExpanded: 300,
  minDiscoveredMovies: 300,
  maxDiscoveredMovies: 4000,

  // Upper bound on solver work per loop length, so a bad seed fails fast.
  solverStepBudget: 200_000,

  maxAttempts: 8,

  requestsPerBatch: 20,
  batchPauseMs: 10_000,
  maxRetries: 5,
};

// ---------------------------------------------------------------------
// TMDB client + cache (same behaviour and same cache keys as
// daily-puzzle.js)
// ---------------------------------------------------------------------

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
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2 ** attempt * 1000;
      console.log(`  TMDB returned ${res.status}, retrying in ${waitMs}ms (attempt ${attempt}/${CONFIG.maxRetries})`);
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

async function loadExcludedMovieIds() {
  // Same X-Men list as daily-puzzle.js, fetched through the shared cache.
  const data = await tmdb("/list/27741?language=en-US");
  for (const item of data.items || []) CONFIG.excludedMovieIds.add(item.id);
}

// ---------------------------------------------------------------------
// Filters (copied from daily-puzzle.js)
// ---------------------------------------------------------------------

function isMarvelMovie(movieDetails) {
  if (CONFIG.excludedMovieIds.has(movieDetails.id)) return true;
  if (CONFIG.excludedTitlePattern && CONFIG.excludedTitlePattern.test(movieDetails.title || "")) return true;
  const companyIds = (movieDetails.production_companies || []).map((c) => c.id);
  if (companyIds.some((id) => CONFIG.marvelCompanyIds.has(id))) return true;
  const keywordIds = ((movieDetails.keywords && movieDetails.keywords.keywords) || []).map((k) => k.id);
  return keywordIds.some((id) => CONFIG.excludedKeywordIds.has(id));
}

function isNonFictionMovie(movieDetails) {
  const genreIds = (movieDetails.genres || []).map((g) => g.id);
  return genreIds.some((id) => CONFIG.excludedGenreIds.has(id));
}

function isUnpopularOrUnreleasedMovie(movieDetails) {
  if (!CONFIG.allowUnreleasedMovies && !movieDetails.release_date) return true;
  if ((movieDetails.popularity ?? 0) < CONFIG.minPopularity) return true;
  if ((movieDetails.vote_count ?? 0) < CONFIG.minVoteCount) return true;
  return false;
}

function isFictionalCastCredit(castMember) {
  const character = castMember.character || "";
  if (!character.trim()) return false;
  return !CONFIG.selfAppearancePattern.test(character.trim());
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

// Looks a seed name up on TMDB and returns the person's id, the name as
// TMDB spells it (accents and all — this is the name the game shows, and
// it has to agree with the spelling used in every film's cast list), and
// their profile photo path (null if TMDB has none). Returns null if
// nobody was found.
async function resolveActor(name) {
  const data = await tmdb(`/search/person?query=${encodeURIComponent(name)}&language=en-US`);
  const results = data.results || [];
  const match = results.find((p) => p.known_for_department === "Acting") || results[0];
  if (!match) return null;
  return { id: match.id, name: match.name || name, photo: match.profile_path || null };
}

// ---------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------

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
  return { actors: {}, movies: {}, surviving: 0 };
}

async function expandMovie(movieId, cache, castDepth) {
  if (cache.movies[movieId]) return cache.movies[movieId];

  let details;
  try {
    details = await tmdb(`/movie/${movieId}?language=en-US&append_to_response=credits,keywords`);
  } catch (err) {
    if (err.status === 404) {
      console.log(`  movie ${movieId} returned 404 (likely deleted/merged on TMDB) — skipping`);
      cache.movies[movieId] = { title: null, year: null, cast: [], _excluded: true };
      return cache.movies[movieId];
    }
    throw err;
  }

  if (isMarvelMovie(details) || isNonFictionMovie(details) || isUnpopularOrUnreleasedMovie(details)) {
    cache.movies[movieId] = { title: details.title, year: null, cast: [], _excluded: true };
    return cache.movies[movieId];
  }

  const cast = ((details.credits && details.credits.cast) || [])
    .filter(isFictionalCastCredit)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, CONFIG.maxCastPerMovie);

  for (const c of cast) {
    const existing = cache.actors[c.id];
    if (!existing) {
      cache.actors[c.id] = { name: c.name, movies: [], depth: castDepth, popularity: c.popularity ?? 0, photo: c.profile_path || null };
    } else {
      if (!existing.name) existing.name = c.name;
      existing.depth = Math.min(existing.depth, castDepth);
      existing.popularity = Math.max(existing.popularity, c.popularity ?? 0);
      // Backup in case the search result for the start actor had no photo.
      if (!existing.photo && c.profile_path) existing.photo = c.profile_path;
    }
  }

  cache.movies[movieId] = {
    title: details.title,
    year: (details.release_date || "").slice(0, 4) || null,
    cast: cast.map((c) => c.id),
  };
  cache.surviving += 1;
  return cache.movies[movieId];
}

async function expandActor(actorId, cache) {
  const actor = cache.actors[actorId];

  let credits;
  try {
    credits = await tmdb(`/person/${actorId}/movie_credits?language=en-US`);
  } catch (err) {
    if (err.status === 404) {
      console.log(`  person ${actorId} returned 404 (likely merged on TMDB) — skipping`);
      actor.movies = [];
      actor._expanded = true;
      return;
    }
    throw err;
  }

  const movieIds = (credits.cast || [])
    .filter(isFictionalCastCredit)
    .filter((c) => !creditLooksExcluded(c))
    .map((c) => c.id);
  for (const movieId of movieIds) {
    await expandMovie(movieId, cache, actor.depth + 1);
  }
  actor.movies = movieIds;
  actor._expanded = true;
}

// Next actor to expand: closest to the start actor first, and within the
// same distance the most popular first. That spends the budget on the
// start actor's best-known co-stars, which is where players will go.
function pickNextActor(cache) {
  let bestId = null;
  let best = null;
  for (const [id, a] of Object.entries(cache.actors)) {
    if (a._expanded) continue;
    if (!best || a.depth < best.depth || (a.depth === best.depth && a.popularity > best.popularity)) {
      bestId = id;
      best = a;
    }
  }
  return bestId;
}

async function buildGraph(start, poolIds = []) {
  const cache = makeGraphCache();
  cache.actors[start.id] = { name: start.name, movies: [], depth: 0, popularity: Infinity, photo: start.photo };

  // Load the always-included films first, so they are never crowded out
  // by the film budget. Depth 99 keeps their casts at the back of the
  // queue for full filmographies unless they turn out to be near the
  // start actor.
  for (const movieId of poolIds) await expandMovie(movieId, cache, 99);

  let expanded = 0;
  while (expanded < CONFIG.maxActorsExpanded) {
    if (cache.surviving >= CONFIG.maxDiscoveredMovies) {
      console.log(`  hit maxDiscoveredMovies (${CONFIG.maxDiscoveredMovies}) — stopping expansion`);
      break;
    }
    const nextId = pickNextActor(cache);
    if (nextId === null) break;
    await expandActor(nextId, cache);
    expanded += 1;
    if (expanded % 10 === 0) {
      console.log(`  expanded ${expanded} actors, ${cache.surviving} playable movies so far`);
    }
  }
  return cache;
}

// photoId: the one actor whose photo is written to the output. The game
// only shows a photo on the START & FINISH ticket, so only the start
// actor gets one — a photo path on every actor would add weight to the
// file for pictures nobody ever sees.
function trimGraph(cache, photoId = null) {
  const movies = {};
  for (const [id, m] of Object.entries(cache.movies)) {
    if (m._excluded) continue;
    movies[id] = { title: m.title, year: m.year, cast: m.cast };
  }

  const actors = {};
  const expandedIds = [];
  for (const [id, a] of Object.entries(cache.actors)) {
    if (!a.name) continue;
    actors[id] = { name: a.name, movies: (a.movies || []).filter((movieId) => movies[movieId]) };
    if (photoId !== null && String(id) === String(photoId) && a.photo) actors[id].photo = a.photo;
    if (a._expanded) expandedIds.push(String(id));
  }
  return { actors, movies, expandedIds };
}

// ---------------------------------------------------------------------
// Loop solver
// ---------------------------------------------------------------------

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Co-star links between the fully expanded (well-known) actors only, so
// the loop that proves a puzzle is solvable uses recognisable names. An
// actor counts as being in a film if the film is in their own list OR
// they are in its cast list, which is the same rule the game page uses
// to accept a guess.
function buildCostarIndex(actors, movies, expandedIds) {
  const known = new Set(expandedIds.map(String));
  const castOf = {};
  const add = (actorId, movieId) => {
    actorId = String(actorId);
    movieId = String(movieId);
    if (!known.has(actorId) || !movies[movieId]) return;
    (castOf[movieId] = castOf[movieId] || new Set()).add(actorId);
  };
  for (const id of known) for (const movieId of actors[id].movies) add(id, movieId);
  for (const [movieId, m] of Object.entries(movies)) for (const actorId of m.cast) add(actorId, movieId);

  const shared = new Map(); // "a|b" -> [movieId]
  const adj = {};
  for (const [movieId, members] of Object.entries(castOf)) {
    const list = [...members];
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const key = `${list[i]}|${list[j]}`;
        if (!shared.has(key)) shared.set(key, []);
        shared.get(key).push(movieId);
        (adj[list[i]] = adj[list[i]] || new Set()).add(list[j]);
      }
    }
  }
  return { adj, sharedMovies: (a, b) => shared.get(`${a}|${b}`) || [] };
}

// Finds one loop of exactly `length` films: start -> film -> actor -> ...
// -> film -> start, with no film and no actor used twice. Returns
// { actors: [start, ..., start], movies: [...] } or null.
function findLoop(startId, length, index) {
  startId = String(startId);
  const { adj, sharedMovies } = index;
  const pathActors = [startId];
  const pathMovies = [];
  const usedActors = new Set([startId]);
  const usedMovies = new Set();
  let steps = 0;

  function dfs() {
    if (++steps > CONFIG.solverStepBudget) return false;
    const current = pathActors[pathActors.length - 1];

    if (pathMovies.length === length - 1) {
      const closing = sharedMovies(current, startId).find((m) => !usedMovies.has(m));
      if (closing === undefined) return false;
      pathMovies.push(closing);
      pathActors.push(startId);
      return true;
    }

    for (const next of shuffle([...(adj[current] || [])])) {
      if (usedActors.has(next)) continue;
      // Trying more than a couple of films for the same pair rarely
      // changes the outcome and multiplies the search.
      const options = sharedMovies(current, next).filter((m) => !usedMovies.has(m)).slice(0, 2);
      for (const movieId of options) {
        usedActors.add(next);
        usedMovies.add(movieId);
        pathActors.push(next);
        pathMovies.push(movieId);
        if (dfs()) return true;
        pathActors.pop();
        pathMovies.pop();
        usedActors.delete(next);
        usedMovies.delete(movieId);
      }
    }
    return false;
  }

  if (!dfs()) return null;
  return { actors: pathActors.map(Number), movies: pathMovies.map(Number) };
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

// The workflow moves each day's output to the repo root, so at generation
// time the root copy is yesterday's puzzle. Used to avoid a repeat.
function previousStartId() {
  try {
    const text = fs.readFileSync(path.join(__dirname, CONFIG.outFile), "utf8");
    const match = text.match(/"start":(\d+)/);
    return match ? Number(match[1]) : null;
  } catch (e) {
    return null;
  }
}

async function main() {
  if (!TMDB_KEY) {
    console.error("Set TMDB_KEY in the environment before running this script.");
    process.exit(1);
  }

  fs.mkdirSync(CONFIG.outDir, { recursive: true });
  await loadExcludedMovieIds();
  const poolIds = await loadPopularPoolIds();

  const yesterday = previousStartId();
  const candidates = shuffle(CONFIG.seedActorNames).slice(0, CONFIG.maxAttempts);
  let puzzle = null;

  for (const [i, seedName] of candidates.entries()) {
    console.log(`Attempt ${i + 1}: trying ${seedName}`);

    const start = await resolveActor(seedName);
    if (!start) {
      console.log("  could not resolve this actor, trying another");
      continue;
    }
    if (start.name !== seedName) console.log(`  note: seed "${seedName}" resolved to "${start.name}" on TMDB`);
    if (start.id === yesterday) {
      console.log("  same actor as yesterday, trying another");
      continue;
    }

    const cache = await buildGraph(start, poolIds);
    if (cache.surviving < CONFIG.minDiscoveredMovies) {
      console.log(`  graph too small (${cache.surviving} playable movies, need ${CONFIG.minDiscoveredMovies}) — trying another`);
      continue;
    }

    const { actors, movies, expandedIds } = trimGraph(cache, start.id);
    const index = buildCostarIndex(actors, movies, expandedIds);

    // Proof that the puzzle can be solved. Kept out of the output file.
    const solutions = {};
    for (let length = CONFIG.minSteps; length <= CONFIG.maxSteps; length++) {
      const loop = findLoop(start.id, length, index);
      if (loop) solutions[length] = loop;
    }

    if (!solutions[CONFIG.minSteps]) {
      console.log(`  no ${CONFIG.minSteps}-film loop found back to ${start.name} — trying another`);
      continue;
    }

    console.log(
      `  accepted. ${Object.keys(actors).length} actors, ${Object.keys(movies).length} movies, ` +
        `loops found for lengths: ${Object.keys(solutions).join(", ")}`
    );
    if (!actors[start.id].photo) console.log(`  note: no TMDB photo for ${start.name} — the game will show initials`);
    puzzle = { start: start.id, actors, movies };
    break;
  }

  if (!puzzle) {
    console.error(`Failed to generate a loop puzzle after ${candidates.length} attempts.`);
    process.exit(1);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    start: puzzle.start,
    minSteps: CONFIG.minSteps,
    maxSteps: CONFIG.maxSteps,
    actors: puzzle.actors,
    movies: puzzle.movies,
  };

  const js =
    `// Auto-generated by daily-loop.js — do not edit by hand.\n` +
    `// Regenerated daily by the GitHub Actions workflow.\n` +
    `window.LOOP_DATA = ${JSON.stringify(payload)};\n`;

  const outPath = path.join(CONFIG.outDir, CONFIG.outFile);
  fs.writeFileSync(outPath, js);
  const fileSizeMB = fs.statSync(outPath).size / (1024 * 1024);
  console.log(`\nWrote out/${CONFIG.outFile} (${puzzle.actors[puzzle.start].name}), ${fileSizeMB.toFixed(2)} MB.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("daily-loop.js failed:", err);
    process.exit(1);
  });
}

module.exports = { CONFIG, trimGraph, buildCostarIndex, findLoop };
