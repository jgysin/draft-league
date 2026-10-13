# Draft League backend

Firebase backend for the Draft League iPhone app: many leagues, invite codes,
server-side rules for every roster move, and stats pulled automatically from the
official FPL API. It lives in the existing `plleague` Firebase project alongside
the website, which keeps working on its own root collections until cutover.

## Layout

```
firebase.json, .firebaserc       Firebase CLI config (project: plleague)
firestore.rules                  Security rules (tests: functions/test/integration/rules.test.ts)
firestore.indexes.json           Composite indexes the functions query with
functions/src/core/              Pure logic: types, scoring, snake draft, waivers, round robin
functions/src/fpl/               FPL API parsing and the scheduled sync
functions/src/league/            Callable functions, one file per area
functions/src/migrate/legacy.ts  One-off copy of the website's league
functions/scripts/               CLI wrapper for the migration
```

## Data model

Player ids are FPL `code`s (as strings). Unlike FPL element ids they don't change
between seasons, and the official headshot URLs use them.

| Path | Written by | Contents |
| --- | --- | --- |
| `players/{code}` | sync | name, full name, position, club, availability status and news |
| `fpl/current` | sync | season, gameweek deadlines, element id → code map |
| `fpl/catalog` | sync | every player in one doc (`{c, n, f, p, t, s}`) so the app loads the pool in one read |
| `seasons/{season}/gameweeks/{gw}` | sync | `stats: {code: {apps, minutes, goals, assists, cs, yc, rc, og}}`, `final` |
| `inviteCodes/{code}` | functions | `{leagueId}`; not readable by clients |
| `leagues/{id}` | functions | name, season, inviteCode, memberUids, scoring, h2h, waivers, bankedGw |
| `leagues/{id}/members/{memberId}` | functions | teamName, uid (null until claimed), email, role (owner/admin/member), roster |
| `leagues/{id}/draft/state` | functions | status, order, rounds, quotas, picks |
| `leagues/{id}/gameweeks/{gw}` | sync | `owners: {code: memberId}` banked at the deadline |
| `leagues/{id}/meta/standings` | functions | per-gameweek points, totals, H2H table, awards |
| `leagues/{id}/meta/schedule` | functions | H2H pairs per gameweek as `"a|b"` strings |
| `leagues/{id}/meta/nicknames` | functions | `{code: nickname}` |
| `leagues/{id}/trades`, `waivers`, `txns` | functions | trade offers, pending claims, transaction log |
| `leagues/{id}/chat` | clients | `{uid, memberId, text, ts}`; the only thing clients write |
| `users/{uid}` | clients | displayName, pushTokens (for step 2) |

Clients only read, plus post chat and edit their own profile. Every other write
goes through a callable function (`functions/src/index.ts` lists them) that checks
membership, turn order, roster locks and quotas inside a transaction.

### Scoring

* Ownership is banked when each gameweek's deadline passes: you score for the
  players on your roster at the deadline, and later moves never shift points
  already earned. (The website banked ownership when stats were typed in.)
* `fplTick` runs every 10 minutes. It refreshes deadlines (and the player
  catalog twice a day), banks any deadlines that passed, re-pulls live stats for
  every started gameweek FPL hasn't marked `data_checked`, and rescores leagues.
* Standings are recomputed in full each time, so scoring changes are retroactive.
  Double gameweeks count appearances and clean sheets per fixture.
* A league created mid-season starts scoring from the next deadline.

## One-time setup (Jesse)

1. **Upgrade `plleague` to the Blaze (pay-as-you-go) plan** in the Firebase
   console. Cloud Functions and scheduled jobs need it. A friends league stays
   well inside the free allowance; setting a budget alert at $1 is a good idea.
2. **Check the Firestore location** (Firestore → Settings). If it isn't in the
   US, change `REGION` in `functions/src/admin.ts` to the matching region (for
   example `europe-west2` for London) so functions sit next to the database.
3. **Add a deploy key so merges to `main` deploy automatically:**
   Google Cloud console → IAM & Admin → Service accounts → create
   `github-deploy` with roles *Firebase Admin*, *Cloud Functions Admin*,
   *Service Account User*, *Cloud Scheduler Admin* and *Artifact Registry
   Administrator*, then Keys → Add key → JSON. Paste the whole JSON file into a
   GitHub repository secret named `FIREBASE_SERVICE_ACCOUNT` (repo → Settings →
   Secrets and variables → Actions). Without the secret, CI still runs the tests
   and simply skips the deploy.

   Or deploy by hand: `cd backend && npx --prefix functions firebase deploy --only functions,firestore`.
4. **Migrate the current league** once the first deploy is live and `fplTick`
   has run once (it fills `players/`):

   ```
   cd backend/functions
   gcloud auth application-default login     # or GOOGLE_APPLICATION_CREDENTIALS=<key.json>
   npm run migrate -- --league-id original --dry-run
   npm run migrate -- --league-id original
   ```

   The dry run lists any players it can't match to FPL (players added by hand on
   the website). Re-run with `--allow-unmatched` to drop them. Every manager
   with an email assigned on the website lands in the league as soon as they
   sign in to the app; anyone else can join with the printed invite code.

## Development

```
cd backend/functions
npm ci
npm run typecheck
npm test            # unit tests, then integration + rules tests in the Firestore emulator (needs Java 11+)
```
