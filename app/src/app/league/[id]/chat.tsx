import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useMemo, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { writeErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { db } from '@/lib/firebase';
import { useChat } from '@/lib/hooks';
import { useLeagueCtx } from '@/lib/league-context';
import { Empty, ErrorState, Loading, Screen, Text, TextButton } from '@/ui/kit';
import { font, space, usePalette } from '@/ui/theme';

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { me, members } = useLeagueCtx();
  const { data: messages, loading, error, retry } = useChat(id);
  const c = usePalette();
  const headerHeight = useHeaderHeight();
  const [text, setText] = useState('');
  // Newest first for the inverted list, which keeps the latest message by the input.
  const newestFirst = useMemo(() => [...messages].reverse(), [messages]);
  const teamNames = useMemo(() => new Map(members.map(m => [m.id, m.teamName])), [members]);

  async function send() {
    const t = text.trim();
    if (!t || !me || !user) return;
    setText('');
    try {
      await addDoc(collection(db, `leagues/${id}/chat`), { uid: user.uid, memberId: me.id, text: t.slice(0, 1000), ts: serverTimestamp() });
    } catch (e) {
      setText(t);
      Alert.alert("Message didn't send", writeErrorMessage(e));
    }
  }

  return (
    <Screen scroll={false}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
        {loading ? <Loading />
          : error ? <View style={{ flex: 1, padding: space(4) }}><ErrorState message="Couldn’t load the chat." onRetry={retry} /></View>
          : newestFirst.length === 0 ? <View style={{ flex: 1 }}><Empty>No messages yet. Start the trash talk.</Empty></View>
          : (
            <FlatList inverted data={newestFirst} keyExtractor={m => m.id} keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: space(4), gap: space(3) }}
              renderItem={({ item }) => {
                const mine = item.uid === user?.uid;
                const who = item.memberId ? teamNames.get(item.memberId) ?? 'Former member' : item.name || 'Someone';
                return (
                  <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', gap: 2 }}>
                    {!mine && <Text size={12} bold tone="muted">{who}</Text>}
                    <View style={{ backgroundColor: mine ? c.ink : c.card, borderColor: c.rule, borderWidth: mine ? 0 : 1,
                      borderRadius: 6, paddingHorizontal: space(3), paddingVertical: space(2) }}>
                      <Text style={{ color: mine ? c.paper : c.ink }}>{item.text}</Text>
                    </View>
                  </View>
                );
              }} />
          )}
        {me && (
          <View style={{ flexDirection: 'row', gap: space(2), padding: space(3), borderTopWidth: 1, borderColor: c.rule }}>
            <TextInput value={text} onChangeText={setText} placeholder="Say something" placeholderTextColor={c.muted}
              accessibilityLabel="Message" multiline maxLength={1000}
              style={{ flex: 1, borderWidth: 1.5, borderColor: c.ink, borderRadius: 4, paddingHorizontal: space(3),
                paddingVertical: space(2), color: c.ink, fontFamily: font, fontSize: 16, maxHeight: 120, backgroundColor: c.card }} />
            <TextButton title="Send" size={16} tone={text.trim() ? 'coral' : 'muted'} disabled={!text.trim()} onPress={send}
              style={{ paddingHorizontal: space(2) }} />
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}
