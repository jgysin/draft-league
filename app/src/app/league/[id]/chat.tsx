import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { useAuth } from '@/lib/auth';
import { db } from '@/lib/firebase';
import { useChat } from '@/lib/hooks';
import { useLeagueCtx } from '@/lib/league-context';
import { Empty, Screen, Text } from '@/ui/kit';
import { font, space, usePalette } from '@/ui/theme';

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { me, memberName } = useLeagueCtx();
  const { data: messages } = useChat(id);
  const c = usePalette();
  const [text, setText] = useState('');
  const list = useRef<FlatList>(null);

  async function send() {
    const t = text.trim();
    if (!t || !me || !user) return;
    setText('');
    try {
      await addDoc(collection(db, `leagues/${id}/chat`), { uid: user.uid, memberId: me.id, text: t.slice(0, 1000), ts: serverTimestamp() });
    } catch {
      setText(t);
      Alert.alert("Message didn't send", 'Check your connection and try again.');
    }
  }

  return (
    <Screen scroll={false}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <FlatList ref={list} data={messages} keyExtractor={m => m.id}
          contentContainerStyle={{ padding: space(4), gap: space(3) }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={<Empty>No messages yet. Start the trash talk.</Empty>}
          renderItem={({ item }) => {
            const mine = item.uid === user?.uid;
            const who = item.memberId ? memberName(item.memberId) : item.name || 'Someone';
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
        {me && (
          <View style={{ flexDirection: 'row', gap: space(2), padding: space(3), borderTopWidth: 1, borderColor: c.rule }}>
            <TextInput value={text} onChangeText={setText} placeholder="Say something" placeholderTextColor={c.muted}
              multiline maxLength={1000}
              style={{ flex: 1, borderWidth: 1.5, borderColor: c.ink, borderRadius: 4, paddingHorizontal: space(3),
                paddingVertical: space(2), color: c.ink, fontFamily: font, fontSize: 16, maxHeight: 120, backgroundColor: c.card }} />
            <Pressable onPress={send} disabled={!text.trim()} style={{ justifyContent: 'center', paddingHorizontal: space(2) }}>
              <Text bold caps tone={text.trim() ? 'coral' : 'muted'}>Send</Text>
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}
