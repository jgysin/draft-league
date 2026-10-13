import { useEffect, useState } from 'react';
import { Alert, Platform, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useAuth } from '@/lib/auth';
import { Button, Screen, Text } from '@/ui/kit';
import { space, usePalette } from '@/ui/theme';

export default function SignIn() {
  const { signInWithApple, signInWithGoogle } = useAuth();
  const c = usePalette();
  const [appleOk, setAppleOk] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { AppleAuthentication.isAvailableAsync().then(setAppleOk); }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { Alert.alert('Sign-in failed', (e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Screen edges={['top', 'bottom']} scroll={false}>
      <View style={{ flex: 1, justifyContent: 'center', padding: space(6), gap: space(8) }}>
        <View style={{ gap: space(2) }}>
          <Text size={34} bold>Draft League</Text>
          <Text tone="muted">Premier League draft fantasy for you and your mates.</Text>
        </View>
        <View style={{ gap: space(3) }}>
          {appleOk && Platform.OS === 'ios' && (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={c.paper === '#faf6ef' ? AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                : AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={4} style={{ height: 48 }}
              onPress={() => run(signInWithApple)} />
          )}
          <Button title="Sign in with Google" kind="secondary" busy={busy} onPress={() => run(signInWithGoogle)} />
          <Text size={12} tone="muted" style={{ textAlign: 'center' }}>
            Already in a league on the website? Use the Google account your commissioner added and your team is waiting.
          </Text>
        </View>
      </View>
    </Screen>
  );
}
