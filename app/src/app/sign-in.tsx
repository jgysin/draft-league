import { useEffect, useState } from 'react';
import { Alert, Platform, useColorScheme, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { authErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button, Screen, Text } from '@/ui/kit';
import { space } from '@/ui/theme';

type Provider = 'apple' | 'google';

export default function SignIn() {
  const { signInWithApple, signInWithGoogle } = useAuth();
  const dark = useColorScheme() === 'dark';
  const [appleOk, setAppleOk] = useState(false);
  /** Which sign-in is in flight; both buttons are off while either is. */
  const [busy, setBusy] = useState<Provider | null>(null);
  useEffect(() => { AppleAuthentication.isAvailableAsync().then(setAppleOk); }, []);

  async function run(provider: Provider) {
    if (busy) return;
    setBusy(provider);
    try { await (provider === 'apple' ? signInWithApple() : signInWithGoogle()); }
    catch (e) { Alert.alert('Sign-in failed', authErrorMessage(e)); }
    finally { setBusy(null); }
  }

  return (
    <Screen edges={['top', 'bottom']} scroll={false}>
      <View style={{ flex: 1, justifyContent: 'center', padding: space(6), gap: space(8) }}>
        <View style={{ gap: space(2) }}>
          <Text size={34} bold accessibilityRole="header">Draft League</Text>
          <Text tone="muted">Premier League draft fantasy for you and your mates.</Text>
        </View>
        <View style={{ gap: space(3) }}>
          {appleOk && Platform.OS === 'ios' && (busy === 'apple'
            // Apple's own button can't show progress, so stand a spinner in for it.
            ? <Button title="Sign in with Apple" busy onPress={() => {}} />
            : (
              <View pointerEvents={busy ? 'none' : 'auto'} style={{ opacity: busy ? 0.5 : 1 }}>
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                  buttonStyle={dark ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                    : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                  cornerRadius={4} style={{ height: 48 }}
                  onPress={() => run('apple')} />
              </View>
            ))}
          <Button title="Sign in with Google" kind="secondary" busy={busy === 'google'} disabled={!!busy} onPress={() => run('google')} />
          <Text size={12} tone="muted" style={{ textAlign: 'center' }}>
            Already in a league on the website? Use the Google account your commissioner added and your team is waiting.
          </Text>
        </View>
      </View>
    </Screen>
  );
}
