/**
 * build-graph.js
 *
 * One-time (well, periodic) build script. Run this locally with `node build-graph.js`.
 * It is NOT shipped to the website — only its output (actors.json, movies.json, pairs.json) is.
 *
 * What it does:
 *   1. Pulls the top N most popular people from TMDB (people flagged as actors).
 *   2. Pulls each person's movie credits.
 *   3. Pulls full details for every movie referenced, to get cast + genres + companies.
 *   4. Filters out:
 *        - Movies from the Marvel corporate family (MCU + Marvel Entertainment's
 *          Spider-Man/X-Men/Venom slate) via production company IDs, the MCU
 *          keyword, and a hand-kept TMDB list of X-Men films.
 *        - Obscure films (low TMDB popularity or vote count) and unreleased ones.
 *        - Documentaries, and any credit where the character name looks like a
 *          self-appearance (awards shows, talk shows, "Self", "Host", etc).
 *   5. Trims cast lists to top-billed N per movie (default 20) to control graph density.
 *   6. Writes actors.json / movies.json for the game to load. Seed actors (the
 *      only ones who can be a START or FINISH) also get a `photo` field, a TMDB
 *      profile_path, for the picture on their ticket.
 *   7. BFS's a curated pool of well-known actor pairs and writes pairs.json —
 *      pairs with a real shortest-path distance of 2-5, for the game to pick from.
 *
 * Requirements: Node 18+ (built-in fetch). No dependencies.
 *
 * Usage:
 *   TMDB_KEY=xxxxx node build-graph.js
 *
 * Resumable: raw TMDB responses are cached under ./cache/, so re-running after
 * a crash or rate-limit pause does not re-fetch what you already have.
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config — tune these
// ---------------------------------------------------------------------------

const TMDB_KEY = process.env.TMDB_KEY;
if (!TMDB_KEY) {
  console.error("Set TMDB_KEY in the environment before running this script.");
  process.exit(1);
}

const CONFIG = {
  baseUrl: "https://api.themoviedb.org/3",
  cacheDir: path.join(__dirname, "cache"),
  outDir: path.join(__dirname, "out"),

  // How many of TMDB's most-popular people to pull as the actor pool.
  // ~5000 keeps the shipped JSON in a reasonable size range after trimming.
  actorPoolSize: 5000,
  actorPoolPages: null, // computed from actorPoolSize below (20 people/page)

  // Top-billed cast members kept per movie. Keeps hub movies from exploding
  // the branching factor and drops uncredited/extra roles.
  maxCastPerMovie: 20,

  // Genre IDs to exclude outright (TMDB movie genre list).
  excludedGenreIds: new Set([
    99, // Documentary
  ]),

  // TV-side non-fiction genres, in case you extend this to TV credits later.
  excludedTvGenreIds: new Set([
    10763, // News
    10764, // Reality
    10767, // Talk
  ]),

  // Character names that indicate a self-appearance rather than an acting role.
  selfAppearancePattern:
    /^(self|himself|herself|themselves|host|presenter|narrator|interviewee|archive footage)\b/i,

  // Production company IDs to treat as "Marvel universe" and exclude entirely.
  // Kept identical to daily-puzzle.js, which is the source of truth for
  // every setting the two scripts share.
  marvelCompanyIds: new Set([420, 19551]),

  // TMDB keyword IDs that mark a title as MCU canon directly, independent
  // of which company is credited on that particular release. More precise
  // than the company check for catching co-productions/crossovers; kept as
  // a second, independent filter rather than a replacement for it, since
  // the company check also catches the wider Marvel Entertainment slate
  // (Sony Spider-Man, Fox X-Men, Venom, Deadpool) that this keyword does not.
  excludedKeywordIds: new Set([
    180547, // "Marvel Cinematic Universe (MCU)"
  ]),

  // Individual movie IDs to exclude. Filled in at startup from a TMDB list
  // (see loadExcludedMovieIds) — add IDs here by hand for one-off exclusions.
  excludedMovieIds: new Set([
  ]),
  excludedMovieListId: 27741, // TMDB list of X-Men films

  // Any film whose title matches this is excluded, whatever companies or
  // keywords TMDB lists for it. Catches the Fox-era Deadpool films
  // (Deadpool, Deadpool 2, Once Upon a Deadpool), which carry neither of
  // the company IDs above nor the MCU keyword. To block another franchise
  // by name, add it inside the brackets with a | between names,
  // e.g. /\b(deadpool|venom)\b/i
  excludedTitlePattern: /\b(deadpool)\b/i,

  // Obscure and unreleased films are dropped (same values as daily-puzzle.js).
  minPopularity: 3,
  minVoteCount: 50,
  allowUnreleasedMovies: false,

  // Well-known actor names to seed pair-finding for the game. Add more —
  // the wider this pool, the better the variety of start/end pairs.
  // Matched against TMDB's spelling ignoring capitals and accents, and any
  // seed that can't be found is named in the log (see findGoodPairs).
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

  // Only keep pairs whose true shortest path is in this range — too close is
  // boring, too far is frustrating for a "guess the chain" game.
  minPairDistance: 2,
  maxPairDistance: 5,

  // Be polite to TMDB's rate limit (40 req / 10s on the free tier).
  requestsPerBatch: 20,
  batchPauseMs: 10_000,
  maxRetries: 5, // for 429s and transient 5xx errors, with backoff
};

CONFIG.actorPoolPages = Math.ceil(CONFIG.actorPoolSize / 20);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cachePath(key) {
  const safe = key.replace(/[^a-z0-9_-]/gi, "_");
  return path.join(CONFIG.cacheDir, `${safe}.json`);
}

// Lowercase, trimmed, accents stripped — so "Penelope Cruz" in the seed list
// still finds TMDB's "Penélope Cruz".
function normName(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

// Simple on-disk cache so re-running the script doesn't re-fetch everything.
async function cachedFetch(cacheKey, url, attempt = 1) {
  const file = cachePath(cacheKey);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
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
    return cachedFetch(cacheKey, url, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`TMDB request failed (${res.status}): ${url}`);
  }
  const data = await res.json();
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

// A rate-limited request queue. Call rateLimiter.run(() => cachedFetch(...)).
function makeRateLimiter({ requestsPerBatch, batchPauseMs }) {
  let count = 0;
  return async function run(fn) {
    if (count > 0 && count % requestsPerBatch === 0) {
      process.stdout.write(
        `  ...pausing ${batchPauseMs}ms for TMDB rate limit (${count} requests so far)\n`
      );
      await sleep(batchPauseMs);
    }
    count += 1;
    return fn();
  };
}

const limiter = makeRateLimiter(CONFIG);

// ---------------------------------------------------------------------------
// Step 0: load the hand-kept list of extra movies to exclude (X-Men films)
// ---------------------------------------------------------------------------

async function loadExcludedMovieIds() {
  const url = `${CONFIG.baseUrl}/list/${CONFIG.excludedMovieListId}?language=en-US`;
  const data = await limiter(() => cachedFetch(`list_${CONFIG.excludedMovieListId}`, url));
  for (const item of data.items || []) {
    CONFIG.excludedMovieIds.add(item.id);
  }
  console.log(`Loaded ${CONFIG.excludedMovieIds.size} individually excluded movies.`);
}

// ---------------------------------------------------------------------------
// Step 1: pull the popular-actor pool
// ---------------------------------------------------------------------------

async function fetchActorPool() {
  console.log(`Fetching ${CONFIG.actorPoolSize} popular actors...`);
  const people = [];
  for (let page = 1; page <= CONFIG.actorPoolPages; page++) {
    const url = `${CONFIG.baseUrl}/person/popular?language=en-US&page=${page}`;
    const data = await limiter(() => cachedFetch(`popular_page_${page}`, url));
    for (const person of data.results || []) {
      // known_for_department filters out crew-heavy profiles (directors, etc.)
      if (person.known_for_department === "Acting") {
        people.push(person);
      }
    }
    if (page % 10 === 0) {
      console.log(`  page ${page}/${CONFIG.actorPoolPages} (${people.length} actors so far)`);
    }
  }
  return people.slice(0, CONFIG.actorPoolSize);
}

// ---------------------------------------------------------------------------
// Step 2: pull movie credits per actor
// ---------------------------------------------------------------------------

async function fetchActorCredits(personId) {
  const url = `${CONFIG.baseUrl}/person/${personId}/movie_credits?language=en-US`;
  return limiter(() => cachedFetch(`credits_person_${personId}`, url));
}

// ---------------------------------------------------------------------------
// Step 3: pull movie details (cast, genres, companies)
// ---------------------------------------------------------------------------

async function fetchMovieDetails(movieId) {
  const url = `${CONFIG.baseUrl}/movie/${movieId}?language=en-US&append_to_response=credits,keywords`;
  return limiter(() => cachedFetch(`movie_${movieId}`, url));
}

// ---------------------------------------------------------------------------
// Step 4: filters
// ---------------------------------------------------------------------------

function isMarvelMovie(movieDetails) {
  if (CONFIG.excludedMovieIds.has(movieDetails.id)) return true;
  if (CONFIG.excludedTitlePattern && CONFIG.excludedTitlePattern.test(movieDetails.title || "")) return true;

  const companyIds = (movieDetails.production_companies || []).map((c) => c.id);
  if (companyIds.some((id) => CONFIG.marvelCompanyIds.has(id))) return true;

  // append_to_response=keywords puts movie keyword data under .keywords.keywords
  // (TV keyword responses use a different shape: .keywords.results — not
  // relevant here since this script only pulls movie details).
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
  if (!CONFIG.allowUnreleasedMovies && !movieDetails.release_date) return true;
  // ?? 0 so a missing or zero value is compared honestly against the threshold.
  if ((movieDetails.popularity ?? 0) < CONFIG.minPopularity) return true;
  if ((movieDetails.vote_count ?? 0) < CONFIG.minVoteCount) return true;
  return false;
}

function isFictionalCastCredit(castMember) {
  const character = castMember.character || "";
  if (!character.trim()) return false;
  return !CONFIG.selfAppearancePattern.test(character.trim());
}

// ---------------------------------------------------------------------------
// Main build: crawl actors -> movies -> filtered graph
// ---------------------------------------------------------------------------

async function buildGraph() {
  ensureDir(CONFIG.cacheDir);
  ensureDir(CONFIG.outDir);

  await loadExcludedMovieIds();

  const actorPool = await fetchActorPool();
  const actorPoolIds = new Set(actorPool.map((a) => a.id));
  const poolById = new Map(actorPool.map((a) => [a.id, a]));
  const seedNames = new Set(CONFIG.seedActorNames.map(normName));

  const actors = {}; // id -> { name, movies: [movieId,...], photo? }
  const movies = {}; // id -> { title, cast: [actorId,...] }
  const seenMovieIds = new Set();

  console.log(`Fetching credits for ${actorPool.length} actors...`);
  let processed = 0;
  for (const person of actorPool) {
    const credits = await fetchActorCredits(person.id);
    const castCredits = (credits.cast || []).filter(isFictionalCastCredit);

    for (const credit of castCredits) {
      seenMovieIds.add(credit.id);
    }

    processed += 1;
    if (processed % 250 === 0) {
      console.log(`  ${processed}/${actorPool.length} actors processed`);
    }
  }

  console.log(`Found ${seenMovieIds.size} distinct movies. Fetching details...`);
  let movieCount = 0;
  for (const movieId of seenMovieIds) {
    let details;
    try {
      details = await fetchMovieDetails(movieId);
    } catch (err) {
      console.warn(`  skipping movie ${movieId}: ${err.message}`);
      continue;
    }

    movieCount += 1;
    if (movieCount % 250 === 0) {
      console.log(`  ${movieCount}/${seenMovieIds.size} movies fetched`);
    }

    if (isMarvelMovie(details)) continue;
    if (isNonFictionMovie(details)) continue;
    if (isUnpopularOrUnreleasedMovie(details)) continue;

    const fullCast = ((details.credits && details.credits.cast) || [])
      .filter(isFictionalCastCredit)
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
      .slice(0, CONFIG.maxCastPerMovie);

    // Only keep cast members who are in our actor pool — this is what keeps
    // the graph bounded instead of ballooning to every co-star of a co-star.
    const castInPool = fullCast
      .map((c) => c.id)
      .filter((id) => actorPoolIds.has(id));

    if (castInPool.length < 2) continue; // no edge value if <2 pool actors share it

    movies[movieId] = {
      title: details.title,
      year: (details.release_date || "").slice(0, 4) || null,
      cast: castInPool,
    };

    for (const actorId of castInPool) {
      if (!actors[actorId]) {
        const person = poolById.get(actorId);
        actors[actorId] = { name: person ? person.name : `#${actorId}`, movies: [] };
        // Photo only for seed actors: they're the only ones who can be a
        // START or FINISH, which is the only place the game shows a photo.
        // Adding one to all ~5000 actors would just bloat actors.json.
        if (person && person.profile_path && seedNames.has(normName(person.name))) {
          actors[actorId].photo = person.profile_path;
        }
      }
      actors[actorId].movies.push(Number(movieId));
    }
  }

  // Drop actors who ended up with no surviving edges (e.g. their only pool
  // co-appearances were all Marvel/non-fiction and got filtered out).
  for (const [id, actor] of Object.entries(actors)) {
    if (actor.movies.length === 0) delete actors[id];
  }

  console.log(
    `Graph built: ${Object.keys(actors).length} actors, ${Object.keys(movies).length} movies.`
  );

  return { actors, movies };
}

// ---------------------------------------------------------------------------
// Step 7: find good start/end pairs among well-known actors via BFS
// ---------------------------------------------------------------------------

function bfsDistance(startId, endId, actors, movies) {
  if (startId === endId) return 0;
  const visited = new Set([startId]);
  let frontier = [startId];
  let distance = 0;

  while (frontier.length > 0) {
    distance += 1;
    const next = [];
    for (const actorId of frontier) {
      const actor = actors[actorId];
      if (!actor) continue;
      for (const movieId of actor.movies) {
        const movie = movies[movieId];
        if (!movie) continue;
        for (const coStarId of movie.cast) {
          if (coStarId === endId) return distance;
          if (!visited.has(coStarId)) {
            visited.add(coStarId);
            next.push(coStarId);
          }
        }
      }
    }
    frontier = next;
    if (distance > CONFIG.maxPairDistance + 1) break; // give up past our range of interest
  }
  return -1; // no path found within the search depth
}

function findGoodPairs(actors, movies) {
  const nameToId = {};
  for (const [id, actor] of Object.entries(actors)) {
    nameToId[normName(actor.name)] = Number(id);
  }

  // A seed that isn't found used to be dropped without a word, so a typo
  // quietly removed that actor from the game. Now they're named in the log.
  const seedIds = [];
  const missing = [];
  for (const name of CONFIG.seedActorNames) {
    const id = nameToId[normName(name)];
    if (id === undefined) missing.push(name);
    else seedIds.push(id);
  }

  console.log(
    `Computing pairwise distances among ${seedIds.length}/${CONFIG.seedActorNames.length} ` +
      `seed actors found in the graph...`
  );
  if (missing.length) {
    console.log(
      `  Seeds NOT found (check the spelling, or they aren't in the top ` +
        `${CONFIG.actorPoolSize} popular actors): ${missing.join(", ")}`
    );
  }

  const pairs = [];
  for (let i = 0; i < seedIds.length; i++) {
    for (let j = i + 1; j < seedIds.length; j++) {
      const a = seedIds[i];
      const b = seedIds[j];
      const distance = bfsDistance(a, b, actors, movies);
      if (distance >= CONFIG.minPairDistance && distance <= CONFIG.maxPairDistance) {
        pairs.push({ a, b, distance });
      }
    }
  }

  console.log(`Found ${pairs.length} usable pairs (distance ${CONFIG.minPairDistance}-${CONFIG.maxPairDistance}).`);
  return pairs;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const { actors, movies } = await buildGraph();
  const pairs = findGoodPairs(actors, movies);

  fs.writeFileSync(path.join(CONFIG.outDir, "actors.json"), JSON.stringify(actors));
  fs.writeFileSync(path.join(CONFIG.outDir, "movies.json"), JSON.stringify(movies));
  fs.writeFileSync(path.join(CONFIG.outDir, "pairs.json"), JSON.stringify(pairs));

  console.log(`\nDone. Output written to ${CONFIG.outDir}/`);
  console.log(`  actors.json  (${Object.keys(actors).length} actors)`);
  console.log(`  movies.json  (${Object.keys(movies).length} movies)`);
  console.log(`  pairs.json   (${pairs.length} start/end pairs)`);
  console.log(`\nNext: gzip these (or let GoDaddy's server do it) and upload alongside game.js.`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
