import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useAuth } from '@/lib/auth';
import { useMyLeagues } from '@/lib/hooks';
import { Button, Card, Empty, Heading, Loading, Screen, Text } from '@/ui/kit';
import { space } from '@/ui/theme';

export default function Leagues() {
  const { user, signOut } = useAuth();
  const { data: leagues, loading } = useMyLeagues(user?.uid ?? null);
  if (loading) return <Loading />;

  return (
    <Screen>
      <Heading>Your leagues</Heading>
      {leagues.length === 0 && <Empty>You’re not in a league yet. Join one with an invite code, or start your own.</Empty>}
      {[...leagues].sort((a, b) => a.name.localeCompare(b.name)).map(l => (
        <Pressable key={l.id} onPress={() => router.push({ pathname: '/league/[id]', params: { id: l.id } })}>
          <Card>
            <Text size={20} bold>{l.name}</Text>
            <Text size={13} tone="muted">{l.memberUids.length} signed in · {l.season}</Text>
          </Card>
        </Pressable>
      ))}
      <View style={{ gap: space(3), marginTop: space(4) }}>
        <Button title="Join with a code" onPress={() => router.push('/join')} />
        <Button title="Start a league" kind="secondary" onPress={() => router.push('/create')} />
      </View>
      <View style={{ marginTop: space(8), gap: space(2) }}>
        <Text size={12} tone="muted" style={{ textAlign: 'center' }}>Signed in as {user?.email ?? user?.displayName}</Text>
        <Button title="Sign out" kind="secondary" onPress={signOut} />
      </View>
    </Screen>
  );
}
