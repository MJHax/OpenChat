import { createContext, useContext } from 'react';
import type { LocalAvailability } from '../../../shared/types';

/** Whether each local model can reply right now, keyed by library id; empty until known and for OpenRouter models. */
export const AvailabilityContext = createContext<Record<string, LocalAvailability>>({});

export const useAvailability = () => useContext(AvailabilityContext);
