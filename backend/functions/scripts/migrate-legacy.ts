/**
 * Copy the website's league into the new multi-league layout.
 *
 *   npm run migrate -- --league-id original --owner-email you@example.com --dry-run
 *   npm run migrate -- --league-id original --owner-email you@example.com
 *
 * --owner-email names the website manager who becomes the league's owner. The
 * website's own admin flags are ignored (anyone could have set them); the
 * report lists who had one so the owner can promote them again in the app.
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

const leagueId = value("league-id"), ownerEmail = value("owner-email");
if (!leagueId || !ownerEmail) {
  console.error("Usage: npm run migrate -- --league-id <id> --owner-email <email> [--dry-run] [--allow-unmatched]");
  process.exit(1);
}

initializeApp({ projectId: value("project") ?? "plleague" });
migrateLegacy(getFirestore(), { leagueId, ownerEmail, dryRun: flag("dry-run"), allowUnmatched: flag("allow-unmatched") })
  .then(r => {
    console.log(JSON.stringify(r, null, 2));
    if (!flag("dry-run")) console.log(`\nMigrated. Managers with an email on the website land in the league when they sign in with it; anyone else joins with invite code ${r.inviteCode}.`);
  })
  .catch(e => { console.error(e.message); process.exit(1); });
