# Marvelless Games

Daily movie-connection puzzles at [marvelless.games](https://marvelless.games). No MCU allowed.

This repository builds each day's puzzles. GitHub Actions runs a script for each game every morning; the script asks [TMDB](https://www.themoviedb.org) for actors and films, keeps only the ones that pass the Marvel and quality filters, and commits a small data file. The game pages load that file straight from this repo through jsDelivr, so there is no server or database to run.

| Game | How it plays | Page |
|---|---|---|
| **Six Degrees** | Link two actors through shared films, in 5 guesses. | [marvelless.games/6-degrees](https://marvelless.games/6-degrees) |
| **Trio** | Name one actor who has shared a film with all three on the board, in 4 guesses. | [marvelless.games/trio](https://marvelless.games/trio) |
| **Full Circle** | Start on one actor and link back to them in 3 to 6 films, never repeating a film or an actor. | [marvelless.games/full-circle](https://marvelless.games/full-circle) |

## What's in the repo

| File | What it is |
|---|---|
| `daily-puzzle.js` | Generator for Six Degrees. Writes `puzzle-data.js`. |
| `daily-loop.js` | Generator for Full Circle. Writes `loop-data.js`. |
| `trio-puzzle.js` | Generator for Trio. Writes `trio-data.js`. |
| `puzzle-data.js`, `loop-data.js`, `trio-data.js` | Today's puzzles. Rewritten every day by the workflows; don't edit by hand. |
| `.github/workflows/daily-puzzle.yml` | Runs the Six Degrees generator at 06:00 UTC. |
| `.github/workflows/daily-loop.yml` | Runs the Full Circle generator at 06:20 UTC. |
| `.github/workflows/` (Trio) | Runs the Trio generator. |
| `build-graph.js` | Older one-off builder that crawls a large actor pool into `actors.json`, `movies.json` and `pairs.json`. The live pages don't use it; its settings are kept in line with `daily-puzzle.js` for reference. |
| `cache/` | Saved TMDB answers. Not committed: the workflows store it with GitHub's Actions cache. |
| `out/` | Where each generator writes its file before the workflow moves it to the repo root. Not committed. |

## How a day's puzzle gets made

1. At 06:00 UTC a workflow starts (Full Circle waits until 06:20 so the two don't push at the same moment). GitHub often starts scheduled jobs a few minutes late, and each run takes a while, so a new puzzle appears a little after the hour.
2. The workflow restores the shared TMDB cache, runs the generator, and moves the output from `out/` to the repo root.
3. If the file changed, the workflow commits it as `github-actions[bot]` and pushes. If another workflow pushed first, it rebases and retries up to five times.
4. When someone opens a game, the page asks the GitHub API for the latest commit on `main` and loads the data file from jsDelivr pinned to that commit, so it always gets today's file rather than a cached copy. If the GitHub API can't be reached, it falls back to `@main` with a date stamp that rolls over at 06:00 UTC.

## Setup

1. **TMDB key.** Create a TMDB account and copy the **API Read Access Token** (the long one, not the short API key) from your TMDB account settings. The scripts send it as a `Bearer` token.
2. **Repository secret.** In this repo go to **Settings → Secrets and variables → Actions** and add a secret named `TMDB_KEY` holding that token.
3. **Workflow permissions.** Each workflow file already asks for `contents: write` so it can commit the data file. If your organisation restricts workflow permissions, allow read and write under **Settings → Actions → General**.

## Running a generator by hand

From the Actions tab, pick the workflow and press **Run workflow**. This is the quickest way to get a fresh puzzle after changing a setting.

To run one on your own computer (Node 18 or newer; the workflows use Node 24):

```bash
TMDB_KEY=your-read-access-token node daily-puzzle.js
TMDB_KEY=your-read-access-token node daily-loop.js
```

The result lands in `out/`. TMDB answers are saved in `cache/`, so a second run is much faster.

To try the Trio page against a local `trio-data.js`, open `trio.html` straight from disk or add `?local` to its address. Six Degrees and Full Circle always load from this repo.

## Changing what goes into a puzzle

Every setting lives in the `CONFIG` block at the top of each generator. The settings the scripts share should stay the same in all of them; `daily-puzzle.js` is the reference copy.

| Setting | What it controls |
|---|---|
| `seedActorNames` | Who can be a starting actor. Names are used to search TMDB, and the game shows the name as TMDB spells it, accents included. |
| `alwaysIncludeMovieIds` | Films to force into every puzzle, by TMDB id. |
| `popularPoolPages`, `recentPoolPages`, `recentPoolMonths` | The pool of well-known films loaded into every puzzle before anything else: by default TMDB's 800 most-voted films ever plus the 200 most-voted of the last 24 months. |
| `minPopularity`, `minVoteCount`, `allowUnreleasedMovies` | Drops obscure and unreleased films. |
| `maxCastPerMovie` | How many top-billed cast members count as being in a film (20). |
| `maxDiscoveredMovies` | Upper limit on films per puzzle (4,000). Higher means fuller filmographies, bigger files and longer runs. |
| `minPairDistance`, `maxPairDistance` | Six Degrees only: how far apart the two actors can be (2 to 5 films). |
| `minSteps`, `maxSteps` | Full Circle only: the allowed loop lengths (3 to 6). Set both to the same number for a fixed-length day. |
| `cacheDaysLists`, `cacheDaysMovies`, `cacheDaysNewMovies` | How long a saved TMDB answer is trusted before it's fetched again (7, 30 and 3 days). |

### Keeping Marvel out

A film is dropped if any of these match:

- **Production company** `marvelCompanyIds` (420, Marvel Studios; 19551).
- **TMDB keyword** `excludedKeywordIds` (180547, Marvel Cinematic Universe).
- **TMDB list 27741** of X-Men films, loaded at startup.
- **Title** `excludedTitlePattern`, currently any title containing *Deadpool* or *Spider-Man*.
- **Film id** in `excludedMovieIds`.

If a Marvel film still slips through, block it in every generator in one of two ways:

- **By name:** add it to the title pattern, separated by `|`, for example `/\b(deadpool|spider-?man|venom)\b/i`.
- **By film:** open the film on themoviedb.org and copy the number from its address (`themoviedb.org/movie/12345-some-title` is `12345`) into `excludedMovieIds`.

The change takes effect from the next generated puzzle.

## The TMDB cache

All the workflows restore and save the same Actions cache (key prefix `tmdb-cache-`), so each run builds on what earlier runs fetched. Saved answers expire on their own: an actor's film list after about 7 days, a film's details after about 30, and a film from the last 120 days after about 3, so new releases and growing vote counts are picked up.

To force everything to be fetched fresh, delete the caches under **Actions → Caches** and run the workflows again.

## The game pages

The pages are hosted on marvelless.games. Each one is a single self-contained HTML file in the same purple, magenta and gold look, and each points at this repo through `REPO = "ojm404/game1"` near the top of its script.

- **Daily reset** is at 06:00 UTC.
- **Progress:** Six Degrees and Full Circle start fresh on a refresh. **Start over** clears the board but keeps the clock running. Trio remembers the day's guesses.
- **Answers:** only Trio reveals possible answers after a loss.
- **Matching** ignores capitals and accents, so `penelope cruz` is accepted for Penélope Cruz.
- **Pick lists:** Six Degrees offers alphabetical film and co-star lists (each with its own checkbox) that open from the ▾ arrow without bringing up a phone keyboard.
- **Nicknames** are accepted in Six Degrees and Full Circle:

| Type this | For |
|---|---|
| `rpattz` | Robert Pattinson (Trio too) |
| `tim hortons swiss chalet` | Timothée Chalamet |
| `benadryl cucumberpatch` | Benedict Cumberbatch |
| `wooow` | Owen Wilson |
| `alright alright alright` | Matthew McConaughey |

- **Share bonuses:** the copied result gets an extra emoji for using Taylor Swift ✨, Stargate 🌀, Robert Pattinson 🧛 or Star Trek 🖖.

## Troubleshooting

**"Could not load today's puzzle."** Check the latest run in the Actions tab. If it failed, the log says why; a missing or expired `TMDB_KEY` is the usual cause. Fix it and press **Run workflow**.

**A well-known film isn't accepted.** Find the film's TMDB id and add it to `alwaysIncludeMovieIds`. If the actor in question is billed lower than 20th, raise `maxCastPerMovie`. A cast member with no character name listed on TMDB is skipped.

**A puzzle failed to generate.** The log names each attempt and why it was rejected (too close, too far, too few films, no loop found). Eight failed attempts end the run; running it again picks different actors.

**A seed actor never appears.** The log prints a note when a seed name resolves to a different spelling on TMDB. Check the spelling in `seedActorNames`.

## Credits

Film and actor data and photos come from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
