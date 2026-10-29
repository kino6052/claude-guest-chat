// The guest page: sign in with Google, check the allowlist, then one live thread with the owner. Plain ES modules, no build step; the
// Firebase SDK is loaded from Google's CDN. Everything anyone wrote is drawn with textContent only (a test refuses any html-building call here).
// The rules (../firebase/firestore.rules) hold every limit; this page only waits for the 2 s gap and explains refusals.
import {
  LIMITS,
  cleanMessage,
  composeSend,
  friendlyError,
  isConfigured,
  newThreadFields,
  notifyError,
  parseMessage,
  planSeen,
  readThread,
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

function show(section) {
  for (const id of ["status", "signin", "chat"]) $(id).hidden = id !== section;
}
function status(text) {
  $("status").textContent = text;
  show("status");
}

if (config.ownerName) {
  const title = `Chat with ${String(config.ownerName).slice(0, 40)}`;
  $("title").textContent = title;
  document.title = title;
}

if (!isConfigured(config)) status("This page is not set up yet.");
else start().catch((e) => status(`Could not start. ${friendlyError(e)}`));

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
      status(`You are not on the list yet. Ask the owner to add ${email}, then reload this page.`);
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
    const stamp = () => fs.serverTimestamp();

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

    function render() {
      const list = $("messages");
      const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
      const sorted = sortMessages(messages);
      const lastMine = [...sorted].reverse().find((m) => m.from === "guest");
      list.replaceChildren(
        ...sorted.map((m) => {
          const li = document.createElement("li");
          li.className = m.from === "guest" ? "mine" : "theirs";
          li.append(document.createTextNode(m.text));
          const time = document.createElement("time");
          time.textContent = timeLabel(m.at, Date.now());
          li.append(time);
          if (m === lastMine && thread && thread.ownerSeenSeq >= m.seq) {
            const seen = document.createElement("span");
            seen.className = "seen";
            seen.textContent = "Seen";
            li.append(seen);
          }
          return li;
        }),
      );
      $("empty").hidden = sorted.length > 0;
      if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
      const blocked = thread?.blocked === true;
      $("text").disabled = blocked;
      $("send").disabled = blocked || sending;
      if (blocked) $("send-error").textContent = "You can't send messages here any more.";
      renderNotify();
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
      const raw = $("text").value;
      const plan = composeSend(thread, raw);
      $("send-error").textContent = "error" in plan ? plan.error : "";
      if ("error" in plan) return;
      sending = true;
      render();
      try {
        await guestWrite(() =>
          fs.runTransaction(db, async (tx) => {
            const now = readThread((await tx.get(ref)).data());
            const p = now && composeSend(now, raw);
            if (!p || "error" in p) throw Object.assign(new Error("refused"), { shown: p?.error });
            tx.update(ref, { guestSeq: p.seq, lastAt: stamp(), lastFrom: "guest", lastText: p.lastText, guestAt: stamp() });
            tx.set(fs.doc(ref, "messages", p.id), { from: "guest", text: p.text, ts: stamp(), seq: p.seq });
          }),
        );
        if ($("text").value === raw) $("text").value = "";
        updateCount();
      } catch (e) {
        $("send-error").textContent = e?.shown ?? friendlyError(e);
      } finally {
        sending = false;
        render();
      }
    }

    function updateCount() {
      const n = cleanMessage($("text").value, Infinity).length;
      $("count").textContent = n > LIMITS.TEXT_MAX * 0.8 ? `${n} / ${LIMITS.TEXT_MAX}` : "";
    }

    // ---- "Notify me": a web push when the owner answers (sent by the owner's PC; sw.js shows it) ----

    const browserCanPush = () => "serviceWorker" in navigator && "Notification" in self && "PushManager" in self;
    const canNotify = () => !!config.vapidKey && browserCanPush();
    const notifying = () => !!thread?.webPush && canNotify() && Notification.permission === "granted";

    function renderNotify() {
      const b = $("notify");
      b.hidden = !canNotify() || !thread || thread.blocked;
      b.textContent = notifying() ? "Turn off notifications" : "Notify me of replies";
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
    const onVisible = () => scheduleSeen();
    $("text").addEventListener("keydown", onKey);
    $("text").addEventListener("input", updateCount);
    $("compose").addEventListener("submit", onSubmit);
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
        messages = s.docs.map((d) => parseMessage(d.id, d.data({ serverTimestamps: "estimate" }))).filter(Boolean);
        render();
      },
      (e) => status(friendlyError(e)),
    );

    return () => {
      offThread();
      offMessages();
      clearTimeout(seenTimer);
      $("text").removeEventListener("keydown", onKey);
      $("text").removeEventListener("input", updateCount);
      $("compose").removeEventListener("submit", onSubmit);
      $("notify").removeEventListener("click", toggleNotify);
      document.removeEventListener("visibilitychange", onVisible);
      $("messages").replaceChildren();
    };
  }
}
