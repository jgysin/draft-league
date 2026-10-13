import { useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Platform, Pressable, TextInput, View } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { useLeagueCtx } from '@/lib/league-context';
import { POSITIONS, Position } from '@/lib/types';
import { Empty, Loading, Rule, Screen, Text } from '@/ui/kit';
import { PlayerRow } from '@/ui/player-row';
import { font, space, usePalette } from '@/ui/theme';

/** Free agents: search, filter by position, and add (or claim, in waiver leagues). */
export default function Players() {
  const { league, members, me, catalog, playerName } = useLeagueCtx();
  const c = usePalette();
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<Position | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const free = useMemo(() => {
    if (!catalog) return [];
    const taken = new Set(members.flatMap(m => m.roster));
    const needle = q.trim().toLowerCase();
    return [...catalog.values()]
      .filter(p => !taken.has(p.c) && (!pos || p.p === pos)
        && (!needle || p.n.toLowerCase().includes(needle) || p.f.toLowerCase().includes(needle) || p.t.toLowerCase() === needle))
      .sort((a, b) => a.n.localeCompare(b.n));
  }, [catalog, members, q, pos]);

  if (!catalog) return <Loading />;

  async function act(code: string, drop: string | null) {
    setBusy(code);
    try {
      if (league.waivers) {
        await api.submitClaim({ leagueId: league.id, playerId: code, drop });
        Alert.alert('Claim submitted', 'Claims run when the commissioner processes waivers. Fewest points picks first.');
      } else {
        await api.addDrop({ leagueId: league.id, add: code, drop: drop ?? undefined });
      }
    } catch (e) { Alert.alert("Couldn't add", errorMessage(e)); } finally { setBusy(null); }
  }

  function add(code: string) {
    const roster = me?.roster ?? [];
    const verb = league.waivers ? 'Claim' : 'Add';
    if (Platform.OS !== 'ios' || !roster.length) { act(code, null); return; }
    const options = [`${verb} without dropping`, ...roster.map(r => `Drop ${playerName(r)}`), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: `${verb} ${playerName(code)}`, options, cancelButtonIndex: options.length - 1 },
      i => { if (i === 0) act(code, null); else if (i < options.length - 1) act(code, roster[i - 1]); });
  }

  return (
    <Screen scroll={false}>
      <View style={{ padding: space(4), gap: space(3) }}>
        <TextInput value={q} onChangeText={setQ} placeholder="Search players or club (e.g. ARS)" placeholderTextColor={c.muted}
          autoCorrect={false} clearButtonMode="while-editing"
          style={{ borderWidth: 1.5, borderColor: c.ink, borderRadius: 4, padding: space(3), color: c.ink, fontFamily: font, fontSize: 16, backgroundColor: c.card }} />
        <View style={{ flexDirection: 'row', gap: space(4) }}>
          {[null, ...POSITIONS].map(p => (
            <Pressable key={p ?? 'all'} onPress={() => setPos(p)} hitSlop={6}>
              <Text bold caps size={13} tone={pos === p ? 'coral' : 'muted'}>{p ?? 'All'}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <FlatList data={free} keyExtractor={p => p.c} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: space(4), paddingBottom: space(8) }}
        ItemSeparatorComponent={Rule}
        ListEmptyComponent={<Empty>No free agents match.</Empty>}
        renderItem={({ item }) => (
          <PlayerRow code={item.c} right={me &&
            <Pressable disabled={!!busy} onPress={() => add(item.c)} hitSlop={8}>
              <Text size={13} bold caps tone="blue">{busy === item.c ? '…' : league.waivers ? 'Claim' : 'Add'}</Text>
            </Pressable>} />
        )} />
    </Screen>
  );
}
