import { Image } from 'expo-image';
import { ReactNode } from 'react';
import { View } from 'react-native';
import { headshotUrl, useLeagueCtx } from '@/lib/league-context';
import { Pill, Text } from './kit';
import { space, usePalette } from './theme';

const STATUS: Record<string, string> = { d: 'DOUBT', i: 'INJ', s: 'SUSP', u: 'GONE', n: 'OUT' };

/** One player line: headshot, name (nickname first), position, club, availability, and an optional action. */
export function PlayerRow({ code, right, sub }: { code: string; right?: ReactNode; sub?: string }) {
  const { catalog, nicknames } = useLeagueCtx();
  const c = usePalette();
  const p = catalog?.get(code);
  const nick = nicknames[code];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(2) }}>
      <Image source={headshotUrl(code)} style={{ width: 40, height: 50, backgroundColor: c.rule, borderRadius: 3 }}
        contentFit="cover" recyclingKey={code} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text bold numberOfLines={1}>{nick || p?.n || `#${code}`}{nick && p ? <Text tone="muted" size={13}> ({p.n})</Text> : null}</Text>
        <View style={{ flexDirection: 'row', gap: space(2), alignItems: 'center' }}>
          <Text size={12} tone="muted">{p ? `${p.p} · ${p.t}` : 'Unknown player'}</Text>
          {p && STATUS[p.s] && <Pill tone="coral">{STATUS[p.s]}</Pill>}
          {sub && <Text size={12} tone="muted">{sub}</Text>}
        </View>
      </View>
      {right}
    </View>
  );
}
