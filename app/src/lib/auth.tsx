import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { GoogleSignin, isErrorWithCode, statusCodes } from '@react-native-google-signin/google-signin';
import {
  GoogleAuthProvider, OAuthProvider, onAuthStateChanged, signInWithCredential, signOut as fbSignOut,
  updateProfile, User,
} from '@firebase/auth';
import { api } from './api';
import { auth } from './firebase';

GoogleSignin.configure({
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
});

interface AuthState {
  user: User | null;
  ready: boolean;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** After any sign-in, pick up team slots the commissioner reserved for this email. */
async function afterSignIn() {
  try { await api.claimSlots({}); } catch { /* not fatal: they can still join by code */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => onAuthStateChanged(auth, u => { setUser(u); setReady(true); }), []);

  async function signInWithApple() {
    // Apple signs a hash of the nonce; Firebase checks it against the raw value.
    const rawNonce = Crypto.randomUUID();
    const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    let cred: AppleAuthentication.AppleAuthenticationCredential;
    try {
      cred = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                          AppleAuthentication.AppleAuthenticationScope.EMAIL],
        nonce: hashed,
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return;
      throw e;
    }
    if (!cred.identityToken) throw new Error('Apple sign-in returned no token.');
    const result = await signInWithCredential(auth,
      new OAuthProvider('apple.com').credential({ idToken: cred.identityToken, rawNonce }));
    // Apple only shares the name on the very first sign-in, so keep it.
    if (!result.user.displayName && cred.fullName?.givenName)
      await updateProfile(result.user, { displayName: AppleAuthentication.formatFullName(cred.fullName) });
    await afterSignIn();
  }

  async function signInWithGoogle() {
    try {
      const res = await GoogleSignin.signIn();
      if (res.type !== 'success') return;
      if (!res.data.idToken) throw new Error('Google sign-in returned no token.');
      await signInWithCredential(auth, GoogleAuthProvider.credential(res.data.idToken));
      await afterSignIn();
    } catch (e) {
      if (isErrorWithCode(e) && e.code === statusCodes.IN_PROGRESS) return;
      throw e;
    }
  }

  async function signOut() {
    try { await GoogleSignin.signOut(); } catch { /* not signed in with Google */ }
    await fbSignOut(auth);
  }

  return (
    <AuthContext.Provider value={{ user, ready, signInWithApple, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
