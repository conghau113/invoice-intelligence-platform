'use client';

import { useEffect, useReducer, useState } from 'react';
import { AskSession } from './ask-session';
import { askReducer, initialAskState } from './ask-state';

/** The Q&A screen's question and answer; the rules live in `AskSession`. */
export function useAsk() {
  const [state, dispatch] = useReducer(askReducer, initialAskState);
  // `dispatch` from useReducer never changes, so one session lives as long as the component.
  const [session] = useState(() => new AskSession(dispatch));
  useEffect(() => () => session.dispose(), [session]);
  return {
    state,
    submit: (question: string) => void session.submit(question),
    stop: () => session.stop(),
  };
}
