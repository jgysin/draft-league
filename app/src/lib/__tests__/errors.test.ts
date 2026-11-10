import { authErrorMessage, errorMessage, writeErrorMessage } from '../errors';

const GENERIC = 'Something went wrong. Try again.';
const CONNECTION = 'Check your connection and try again.';
const fn = (code: string, message: string) => ({ code: `functions/${code}`, message });

describe('errorMessage', () => {
  it('strips the HTTP status that @firebase/functions appends', () => {
    expect(errorMessage(fn('invalid-argument', 'Team name is required. [400]'))).toBe('Team name is required.');
    expect(errorMessage(fn('failed-precondition', 'The draft has not finished yet. [400]'))).toBe('The draft has not finished yet.');
  });

  it('keeps a message that has no suffix', () => {
    expect(errorMessage(fn('not-found', 'No league has that code.'))).toBe('No league has that code.');
  });

  it('never shows a bare status code', () => {
    expect(errorMessage(fn('not-found', 'not-found [404]'))).toBe(GENERIC);
    expect(errorMessage(fn('not-found', 'not-found'))).toBe(GENERIC);
    expect(errorMessage(fn('permission-denied', ''))).toBe(GENERIC);
  });

  it('treats status 0 and unavailable as a connection problem', () => {
    expect(errorMessage(fn('internal', 'internal [0]'))).toBe(CONNECTION);
    expect(errorMessage(fn('unavailable', 'unavailable [503]'))).toBe(CONNECTION);
    expect(errorMessage(fn('deadline-exceeded', 'deadline-exceeded'))).toBe(CONNECTION);
  });

  it('hides internal and unparsed backend errors', () => {
    expect(errorMessage(fn('internal', 'internal [500]'))).toBe(GENERIC);
    expect(errorMessage(fn('internal', 'Cannot read properties of undefined [500]'))).toBe(GENERIC);
    expect(errorMessage(fn('unknown', 'Backend error status: 502 [502]'))).toBe(GENERIC);
  });

  it('hides anything that is not a callable error', () => {
    expect(errorMessage(new TypeError('x is not a function'))).toBe(GENERIC);
    expect(errorMessage({ code: 'auth/network-request-failed', message: 'Firebase: Error (auth/network-request-failed).' })).toBe(GENERIC);
    expect(errorMessage(null)).toBe(GENERIC);
    expect(errorMessage(undefined)).toBe(GENERIC);
    expect(errorMessage('boom')).toBe(GENERIC);
  });
});

describe('authErrorMessage', () => {
  it('maps the codes people can act on and hides the rest', () => {
    expect(authErrorMessage({ code: 'auth/account-exists-with-different-credential' }))
      .toBe('That email already signs in with Google. Use Google instead.');
    expect(authErrorMessage({ code: 'auth/network-request-failed' })).toBe(CONNECTION);
    expect(authErrorMessage({ code: 'auth/internal-error', message: 'Firebase: Error (auth/internal-error).' }))
      .toBe("Sign-in didn't work. Try again.");
    expect(authErrorMessage(null)).toBe("Sign-in didn't work. Try again.");
  });
});

describe('writeErrorMessage', () => {
  it('only blames the connection when that is the cause', () => {
    expect(writeErrorMessage({ code: 'unavailable' })).toBe(CONNECTION);
    expect(writeErrorMessage({ code: 'permission-denied' })).toBe("You can't post in this league any more.");
    expect(writeErrorMessage(new Error('x'))).toBe(GENERIC);
  });
});
