import { router, Tabs, useLocalSearchParams } from 'expo-router';
import { ColorValue, Pressable } from 'react-native';
import { SymbolView, SFSymbol } from 'expo-symbols';
import { useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import { useCatalog, useLeague, useMembers, useNicknames } from '@/lib/hooks';
import { LeagueContext, LeagueCtx } from '@/lib/league-context';
import { Empty, Loading, Screen } from '@/ui/kit';
import { font, usePalette } from '@/ui/theme';

function icon(name: SFSymbol) {
  return function TabIcon({ color }: { color: ColorValue }) {
    return <SymbolView name={name} tintColor={color} size={22} />;
  };
}

export default function LeagueLayout() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const c = usePalette();
  const league = useLeague(id);
  const members = useMembers(id);
  const nicknames = useNicknames(id);
  const catalog = useCatalog();

  const ctx = useMemo<LeagueCtx | null>(() => {
    if (!league.data) return null;
    const byId = new Map(members.data.map(m => [m.id, m]));
    const nicks = (nicknames.data ?? {}) as Record<string, string>;
    return {
      league: league.data, members: members.data, catalog, nicknames: nicks,
      me: members.data.find(m => m.uid === user?.uid) ?? null,
      memberName: mid => (mid && byId.get(mid)?.teamName) || 'Free agent',
      playerName: code => nicks[code] || catalog?.get(code)?.n || `#${code}`,
    };
  }, [league.data, members.data, nicknames.data, catalog, user?.uid]);

  if (league.loading || members.loading) return <Loading />;
  if (!ctx) return <Screen edges={['top']}><Empty>This league isn’t available.</Empty></Screen>;

  return (
    <LeagueContext.Provider value={ctx}>
      <Tabs screenOptions={{
        headerStyle: { backgroundColor: c.paper }, headerTintColor: c.ink, headerShadowVisible: false,
        headerTitleStyle: { fontFamily: font, fontWeight: '700' },
        tabBarStyle: { backgroundColor: c.paper, borderTopColor: c.rule },
        tabBarActiveTintColor: c.coral, tabBarInactiveTintColor: c.muted,
        tabBarLabelStyle: { fontFamily: font, fontWeight: '700' },
        sceneStyle: { backgroundColor: c.paper },
        headerLeft: () => (
          <Pressable accessibilityLabel="All leagues" hitSlop={12} style={{ paddingHorizontal: 16 }}
            onPress={() => router.dismissTo('/')}>
            <SymbolView name="chevron.left" tintColor={c.ink} size={20} />
          </Pressable>
        ),
      }}>
        <Tabs.Screen name="index" options={{ title: ctx.league.name, tabBarLabel: 'Table', tabBarIcon: icon('list.number') }} />
        <Tabs.Screen name="team" options={{ title: ctx.me?.teamName ?? 'Team', tabBarLabel: 'Team', tabBarIcon: icon('tshirt') }} />
        <Tabs.Screen name="players" options={{ title: 'Players', tabBarIcon: icon('person.3') }} />
        <Tabs.Screen name="chat" options={{ title: 'Chat', tabBarIcon: icon('bubble.left.and.bubble.right') }} />
        <Tabs.Screen name="league" options={{ title: 'League', tabBarIcon: icon('gearshape') }} />
      </Tabs>
    </LeagueContext.Provider>
  );
}
