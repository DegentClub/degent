import { createContext, useContext, type Dispatch } from 'react';
import type { AppConfig } from '../config';
import type { Services } from '../services/types';
import type { KeyValueStore } from '../lib/recovery';
import type { KeyVault } from './keyVault';
import type { FlowAction } from './reducer';
import type { FlowState } from './state';

export interface MintContextValue {
  app: AppConfig;
  services: Services;
  vault: KeyVault;
  store: KeyValueStore | null;
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
}

export const MintContext = createContext<MintContextValue | null>(null);

export function useMint(): MintContextValue {
  const v = useContext(MintContext);
  if (!v) throw new Error('useMint must be used inside <MintContext.Provider>');
  return v;
}
