/** Turning thrown errors into text for the user. Pure, so it is unit tested without Firebase. */

const CONNECTION = 'Check your connection and try again.';
const GENERIC = 'Something went wrong. Try again.';

type Coded = { code?: string; message?: string };

/**
 * The message a callable error carries, for showing to the user. @firebase/functions
 * appends the HTTP status (" [400]") to messages, and falls back to the bare code
 * ("not-found [404]") when the backend sent no message.
 */
export function errorMessage(e: unknown): string {
  const { code = '', message = '' } = (e ?? {}) as Coded;
  const bare = code.replace(/^functions\//, '');
  const text = message.replace(/\s*\[\d+\]$/, '').trim();
  if (/\[0\]$/.test(message) || bare === 'unavailable' || bare === 'deadline-exceeded')
    return CONNECTION;
  if (!code.startsWith('functions/') || bare === 'internal' || !text || text === bare
      || text.startsWith('Backend error status'))
    return GENERIC;
  return text;
}

/** Sign-in failures, without Firebase's raw "Firebase: Error (auth/...)" strings. */
export function authErrorMessage(e: unknown): string {
  const { code = '' } = (e ?? {}) as Coded;
  if (code === 'auth/account-exists-with-different-credential')
    return 'That email already signs in with Google. Use Google instead.';
  if (code === 'auth/network-request-failed') return CONNECTION;
  return "Sign-in didn't work. Try again.";
}

/** Direct Firestore writes (chat). */
export function writeErrorMessage(e: unknown): string {
  const { code = '' } = (e ?? {}) as Coded;
  if (code === 'unavailable' || code === 'deadline-exceeded') return CONNECTION;
  if (code === 'permission-denied') return "You can't post in this league any more.";
  return GENERIC;
}
