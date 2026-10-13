import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Share, View } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTxns } from '@/lib/hooks';
import { useLeagueCtx } from '@/lib/league-context';
import { isAdmin } from '@/lib/types';
import { Button, Card, Heading, Pill, Rule, Screen, Text } from '@/ui/kit';
import { space } from '@/ui/theme';

export default function LeagueInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { league, members, me } = useLeagueCtx();
  const { signOut } = useAuth();
  const { data: txns } = useTxns(id);
  const [busy, setBusy] = useState(false);
  const admin = isAdmin(me);

  async function rotate() {
    setBusy(true);
    try { await api.rotateInvite({ leagueId: league.id }); }
    catch (e) { Alert.alert("Couldn't change the code", errorMessage(e)); } finally { setBusy(false); }
  }

  function rename() {
    if (!me) return;
    Alert.prompt('Team name', undefined, async name => {
      if (!name?.trim()) return;
      try { await api.updateMember({ leagueId: league.id, memberId: me.id, teamName: name.trim() }); }
      catch (e) { Alert.alert("Couldn't rename", errorMessage(e)); }
    }, 'plain-text', me.teamName);
  }

  return (
    <Screen>
      <Card>
        <Heading>Invite code</Heading>
        <Text size={32} bold style={{ letterSpacing: 6 }}>{league.inviteCode}</Text>
        <Button title="Share invite" onPress={() => Share.share({
          message: `Join "${league.name}" on Draft League with code ${league.inviteCode}` })} />
        {admin && <Button title="New code" kind="secondary" busy={busy} onPress={rotate} />}
      </Card>

      <Card>
        <Heading>Teams · {members.length}</Heading>
        {members.map(m => (
          <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
            <Text style={{ flex: 1 }} bold={m.id === me?.id}>{m.teamName}</Text>
            {m.role !== 'member' && <Pill tone="blue">{m.role === 'owner' ? 'COMMISH' : 'ADMIN'}</Pill>}
            {!m.uid && <Pill>NOT JOINED</Pill>}
          </View>
        ))}
        {me && <Button title="Rename my team" kind="secondary" onPress={rename} />}
      </Card>

      <Card>
        <Heading>Activity</Heading>
        {txns.length === 0 && <Text tone="muted">Nothing yet.</Text>}
        {[...txns].reverse().slice(0, 30).map((t, i) => (
          <View key={t.id} style={{ gap: space(1) }}>
            {i > 0 && <Rule />}
            <Text size={14}>{t.text}</Text>
            {t.ts && <Text size={11} tone="muted">{t.ts.toDate().toLocaleString()}</Text>}
          </View>
        ))}
      </Card>

      <Text size={12} tone="muted" style={{ textAlign: 'center' }}>{league.season} season · {league.waivers ? 'waivers on' : 'free agency'}{league.h2h ? ' · head to head' : ''}</Text>
      <Button title="Sign out" kind="secondary" onPress={signOut} />
    </Screen>
  );
}
