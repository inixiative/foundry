// Voice for the composer: browser dictation in, spoken replies out. The thread's
// own model does the work; neither Claude Code nor the Codex exec path exposes a
// native voice channel, so speech is converted at the browser edge.
import { effect, signal } from './lib.js';
import { messages } from './store.js';

const Recognition =
  typeof window !== 'undefined'
    ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
    : undefined;
export const dictationSupported = Boolean(Recognition);
export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Continuous dictation. onText receives everything heard this session, interim words included. */
export function startDictation({ onText, onEnd }) {
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  let final = '';
  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) final += result[0].transcript;
      else interim += result[0].transcript;
    }
    onText((final + interim).trim());
  };
  recognition.onerror = (event) =>
    onEnd(event.error === 'no-speech' || event.error === 'aborted' ? undefined : event.error);
  recognition.onend = () => onEnd();
  recognition.start();
  return () => recognition.stop();
}

const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
export const speakReplies = signal(speechSupported && read('foundry.speakReplies') === '1');
effect(() => {
  try {
    localStorage.setItem('foundry.speakReplies', speakReplies.value ? '1' : '0');
  } catch {}
});

/** Prose worth hearing: code blocks and markdown syntax are skipped. */
export function speakable(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Only replies watched streaming live are spoken, so history, paging and thread switches stay silent.
const live = new Set();
effect(() => {
  const on = speakReplies.value;
  for (const m of messages.value) {
    if (m.actor !== 'agent') continue;
    const key = m.turnId ?? m.id;
    if (m.streaming) {
      live.add(key);
      continue;
    }
    if (!live.delete(key) || !on || m.error || !m.content) continue;
    const text = speakable(m.content);
    if (text) window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
});

export function toggleSpeakReplies() {
  if (speakReplies.value) window.speechSynthesis.cancel();
  speakReplies.value = !speakReplies.value;
}
