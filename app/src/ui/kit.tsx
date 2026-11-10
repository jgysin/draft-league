import { ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleProp, StyleSheet, Text as RNText, TextInput, TextProps,
  TextStyle, View, ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { font, space, usePalette } from './theme';

type Tone = 'ink' | 'muted' | 'coral' | 'blue' | 'green';

export function Text({ tone = 'ink', size = 16, bold, caps, style, ...rest }:
  TextProps & { tone?: Tone; size?: number; bold?: boolean; caps?: boolean }) {
  const c = usePalette();
  return <RNText {...rest} style={[{
    color: c[tone], fontFamily: font, fontSize: size, lineHeight: Math.round(size * 1.35),
    fontWeight: bold ? '700' : '400',
    ...(caps ? { textTransform: 'uppercase', letterSpacing: 1.5 } : {}),
  } as TextStyle, style]} />;
}

/** A scrolling page on paper. Pass scroll={false} when the child scrolls itself (lists, chat). */
export function Screen({ children, scroll = true, edges }: {
  children: ReactNode; scroll?: boolean; edges?: ('top' | 'bottom')[];
}) {
  const c = usePalette();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }} edges={edges ?? []}>
      {scroll
        ? <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4) }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        : <View style={{ flex: 1 }}>{children}</View>}
    </SafeAreaView>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text size={13} bold caps tone="muted">{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = usePalette();
  return <View style={[{ backgroundColor: c.card, borderColor: c.rule, borderWidth: 1, borderStyle: 'dashed',
    borderRadius: 4, padding: space(3), gap: space(2) }, style]}>{children}</View>;
}

export function Rule() {
  const c = usePalette();
  return <View style={{ borderTopWidth: 1, borderColor: c.rule, borderStyle: 'dashed' }} />;
}

export function Button({ title, onPress, kind = 'primary', busy, disabled }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; busy?: boolean; disabled?: boolean;
}) {
  const c = usePalette();
  const bg = kind === 'primary' ? c.ink : kind === 'danger' ? c.coral : 'transparent';
  const fg = kind === 'secondary' ? c.ink : c.paper;
  const off = disabled || busy;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title}
      accessibilityState={{ busy: !!busy, disabled: !!off }} disabled={off} onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, borderColor: c.ink, opacity: off ? 0.5 : pressed ? 0.75 : 1 }]}>
      {busy ? <ActivityIndicator color={fg} /> : <Text bold caps size={14} style={{ color: fg }}>{title}</Text>}
    </Pressable>
  );
}

/**
 * A word that acts as a button (Add, Drop, Send, filters). The text is small, so the
 * pressable is padded out to Apple's 44pt minimum.
 */
export function TextButton({ title, onPress, tone = 'coral', size = 13, label, busy, disabled, selected, style }: {
  title: string; onPress: () => void; tone?: Tone; size?: number; label?: string; busy?: boolean; disabled?: boolean;
  selected?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || busy;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title}
      accessibilityState={{ busy: !!busy, disabled: !!off, ...(selected === undefined ? {} : { selected }) }}
      disabled={off} onPress={onPress} hitSlop={6}
      style={({ pressed }) => [styles.textButton, { opacity: pressed ? 0.6 : 1 }, style]}>
      <Text bold caps size={size} tone={tone}>{busy ? '…' : title}</Text>
    </Pressable>
  );
}

export function Field({ label, ...rest }: React.ComponentProps<typeof TextInput> & { label: string }) {
  const c = usePalette();
  return (
    <View style={{ gap: space(1) }}>
      <Heading>{label}</Heading>
      <TextInput placeholderTextColor={c.muted} {...rest}
        style={[styles.input, { color: c.ink, borderColor: c.ink, backgroundColor: c.card, fontFamily: font }]} />
    </View>
  );
}

/** Centred spinner. Children (a way out, say) sit under it. */
export function Loading({ children }: { children?: ReactNode }) {
  const c = usePalette();
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space(6), padding: space(6), backgroundColor: c.paper }}>
    <ActivityIndicator color={c.ink} />{children}</View>;
}

/** Something failed to load: say so and offer another go. Children are extra buttons. */
export function ErrorState({ message, onRetry, children }: { message: string; onRetry: () => void; children?: ReactNode }) {
  return (
    <View style={{ gap: space(3), paddingVertical: space(6) }}>
      <Text tone="muted" style={{ textAlign: 'center' }}>{message}</Text>
      <Button title="Retry" onPress={onRetry} />
      {children}
    </View>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <Text tone="muted" style={{ textAlign: 'center', marginTop: space(6) }}>{children}</Text>;
}

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: Tone }) {
  const c = usePalette();
  return <View style={{ borderWidth: 1, borderColor: c[tone], borderRadius: 3, paddingHorizontal: 4 }}>
    <Text size={11} bold tone={tone}>{children}</Text></View>;
}


const styles = StyleSheet.create({
  textButton: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  button: { minHeight: 48, borderWidth: 1.5, borderRadius: 4, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space(4) },
  input: { borderWidth: 1.5, borderRadius: 4, paddingHorizontal: space(3), paddingVertical: space(3), fontSize: 16 },
});
