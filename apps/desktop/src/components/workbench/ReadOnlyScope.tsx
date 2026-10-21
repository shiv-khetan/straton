import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
const ReadOnlyContext = createContext(false);
export const useReadOnly = () => useContext(ReadOnlyContext);
export function ReadOnlyScope({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  return (
    <ReadOnlyContext.Provider value={disabled}>
      <fieldset className="read-only-scope" disabled={disabled}>
        {children}
      </fieldset>
    </ReadOnlyContext.Provider>
  );
}
