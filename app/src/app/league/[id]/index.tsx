import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useStandings } from '@/lib/hooks';
import { useLeagueCtx } from '@/lib/league-context';
import { Card, Empty, Heading, Rule, Screen, Text } from '@/ui/kit';
import { space } from '@/ui/theme';

export default function Table() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { league, members, me, memberName } = useLeagueCtx();
  const { data: standings } = useStandings(id);
  const [view, setView] = useState<'total' | 'h2h'>(league.h2h ? 'h2h' : 'total');

  const totals = standings?.totals ?? {};
  const gws = Object.keys(standings?.gwPoints ?? {}).map(Number).sort((a, b) => a - b);
  const lastGw = gws[gws.length - 1];
  const rows = members.map(m => ({ m, total: totals[m.id] ?? 0, last: lastGw ? standings!.gwPoints[lastGw][m.id] ?? 0 : 0 }))
    .sort((a, b) => b.total - a.total || a.m.teamName.localeCompare(b.m.teamName));
  const h2h = standings?.h2h ?? null;

  return (
    <Screen>
      {league.h2h && h2h && (
        <View style={{ flexDirection: 'row', gap: space(4) }}>
          {(['h2h', 'total'] as const).map(v => (
            <Pressable key={v} onPress={() => setView(v)}>
              <Text bold caps size={13} tone={view === v ? 'coral' : 'muted'}>{v === 'h2h' ? 'Head to head' : 'Total points'}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Card>
        {view === 'h2h' && h2h ? (
          <>
            <Row cells={['#', 'Team', 'W-D-L', 'Pts']} head />
            <Rule />
            {h2h.map((r, i) => (
              <Row key={r.memberId} mine={r.memberId === me?.id}
                cells={[String(i + 1), memberName(r.memberId), `${r.w}-${r.d}-${r.l}`, String(r.pts)]} />
            ))}
          </>
        ) : (
          <>
            <Row cells={['#', 'Team', lastGw ? `GW${lastGw}` : 'GW', 'Total']} head />
            <Rule />
            {rows.map((r, i) => (
              <Row key={r.m.id} mine={r.m.id === me?.id} cells={[String(i + 1), r.m.teamName, String(r.last), String(r.total)]} />
            ))}
          </>
        )}
      </Card>
      {!gws.length && <Empty>Points appear here once the first gameweek after the draft kicks off.</Empty>}
      {gws.length > 0 && <Heading>Updated live from FPL during matches</Heading>}
    </Screen>
  );
}

function Row({ cells, head, mine }: { cells: string[]; head?: boolean; mine?: boolean }) {
  const widths = [28, undefined, 64, 56];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space(1) }}>
      {cells.map((t, i) => (
        <Text key={i} numberOfLines={1} bold={head || mine || i === 3} size={head ? 12 : 16} tone={head ? 'muted' : mine ? 'coral' : 'ink'}
          caps={head} style={{ width: widths[i], flex: widths[i] ? undefined : 1, textAlign: i >= 2 ? 'right' : 'left' }}>{t}</Text>
      ))}
    </View>
  );
}
