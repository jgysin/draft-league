import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '@/lib/auth';
import { TextButton } from '@/ui/kit';
import { font, usePalette } from '@/ui/theme';

SplashScreen.preventAutoHideAsync();

/** Modals have no back chevron, and swipe-to-dismiss is invisible to VoiceOver. */
const modal = {
  presentation: 'modal',
  headerLeft: () => <TextButton title="Cancel" tone="ink" size={15} onPress={() => router.back()} />,
} as const;

function RootStack() {
  const { user, ready } = useAuth();
  const c = usePalette();
  useEffect(() => { if (ready) SplashScreen.hideAsync(); }, [ready]);
  if (!ready) return null;
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{
        headerStyle: { backgroundColor: c.paper }, headerTintColor: c.ink, headerShadowVisible: false,
        headerTitleStyle: { fontFamily: font, fontWeight: '700' }, contentStyle: { backgroundColor: c.paper },
        headerBackButtonDisplayMode: 'minimal',
      }}>
        <Stack.Protected guard={!user}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={!!user}>
          <Stack.Screen name="index" options={{ title: 'Draft League' }} />
          <Stack.Screen name="create" options={{ title: 'New league', ...modal }} />
          <Stack.Screen name="join" options={{ title: 'Join a league', ...modal }} />
          <Stack.Screen name="league/[id]" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return <AuthProvider><RootStack /></AuthProvider>;
}
