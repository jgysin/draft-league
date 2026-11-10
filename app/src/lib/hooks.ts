import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, doc, DocumentData, limitToLast, onSnapshot, orderBy, query, Query, where } from 'firebase/firestore';
import { db } from './firebase';
import type { CatalogPlayer, ChatMessage, League, Member, Standings, Txn } from './types';

export type State<T> = { data: T; loading: boolean; error: Error | null; retry: () => void };

/**
 * Subscribe while `key` is non-null; resubscribes when it changes or on retry().
 * Results are tagged with the key they belong to, so a stale result reads as
 * loading. An error ends the Firestore listener and clears the data, so screens
 * show the error (with retry) rather than something stale.
 */
function useSnapshot<T>(key: string | null,
                        subscribe: (set: (v: T) => void, fail: (e: Error) => void) => () => void,
                        initial: T): State<T> {
  const [state, setState] = useState<{ key: string | null; data: T; error: Error | null }>({ key: null, data: initial, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (key === null) return;
    return subscribe(data => setState({ key, data, error: null }), error => setState({ key, data: initial, error }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const retry = useCallback(() => {
    setState({ key: null, data: initial, error: null });
    setNonce(n => n + 1);
  }, [initial]);
  if (key === null) return { data: initial, loading: false, error: null, retry };
  if (state.key !== key) return { data: initial, loading: true, error: null, retry };
  return { data: state.data, loading: false, error: state.error, retry };
}

const NONE: never[] = [];

function useDocData<T>(path: string | null): State<T | null> {
  return useSnapshot<T | null>(path, (set, fail) =>
    onSnapshot(doc(db, path!), s => set(s.exists() ? ({ id: s.id, ...s.data() } as T) : null), fail), null);
}

/** `key` identifies the query; the query itself is only built when subscribing. */
function useQueryData<T>(key: string | null, build: () => Query<DocumentData>): State<T[]> {
  return useSnapshot<T[]>(key, (set, fail) =>
    onSnapshot(build(), s => set(s.docs.map(d => ({ id: d.id, ...d.data() }) as T)), fail), NONE);
}

export const useMyLeagues = (uid: string | null) => useQueryData<League>(uid && `leagues:${uid}`,
  () => query(collection(db, 'leagues'), where('memberUids', 'array-contains', uid)));
export const useLeague = (id: string) => useDocData<League>(`leagues/${id}`);
export const useMembers = (id: string) => useQueryData<Member>(`members:${id}`,
  () => collection(db, `leagues/${id}/members`));
export const useStandings = (id: string) => useDocData<Standings & { id: string }>(`leagues/${id}/meta/standings`);
export const useNicknames = (id: string) => useDocData<Record<string, string>>(`leagues/${id}/meta/nicknames`);
export const useChat = (id: string) => useQueryData<ChatMessage>(`chat:${id}`,
  () => query(collection(db, `leagues/${id}/chat`), orderBy('ts', 'asc'), limitToLast(200)));
export const useTxns = (id: string) => useQueryData<Txn>(`txns:${id}`,
  () => query(collection(db, `leagues/${id}/txns`), orderBy('ts', 'asc'), limitToLast(60)));

/**
 * The whole FPL player pool, live, so injuries and transfers show up without
 * restarting the app. `data` is null until it loads.
 */
export function useCatalog(): State<Map<string, CatalogPlayer> | null> {
  const { data, loading, error, retry } = useDocData<{ players?: CatalogPlayer[] }>('fpl/catalog');
  const map = useMemo(
    () => (loading || error ? null : new Map((data?.players ?? []).map(p => [p.c, p]))),
    [data, loading, error]);
  return { data: map, loading, error, retry };
}
