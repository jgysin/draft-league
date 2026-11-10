import { router } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button, Field, Screen, Text } from '@/ui/kit';

export default function CreateLeague() {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [teamName, setTeamName] = useState(user?.displayName ? `${user.displayName.split(' ')[0]} FC` : '');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const { leagueId } = await api.createLeague({ name, teamName });
      router.dismissTo({ pathname: '/league/[id]', params: { id: leagueId } });
    } catch (e) { Alert.alert("Couldn't create the league", errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Field label="League name" value={name} onChangeText={setName} placeholder="Sunday Lads" maxLength={60} autoFocus />
      <Field label="Your team name" value={teamName} onChangeText={setTeamName} maxLength={40} />
      <Text size={13} tone="muted">You’ll be the commissioner. Share the invite code from the league’s settings to bring your friends in.</Text>
      <Button title="Create league" busy={busy} disabled={!name.trim() || !teamName.trim()} onPress={create} />
    </Screen>
  );
}
