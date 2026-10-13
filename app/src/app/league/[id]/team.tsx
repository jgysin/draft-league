import { useState } from 'react';
import { Alert, Pressable } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { useLeagueCtx } from '@/lib/league-context';
import { sortByPosition } from '@/lib/positions';
import { POSITIONS } from '@/lib/types';
import { Card, Empty, Heading, Screen, Text } from '@/ui/kit';
import { PlayerRow } from '@/ui/player-row';

export default function Team() {
  const { league, me, catalog, playerName } = useLeagueCtx();
  const [busy, setBusy] = useState<string | null>(null);
  if (!me) return <Screen><Empty>You don’t have a team in this league.</Empty></Screen>;

  const roster = sortByPosition(me.roster, catalog);

  function drop(code: string) {
    Alert.alert(`Drop ${playerName(code)}?`, 'They go back into the free agent pool.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Drop', style: 'destructive', onPress: async () => {
        setBusy(code);
        try { await api.addDrop({ leagueId: league.id, drop: code }); }
        catch (e) { Alert.alert("Couldn't drop", errorMessage(e)); }
        finally { setBusy(null); }
      } },
    ]);
  }

  return (
    <Screen>
      {roster.length === 0 && <Empty>No players yet. They arrive with the draft, or from the Players tab.</Empty>}
      {POSITIONS.map(pos => {
        const group = roster.filter(c => (catalog?.get(c)?.p ?? 'MID') === pos);
        if (!group.length) return null;
        return (
          <Card key={pos}>
            <Heading>{pos} · {group.length}</Heading>
            {group.map(code => (
              <PlayerRow key={code} code={code} right={
                <Pressable disabled={busy === code} onPress={() => drop(code)} hitSlop={8}>
                  <Text size={13} bold caps tone="coral">{busy === code ? '…' : 'Drop'}</Text>
                </Pressable>} />
            ))}
          </Card>
        );
      })}
    </Screen>
  );
}
