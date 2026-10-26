// The guest page's pure logic (no DOM, no Firebase), used by app.js and by the tests (plugin/test/guest-page.test.ts). The numbers
// and the text cleaning are the protocol's (packages/phone-protocol/src/guests.ts) and the rules' (../firebase/firestore.rules); the
// tests keep the three equal. The page checks limits only to say something helpful: the rules are what holds them.

export const LIMITS = Object.freeze({ TEXT_MAX: 2000, LAST_TEXT_MAX: 140, NAME_MAX: 40, UNSEEN_MAX: 50, GAP_MS: 2000 });

// Control characters (but tab and newline), soft hyphen, zero-width, line/paragraph separators and bidirectional overrides.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export const stripInvisible = (s) => s.replace(INVISIBLE, "");

/** One line: invisible characters out, whitespace runs as one space, cut to `max` with an ellipsis. */
export function cleanLine(raw, max) {
  const s = stripInvisible(String(raw)).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A message as it is sent and shown: line ends as \n, no spaces at line ends, at most one blank line in a row, trimmed. */
export function cleanMessage(raw, max = LIMITS.TEXT_MAX) {
  const s = stripInvisible(String(raw).replace(/\r\n?/g, "\n"))
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Whether config.js has been filled in with the guest project's web config. */
export function isConfigured(c) {
  const f = c && c.firebase;
  return !!f && ["apiKey", "authDomain", "projectId", "appId"].every((k) => typeof f[k] === "string" && f[k] !== "" && !f[k].includes("REPLACE"));
}

/** A Firestore time (a Timestamp, or a number) as ms; undefined for anything else. */
export function msOf(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v.toMillis === "function") return v.toMillis();
  return undefined;
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** The guest's own thread document, as much of it as the page needs. */
export function readThread(d) {
  if (!d || typeof d !== "object") return undefined;
  return {
    guestSeq: count(d.guestSeq),
    ownerSeq: count(d.ownerSeq),
    ownerSeenSeq: count(d.ownerSeenSeq),
    guestSeenSeq: count(d.guestSeenSeq),
    blocked: d.blocked === true,
    guestAt: msOf(d.guestAt) ?? 0,
    webPush: !!(d.webPush && typeof d.webPush.token === "string"),
  };
}

/** A new thread: everything at zero, `stamp` being the server-time sentinel (serverTimestamp()). The rules accept only this shape. */
export function newThreadFields(email, displayName, stamp) {
  return {
    email,
    name: cleanLine(displayName || "", LIMITS.NAME_MAX),
    createdAt: stamp,
    lastAt: stamp,
    lastFrom: "",
    lastText: "",
    guestSeq: 0,
    ownerSeq: 0,
    ownerSeenSeq: 0,
    guestSeenSeq: 0,
    guestAt: stamp,
    blocked: false,
    webPush: null,
    pushedOwnerSeq: 0,
  };
}

/** The next message from the guest: cleaned, numbered and with its preview, or `{error}` in words to show. */
export function composeSend(t, raw) {
  if (t.blocked) return { error: "You can't send messages here any more." };
  if (t.guestSeq - t.ownerSeenSeq >= LIMITS.UNSEEN_MAX) {
    return { error: `${LIMITS.UNSEEN_MAX} of your messages are still unread. Wait for an answer, then write again.` };
  }
  const text = cleanMessage(raw, Infinity);
  if (!text) return { error: "Write something first." };
  if (text.length > LIMITS.TEXT_MAX) return { error: `Too long: ${text.length} characters, at most ${LIMITS.TEXT_MAX}.` };
  const seq = t.guestSeq + 1;
  return { id: `g${seq}`, seq, text, lastText: cleanLine(text, LIMITS.LAST_TEXT_MAX) };
}

/** ms to wait before the next write to the thread: the rules take one per 2 s, by the server's clock (a little margin added). */
export const waitBeforeWrite = (t, now) => Math.max(0, t.guestAt + LIMITS.GAP_MS + 300 - now);

/** The seen mark to write once the page is in view and the owner wrote something the guest has not marked yet. */
export function planSeen(t, now, visible) {
  if (!t || !visible || t.blocked || t.guestSeenSeq >= t.ownerSeq) return undefined;
  return { seq: t.ownerSeq, wait: Math.max(800, waitBeforeWrite(t, now)) };
}

/** A message document; undefined if malformed (its id must agree with its sender and seq). */
export function parseMessage(id, d) {
  if (!d || (d.from !== "guest" && d.from !== "owner") || !Number.isInteger(d.seq) || d.seq < 1 || typeof d.text !== "string") return undefined;
  if (id !== `${d.from === "guest" ? "g" : "o"}${d.seq}`) return undefined;
  const text = cleanMessage(d.text);
  const at = msOf(d.ts);
  if (!text || at === undefined) return undefined;
  return { id, from: d.from, text, at, seq: d.seq };
}

/** Oldest first: by server time, one side's messages by seq. */
export const sortMessages = (ms) => [...ms].sort((a, b) => a.at - b.at || (a.from === b.from ? a.seq - b.seq : a.from === "guest" ? -1 : 1));

/** "14:05" today, "Tue 14:05" this week, "12 Mar" before. */
export function timeLabel(at, now) {
  const d = new Date(at);
  const n = new Date(now);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === n.toDateString()) return hm;
  if (now - at < 6 * 86_400_000 && now >= at) return `${d.toLocaleDateString([], { weekday: "short" })} ${hm}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() !== n.getFullYear() ? { year: "numeric" } : {}) });
}

/** Words for an error. Never the error's own message: it is shown as text, but says nothing a guest can act on. */
export function friendlyError(e) {
  const code = (e && e.code) || "";
  if (code === "auth/popup-blocked") return "The sign-in window was blocked. Allow pop-ups for this page and try again.";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "Sign-in was cancelled.";
  if (code === "auth/unauthorized-domain") return "This address may not sign in yet: the owner has to allow it in Firebase.";
  if (code === "auth/network-request-failed" || code === "unavailable") return "No connection. Check your network and try again.";
  if (code === "permission-denied") return "Not allowed: you may have been taken off the list, or you are writing too fast.";
  return "Something went wrong. Reload the page and try again.";
}
