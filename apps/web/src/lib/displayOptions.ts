import { createContext, useContext } from 'react';

export interface DisplayOptions {
  /**
   * Show measured figures: tool durations, tokens, cost, latency. Off in demo mode, whose
   * sample data has no measurements and must not show made-up ones.
   */
  readonly showMeasurements: boolean;
}

export const LIVE_DISPLAY: DisplayOptions = { showMeasurements: true };
export const DEMO_DISPLAY: DisplayOptions = { showMeasurements: false };

export const DisplayOptionsContext = createContext<DisplayOptions>(LIVE_DISPLAY);

export function useDisplayOptions(): DisplayOptions {
  return useContext(DisplayOptionsContext);
}
