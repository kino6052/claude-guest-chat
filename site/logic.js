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

/**
 * The next message from the guest: cleaned, numbered and with its preview, or `{error}` in words to show. `pictures`: the saved
 * pictures' bytes (preparePicture in app.js); with pictures the text may be empty.
 */
export function composeSend(t, raw, pictures = []) {
  if (t.blocked) return { error: "You can't send messages here any more." };
  if (t.guestSeq - t.ownerSeenSeq >= LIMITS.UNSEEN_MAX) {
    return { error: `${LIMITS.UNSEEN_MAX} of your messages are still unread. Wait for an answer, then write again.` };
  }
  const text = cleanMessage(raw, Infinity);
  if (!text && !pictures.length) return { error: "Write something first." };
  if (text.length > LIMITS.TEXT_MAX) return { error: `Too long: ${text.length} characters, at most ${LIMITS.TEXT_MAX}.` };
  if (pictures.length > PICTURES.MAX) return { error: `At most ${PICTURES.MAX} pictures in one message.` };
  if (!pictures.every((p) => checkPicture(p))) return { error: "A picture could not be prepared. Take it out and add it again." };
  const seq = t.guestSeq + 1;
  return { id: `g${seq}`, seq, text, lastText: text ? cleanLine(text, LIMITS.LAST_TEXT_MAX) : pictureLabel(pictures.length), pictures: [...pictures] };
}

/** ms to wait before the next write to the thread: the rules take one per 2 s, by the server's clock (a little margin added). */
export const waitBeforeWrite = (t, now) => Math.max(0, t.guestAt + LIMITS.GAP_MS + 300 - now);

/** The seen mark to write once the page is in view and the owner wrote something the guest has not marked yet. */
export function planSeen(t, now, visible) {
  if (!t || !visible || t.blocked || t.guestSeenSeq >= t.ownerSeq) return undefined;
  return { seq: t.ownerSeq, wait: Math.max(800, waitBeforeWrite(t, now)) };
}

/**
 * A message document; undefined if malformed (its id must agree with its sender and seq). It has text, pictures, or both. `pictures`:
 * this message's pictures read before (messages are never edited), so the same bytes are not checked again on every change.
 */
export function parseMessage(id, d, pictures) {
  if (!d || (d.from !== "guest" && d.from !== "owner") || !Number.isInteger(d.seq) || d.seq < 1 || typeof d.text !== "string") return undefined;
  if (id !== `${d.from === "guest" ? "g" : "o"}${d.seq}`) return undefined;
  const text = cleanMessage(d.text);
  const at = msOf(d.ts);
  const pics = pictures ?? readPictures(d.pictures);
  if (at === undefined || (!text && !pics.list.length && !pics.skipped)) return undefined;
  return { id, from: d.from, text, at, seq: d.seq, ...(pics.list.length ? { pictures: pics.list } : {}), ...(pics.skipped ? { skipped: pics.skipped } : {}) };
}

// ---- pictures (the same as packages/phone-protocol/src/pictures.ts; a test keeps them equal) ----
// A message holds up to 3 pictures in its own document, as bytes. app.js opens what the guest picked, draws it on a canvas and saves it
// again as JPEG (that drops what the original carried: the place it was taken, the camera, a GIF's other frames), longest side 1280 px,
// at most 220 KiB. The rules hold the count, the sizes and the first bytes; this page checks them again before it draws a picture, and
// draws one only from a blob of the type its first bytes say. JPEG, PNG and WebP are shown; never SVG.

export const PICTURES = Object.freeze({ MAX: 3, BYTES_MAX: 225_280, BYTES_MIN: 16, SIDE_MAX: 1280, PICKED_BYTES_MAX: 40 * 1024 * 1024 });
export const PICTURE_QUALITIES = Object.freeze([0.85, 0.75, 0.65, 0.55]);

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The type the first bytes say; undefined for anything but JPEG, PNG and WebP. */
export function pictureType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && PNG_HEAD.every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** A picture's bytes from a Firestore Bytes (toUint8Array) or a Uint8Array; undefined for anything else. */
export function bytesOf(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v !== "object" || v === null || typeof v.toUint8Array !== "function") return undefined;
  try {
    const b = v.toUint8Array();
    return b instanceof Uint8Array ? b : undefined;
  } catch {
    return undefined;
  }
}

/** One picture, checked: its size and its first bytes. */
export function checkPicture(v) {
  const bytes = bytesOf(v);
  if (!bytes || bytes.length < PICTURES.BYTES_MIN || bytes.length > PICTURES.BYTES_MAX) return undefined;
  const type = pictureType(bytes);
  return type ? { type, bytes } : undefined;
}

/** A message's `pictures` field: the ones to show, and how many could not be. More than 3, or not a list: none. */
export function readPictures(raw) {
  if (raw === undefined || raw === null) return { list: [], skipped: 0 };
  if (!Array.isArray(raw)) return { list: [], skipped: 1 };
  if (raw.length > PICTURES.MAX) return { list: [], skipped: raw.length };
  const list = raw.map(checkPicture).filter(Boolean);
  return { list, skipped: raw.length - list.length };
}

export const pictureLabel = (n) => (n === 1 ? "Picture" : `${n} pictures`);
export const skippedLabel = (n) => (n === 1 ? "A picture could not be shown." : `${n} pictures could not be shown.`);

const HEIF = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** The kind of a picked file from its first 16 bytes; undefined for anything else (SVG, PDF, a video, a renamed file). */
export function pickedKind(head) {
  const t = pictureType(head);
  if (t) return t.slice(6);
  if (head.length >= 6 && /^GIF8[79]a$/.test(ascii(head, 0, 6))) return "gif";
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (HEIF.has(brand)) return "heic";
  }
  return undefined;
}

/** A size that fits in `max` × `max`, the shape kept; never larger than it was. */
export function fitSide(w, h, max = PICTURES.SIDE_MAX) {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** The tries, in order, to save a picture under the size: each quality, then three quarters of the size. */
export function encodeSteps(w, h) {
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) return [];
  const out = [];
  for (let side = Math.min(PICTURES.SIDE_MAX, Math.max(w, h)), round = 0; round < 4; side = Math.round(side * 0.75), round++) {
    const size = fitSide(w, h, side);
    for (const q of PICTURE_QUALITIES) out.push({ ...size, q });
  }
  return out;
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

/**
 * Resolves once the service worker registration `reg` has an active worker. The browser refuses to subscribe to push before that
 * ("Subscription failed - no active Service Worker"), and the Firebase SDK waits only for the worker it registers itself, not for one it
 * is handed, so the first "Notify me" used to fail right after the registration was made. Rejects if the worker is thrown away or does
 * not come up in `ms`.
 */
export function waitForActive(reg, ms = 10_000) {
  return new Promise((resolve, reject) => {
    if (reg.active) return resolve();
    const worker = reg.installing || reg.waiting;
    if (!worker) return reject(Object.assign(new Error("no worker"), { code: "sw/none" }));
    let timer;
    const finish = (err) => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", check);
      return err ? reject(err) : resolve();
    };
    function check() {
      if (worker.state === "activating" || worker.state === "activated") finish();
      else if (worker.state === "redundant") finish(Object.assign(new Error("worker discarded"), { code: "sw/redundant" }));
    }
    timer = setTimeout(() => finish(Object.assign(new Error("worker too slow"), { code: "sw/timeout" })), ms);
    worker.addEventListener("statechange", check);
    check();
  });
}

/** Words for a failure to turn "Notify me" on or off. The error's code is added in brackets (it says nothing private) so a failure can be reported. */
export function notifyError(e) {
  const raw = (e && (e.code || e.name)) || "";
  const code = /^[\w/.-]{1,60}$/.test(String(raw)) ? String(raw) : "";
  const tail = code ? ` (${code})` : "";
  if (code === "messaging/permission-blocked") return "Notifications are blocked for this page in your browser's settings.";
  if (code === "messaging/unsupported-browser") return "This browser can't get notifications from this page (on an iPhone: add it to the Home Screen first).";
  if (code === "auth/network-request-failed" || code === "unavailable") return friendlyError(e);
  if (code === "permission-denied") return friendlyError(e);
  if (code === "messaging/token-subscribe-failed" || code === "messaging/token-unsubscribe-failed") {
    return `The notification service did not accept this browser${tail}. Wait a minute and try again.`;
  }
  return `Could not turn notifications on${tail}. Reload the page and try again.`;
}

// ---- links (the same as packages/phone-protocol/src/links.ts; a test keeps them equal) ----
// The parts of a message: text, and http(s) links that app.js draws as <a> elements with their text set as text. Nothing is fetched or
// previewed. A link with a user name or password, a backslash, a host without a dot or over LINK_MAX characters stays text. `host` is
// the real host, punycode decoded; `idn`: it had punycode in it (other alphabets, which can imitate a site); `plain`: the written text
// shows that host. The page shows the host beside a link that is not plain or is idn.

export const LINK_MAX = 2000;
export const LINKS_PER_MESSAGE = 30;

const CANDIDATE = /(^|[^A-Za-z0-9])(https?:\/\/(?:[!#-;=?-_a-~]|[\p{L}\p{N}\p{M}])+)/giu;
const TRAILING = /[.,:;!?'*_~-]$/;
const PAIRS = { ")": "(", "]": "[", "}": "{" };
const countOf = (s, c) => s.split(c).length - 1;

function trimEnd(s) {
  for (;;) {
    const last = s.slice(-1);
    if (TRAILING.test(last)) s = s.slice(0, -1);
    else if (PAIRS[last] && countOf(s, last) > countOf(s, PAIRS[last])) s = s.slice(0, -1);
    else return s;
  }
}

function writtenHost(s) {
  const authority = s.slice(s.indexOf("//") + 2).split(/[/?#]/, 1)[0];
  const host = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.replace(/:\d*$/, "");
  return host.toLowerCase();
}

/** A link part for `text`, or undefined when it is not a link this chat makes. */
export function parseLink(text) {
  if (!/^https?:\/\//i.test(text) || text.includes("\\")) return undefined;
  let u;
  try {
    u = new URL(text);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return undefined;
  const hostAscii = u.hostname.toLowerCase();
  if (!hostAscii || (!hostAscii.includes(".") && !hostAscii.startsWith("[")) || u.href.length > LINK_MAX) return undefined;
  const host = displayHost(hostAscii);
  const written = writtenHost(text);
  return { text, href: u.href, host, hostAscii, idn: hostAscii.split(".").some((l) => l.startsWith("xn--")), plain: written === host || written === hostAscii };
}

export const isLink = (p) => "href" in p;

/** The message's text as parts: text and links, in order. Joined, the parts' text is the message. */
export function linkParts(message) {
  const out = [];
  const text = (s) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && !isLink(last)) last.text += s;
    else out.push({ text: s });
  };
  let at = 0;
  let links = 0;
  CANDIDATE.lastIndex = 0;
  for (let m = CANDIDATE.exec(message); m; m = CANDIDATE.exec(message)) {
    const start = m.index + m[1].length;
    const raw = trimEnd(m[2]);
    const link = links < LINKS_PER_MESSAGE ? parseLink(raw) : undefined;
    if (!link) continue;
    text(message.slice(at, start));
    out.push(link);
    links++;
    at = start + raw.length;
    CANDIDATE.lastIndex = at;
  }
  text(message.slice(at));
  return out;
}

// Punycode (RFC 3492), decoding only: to show a host as people read it.
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const MAX_INT = 0x7fffffff;

function adapt(delta, points, first) {
  let k = 0;
  delta = first ? Math.floor(delta / 700) : delta >> 1;
  delta += Math.floor(delta / points);
  for (; delta > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - T_MIN));
  return Math.floor(k + ((BASE - T_MIN + 1) * delta) / (delta + 38));
}

function digitOf(c) {
  if (c >= 48 && c <= 57) return c - 22;
  if (c >= 65 && c <= 90) return c - 65;
  if (c >= 97 && c <= 122) return c - 97;
  return BASE;
}

/** One punycode label (without "xn--") decoded; undefined when it is not valid punycode. */
export function punycodeDecode(input) {
  if (input.length > 63) return undefined;
  const out = [];
  const basic = Math.max(0, input.lastIndexOf("-"));
  for (let j = 0; j < basic; j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return undefined;
    out.push(c);
  }
  let n = 128;
  let i = 0;
  let bias = 72;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length; ) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (idx >= input.length) return undefined;
      const digit = digitOf(input.charCodeAt(idx++));
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w)) return undefined;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return undefined;
      w *= BASE - t;
    }
    const len = out.length + 1;
    bias = adapt(i - old, len, old === 0);
    if (Math.floor(i / len) > MAX_INT - n) return undefined;
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return undefined;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** A host as people read it: each "xn--" label decoded (one that does not decode stays as it is), lower case. */
export function displayHost(hostAscii) {
  return hostAscii
    .toLowerCase()
    .split(".")
    .map((l) => (l.startsWith("xn--") ? (punycodeDecode(l.slice(4)) ?? l) : l))
    .join(".");
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
