import { useEffect, useRef, useState } from 'react';
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
  stop: () => void;
}
export function useDictation(onText: (text: string) => void, onError: (error: string) => void) {
  const recognition = useRef<Recognition | null>(null);
  const callback = useRef(onText);
  callback.current = onText;
  const [listening, setListening] = useState(false);
  const constructor =
    (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
      .SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
  useEffect(
    () => () => {
      recognition.current?.abort();
    },
    [],
  );
  const toggle = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    if (!constructor) return;
    const instance = new constructor();
    recognition.current = instance;
    instance.lang = 'tr-TR';
    instance.continuous = false;
    instance.interimResults = false;
    instance.onresult = (event) =>
      callback.current(
        Array.from(event.results)
          .map((result) => result[0]?.transcript || '')
          .join(' '),
      );
    instance.onerror = (event) => {
      setListening(false);
      onError(event.error === 'not-allowed' ? 'Microphone access was denied.' : 'Speech could not be transcribed. Try again.');
    };
    instance.onend = () => setListening(false);
    try {
      instance.start();
      setListening(true);
    } catch {
      onError('The microphone could not start.');
    }
  };
  return { supported: !!constructor, listening, toggle };
}
