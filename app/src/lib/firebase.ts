import AsyncStorage from '@react-native-async-storage/async-storage';
import { getReactNativePersistence, initializeAuth } from '@firebase/auth';
import { initializeApp } from 'firebase/app';
import { initializeFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

// The plleague web config. These values identify the project; they are not secrets.
const config = {
  apiKey: 'AIzaSyC1R_499lbW7pJODNvM1yWNUX9blw_9hx8',
  authDomain: 'plleague.firebaseapp.com',
  projectId: 'plleague',
  storageBucket: 'plleague.firebasestorage.app',
  messagingSenderId: '549468608800',
  appId: '1:549468608800:web:77089309725edad1525f45',
};

/** Must match REGION in backend/functions/src/admin.ts. */
export const FUNCTIONS_REGION = 'us-central1';

export const app = initializeApp(config);
export const auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
// Long polling is more reliable than WebChannel streaming on React Native.
export const db = initializeFirestore(app, { experimentalForceLongPolling: true });
export const functions = getFunctions(app, FUNCTIONS_REGION);
