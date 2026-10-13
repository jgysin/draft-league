# Draft League iPhone app

Expo (React Native) app for Draft League, built on the backend in `../backend`.
iPhone first; Android can come later from the same code.

## What's here

* Sign in with Apple or Google. Anyone whose email the commissioner put on a team
  (including everyone migrated from the website) lands on that team automatically.
* Your leagues; start a league or join one with a 6-character invite code.
* Per league: **Table** (total points or head to head, live from FPL), **Team**
  (your roster, drop players), **Players** (search free agents, add or claim),
  **Chat**, and **League** (invite code, teams, activity feed).
* The website's typewriter look in light and dark mode.

Still to come: the draft room, trades, commissioner tools, push notifications and
account deletion (required by the App Store).

## Code map

```
src/app/                 Screens (Expo Router: every file is a route)
src/app/league/[id]/     League tabs
src/lib/firebase.ts      Firebase app, auth (persisted), Firestore, functions
src/lib/auth.tsx         Apple + Google sign-in
src/lib/api.ts           Typed wrappers for the backend's callable functions
src/lib/hooks.ts         Live Firestore subscriptions
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
   `app/.env` (see `.env.example`); for cloud builds, add them as EAS environment
   variables (`npx eas-cli@latest env:create`).
3. **Apple Developer account:** nothing to do by hand. EAS creates the App ID
   (with Sign in with Apple), certificates and profiles on the first build when
   you log in with your Apple ID.

## Running and building

```
cd app
npm ci
npm run typecheck && npx eslint src
npx eas-cli@latest build --profile development --platform ios   # dev build for your phone
npx expo start                                                  # then open it in the dev build
npx eas-cli@latest build --profile production --platform ios    # App Store / TestFlight build
npx eas-cli@latest submit --platform ios                        # upload to TestFlight
```

The app uses native modules (Apple and Google sign-in), so it needs a development
build rather than Expo Go.
