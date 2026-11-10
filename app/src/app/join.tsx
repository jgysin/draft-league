import { router } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { Button, Field, Screen, Text } from '@/ui/kit';

export default function JoinLeague() {
  const [code, setCode] = useState('');
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);
  // New codes are 8 characters; 6-character codes from before still work.

  async function join() {
    setBusy(true);
    try {
      const { leagueId } = await api.joinLeague({ code, teamName: teamName.trim() || undefined });
      router.dismissTo({ pathname: '/league/[id]', params: { id: leagueId } });
    } catch (e) { Alert.alert("Couldn't join", errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Field label="Invite code" value={code} onChangeText={t => setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="ABCD2345"
        autoCapitalize="characters" autoCorrect={false} maxLength={8} autoFocus />
      <Field label="Your team name" value={teamName} onChangeText={setTeamName} maxLength={40} />
      <Text size={13} tone="muted">If your commissioner already set up a team for your email, you’ll take that one over.</Text>
      <Button title="Join league" busy={busy} disabled={code.length < 6} onPress={join} />
    </Screen>
  );
}
