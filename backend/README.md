# Draft League backend

Firebase backend for the Draft League iPhone app: many leagues, invite codes,
server-side rules for every roster move, and stats pulled automatically from the
official FPL API. It lives in the existing `plleague` Firebase project alongside
the website, which keeps working on its own root collections until cutover.

Deploying these rules changes one thing for the website: writing to its
collections now needs a Google sign-in (reading stays open). Every write the
site makes was already behind its "Sign in with Google" button, so managers
should notice nothing; an anonymous script can no longer edit the league.

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
| `inviteCodes/{code}` | functions | `{leagueId}`; not readable by clients. Codes are 8 characters (older 6-character ones still work) |
| `leagues/{id}` | functions | name, season, inviteCode, memberUids, scoring, h2h, waivers, rosterLimit, bankedGw |
| `leagues/{id}/members/{memberId}` | functions | teamName, uid (null until claimed), role (owner/admin/member), roster |
| `leagues/{id}/slots/{memberId}` | functions | `{email, autoClaim}`: the email a team is reserved for. Private: functions only, not readable by clients |
| `leagues/{id}/draft/state` | functions | status, order, rounds, quotas, picks |
| `leagues/{id}/gameweeks/{gw}` | sync | `owners: {code: memberId}` banked at the deadline |
| `leagues/{id}/meta/standings` | functions | per-gameweek points, totals, H2H table, awards, `liveGw` (gameweeks not yet final) |
| `leagues/{id}/meta/schedule` | functions | H2H pairs per gameweek as `"a|b"` strings |
| `leagues/{id}/meta/nicknames` | functions | `{code: nickname}` |
| `leagues/{id}/trades`, `waivers`, `txns` | functions | trade offers, pending claims, transaction log |
| `leagues/{id}/chat` | clients | `{uid, memberId, text, ts}`; the only league data clients write |
| `users/{uid}` | clients | displayName, pushTokens (for step 2), updatedAt |

Clients only read, plus post chat and edit their own profile. Every other write
goes through a callable function (`functions/src/index.ts` lists them) that checks
membership, permissions, turn order and roster limits inside a transaction.
Position quotas apply to the draft only. Members read the league subcollections
named in `firestore.rules`; anything not named there, `slots` included, is
closed to them.

The callables accept App Check: set `ENFORCE_APP_CHECK=true` once the app ships
App Check, and requests from anything but the real app are refused. Until then
it is off.

### Scoring

* Ownership is banked exactly at each gameweek's deadline: you score for the
  players on your roster at the deadline, and later moves never shift points
  already earned. The scheduler banks from the deadlines it has stored, so it
  still banks on time if FPL is down. Any roster move made after a deadline
  banks that deadline first, inside the same transaction, so a move can't slip
  in ahead of it. (The website banked ownership when stats were typed in.)
* `fplTick` runs every 10 minutes. It refreshes deadlines (and the player
  catalog twice a day), banks any deadlines that passed, re-pulls live stats for
  every started gameweek FPL hasn't marked `data_checked`, and rescores leagues.
* Standings are recomputed in full each time, so scoring changes are retroactive.
  Double gameweeks count appearances and clean sheets per fixture.
* Head-to-head results count only finalised gameweeks. A gameweek still in
  play shows live points (it is listed in `liveGw`) but no win, draw or loss
  until FPL marks it final.
* Free agency, waiver claims and trades open once the draft is done.
* Rosters are capped at the draft's round count, unless the commissioner
  changes `rosterLimit`.
* A league created mid-season starts scoring from the next deadline.
* The historic gameweeks of a migrated league are rescored from official FPL
  stats, so totals can differ from what was typed in on the website.

## One-time setup (Jesse)

1. **Upgrade `plleague` to the Blaze (pay-as-you-go) plan** in the Firebase
   console. Cloud Functions and scheduled jobs require it; there is no free
   way to run this backend. A small league should cost cents per month at
   most. Set a budget alert (Billing → Budgets & alerts, $1 is fine), and know
   what it is: an alert only emails you. It does not cap spend or switch
   anything off.
2. **Check the Firestore location** (Firestore → Settings). If it isn't in the
   US, change `REGION` in `functions/src/admin.ts` to the matching region (for
   example `europe-west2` for London) so functions sit next to the database.
3. **Do the first deploy by hand, as the project owner:**

   ```
   firebase login
   cd backend && npx --prefix functions firebase deploy --only functions,firestore
   ```

   The first deploy has to grant IAM roles to Google's service agents, which
   needs owner-level access that a CI key should not have. Later deploys don't.

   Deploying the rules is also the moment website writes start to require a
   Google sign-in (see the top of this file).
4. **Then add a deploy key so merges to `main` deploy automatically.**
   Google Cloud console → IAM & Admin → Service accounts → create
   `github-deploy` with these roles, and no others:

   * Cloud Functions Admin
   * Cloud Run Admin
   * Firebase Rules Admin
   * Cloud Datastore Index Admin
   * Cloud Scheduler Admin
   * Eventarc Admin
   * Artifact Registry Writer
   * Service Usage Consumer
   * Service Account User, granted on the functions runtime service account
     only (open that service account → Permissions → Grant access), not on the
     whole project

   Do **not** give it Firebase Admin. Then Keys → Add key → JSON.

   In GitHub, create an environment named `production` (repo → Settings →
   Environments), restrict its deployment branches to `main`, and add the
   whole JSON file there as an environment secret named
   `FIREBASE_SERVICE_ACCOUNT`. An environment secret, unlike a repository
   secret, is only handed to runs on `main`. Delete the downloaded key file
   afterwards. Without the secret, CI still runs the tests and skips the deploy.

   Workload Identity Federation is the better long-term option: GitHub proves
   its identity to Google directly and there is no key to store or leak.
5. **Migrate the current league** once the first deploy is live and `fplTick`
   has run once (it fills `players/`). Take a Firestore export first, so there
   is something to go back to:

   ```
   gcloud firestore export gs://<a-bucket-you-own>/pre-migration --project plleague
   ```

   Then:

   ```
   cd backend/functions
   gcloud auth application-default login     # or GOOGLE_APPLICATION_CREDENTIALS=<key.json>
   npm run migrate -- --league-id original --owner-email <your google email> --dry-run
   npm run migrate -- --league-id original --owner-email <your google email>
   ```

   `--owner-email` is required: it names the league's owner. The script
   ignores the website's admin flags and commissioner email, because that data
   was publicly writable and anyone could have set them.

   The dry run prints every team and the email it is reserved for. Read that
   list before the real run, for the same reason: an email on the website is
   only as trustworthy as the website was. It also lists any players it can't
   match to FPL (players added by hand on the website); re-run with
   `--allow-unmatched` to drop them.

   Managers with an email on the website land in their team when they sign in
   to the app. Everyone else joins with the printed invite code.
6. **After everyone has moved**, delete the legacy block from
   `firestore.rules` and deploy. That closes the website's collections.

## Development

```
cd backend/functions
npm ci
npm run typecheck
npm test            # unit tests, then integration + rules tests in the Firestore emulator (needs Java 11+)
```
