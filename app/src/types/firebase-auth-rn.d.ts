// @firebase/auth ships getReactNativePersistence only in its react-native build, whose
// types TypeScript doesn't pick up from the package's exports map. Metro resolves the
// react-native build at runtime, so declaring it here is enough.
import type { Persistence } from '@firebase/auth';

declare module '@firebase/auth' {
  interface ReactNativeAsyncStorage {
    setItem(key: string, value: string): Promise<void>;
    getItem(key: string): Promise<string | null>;
    removeItem(key: string): Promise<void>;
  }
  export function getReactNativePersistence(storage: ReactNativeAsyncStorage): Persistence;
}
