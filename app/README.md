# Draft League iPhone app

Expo (React Native) app for Draft League, built on the backend in `../backend`.
iPhone first; Android can come later from the same code.

## What's here

* Sign in with Apple or Google. Anyone whose email the commissioner put on a team
  (including everyone migrated from the website) lands on that team automatically.
* Your leagues; start a league or join one with an invite code (8 characters;
  the 6-character codes from before still work).
* Per league: **Table** (total points or head to head, live from FPL), **Team**
  (your roster, drop players), **Players** (search free agents, add or claim),
  **Chat**, and **League** (invite code, teams, activity feed).
* The website's typewriter look in light and dark mode.

Still to come: see "Known gaps" at the end.

## Code map

```
src/app/                 Screens (Expo Router: every file is a route)
src/app/league/[id]/     League tabs
src/lib/firebase.ts      Firebase app, auth (persisted), Firestore, functions
src/lib/auth.tsx         Apple + Google sign-in
src/lib/api.ts           Typed wrappers for the backend's callable functions
src/lib/errors.ts        Turns thrown errors into text for the user
src/lib/hooks.ts         Live Firestore subscriptions (each exposes error and retry)
src/lib/__tests__/       Unit tests and the backend contract test
src/ui/                  Theme and shared components
```

All league changes go through the backend's callable functions; the app writes
to Firestore directly only for chat.

## One-time setup (Jesse)

1. **Firebase console → Authentication → Sign-in method:** enable **Apple**
   (Google is already on).
2. **Firebase console → Project settings → Add app → iOS**, bundle ID
   `com.jgysin.draftleague`. Download `GoogleService-Info.plist` and copy its
   `CLIENT_ID` into `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`. Copy the Google provider's
   **Web client ID** into `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`. Locally these go in
   `app/.env` (copy `.env.example`; `.env` is ignored by git).
3. **EAS project:** run `npx eas-cli@latest init` once. It creates the project
   on expo.dev and prints a project ID. Because the config is `app.config.ts`,
   EAS cannot write the ID in for you: put it in `EAS_PROJECT_ID` in `app/.env`.
   The config reads it into `extra.eas.projectId`.
4. **EAS environment variables:** cloud builds do not see your `.env`. Each build
   profile in `eas.json` names an EAS environment (`development`, `preview`,
   `production`). Add `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`,
   `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and `EAS_PROJECT_ID` to all three with
   `npx eas-cli@latest env:create`. A cloud build stops with a clear error if
   the iOS client ID is missing, because Google sign-in would not work in it.
5. **Apple Developer account:** nothing to do by hand. EAS creates the App ID
   (with Sign in with Apple), certificates and profiles on the first build when
   you log in with your Apple ID.

## Running and building

```
cd app
npm ci
npm run typecheck && npx eslint src && npm test
npx eas-cli@latest build --profile development --platform ios   # dev build for your phone
npx expo start                                                  # then open it in the dev build
npx eas-cli@latest build --profile production --platform ios    # App Store / TestFlight build
npx eas-cli@latest submit --platform ios                        # upload to TestFlight
```

The app uses native modules (Apple and Google sign-in), so it needs a development
build rather than Expo Go.

## Tests

`npm test` runs Jest (the `jest-expo` preset) over `src/lib/__tests__`:

* the error text shown to users (`errors.ts`), the roster position sort and the
  accent-insensitive player search;
* a contract test that reads `../backend/functions/src/index.ts` and fails if
  the app calls a function the backend no longer exports. It needs the whole
  repository checked out, not only `app/`.

The screens themselves have no automated tests. Check them on a phone.

## Known gaps before App Store submission

* **Account deletion.** Apple requires an in-app way to delete the account. For
  people who signed in with Apple it must also revoke their Apple token. Not
  built yet.
* **Icon and splash art.** `assets/images/icon.png` and `splash-icon.png` are
  still the Expo template placeholders.
* **Device testing.** Nothing here has been run on a real iPhone yet. Sign-in,
  the keyboard in chat, VoiceOver labels and dark mode all need a pass on a
  development build.
* **Privacy details.** The privacy manifest in `app.config.ts` covers the
  required-reason APIs. The App Store privacy questionnaire and a privacy
  policy URL still have to be filled in on App Store Connect.
* **Features not built:** the draft room, trades, the list of your pending
  waiver claims, commissioner tools and push notifications. Until a league's
  draft is done the backend rejects adds, claims and trades from anyone who is
  not an admin, and the app shows the backend's message.
