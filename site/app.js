// The guest page: sign in with Google, check the allowlist, then one live thread with the owner. Plain ES modules, no build step; the
// Firebase SDK is loaded from Google's CDN. Everything anyone wrote is drawn with text nodes only (a test refuses any html-building call
// here); links are <a> elements made with DOM calls, http(s) only, opened in a new tab without a referrer, never fetched or previewed.
// Pictures (up to 3 a message) are saved again as JPEG here before they go, and drawn as <img> from a blob of the type their first
// bytes say, after the same checks the rules make. The rules (../firebase/firestore.rules) hold every limit; this page only waits for
// the 2 s gap and explains refusals.
import {
  LIMITS,
  PICTURES,
  checkPicture,
  cleanLine,
  cleanMessage,
  composeSend,
  encodeSteps,
  friendlyError,
  isConfigured,
  isLink,
  linkParts,
  newThreadFields,
  notifyError,
  parseMessage,
  pickedKind,
  planSeen,
  readPictures,
  readThread,
  skippedLabel,
  sortMessages,
  timeLabel,
  waitBeforeWrite,
  waitForActive,
} from "./logic.js";

/** The SDK version: the one the repo builds with (its four modules are on the CDN, checked 2026-10-26). */
const SDK = "https://www.gstatic.com/firebasejs/13.0.0";
const config = self.GUEST_CHAT_CONFIG || {};
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Messages from one side this close together are drawn as a run. */
const RUN_MS = 5 * 60_000;

function show(section) {
  for (const id of ["status", "signin", "chat"]) $(id).hidden = id !== section;
  $("composer").hidden = section !== "chat";
}
function status(text) {
  $("status").textContent = text;
  show("status");
}

const ownerName = config.ownerName ? cleanLine(String(config.ownerName), LIMITS.NAME_MAX) : "";
const owner = ownerName || "the owner";
if (ownerName) {
  $("title").textContent = ownerName;
  $("signin-title").textContent = `Chat with ${ownerName}`;
  document.title = `Chat with ${ownerName}`;
}
$("signin-text").textContent = `Sign in with the Google account ${owner} added to the list.`;
$("signin-note").textContent = `Messages here are not end-to-end encrypted: ${owner} and Google, which stores them, can read them.`;
$("note").textContent = `Not end-to-end encrypted: ${owner} and Google, which stores the messages, can read them.`;

if (!isConfigured(config)) status("This page is not set up yet.");
else start().catch((e) => status(`Could not start. ${friendlyError(e)}`));

const SVG = "http://www.w3.org/2000/svg";
/** One of the page's sprite icons (index.html), the size of the text. */
function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "ic t");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

/** A message's text into `el`: text as text, http(s) links as links, and the real host beside a link that does not show it plainly. */
function drawText(el, message) {
  for (const p of linkParts(message)) {
    if (!isLink(p)) {
      el.append(p.text);
      continue;
    }
    const a = document.createElement("a");
    a.href = p.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    a.referrerPolicy = "no-referrer";
    a.title = p.href;
    a.textContent = p.text;
    el.append(a);
    if (p.idn || !p.plain) {
      const host = document.createElement("span");
      host.className = p.idn ? "host warn" : "host";
      if (p.idn) host.append(icon("alert"), p.hostAscii);
      else host.textContent = `→ ${p.host}`;
      host.title = p.idn ? `Goes to ${p.host}, written ${p.hostAscii}: letters from other alphabets can look like a site you know.` : `Goes to ${p.host}`;
      el.append(host);
    }
  }
}

// ---- pictures ----

/** The address an <img> here gets: a blob of a checked picture (checkPicture, readPictures), of the type its first bytes say. */
const pictureSrc = (p) => URL.createObjectURL(new Blob([p.bytes], { type: p.type }));
const shown = (text) => Object.assign(new Error(text), { shown: text });

/** Opens a picked file: an ImageBitmap the right way up, or an <img> where the browser has no createImageBitmap. */
async function decode(file) {
  if (self.createImageBitmap) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A picked file saved again as a JPEG for a message: opened by the browser, drawn on a canvas at most 1280 px on its longest side, and
 * encoded under 220 KiB (lower quality, then smaller, until it fits). Nothing of the original but its pixels survives the canvas: not
 * where or with what it was taken, not a GIF's other frames, not anything hidden in the file. Throws with words to show.
 */
async function preparePicture(file) {
  const kind = pickedKind(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (!kind) throw shown("Only photos can be added: JPEG, PNG, WebP, GIF or HEIC.");
  if (file.size > PICTURES.PICKED_BYTES_MAX) throw shown("That picture is too large to open (over 40 MB).");
  let img;
  try {
    img = await decode(file);
  } catch {
    throw shown(kind === "heic" || kind === "avif" ? "This browser can't open HEIC or AVIF pictures. Pick a JPEG or PNG instead." : "This picture could not be opened.");
  }
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    let drawn = "";
    for (const s of encodeSteps(img.width, img.height)) {
      if (drawn !== `${s.w}x${s.h}`) {
        drawn = `${s.w}x${s.h}`;
        canvas.width = s.w;
        canvas.height = s.h;
        ctx.imageSmoothingQuality = "high";
        ctx.fillStyle = "#fff"; // JPEG has no transparency: a see-through PNG gets a white ground
        ctx.fillRect(0, 0, s.w, s.h);
        ctx.drawImage(img.source, 0, 0, s.w, s.h);
      }
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", s.q));
      if (!blob || blob.size > PICTURES.BYTES_MAX) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (checkPicture(bytes)?.type === "image/jpeg") return bytes;
    }
  } finally {
    img.close();
  }
  throw shown("This picture could not be made small enough to send.");
}

// The viewer: one picture as large as the screen allows. A tap anywhere, Escape or Close shuts it.
const viewer = $("viewer");
let viewerFrom;
function openViewer(url) {
  viewerFrom = document.activeElement;
  $("viewer-img").src = url;
  viewer.hidden = false;
  $("viewer-close").focus({ preventScroll: true });
}
function closeViewer() {
  if (viewer.hidden) return;
  viewer.hidden = true;
  $("viewer-img").removeAttribute("src");
  viewerFrom?.focus?.({ preventScroll: true });
}
viewer.addEventListener("click", closeViewer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !viewer.hidden) {
    e.preventDefault();
    closeViewer();
  }
});

async function start() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config.firebase);
  const a = auth.getAuth(app);
  const db = fs.getFirestore(app);
  let stop = () => {};

  $("google").addEventListener("click", () => {
    $("signin-error").textContent = "";
    const provider = new auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    // A popup, not a redirect (redirects break on github.io); it must start from this click or it is blocked.
    auth.signInWithPopup(a, provider).catch((e) => ($("signin-error").textContent = friendlyError(e)));
  });
  $("signout").addEventListener("click", () => auth.signOut(a));

  auth.onAuthStateChanged(a, (user) => {
    stop();
    stop = () => {};
    $("signout").hidden = !user;
    $("who").textContent = user?.email ?? "";
    if (!user) return show("signin");
    enter(user).then(
      (s) => (stop = s),
      (e) => status(friendlyError(e)),
    );
  });

  /** Checks the list, makes the thread on the first visit, opens the chat. Returns what stops its listeners. */
  async function enter(user) {
    if (!user.email || !user.emailVerified) {
      status("Your Google account's email is not verified, so this page can't tell who you are.");
      return () => {};
    }
    status("Checking the list…");
    const email = user.email.toLowerCase();
    let listed = false;
    try {
      listed = (await fs.getDoc(fs.doc(db, "allow", email))).exists();
    } catch (e) {
      if (e?.code !== "permission-denied") throw e;
    }
    if (!listed) {
      status(`You are not on the list yet. Ask ${owner} to add ${email}, then reload this page.`);
      return () => {};
    }
    const ref = fs.doc(db, "threads", user.uid);
    if (!(await fs.getDoc(ref)).exists()) await fs.setDoc(ref, newThreadFields(email, user.displayName, fs.serverTimestamp()));
    return chat(ref);
  }

  /** The live thread. */
  function chat(ref) {
    show("chat");
    let thread;
    let messages = [];
    let sending = false;
    let seenTimer;
    /** The ids drawn so far: a message not among them comes in with a short animation (none on the first drawing). */
    const drawn = new Set();
    let first = true;
    let toBottom = false;
    const stamp = () => fs.serverTimestamp();
    const stage = $("stage");
    const box = $("text");
    /** Each message's pictures as read (a message is never edited, so they are checked once), and their drawn strip with its blobs. */
    const known = new Map();
    const strips = new Map();
    /** The pictures to go with the next message: {busy} while one is being prepared, then {bytes, url}. */
    let tray = [];

    /** A write to the thread, after the 2 s gap the rules hold; tried once more if refused (the server's clock may be ahead). */
    async function guestWrite(write) {
      if (thread) await sleep(waitBeforeWrite(thread, Date.now()));
      try {
        return await write();
      } catch (e) {
        if (e?.code !== "permission-denied" && e?.code !== "failed-precondition" && e?.code !== "aborted") throw e;
        await sleep(LIMITS.GAP_MS + 500);
        return write();
      }
    }

    /** A message's pictures as tiles that open larger; made once per message and moved into each new drawing of its bubble. */
    function pictureStrip(m) {
      const had = strips.get(m.id);
      if (had) return had.el;
      const urls = m.pictures.map(pictureSrc);
      const el = document.createElement("div");
      el.className = `pics n${urls.length}`;
      urls.forEach((url, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pic";
        b.setAttribute("aria-label", urls.length > 1 ? `Picture ${i + 1} of ${urls.length}, open it larger` : "Picture, open it larger");
        const img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.src = url;
        b.append(img);
        b.addEventListener("click", () => openViewer(url));
        el.append(b);
      });
      strips.set(m.id, { el, urls });
      return el;
    }

    /** Lets go of the blobs of messages no longer shown. */
    function freeStrips(keep) {
      for (const [id, s] of strips) {
        if (keep.has(id)) continue;
        for (const url of s.urls) URL.revokeObjectURL(url);
        strips.delete(id);
      }
    }

    function bubble(m, prev, seen) {
      const li = document.createElement("li");
      const mine = m.from === "guest";
      li.className = mine ? "msg mine" : "msg theirs";
      if (prev && prev.from === m.from && m.at - prev.at < RUN_MS) li.classList.add("next");
      if (!first && !drawn.has(m.id)) li.classList.add("arrive");
      if (m.pictures) {
        li.classList.add("has-pics");
        li.append(pictureStrip(m));
      }
      if (m.text) {
        const text = document.createElement("div");
        text.className = "text";
        drawText(text, m.text);
        li.append(text);
      }
      if (m.skipped) {
        const s = document.createElement("div");
        s.className = "skipped";
        s.textContent = skippedLabel(m.skipped);
        li.append(s);
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      const time = document.createElement("time");
      time.dateTime = new Date(m.at).toISOString();
      time.textContent = timeLabel(m.at, Date.now());
      meta.append(time);
      if (seen) meta.append(" · Seen");
      li.append(meta);
      return li;
    }

    function render() {
      const nearBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 80;
      const sorted = sortMessages(messages);
      const lastMine = [...sorted].reverse().find((m) => m.from === "guest");
      $("messages").replaceChildren(...sorted.map((m, i) => bubble(m, sorted[i - 1], m === lastMine && !!thread && thread.ownerSeenSeq >= m.seq)));
      freeStrips(new Set(sorted.map((m) => m.id)));
      for (const m of sorted) drawn.add(m.id);
      $("empty").hidden = sorted.length > 0;
      if (nearBottom || toBottom) {
        stage.scrollTop = stage.scrollHeight;
        toBottom = false;
      }
      const blocked = thread?.blocked === true;
      box.disabled = blocked;
      $("send").disabled = blocked || sending;
      if (blocked) $("send-error").textContent = "You can't send messages here any more.";
      renderTray();
      renderNotify();
    }

    // ---- the pictures to send: picked (or pasted), saved again as JPEG one after the other, shown above the box ----

    function renderTray() {
      // The tray takes room from the messages: the newest stays in sight if it was.
      const nearBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 80;
      const list = $("tray");
      list.hidden = !tray.length;
      list.replaceChildren(
        ...tray.map((item) => {
          const li = document.createElement("li");
          li.className = item.busy ? "slot busy" : "slot";
          if (item.url) {
            const img = document.createElement("img");
            img.alt = "";
            img.src = item.url;
            li.append(img);
          }
          const out = document.createElement("button");
          out.type = "button";
          out.className = "unpick";
          out.title = "Take this picture out";
          out.setAttribute("aria-label", "Take this picture out");
          out.append(icon("x"));
          out.addEventListener("click", () => unpick([item]));
          li.append(out);
          return li;
        }),
      );
      $("compose").classList.toggle("has-pictures", tray.length > 0);
      $("attach").disabled = thread?.blocked === true || tray.length >= PICTURES.MAX;
      if (nearBottom) stage.scrollTop = stage.scrollHeight;
    }

    function unpick(items) {
      for (const item of items) if (item.url) URL.revokeObjectURL(item.url);
      tray = tray.filter((x) => !items.includes(x));
      renderTray();
    }

    async function addPictures(files) {
      if (!files.length) return;
      $("send-error").textContent = "";
      const room = Math.max(0, PICTURES.MAX - tray.length);
      if (files.length > room) $("send-error").textContent = `At most ${PICTURES.MAX} pictures in one message.`;
      const items = files.slice(0, room).map((file) => ({ file, busy: true }));
      tray.push(...items);
      renderTray();
      // One at a time: a phone has the memory for one opened photo more easily than for three.
      for (const item of items) {
        try {
          const bytes = await preparePicture(item.file);
          if (!tray.includes(item)) continue; // taken out meanwhile
          item.bytes = bytes;
          item.url = pictureSrc(checkPicture(bytes));
          item.busy = false;
        } catch (e) {
          tray = tray.filter((x) => x !== item);
          $("send-error").textContent = e?.shown ?? "This picture could not be opened.";
        }
        delete item.file;
        renderTray();
      }
    }

    function scheduleSeen() {
      clearTimeout(seenTimer);
      const plan = planSeen(thread, Date.now(), document.visibilityState === "visible");
      if (!plan) return;
      seenTimer = setTimeout(() => {
        if (sending) return scheduleSeen();
        fs.updateDoc(ref, { guestSeenSeq: plan.seq, guestAt: stamp() }).catch(() => {}); // best effort: tried again on the next change
      }, plan.wait);
    }

    async function send() {
      if (sending || !thread) return;
      if (tray.some((x) => x.busy)) {
        $("send-error").textContent = "A picture is still being prepared. Send again in a moment.";
        return;
      }
      const raw = box.value;
      const going = [...tray];
      const pictures = going.map((x) => x.bytes);
      const plan = composeSend(thread, raw, pictures);
      $("send-error").textContent = "error" in plan ? plan.error : "";
      if ("error" in plan) return;
      sending = true;
      render();
      try {
        await guestWrite(() =>
          fs.runTransaction(db, async (tx) => {
            const now = readThread((await tx.get(ref)).data());
            const p = now && composeSend(now, raw, pictures);
            if (!p || "error" in p) throw Object.assign(new Error("refused"), { shown: p?.error });
            tx.update(ref, { guestSeq: p.seq, lastAt: stamp(), lastFrom: "guest", lastText: p.lastText, guestAt: stamp() });
            const message = { from: "guest", text: p.text, ts: stamp(), seq: p.seq };
            if (p.pictures.length) message.pictures = p.pictures.map((b) => fs.Bytes.fromUint8Array(b));
            tx.set(fs.doc(ref, "messages", p.id), message);
          }),
        );
        if (box.value === raw) box.value = "";
        unpick(going);
        toBottom = true;
        onInput();
      } catch (e) {
        $("send-error").textContent = e?.shown ?? friendlyError(e);
      } finally {
        sending = false;
        render();
      }
    }

    /** The box grows with what is written (by CSS where the browser can, here where it can't); the count shows near the limit. */
    const grows = !(self.CSS && CSS.supports("field-sizing", "content"));
    function onInput() {
      if (grows) {
        box.style.height = "auto";
        box.style.height = `${box.scrollHeight}px`;
      }
      const n = cleanMessage(box.value, Infinity).length;
      $("count").textContent = n > LIMITS.TEXT_MAX * 0.8 ? `${n} / ${LIMITS.TEXT_MAX}` : "";
    }

    // ---- "Notify me": a web push when the owner answers (sent by the owner's PC; sw.js shows it) ----

    const browserCanPush = () => "serviceWorker" in navigator && "Notification" in self && "PushManager" in self;
    const canNotify = () => !!config.vapidKey && browserCanPush();
    const notifying = () => !!thread?.webPush && canNotify() && Notification.permission === "granted";

    function renderNotify() {
      const b = $("notify");
      const on = notifying();
      b.hidden = !canNotify() || !thread || thread.blocked;
      b.classList.toggle("on", on);
      $("notify-text").textContent = on ? "Turn off notifications" : "Notify me of replies";
      $("notify-icon").setAttribute("href", on ? "#i-bell-off" : "#i-bell");
      // A browser that can't show notifications (an in-app browser, an iPhone's Safari outside the Home Screen) used to get no button and
      // no word why; now it is told.
      $("notify-hint").hidden = !config.vapidKey || browserCanPush() || !thread || thread.blocked;
    }

    async function toggleNotify() {
      const b = $("notify");
      b.disabled = true;
      $("send-error").textContent = "";
      try {
        if (notifying()) {
          const m = await import(`${SDK}/firebase-messaging.js`);
          await m.deleteToken(m.getMessaging(app)).catch(() => {});
          await guestWrite(() => fs.updateDoc(ref, { webPush: null, guestAt: stamp() }));
          return;
        }
        // Asked first, straight from the click: browsers refuse a permission prompt that does not follow a gesture.
        if ((await Notification.requestPermission()) !== "granted") {
          $("send-error").textContent = "Notifications are blocked for this page in your browser's settings.";
          return;
        }
        const m = await import(`${SDK}/firebase-messaging.js`);
        if (!(await m.isSupported())) {
          $("send-error").textContent = "This browser can't get notifications from this page (on an iPhone: add it to the Home Screen first).";
          return;
        }
        const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
        // The browser subscribes to push only through a worker that is active, and the SDK does not wait for the one it is handed: on a
        // first visit the subscription failed right after the registration, and the guest got an error and no notifications.
        await waitForActive(reg);
        const token = await m.getToken(m.getMessaging(app), { vapidKey: config.vapidKey, serviceWorkerRegistration: reg });
        if (!token) throw new Error("no token");
        await guestWrite(() => fs.updateDoc(ref, { webPush: { token, updatedAt: stamp() }, guestAt: stamp() }));
      } catch (e) {
        $("send-error").textContent = notifyError(e);
      } finally {
        b.disabled = false;
        renderNotify();
      }
    }

    const onKey = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    };
    const onSubmit = (e) => {
      e.preventDefault();
      send();
    };
    // Send keeps the focus in the box, so a phone's keyboard stays up between messages.
    const keepFocus = (e) => e.preventDefault();
    const onVisible = () => scheduleSeen();
    const onAttach = () => $("pick").click();
    const onPick = () => {
      const files = [...$("pick").files];
      $("pick").value = ""; // the same picture may be picked again after it was taken out
      addPictures(files);
    };
    // A picture pasted into the box (a screenshot, say) is added like a picked one; pasted text stays text.
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      addPictures(files);
    };
    box.addEventListener("keydown", onKey);
    box.addEventListener("input", onInput);
    box.addEventListener("paste", onPaste);
    $("send").addEventListener("mousedown", keepFocus);
    $("compose").addEventListener("submit", onSubmit);
    $("attach").addEventListener("click", onAttach);
    $("pick").addEventListener("change", onPick);
    $("notify").addEventListener("click", toggleNotify);
    document.addEventListener("visibilitychange", onVisible);

    const offThread = fs.onSnapshot(
      ref,
      (s) => {
        thread = readThread(s.data({ serverTimestamps: "estimate" }));
        render();
        scheduleSeen();
      },
      (e) => status(friendlyError(e)),
    );
    const recent = fs.query(fs.collection(ref, "messages"), fs.orderBy("ts", "desc"), fs.limit(300));
    const offMessages = fs.onSnapshot(
      recent,
      (s) => {
        const ids = new Set(s.docs.map((d) => d.id));
        for (const id of known.keys()) if (!ids.has(id)) known.delete(id);
        messages = s.docs
          .map((d) => {
            const data = d.data({ serverTimestamps: "estimate" });
            if (!known.has(d.id)) known.set(d.id, readPictures(data?.pictures));
            return parseMessage(d.id, data, known.get(d.id));
          })
          .filter(Boolean);
        if (first) toBottom = true;
        render();
        first = false;
      },
      (e) => status(friendlyError(e)),
    );

    return () => {
      offThread();
      offMessages();
      clearTimeout(seenTimer);
      box.removeEventListener("keydown", onKey);
      box.removeEventListener("input", onInput);
      box.removeEventListener("paste", onPaste);
      $("send").removeEventListener("mousedown", keepFocus);
      $("compose").removeEventListener("submit", onSubmit);
      $("attach").removeEventListener("click", onAttach);
      $("pick").removeEventListener("change", onPick);
      $("notify").removeEventListener("click", toggleNotify);
      document.removeEventListener("visibilitychange", onVisible);
      $("messages").replaceChildren();
      closeViewer();
      freeStrips(new Set());
      unpick([...tray]);
    };
  }
}
