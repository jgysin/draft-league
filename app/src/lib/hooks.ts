import { useEffect, useState } from 'react';
import { collection, doc, DocumentData, getDoc, limitToLast, onSnapshot, orderBy, query, Query, where } from 'firebase/firestore';
import { db } from './firebase';
import type { CatalogPlayer, ChatMessage, League, Member, Standings, Txn } from './types';

type State<T> = { data: T; loading: boolean; error: Error | null };

/**
 * Subscribe while `key` is non-null; resubscribes when it changes. Results are
 * tagged with the key they belong to, so a stale result reads as loading.
 */
function useSnapshot<T>(key: string | null,
                        subscribe: (set: (v: T) => void, fail: (e: Error) => void) => () => void,
                        initial: T): State<T> {
  const [state, setState] = useState<{ key: string | null; data: T; error: Error | null }>({ key: null, data: initial, error: null });
  useEffect(() => {
    if (key === null) return;
    return subscribe(data => setState({ key, data, error: null }), error => setState(s => ({ ...s, key, error })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (key === null) return { data: initial, loading: false, error: null };
  if (state.key !== key) return { data: initial, loading: true, error: null };
  return { data: state.data, loading: false, error: state.error };
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

/** The whole FPL player pool, read once per app session. */
let catalogCache: Promise<Map<string, CatalogPlayer>> | null = null;
export function useCatalog() {
  const [map, setMap] = useState<Map<string, CatalogPlayer> | null>(null);
  useEffect(() => {
    let live = true;
    if (!catalogCache) {
      catalogCache = getDoc(doc(db, 'fpl/catalog'))
        .then(s => new Map(((s.data()?.players ?? []) as CatalogPlayer[]).map(p => [p.c, p])))
        .catch(e => { catalogCache = null; throw e; });
    }
    catalogCache.then(m => live && setMap(m), () => {});
    return () => { live = false; };
  }, []);
  return map;
}
