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
 * Same Marvel / X-Men / non-fiction / popularity filters and seed list as
 * daily-puzzle.js. They are copied rather than shared so this script has no
 * dependency on the other one, so if you change them there, mirror the
 * change here.
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

  // Production companies treated as Marvel. 420 and 19551 match
  // daily-puzzle.js; 7505 (Marvel Entertainment, the older Sony / Fox
  // Marvel films) was already here and is kept, since this game is where
  // Marvel films had been slipping through.
  marvelCompanyIds: new Set([420, 7505, 19551]),
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
  // Spider-Man pair and the animated Spider-Verse films. To block another
  // franchise by name, add it inside the brackets with a | between names,
  // e.g. /\b(deadpool|spider-?man|venom)\b/i
  excludedTitlePattern: /\b(deadpool|spider-?man)\b/i,

  minPopularity: 3,
  minVoteCount: 50,
  allowUnreleasedMovies: false,

  // How long a saved TMDB answer is trusted before it is fetched again
  // (same rules as daily-puzzle.js, which shares this cache). Vote counts
  // matter a lot here, since they decide which films count as "well
  // known", so keeping them fresh matters.
  cacheDaysLists: 7,         // an actor's film list, name searches, the X-Men list
  cacheDaysMovies: 30,       // a film's details and cast
  cacheDaysNewMovies: 3,     // ...when the film is new or not out yet
  newReleaseWindowDays: 120, // "new" = released within this many days

  // ---- Trio-specific ----
  // Answer actors and autocomplete decoys come from this list. Same list
  // as daily-puzzle.js. The names are only used to SEARCH TMDB; the name
  // shown in the game is the one TMDB sends back (see resolveActor).
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

  maxAnswerMovies: 25,        // how many of X's films to scan for candidates
  linkMinVoteCount: 1500,     // the film linking X to A/B/C must be well known
  linkMaxBillingOrder: 4,     // A/B/C must be billed in the top N of that film
  candidatePoolSize: 40,      // only the candidates from the best-known films are considered
  maxCandidateChecks: 30,     // filmographies fetched while hunting for a trio

  // How famous the three shown actors must be. A film counts as "big" once it
  // has this many TMDB votes, and each of A/B/C needs at least minFameFilms of
  // them in their credits. Raise either number for bigger names, lower them if
  // the generator starts failing to find a trio.
  fameFilmVoteCount: 3000,
  minFameFilms: 8,
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

// Lowercase, trimmed, accents stripped (same rule as the game pages).
function normName(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TMDB_KEY}` } });

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
    fs.mkdirSync(CONFIG.cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  });
}

// ---------------------------------------------------------------
// Filters (mirrors daily-puzzle.js)
// ---------------------------------------------------------------
function isExcludedTitle(title) {
  return Boolean(CONFIG.excludedTitlePattern && CONFIG.excludedTitlePattern.test(title || ""));
}

function isMarvelMovie(details) {
  if (CONFIG.excludedMovieIds.has(details.id)) return true;
  if (isExcludedTitle(details.title)) return true;
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

// Looks a seed name up on TMDB and returns the person's id and the name as
// TMDB spells it (accents and all — the name the game shows, which has to
// agree with the spelling in every film's cast list). Null if not found.
async function resolveActor(name) {
  const data = await tmdb(`/search/person?query=${encodeURIComponent(name)}&language=en-US`);
  const results = data.results || [];
  const match = results.find((p) => p.known_for_department === "Acting") || results[0];
  if (!match) return null;
  return { id: match.id, name: match.name || name };
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
  if (isExcludedTitle(credit.title)) return false;
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
    if (!graph.actors[c.id].photo && c.profile_path) graph.actors[c.id].photo = c.profile_path;
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
  const seedName = shuffle(CONFIG.seedActorNames)[0];
  const answer = await resolveActor(seedName);
  if (!answer) { console.log(`  could not resolve ${seedName}`); return null; }
  const answerId = answer.id, answerName = answer.name;
  console.log(`  answer actor: ${answerName}` + (answerName !== seedName ? ` (seed "${seedName}")` : ""));

  const graph = { actors: {}, movies: {} };
  graph.actors[answerId] = { name: answerName };

  // 1. Candidates: actors billed near the top in X's best-known films.
  const xCredits = bestKnownCredits(await getCredits(answerId), CONFIG.maxAnswerMovies);
  //    Each candidate is ranked by the best-known film they share with X, so
  //    co-leads of blockbusters come before supporting names.
  const candidateScore = new Map();   // actor id -> vote count of their best linking film
  for (const credit of xCredits) {
    const movie = await loadMovie(credit.id, graph);
    if (movie.excluded || movie.voteCount < CONFIG.linkMinVoteCount) continue;
    for (const id of movie.cast.slice(0, CONFIG.linkMaxBillingOrder)) {
      if (String(id) === String(answerId)) continue;
      candidateScore.set(id, Math.max(candidateScore.get(id) || 0, movie.voteCount));
    }
  }
  const candidateIds = [...candidateScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CONFIG.candidatePoolSize)
    .map(([id]) => id);
  console.log(`  ${candidateScore.size} candidate costars from ${xCredits.length} films, using the top ${candidateIds.length}`);

  // 2. Keep the first three whose filmographies don't overlap.
  const chosen = [];
  let checks = 0, notFamous = 0;
  for (const id of shuffle(candidateIds)) {
    if (chosen.length === 3 || checks >= CONFIG.maxCandidateChecks) break;
    checks += 1;
    const credits = await getCredits(id);
    const bigFilms = credits.filter(
      (c) => creditLooksPlayable(c) && (c.vote_count ?? 0) >= CONFIG.fameFilmVoteCount
    ).length;
    if (bigFilms < CONFIG.minFameFilms) { notFamous += 1; continue; }
    const movieIds = new Set(credits.map((c) => c.id));
    const overlaps = chosen.some((ch) => [...movieIds].some((m) => ch.movieIds.has(m)));
    if (overlaps) continue;
    chosen.push({ id, credits, movieIds });
  }
  if (chosen.length < 3) {
    console.log(
      `  only found ${chosen.length} usable costars in ${checks} checks ` +
      `(${notFamous} not famous enough, the rest overlapped)`
    );
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
    if (!graph.actors[id]) continue;
    actors[id] = { name: graph.actors[id].name };
    // Photos are only shown on the three tickets, so only those carry one.
    if (trioIds.includes(id) && graph.actors[id].photo) actors[id].photo = graph.actors[id].photo;
  }

  // Names for autocomplete that are NOT in the data. They never match a film,
  // so guessing one is a valid, all-crosses guess, and they stop the
  // suggestion list from containing only relevant actors. Compared ignoring
  // accents, so a seed spelled without one never shows up twice.
  const known = new Set(Object.values(actors).map((a) => normName(a.name)));
  const decoys = CONFIG.seedActorNames.filter((n) => !known.has(normName(n)));

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
