/**
 * Copy the website's league into the new multi-league layout.
 *
 *   npm run migrate -- --league-id original --dry-run
 *   npm run migrate -- --league-id original
 *
 * Needs admin credentials for the plleague project, e.g. `gcloud auth
 * application-default login` or GOOGLE_APPLICATION_CREDENTIALS pointing at a
 * service account key. Add --allow-unmatched to drop players that can't be
 * matched to the FPL catalog.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { migrateLegacy } from "../src/migrate/legacy";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const leagueId = value("league-id");
if (!leagueId) { console.error("Usage: npm run migrate -- --league-id <id> [--dry-run] [--allow-unmatched]"); process.exit(1); }

initializeApp({ projectId: value("project") ?? "plleague" });
migrateLegacy(getFirestore(), { leagueId, dryRun: flag("dry-run"), allowUnmatched: flag("allow-unmatched") })
  .then(r => {
    console.log(JSON.stringify(r, null, 2));
    if (!flag("dry-run")) console.log(`\nMigrated. Friends join by signing in with their Google email, or with invite code ${r.inviteCode}.`);
  })
  .catch(e => { console.error(e.message); process.exit(1); });
