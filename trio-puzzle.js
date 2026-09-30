/**
 * trio-puzzle.js
 *
 * Daily generator for Marvelless Trio. Runs in GitHub Actions the same way
 * daily-puzzle.js does (see .github/workflows/trio-puzzle.yml), and you can
 * test it by hand with `TMDB_KEY=xxx node trio-puzzle.js`.
 *
 * What a Trio puzzle is:
 *   - three actors (A, B, C) shown to the player
 *   - the player guesses an actor who has shared a film with EACH of them
 *   - A, B and C have never shared a film with each other, so every valid
 *     answer has to bridge three different films
 *
 * How it picks one:
 *   1. Pick an answer actor X from the seed list.
 *   2. Look at X's best-known films and collect the actors billed near the
 *      top of the cast in each. Those are the candidates for A, B and C.
 *   3. Shuffle the candidates and keep the first three whose full
 *      filmographies don't overlap each other.
 *   4. Fetch the films for A, B and C (plus X's films) and write them out.
 *      That's all the game needs to check any guess.
 *
 * Same Marvel / X-Men / non-fiction / popularity filters as daily-puzzle.js.
 * They are copied rather than shared so this script has no dependency on the
 * other one, so if you change the filters there, mirror the change here.
 *
 * Output: out/trio-data.js, a single file that assigns window.TRIO_DATA.
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
  outDir: process.env.OUT_DIR || path.join(__dirname, "out"),
  cacheDir: process.env.CACHE_DIR || path.join(__dirname, "cache"),

  // ---- filters (mirrors daily-puzzle.js) ----
  maxCastPerMovie: 20,
  excludedGenreIds: new Set([99]), // Documentary
  selfAppearancePattern:
    /^(self|himself|herself|themselves|host|presenter|narrator|interviewee|archive footage)\b/i,
  marvelCompanyIds: new Set([420, 7505]),
  excludedKeywordIds: new Set([180547]),
  excludedMovieIds: new Set(),
  minPopularity: 3,
  minVoteCount: 50,
  allowUnreleasedMovies: false,

  // ---- Trio-specific ----
  // Answer actors and autocomplete decoys come from this list.
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
    "Robert Downey Jr.", "Cillian Murphy", "Keanu Reeves", "Willem Dafoe",
    "Nicolas Cage", "Oscar Isaac", "Anthony Hopkins", "Jodie Foster",
    "Hilary Swank", "Margot Robbie", "Helen Mirren", "Michael Caine",
    "Ryan Gosling", "Ben Affleck", "Emma Watson"
  ],

  maxAnswerMovies: 25,        // how many of X's films to scan for candidates
  linkMinVoteCount: 500,      // the film linking X to A/B/C must be well known
  linkMaxBillingOrder: 5,     // A/B/C must be billed in the top N of that film
  maxCandidateChecks: 15,     // filmographies fetched while hunting for a trio
  maxMoviesPerActor: 60,      // films kept per trio actor (best known first)
  minValidAnswers: 1,         // how many actors can complete the trio, in the data
  maxValidAnswers: 8,         // too many valid answers makes the puzzle easy

  maxAttempts: 6,

  requestsPerBatch: 20,
  batchPauseMs: process.env.BATCH_PAUSE_MS !== undefined ? Number(process.env.BATCH_PAUSE_MS) : 10_000,
  maxRetries: 5,
};

// ---------------------------------------------------------------
// TMDB plumbing (same behaviour as daily-puzzle.js)
// ---------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRateLimiter({ requestsPerBatch, batchPauseMs }) {
  let count = 0;
  return async function run(fn) {
    if (count > 0 && count % requestsPerBatch === 0 && batchPauseMs > 0) {
      console.log(`  ...pausing ${batchPauseMs}ms for TMDB rate limit`);
      await sleep(batchPauseMs);
    }
    count += 1;
    return fn();
  };
}
const limiter = makeRateLimiter(CONFIG);

function cachePathFor(urlPath) {
  const safe = urlPath.replace(/[^a-z0-9_-]/gi, "_");
  return path.join(CONFIG.cacheDir, `${safe}.json`);
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
    if (!res.ok) throw new Error(`TMDB X-Men list request failed (${res.status}): ${url}`);
    data = await res.json();
    fs.mkdirSync(CONFIG.cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }

  for (const item of data.items || []) CONFIG.excludedMovieIds.add(item.id);
}

async function tmdb(urlPath, attempt = 1) {
  const file = cachePathFor(urlPath);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));

  const url = `${CONFIG.baseUrl}${urlPath}`;
  return limiter(async () => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TMDB_KEY}` } });

    if (res.status === 429 || res.status >= 500) {
      if (attempt > CONFIG.maxRetries) {
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
    fs.mkdirSync(CONFIG.cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  });
}

// ---------------------------------------------------------------
// Filters (mirrors daily-puzzle.js)
// ---------------------------------------------------------------
function isMarvelMovie(details) {
  if (CONFIG.excludedMovieIds.has(details.id)) return true;
  const companyIds = (details.production_companies || []).map((c) => c.id);
  if (companyIds.some((id) => CONFIG.marvelCompanyIds.has(id))) return true;
  const keywordIds = ((details.keywords && details.keywords.keywords) || []).map((k) => k.id);
  return keywordIds.some((id) => CONFIG.excludedKeywordIds.has(id));
}

function isNonFictionMovie(details) {
  return (details.genres || []).some((g) => CONFIG.excludedGenreIds.has(g.id));
}

function isUnpopularOrUnreleasedMovie(details) {
  if (!CONFIG.allowUnreleasedMovies && !details.release_date) return true;
  if ((details.popularity ?? 0) < CONFIG.minPopularity) return true;
  if ((details.vote_count ?? 0) < CONFIG.minVoteCount) return true;
  return false;
}

function isFictionalCastCredit(castMember) {
  const character = castMember.character || "";
  if (!character.trim()) return false;
  return !CONFIG.selfAppearancePattern.test(character.trim());
}

// ---------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------
async function resolveActorId(name) {
  const data = await tmdb(`/search/person?query=${encodeURIComponent(name)}&language=en-US`);
  const match = (data.results || []).find((p) => p.known_for_department === "Acting");
  return match ? match.id : data.results && data.results[0] && data.results[0].id;
}

// An actor's fictional film credits, straight from TMDB (404 = merged/deleted person).
async function getCredits(actorId) {
  try {
    const credits = await tmdb(`/person/${actorId}/movie_credits?language=en-US`);
    return (credits.cast || []).filter(isFictionalCastCredit);
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

// Cheap pre-filter using fields already on a credit, so we don't spend a
// request on a film that is certain to be rejected. Marvel and popularity
// are still checked properly once the full details are loaded.
function creditLooksPlayable(credit) {
  if (!CONFIG.allowUnreleasedMovies && !credit.release_date) return false;
  if ((credit.vote_count ?? 0) < CONFIG.minVoteCount) return false;
  if ((credit.genre_ids || []).some((id) => CONFIG.excludedGenreIds.has(id))) return false;
  if (CONFIG.excludedMovieIds.has(credit.id)) return false;
  return true;
}

function bestKnownCredits(credits, limit) {
  return credits
    .filter(creditLooksPlayable)
    .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
    .slice(0, limit);
}

// Loads one film into the graph (or records it as excluded). The graph is
// { actors: {id: {name}}, movies: {id: {title, year, cast, voteCount, excluded}} }
async function loadMovie(movieId, graph) {
  if (graph.movies[movieId]) return graph.movies[movieId];

  let details;
  try {
    details = await tmdb(`/movie/${movieId}?language=en-US&append_to_response=credits,keywords`);
  } catch (err) {
    if (err.status === 404) return (graph.movies[movieId] = { excluded: true });
    throw err;
  }

  if (isMarvelMovie(details) || isNonFictionMovie(details) || isUnpopularOrUnreleasedMovie(details)) {
    return (graph.movies[movieId] = { excluded: true });
  }

  const cast = ((details.credits && details.credits.cast) || [])
    .filter(isFictionalCastCredit)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, CONFIG.maxCastPerMovie);

  for (const c of cast) {
    if (!graph.actors[c.id]) graph.actors[c.id] = { name: c.name };
  }

  return (graph.movies[movieId] = {
    title: details.title,
    year: (details.release_date || "").slice(0, 4) || null,
    cast: cast.map((c) => c.id),
    voteCount: details.vote_count ?? 0,
    excluded: false,
  });
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Every actor in the graph who shares a surviving film with `actorId`.
function costarsOf(graph, actorId) {
  const out = new Set();
  for (const m of Object.values(graph.movies)) {
    if (m.excluded || !m.cast.some((c) => String(c) === String(actorId))) continue;
    for (const c of m.cast) if (String(c) !== String(actorId)) out.add(String(c));
  }
  return out;
}

// ---------------------------------------------------------------
// Puzzle search
// ---------------------------------------------------------------
async function tryBuildPuzzle() {
  const answerName = shuffle(CONFIG.seedActorNames)[0];
  const answerId = await resolveActorId(answerName);
  if (!answerId) { console.log(`  could not resolve ${answerName}`); return null; }
  console.log(`  answer actor: ${answerName}`);

  const graph = { actors: {}, movies: {} };
  graph.actors[answerId] = { name: answerName };

  // 1. Candidates: actors billed near the top in X's best-known films.
  const xCredits = bestKnownCredits(await getCredits(answerId), CONFIG.maxAnswerMovies);
  const candidateIds = new Set();
  for (const credit of xCredits) {
    const movie = await loadMovie(credit.id, graph);
    if (movie.excluded || movie.voteCount < CONFIG.linkMinVoteCount) continue;
    for (const id of movie.cast.slice(0, CONFIG.linkMaxBillingOrder)) {
      if (String(id) !== String(answerId)) candidateIds.add(id);
    }
  }
  console.log(`  ${candidateIds.size} candidate costars from ${xCredits.length} films`);

  // 2. Keep the first three whose filmographies don't overlap.
  const chosen = [];
  let checks = 0;
  for (const id of shuffle([...candidateIds])) {
    if (chosen.length === 3 || checks >= CONFIG.maxCandidateChecks) break;
    checks += 1;
    const credits = await getCredits(id);
    const movieIds = new Set(credits.map((c) => c.id));
    const overlaps = chosen.some((ch) => [...movieIds].some((m) => ch.movieIds.has(m)));
    if (overlaps) continue;
    chosen.push({ id, credits, movieIds });
  }
  if (chosen.length < 3) {
    console.log(`  only found ${chosen.length} non-overlapping costars in ${checks} checks`);
    return null;
  }

  // 3. Load the trio's films so the game can check any guess.
  for (const ch of chosen) {
    for (const credit of bestKnownCredits(ch.credits, CONFIG.maxMoviesPerActor)) {
      await loadMovie(credit.id, graph);
    }
  }

  // 4. Validate against what will actually be shipped.
  const trioIds = chosen.map((c) => String(c.id));
  const common = trioIds
    .map((id) => costarsOf(graph, id))
    .reduce((acc, set) => new Set([...acc].filter((x) => set.has(x))));
  trioIds.forEach((id) => common.delete(id));

  if (!common.has(String(answerId))) {
    console.log("  answer actor is not connected to all three in the shipped data, skipping");
    return null;
  }
  if (common.size < CONFIG.minValidAnswers || common.size > CONFIG.maxValidAnswers) {
    console.log(`  ${common.size} valid answers (want ${CONFIG.minValidAnswers}-${CONFIG.maxValidAnswers}), skipping`);
    return null;
  }
  for (const m of Object.values(graph.movies)) {
    if (m.excluded) continue;
    const castSet = new Set(m.cast.map(String));
    if (trioIds.every((id) => castSet.has(id))) {
      console.log(`  all three share ${m.title}, skipping`);
      return null;
    }
  }

  console.log(`  trio: ${trioIds.map((id) => graph.actors[id].name).join(", ")}`);
  console.log(`  valid answers: ${[...common].map((id) => graph.actors[id].name).join(", ")}`);
  return { graph, trioIds, answerId: String(answerId), validCount: common.size };
}

function buildPayload({ graph, trioIds, answerId }) {
  const movies = {};
  const usedActors = new Set(trioIds.concat(answerId));
  for (const [id, m] of Object.entries(graph.movies)) {
    if (m.excluded) continue;
    movies[id] = { title: m.title, year: m.year, cast: m.cast };
    m.cast.forEach((c) => usedActors.add(String(c)));
  }
  const actors = {};
  for (const id of usedActors) {
    if (graph.actors[id]) actors[id] = { name: graph.actors[id].name };
  }

  // Names for autocomplete that are NOT in the data. They never match a film,
  // so guessing one is a valid, all-crosses guess, and they stop the
  // suggestion list from containing only relevant actors.
  const known = new Set(Object.values(actors).map((a) => a.name.toLowerCase()));
  const decoys = CONFIG.seedActorNames.filter((n) => !known.has(n.toLowerCase()));

  return {
    date: process.env.PUZZLE_DATE || new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    trio: trioIds,
    answer: answerId,
    actors,
    movies,
    decoys,
  };
}

async function main() {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
  await loadExcludedMovieIds();

  let result = null;
  for (let attempt = 1; attempt <= CONFIG.maxAttempts && !result; attempt++) {
    console.log(`Attempt ${attempt}`);
    result = await tryBuildPuzzle();
  }
  if (!result) {
    console.error(`Failed to generate a trio after ${CONFIG.maxAttempts} attempts.`);
    process.exit(1);
  }

  const payload = buildPayload(result);
  const js =
    `// Auto-generated by trio-puzzle.js. Do not edit by hand.\n` +
    `// Regenerated daily by the GitHub Actions workflow.\n` +
    `window.TRIO_DATA = ${JSON.stringify(payload)};\n`;

  const outFile = path.join(CONFIG.outDir, "trio-data.js");
  fs.writeFileSync(outFile, js);
  const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log(
    `\nWrote ${outFile} (${sizeKB} KB): ${payload.trio.map((id) => payload.actors[id].name).join(" / ")}, ` +
    `${Object.keys(payload.movies).length} movies, ${Object.keys(payload.actors).length} actors.`
  );
}

main().catch((err) => {
  console.error("trio-puzzle.js failed:", err);
  process.exit(1);
});
