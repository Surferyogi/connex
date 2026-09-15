// ---------------------------------------------------------------------------
// Read-only offline support.
//
//   - Card list: the last successfully loaded list is kept in localStorage,
//     per user, so the app can show it when Supabase is unreachable.
//   - Photos: each card photo is stored in IndexedDB the first time it is
//     loaded (keyed by its storage path) and served from there afterwards.
//
// Nothing here writes to Supabase, and the service worker is not involved:
// public/sw.js keeps caching only the app shell, exactly as before.
// Every function is fail-safe — a private-browsing Safari with no IndexedDB,
// a full quota, or a corrupt entry degrades to "fetch it from the network".
// ---------------------------------------------------------------------------

const DB_NAME = "connex-offline";
const DB_VERSION = 1;
const STORE = "images";
const USER_KEY = "connex:lastUser";
const listKey = (userId) => `connex:cards:${userId}`;

// --- card list snapshot (localStorage) ---------------------------------------
export function saveCardsSnapshot(userId, cards) {
  if (!userId) return;
  try {
    localStorage.setItem(listKey(userId), JSON.stringify({ savedAt: Date.now(), cards }));
  } catch {
    /* quota or disabled storage — offline copy simply isn't refreshed */
  }
}

export function loadCardsSnapshot(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(listKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.cards)) return null;
    return { savedAt: parsed.savedAt || null, cards: parsed.cards };
  } catch {
    return null;
  }
}

export function rememberUser(userId) {
  try {
    if (userId) localStorage.setItem(USER_KEY, userId);
  } catch {
    /* ignore */
  }
}

export function lastUser() {
  try {
    return localStorage.getItem(USER_KEY) || null;
  } catch {
    return null;
  }
}

// Called on sign-out: remove everything this device holds for the user.
export async function clearOfflineData(userId) {
  try {
    if (userId) localStorage.removeItem(listKey(userId));
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

// --- photos (IndexedDB) ---------------------------------------------------------
let dbPromise = null;
function openDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((res) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
        req.onblocked = () => res(null);
      } catch {
        res(null);
      }
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((res) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((res) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    } catch {
      res(false);
    }
  });
}

async function idbKeys() {
  const db = await openDb();
  if (!db) return [];
  return new Promise((res) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => res(req.result ?? []);
      req.onerror = () => res([]);
    } catch {
      res([]);
    }
  });
}

async function idbDelete(keys) {
  if (!keys.length) return;
  const db = await openDb();
  if (!db) return;
  await new Promise((res) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      keys.forEach((k) => store.delete(k));
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    } catch {
      res();
    }
  });
}

// Resolve a storage path to something an <img> can show.
//   1. cached blob in IndexedDB  -> object URL (works offline)
//   2. else a signed URL from Supabase; the bytes are fetched once and
//      stored for next time. If that fetch fails (CORS, offline mid-way),
//      the signed URL itself is returned so the image still shows online.
// Returns null when nothing is available. Callers should revoke the URL
// (revokeImageUrl) when they are done with it.
export async function cachedImageUrl(path, signedUrl) {
  if (!path) return null;
  const blob = await idbGet(path);
  if (blob instanceof Blob && blob.size > 0) return URL.createObjectURL(blob);
  let signed = null;
  try {
    signed = await signedUrl(path);
  } catch {
    signed = null;
  }
  if (!signed) return null;
  try {
    const res = await fetch(signed);
    if (!res.ok) return signed;
    const fetched = await res.blob();
    if (fetched.size > 0) {
      await idbPut(path, fetched);
      return URL.createObjectURL(fetched);
    }
  } catch {
    /* fall through */
  }
  return signed;
}

export function revokeImageUrl(url) {
  if (url && url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
}

// Drop cached photos that no current card references (after re-crop, retake,
// or delete). keepPaths: every image_path / image_path_back still in use.
export async function pruneImages(keepPaths) {
  try {
    const keep = new Set(keepPaths.filter(Boolean));
    const keys = await idbKeys();
    await idbDelete(keys.filter((k) => !keep.has(k)));
  } catch {
    /* ignore */
  }
}
