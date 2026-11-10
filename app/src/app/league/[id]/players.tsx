import { useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Platform, TextInput, View } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { useLeagueCtx } from '@/lib/league-context';
import { sortByPosition } from '@/lib/positions';
import { normaliseSearch } from '@/lib/search';
import { POSITIONS, Position } from '@/lib/types';
import { Empty, ErrorState, Loading, Rule, Screen, TextButton } from '@/ui/kit';
import { PlayerRow } from '@/ui/player-row';
import { font, space, usePalette } from '@/ui/theme';

/** Free agents: search, filter by position, and add (or claim, in waiver leagues). */
export default function Players() {
  const { league, members, me, catalog, catalogError, retryCatalog, playerName } = useLeagueCtx();
  const c = usePalette();
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<Position | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** Every player with the text a search runs against, built once per catalog. */
  const searchable = useMemo(() => [...(catalog?.values() ?? [])]
    .map(p => ({ p, name: normaliseSearch(`${p.n} ${p.f}`), club: p.t.toLowerCase() }))
    .sort((a, b) => a.p.n.localeCompare(b.p.n)), [catalog]);

  const free = useMemo(() => {
    const taken = new Set(members.flatMap(m => m.roster));
    const needle = normaliseSearch(q);
    return searchable
      .filter(({ p, name, club }) => !taken.has(p.c) && (!pos || p.p === pos)
        && (!needle || name.includes(needle) || club === needle))
      .map(s => s.p);
  }, [searchable, members, q, pos]);

  if (!catalog) return catalogError
    ? <Screen><ErrorState message="Couldn’t load the player list. Check your connection and try again." onRetry={retryCatalog} /></Screen>
    : <Loading />;

  const verb = league.waivers ? 'Claim' : 'Add';

  async function act(code: string, drop: string | null) {
    setBusy(code);
    try {
      if (league.waivers) {
        await api.submitClaim({ leagueId: league.id, playerId: code, drop });
        Alert.alert('Claim submitted', 'Claims run when the commissioner processes waivers. Fewest points picks first.');
      } else {
        await api.addDrop({ leagueId: league.id, add: code, drop: drop ?? undefined });
      }
    } catch (e) { Alert.alert(`Couldn't ${verb.toLowerCase()}`, errorMessage(e)); } finally { setBusy(null); }
  }

  function add(code: string) {
    const roster = sortByPosition(me?.roster ?? [], catalog);
    // rosterLimit 0 (or missing, on older leagues) means unlimited.
    const full = !!league.rosterLimit && roster.length >= league.rosterLimit;
    if (Platform.OS !== 'ios') {
      if (full) Alert.alert('Your roster is full', 'Drop a player from the Team tab first.');
      else act(code, null);
      return;
    }
    if (!roster.length) { act(code, null); return; }
    const drops = roster.map(r => `Drop ${playerName(r)}`);
    const options = full ? [...drops, 'Cancel'] : [`${verb} without dropping`, ...drops, 'Cancel'];
    const firstDrop = full ? 0 : 1;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: `${verb} ${playerName(code)}`,
        message: full ? `Your roster is full (${roster.length} of ${league.rosterLimit}). Choose a player to drop.` : undefined,
        options, cancelButtonIndex: options.length - 1,
        destructiveButtonIndex: drops.map((_, i) => firstDrop + i),
      },
      i => {
        if (i === options.length - 1) return;
        act(code, i < firstDrop ? null : roster[i - firstDrop]);
      });
  }

  return (
    <Screen scroll={false}>
      <View style={{ padding: space(4), paddingBottom: space(1), gap: space(1) }}>
        <TextInput value={q} onChangeText={setQ} placeholder="Search players or club (e.g. ARS)" placeholderTextColor={c.muted}
          accessibilityLabel="Search players or club" autoCorrect={false} clearButtonMode="while-editing"
          style={{ borderWidth: 1.5, borderColor: c.ink, borderRadius: 4, padding: space(3), color: c.ink, fontFamily: font, fontSize: 16, backgroundColor: c.card }} />
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          {[null, ...POSITIONS].map(p => (
            <TextButton key={p ?? 'all'} title={p ?? 'All'} label={p ? `Show ${p} only` : 'Show all positions'}
              selected={pos === p} tone={pos === p ? 'coral' : 'muted'} onPress={() => setPos(p)} />
          ))}
        </View>
      </View>
      <FlatList data={free} keyExtractor={p => p.c} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: space(4), paddingBottom: space(8) }}
        ItemSeparatorComponent={Rule}
        ListEmptyComponent={<Empty>No free agents match.</Empty>}
        renderItem={({ item }) => (
          <PlayerRow code={item.c} right={me &&
            <TextButton title={verb} label={`${verb} ${playerName(item.c)}`} tone="blue"
              busy={busy === item.c} disabled={!!busy} onPress={() => add(item.c)} />} />
        )} />
    </Screen>
  );
}
