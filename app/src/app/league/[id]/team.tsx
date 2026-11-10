import { useState } from 'react';
import { Alert } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { useLeagueCtx } from '@/lib/league-context';
import { sortByPosition } from '@/lib/positions';
import { POSITIONS } from '@/lib/types';
import { Card, Empty, ErrorState, Heading, Loading, Screen, TextButton } from '@/ui/kit';
import { PlayerRow } from '@/ui/player-row';

export default function Team() {
  const { league, me, catalog, catalogError, retryCatalog, playerName } = useLeagueCtx();
  const [busy, setBusy] = useState<string | null>(null);
  if (!me) return <Screen><Empty>You don’t have a team in this league.</Empty></Screen>;
  // Without the player pool a roster is only numbers, so wait for it rather than guess.
  if (!catalog) return catalogError
    ? <Screen><ErrorState message="Couldn’t load the player list. Check your connection and try again." onRetry={retryCatalog} /></Screen>
    : <Loading />;

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
        const group = roster.filter(c => (catalog.get(c)?.p ?? 'MID') === pos);
        if (!group.length) return null;
        return (
          <Card key={pos}>
            <Heading>{pos} · {group.length}</Heading>
            {group.map(code => (
              <PlayerRow key={code} code={code} right={
                <TextButton title="Drop" label={`Drop ${playerName(code)}`} busy={busy === code} onPress={() => drop(code)} />} />
            ))}
          </Card>
        );
      })}
    </Screen>
  );
}
