import type { ExpoConfig } from 'expo/config';

/**
 * Google sign-in on iOS needs the reversed iOS client id as a URL scheme. It
 * comes from the iOS app registered in the plleague Firebase project
 * (GoogleService-Info.plist → REVERSED_CLIENT_ID); see app/README.md.
 */
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
// A cloud build with the placeholder scheme would ship with Google sign-in broken, so stop it here.
if (process.env.EAS_BUILD && !googleIosClientId) {
  throw new Error(
    'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID is not set for this EAS build. Add it (and EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID) ' +
    'to the EAS environment this build profile uses: npx eas-cli@latest env:create. See app/README.md.');
}
const iosUrlScheme = googleIosClientId
  ? `com.googleusercontent.apps.${googleIosClientId.replace('.apps.googleusercontent.com', '')}`
  : 'com.googleusercontent.apps.missing';

/** Set by `eas init` (see app/README.md); EAS builds need it, local bundling does not. */
const easProjectId = process.env.EAS_PROJECT_ID;

const splashImage = './assets/images/splash-icon.png';

const config: ExpoConfig = {
  name: 'Draft League',
  slug: 'draft-league',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'draftleague',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'com.jgysin.draftleague',
    supportsTablet: false,
    usesAppleSignIn: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
    // Required-reason APIs used by React Native, AsyncStorage and Expo's own modules.
    privacyManifests: {
      NSPrivacyAccessedAPITypes: [
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1'] },
      ],
    },
  },
  android: { package: 'com.jgysin.draftleague' },
  plugins: [
    'expo-router',
    'expo-apple-authentication',
    ['@react-native-google-signin/google-signin', { iosUrlScheme }],
    ['expo-splash-screen', {
      backgroundColor: '#faf6ef', image: splashImage, imageWidth: 76,
      dark: { backgroundColor: '#1a1917', image: splashImage },
    }],
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
  ...(easProjectId ? { extra: { eas: { projectId: easProjectId } } } : {}),
};

export default config;
