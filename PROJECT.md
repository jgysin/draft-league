# Draft League — project notes

Fantasy Premier League app for Jesse (<gysin.jesse@gmail.com>) and friends. Single self-contained HTML file, no build step, no framework.

## Live deployment

- URL: <https://utter-woke-nonsense.com/> (custom domain).
- Hosting: GitHub Pages, repo `jgysin/draft-league`, deploy from `main` branch, `/` root.
- Custom domain is set via the `CNAME` file in the repo root (contents: `utter-woke-nonsense.com`). GitHub Pages reads it on deploy.
- Repo contains `index.html` (the app), `CNAME` (custom domain), and `.nojekyll` (required — first deploy failed without it).
- Update flow: edit `index.html` and push to `main`; Claude pushes updates via the GitHub connector.

### DNS (at the registrar for utter-woke-nonsense.com)

Apex/root domain → point at GitHub Pages with A records:

- `185.199.108.153`
- `185.199.109.153`
- `185.199.110.153`
- `185.199.111.153`

(Optional IPv6 AAAA: `2606:50c0:8000::153`, `…8001::153`, `…8002::153`, `…8003::153`.)
Optional `www` subdomain → CNAME to `jgysin.github.io`. Enable "Enforce HTTPS" in the repo's Pages settings once the cert provisions.

## Files

- `index.html` — deploy-ready app WITH Firebase config baked in.
- `draft-league-live.html` — same code, unbaked master (config marker `/*__CFG__*/null`). To bake: replace that marker with the JSON config below, save as `index.html`.

## Auth — Google (Gmail) sign-in

The app uses **Firebase Authentication with Google sign-in only** (no passwords). Firebase Auth SDK v10.12.2 is dynamically imported alongside app/firestore; sign-in uses `signInWithPopup(GoogleAuthProvider)`, and sessions come from `onAuthStateChanged`.

- **Identity mapping:** each manager doc has an `email` field. A signed-in Google account is matched to its manager by email (case-insensitive). The commissioner pre-assigns these emails in Settings.
- **Commissioner:** `meta/config.commissionerEmail` always has admin access (even with no manager row). This replaces the old commissioner PIN. Change it to hand off the league.
- **Bootstrap/migration:** a league with no `commissionerEmail` set yet grants admin to the first signed-in user (with a ⚠ banner), so an existing league can be claimed and emails assigned.
- **Unknown accounts:** a signed-in Google user with no matching manager email and not the commissioner is shown as "not on roster" and has no manager/admin powers.

### Firebase Console prerequisites (one-time, per project)

- **Authentication → Sign-in method → Google → Enable** (set a support email).
- **Authentication → Settings → Authorized domains →** must include the live domain(s): `utter-woke-nonsense.com`, `www.utter-woke-nonsense.com`, and `jgysin.github.io`. `localhost` and `*.firebaseapp.com` are there by default. Missing domain → sign-in rejected with `auth/unauthorized-domain`.

## Firebase (backend)

- Project `plleague`, Firestore in test mode with rules `allow read, write: if true;` (friends-league honor system; transaction log provides accountability).
- Config baked into `index.html`:

```json
{"apiKey":"AIzaSyC1R_499lbW7pJODNvM1yWNUX9blw_9hx8","authDomain":"plleague.firebaseapp.com","projectId":"plleague","storageBucket":"plleague.firebasestorage.app","messagingSenderId":"549468608800","appId":"1:549468608800:web:77089309725edad1525f45"}
```

(The `apiKey` is not a secret — it identifies the project and is fine to ship in a public page.)

- SDK: Firebase JS v10.12.2 modular, dynamically imported from gstatic CDN. `initializeFirestore(app, {experimentalAutoDetectLongPolling: true})`; `getAuth(app)` for auth.

## Firestore data model

- `meta/config` — `{leagueName, commissionerEmail, scoring{...}, h2h}` (legacy `adminPin` may still be present on old configs; unused).
- `meta/players` — registry: `pid → {name, full, position, club, code (FPL photo id), nickname}`.
- `meta/pool` — `{list: [{n, f, p, c, code}], count, updated}` — pasted-in FPL bootstrap-static data.
- `meta/draft` — `{status: setup|live|done, order[], rounds, quotas{GK,DEF,MID,FWD}, picks[{mid,pid}]}`.
- `meta/schedule` — h2h round-robin: `{"1": ["midA|midB", ...], ... "38": [...]}` (pairs as strings — Firestore forbids nested arrays).
- `managers/{mid}` — `{name, email (Google address, "" = unassigned), admin (bool), roster[pid]}`.
- `gameweeks/{gw}` — `{stats: {pid: {played,goals,assists,cs,yc,rc,og}}, owners: {pid: mid}}`.
- `chat/{auto}` — `{ts, name, text}`; `trades/{auto}` — `{ts, from, to, give[], get[], note, status}`; `txns/{auto}` — `{ts, text}`.

## Key design decisions

- Scoring: raw stats stored per GW; points computed client-side from `meta/config.scoring`, so scoring changes retroactively re-score everything. Per-position goal/CS values.
- Ownership banking: `gameweeks.owners` maps player→manager at stat-entry time. Manager totals sum only players they owned that GW — drops/trades don't move past points.
- Auth: Google sign-in only (see Auth section). Managers are identified by their pre-assigned Google email; the commissioner email holds admin. Per-manager `admin` flag = full commissioner powers.
- Player pool: no API fetch (CORS); commissioner pastes `fantasy.premierleague.com/api/bootstrap-static/` JSON into Settings → parsed to `meta/pool`. Photos: `resources.premierleague.com/premierleague/photos/players/110x140/p{code}.png` (grayscale-filtered to match aesthetic, onerror hides).
- Draft: snake, casual/async (no clock), admin can pick for absent managers, custom per-position quota caps (0 = unlimited), rosters/trades locked while draft is live.
- Trades: multi-player (checkbox both sides, uneven allowed), target accepts/rejects, proposer cancels, admin vetoes; accept validates rosters, voids if a player moved.
- H2H mode: optional (`config.h2h` + generated schedule). W=3/D=1/L=0, total points tiebreak. Circle-method round robin over 38 GWs; regenerate after roster of managers changes.
- Awards/recap: computed live (manager of week, top player, wooden spoon) on Standings; admin button on Gameweek tab posts recap + h2h results to chat (name "recap").
- Chart: inline SVG cumulative points race on Standings (no chart lib), shows at 2+ entered GWs.
- Style: typewriter aesthetic — Courier Prime/Courier New, paper `#faf6ef`, ink `#1c1b1a`, coral `#e4572e` / blue `#2e6fe4` accents, dashed rules, uppercase letter-spaced headers.
- All inline onclick handlers must be exposed via `Object.assign(window, {...})` at the bottom of the module script (`type="module"` scoping).

## Gotchas

- Keep `.nojekyll` in the repo or Pages builds fail.
- Keep `CNAME` in the repo or the custom domain resets on the next deploy. GitHub Pages HTTPS cert can take a few minutes to provision after the DNS/CNAME first go live.
- Any new live domain must be added to Firebase **Authorized domains** or Google sign-in fails there.
- The bake marker string is constructed dynamically in `bakeDownload()` so it appears exactly once in source.
- FPL data too large for fetch tools; parser verified against real data (elements: `web_name`, `first_name`, `second_name`, `element_type` 1-4 → GK/DEF/MID/FWD, `team` → `teams[].short_name`, `code`).
- Chat renders with `white-space: pre-wrap` (recap messages are multi-line).
