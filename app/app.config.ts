import type { ExpoConfig } from 'expo/config';

/**
 * Google sign-in on iOS needs the reversed iOS client id as a URL scheme. It
 * comes from the iOS app registered in the plleague Firebase project
 * (GoogleService-Info.plist → REVERSED_CLIENT_ID); see app/README.md.
 */
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
const iosUrlScheme = googleIosClientId
  ? `com.googleusercontent.apps.${googleIosClientId.replace('.apps.googleusercontent.com', '')}`
  : 'com.googleusercontent.apps.missing';

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
  },
  android: { package: 'com.jgysin.draftleague' },
  plugins: [
    'expo-router',
    'expo-apple-authentication',
    ['@react-native-google-signin/google-signin', { iosUrlScheme }],
    ['expo-splash-screen', { backgroundColor: '#faf6ef', image: './assets/images/splash-icon.png', imageWidth: 76 }],
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
};

export default config;
