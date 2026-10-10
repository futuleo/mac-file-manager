import type { FileEntry } from "../backend/contracts";

/** A folder the explorer can show. `id` is the backend's lossless hex path id. */
export interface Location {
  id: string;
  path: string;
  name: string;
}

export function locationOf(entry: Pick<FileEntry, "id" | "path" | "name">): Location {
  return { id: entry.id, path: entry.path, name: entry.name };
}

const SLASH = 0x2f;
const decoder = new TextDecoder("utf-8");

function idToBytes(id: string): Uint8Array | null {
  if (id.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(id)) return null;
  const bytes = new Uint8Array(id.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToId(bytes: Uint8Array): string {
  let id = "";
  for (const b of bytes) id += b.toString(16).padStart(2, "0");
  return id;
}

/**
 * The lexical chain from `/` down to the location, derived from the raw path bytes of
 * the id so non-UTF-8 names stay addressable. `/` never occurs inside a UTF-8
 * multi-byte sequence, so splitting on that byte is lossless. Returns just the
 * location itself if the id is not decodable.
 */
export function ancestors(location: Location): Location[] {
  const bytes = idToBytes(location.id);
  if (!bytes || bytes[0] !== SLASH) return [location];
  const chain: Location[] = [{ id: bytesToId(bytes.slice(0, 1)), path: "/", name: "/" }];
  let start = 1;
  for (let i = 1; i <= bytes.length; i += 1) {
    if (i === bytes.length || bytes[i] === SLASH) {
      if (i > start) {
        const prefix = bytes.slice(0, i);
        chain.push({
          id: bytesToId(prefix),
          path: decoder.decode(prefix),
          name: decoder.decode(bytes.slice(start, i)),
        });
      }
      start = i + 1;
    }
  }
  // The final element is the location itself, with its own backend-provided display data.
  if (chain[chain.length - 1]!.id === location.id) chain[chain.length - 1] = location;
  return chain;
}

/** The containing folder, or null for `/`. */
export function parentOf(location: Location): Location | null {
  const chain = ancestors(location);
  return chain.length > 1 ? chain[chain.length - 2]! : null;
}
