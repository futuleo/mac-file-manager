import { call } from "./backend/client";

/** At most this many native icon lookups run at once; the rest wait (and can be dropped). */
export const MAX_CONCURRENT_ICONS = 4;
const MAX_CACHED = 1000;

const cache = new Map<string, string>();
const waiting: Task[] = [];
let running = 0;

interface Task {
  key: string;
  id: string;
  pixels: number;
  waiters: Set<(url: string) => void>;
  started: boolean;
}
const tasks = new Map<string, Task>();

export const cachedIcon = (id: string, size: number) => cache.get(`${id}:${size}`) ?? null;

function pump() {
  while (running < MAX_CONCURRENT_ICONS && waiting.length > 0) {
    const task = waiting.shift()!;
    task.started = true;
    running += 1;
    call("get_icon", { id: task.id, size: task.pixels })
      .then(
        (url) => {
          if (cache.size >= MAX_CACHED) cache.clear();
          cache.set(task.key, url);
          task.waiters.forEach((w) => w(url));
        },
        () => {}, // an icon is cosmetic; the placeholder glyph stays
      )
      .finally(() => {
        running -= 1;
        tasks.delete(task.key);
        pump();
      });
  }
}

/**
 * Requests an icon. Requests for the same icon share one lookup; a lookup that has
 * not started is dropped when its last requester cancels (row scrolled away, tab closed).
 * A lookup already running cannot be aborted natively, but the number is bounded.
 */
export function requestIcon(id: string, size: number, onLoad: (url: string) => void): () => void {
  const key = `${id}:${size}`;
  const hit = cache.get(key);
  if (hit) {
    onLoad(hit);
    return () => {};
  }
  let task = tasks.get(key);
  if (!task) {
    task = { key, id, pixels: size, waiters: new Set(), started: false };
    tasks.set(key, task);
    waiting.push(task);
  }
  task.waiters.add(onLoad);
  const owned = task;
  pump();
  return () => {
    owned.waiters.delete(onLoad);
    if (!owned.started && owned.waiters.size === 0) {
      const index = waiting.indexOf(owned);
      if (index >= 0) waiting.splice(index, 1);
      tasks.delete(owned.key);
    }
  };
}

export function resetIconQueueForTests() {
  cache.clear();
  waiting.length = 0;
  tasks.clear();
  running = 0;
}
