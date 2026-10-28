(function () {
  "use strict";

  const API = window.ELVEN_API_BASE;
  const LS_CODE = "elven_access_code";
  const LS_ROLE = "elven_role";
  const LS_NAME = "elven_name";
  const LS_NEON = "cdi_neon_theme";
  const NEON_THEMES = ["cyan", "pink", "purple", "green", "amber"];
  // per-tab session counter (sessionStorage, not localStorage): resets every
  // time the tab/session actually ends, unlike the visitor's neon preference
  const LS_SESSION_DOWNLOADS = "cdi_session_downloads";

  // applied immediately (before anything else renders) so there's no flash
  // of the wrong accent color — this is a per-visitor preference read from
  // this browser's own storage, never sent anywhere.
  // Set on <html>, not #app: the modals (book-modal, updates-modal, etc.)
  // are siblings of #app in the DOM, not descendants of it, so scoping the
  // CSS variable override to #app would silently leave every modal cyan.
  (function applyStoredNeonTheme() {
    const saved = localStorage.getItem(LS_NEON);
    if (saved && NEON_THEMES.includes(saved) && saved !== "cyan") {
      document.documentElement.dataset.neon = saved;
    }
  })();

  let state = {
    code: localStorage.getItem(LS_CODE) || "",
    role: localStorage.getItem(LS_ROLE) || "",
    name: localStorage.getItem(LS_NAME) || "",
    books: [],
    genres: [],
    activeGenre: "",
    search: "",
    totalBooks: 0,
  };

  // ---------- tiny helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // Defensive: if a deploy ever ships app.js ahead of index.html (or vice
  // versa), a missing element must never crash enterLibrary() mid-flight and
  // leave the page stuck on a blank #app. Warn loudly instead of throwing.
  function show(el) {
    if (!el) { console.warn("[CDI] show(): élément introuvable — index.html et app.js sont-ils bien de la même version ?"); return; }
    el.hidden = false;
  }
  function hide(el) { if (el) el.hidden = true; }
  function setHidden(sel, val) {
    const el = $(sel);
    if (!el) { console.warn(`[CDI] élément "${sel}" introuvable — index.html et app.js sont-ils bien de la même version ?`); return; }
    el.hidden = val;
  }

  function openModal(id) { show($("#" + id)); }
  function closeModal(id) { hide($("#" + id)); }

  $$("[data-close]").forEach((btn) =>
    btn.addEventListener("click", () => closeModal(btn.dataset.close))
  );
  $$(".modal-overlay").forEach((overlay) =>
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.hidden = true;
    })
  );

  // ---------- scroll-reveal (fade/slide-up as elements enter the viewport) ----------
  const revealObserver = "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-visible");
              revealObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
      )
    : null;

  function observeReveal(el, i) {
    if (!el) return;
    el.classList.add("reveal");
    if (i != null) el.style.setProperty("--i", i);
    if (revealObserver) revealObserver.observe(el);
    else el.classList.add("is-visible"); // no IO support: just show it
  }

  // static decoy sections reveal as soon as the page is scrolled to them
  $$(".d-feature, .d-signup-card, .d-specs-grid > div:first-child, .d-faq details").forEach((el, i) =>
    observeReveal(el, i % 6)
  );

  // Safety net: some environments (odd zoom levels, embedded webviews, a
  // screenshot/print tool) never fire the IntersectionObserver callback the
  // way a normal scrolling visit does. Nothing should stay permanently
  // invisible just because of that, so force-reveal anything still hidden
  // a couple of seconds after load.
  setTimeout(() => {
    $$(".reveal:not(.is-visible)").forEach((el) => el.classList.add("is-visible"));
  }, 2500);

  // ---------- ripple feedback on buttons ----------
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".e-btn, .d-cta, .d-account-link");
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.4;
    const ripple = document.createElement("span");
    ripple.className = "e-ripple";
    ripple.style.width = ripple.style.height = size + "px";
    ripple.style.left = (e.clientX - rect.left - size / 2) + "px";
    ripple.style.top = (e.clientY - rect.top - size / 2) + "px";
    btn.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());
  });

  // ---------- retractable side docks (left: genres/search, right: actions/admin) ----------
  // Both docks live outside #app in the DOM (see the note in index.html) so
  // their position:fixed isn't fought by the "#app > *" rule in style.css.
  function wireDock(tabSel, dockSel) {
    const tab = $(tabSel);
    const dock = $(dockSel);
    if (!tab || !dock) return;
    tab.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = dock.classList.toggle("open");
      tab.setAttribute("aria-expanded", open ? "true" : "false");
    });
    // clicking anywhere outside an open dock closes it
    document.addEventListener("click", (e) => {
      if (dock.classList.contains("open") && !dock.contains(e.target)) {
        dock.classList.remove("open");
        tab.setAttribute("aria-expanded", "false");
      }
    });
    // tapping an actual action inside the right dock closes it afterwards
    dock.addEventListener("click", (e) => {
      if (e.target.closest(".e-dock-item")) {
        dock.classList.remove("open");
        tab.setAttribute("aria-expanded", "false");
      }
    });
  }
  wireDock("#e-dock-left-tab", "#e-dock-left");
  wireDock("#e-dock-right-tab", "#e-dock-right");

  // ---------- back-to-top ----------
  const backToTop = $("#e-back-to-top");
  if (backToTop) {
    window.addEventListener("scroll", () => {
      backToTop.classList.toggle("is-visible", window.scrollY > 480);
    }, { passive: true });
    backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // ---------- book-cover tilt on hover (pointer devices only) ----------
  const supportsHoverTilt = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  function wireTilt(card) {
    if (!supportsHoverTilt) return;
    const cover = card.querySelector(".e-card-cover, .e-recent-cover");
    if (!cover) return;
    card.addEventListener("mousemove", (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      cover.style.setProperty("--ry", (px * 14).toFixed(2) + "deg");
      cover.style.setProperty("--rx", (-py * 14).toFixed(2) + "deg");
    });
    card.addEventListener("mouseleave", () => {
      cover.style.setProperty("--rx", "0deg");
      cover.style.setProperty("--ry", "0deg");
    });
  }

  // ---------- "Derniers ajouts" auto-scrolling rail ----------
  // Drifts continuously to the left; the card set is duplicated once so the
  // loop can wrap seamlessly (jumping back by exactly one set's width is
  // invisible). Pauses on hover/touch/manual-scroll and while the tab is
  // hidden; skipped entirely for prefers-reduced-motion or if there aren't
  // enough cards to make a loop worthwhile.
  const prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let recentAutoScrollPaused = false;
  let recentAutoScrollRafId = null;

  // resuming from a pause resyncs the accumulator to wherever the rail
  // actually is (the user may have dragged/scrolled it manually while paused)
  function resumeAutoScroll(row) {
    row._eScrollPos = row.scrollLeft;
    recentAutoScrollPaused = false;
  }

  function setupAutoScrollPauseTriggers(row) {
    if (row.dataset.autoScrollWired === "1") return;
    row.dataset.autoScrollWired = "1";
    row.addEventListener("click", (e) => {
      const card = e.target.closest(".e-recent-card");
      const id = card && card.dataset.bookId;
      if (id) openBook(id);
    });
    row.addEventListener("mouseenter", () => { recentAutoScrollPaused = true; });
    row.addEventListener("mouseleave", () => resumeAutoScroll(row));
    row.addEventListener("touchstart", () => { recentAutoScrollPaused = true; }, { passive: true });
    row.addEventListener("touchend", () => { setTimeout(() => resumeAutoScroll(row), 1500); }, { passive: true });
    row.addEventListener("wheel", () => {
      recentAutoScrollPaused = true;
      clearTimeout(row._eResumeTimer);
      row._eResumeTimer = setTimeout(() => resumeAutoScroll(row), 1500);
    }, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) recentAutoScrollPaused = true;
    });
  }

  // (re)starts the drift loop for the current set of cards in `row` — called
  // fresh every time renderRecent repopulates the rail
  function wireAutoScroll(row, originalCount) {
    if (recentAutoScrollRafId) { cancelAnimationFrame(recentAutoScrollRafId); recentAutoScrollRafId = null; }
    row.scrollLeft = 0;
    row._eScrollPos = 0;
    if (prefersReducedMotion || originalCount < 3) return;

    setupAutoScrollPauseTriggers(row);

    // duplicate the original cards once so scrolling past the end can wrap
    const originals = Array.from(row.children);
    originals.forEach((card) => { const clone = card.cloneNode(true); wireTilt(clone); row.appendChild(clone); });

    const SPEED = 0.45; // px per animation frame (~27px/s at 60fps)

    function step() {
      // re-measured every frame rather than once up front: the rail is
      // populated while the oath→library transition is still mid-flight
      // (the library panel is still `display:none` for ~500ms), so a single
      // upfront measurement can permanently capture a width of 0
      const halfWidth = row.scrollWidth / 2;
      if (!recentAutoScrollPaused && halfWidth > 0) {
        // accumulate in JS, not in row.scrollLeft directly — the DOM rounds
        // scrollLeft to a whole pixel on every read, which would silently
        // swallow a sub-pixel-per-frame increment like SPEED forever
        row._eScrollPos += SPEED;
        if (row._eScrollPos >= halfWidth) row._eScrollPos -= halfWidth;
        row.scrollLeft = row._eScrollPos;
      }
      recentAutoScrollRafId = requestAnimationFrame(step);
    }
    recentAutoScrollRafId = requestAnimationFrame(step);
  }

  async function api(path, opts) {
    opts = opts || {};
    const headers = opts.headers || {};
    const res = await fetch(API + path, { ...opts, headers });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON (file streams) */ }
    if (!res.ok) {
      const message = (data && data.error) || `Erreur ${res.status}`;
      throw new Error(message);
    }
    return data;
  }

  // ---------- decoy: sign-up ----------
  $("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = $("#signup-status");
    status.textContent = "Envoi…";
    const body = {
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      message: form.message.value.trim(),
    };
    try {
      await api("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      status.textContent = "Merci ! Nous revenons vers vous très vite.";
      form.reset();
    } catch (err) {
      status.textContent = "Une erreur est survenue, réessayez plus tard.";
    }
  });

  // ---------- decoy: "espace client" -> unlock ----------
  $("#open-unlock").addEventListener("click", () => openModal("unlock-modal"));

  $("#unlock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim();
    const status = $("#unlock-status");
    status.textContent = "Vérification…";
    try {
      const data = await api("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      persistSession(code, data.role, data.name);
      closeModal("unlock-modal");
      // no more "oath" screen — a quick "bug"/glitch flicker covers the swap
      // from the coffee decoy straight into the real library
      playGlitchTransition(enterLibrary);
    } catch (err) {
      status.textContent = "Code invalide.";
    }
  });

  // ---------- decoy -> library transition: a brief "glitch" flicker instead
  // of the old oath screen. reveal() runs once the overlay is fully opaque,
  // so the actual screen swap is hidden behind the flicker. ----------
  function playGlitchTransition(reveal) {
    const overlay = $("#e-glitch-overlay");
    if (!overlay) { reveal(); return; }
    overlay.classList.add("active");
    setTimeout(reveal, 260);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      overlay.classList.remove("active");
      overlay.removeEventListener("animationend", finish);
    };
    overlay.addEventListener("animationend", finish);
    setTimeout(finish, 950); // safety net in case animationend doesn't fire
  }

  function persistSession(code, role, name) {
    state.code = code;
    state.role = role;
    state.name = name;
    localStorage.setItem(LS_CODE, code);
    localStorage.setItem(LS_ROLE, role || "");
    localStorage.setItem(LS_NAME, name || "");
  }

  function clearSession() {
    state.code = ""; state.role = ""; state.name = "";
    localStorage.removeItem(LS_CODE);
    localStorage.removeItem(LS_ROLE);
    localStorage.removeItem(LS_NAME);
  }

  // ---------- stats: library size + this session's downloads ----------
  function updateStatsDisplay() {
    const totalEl = $("#e-stat-total");
    const dlEl = $("#e-stat-downloads");
    if (totalEl) totalEl.textContent = String(state.totalBooks || 0);
    if (dlEl) dlEl.textContent = sessionStorage.getItem(LS_SESSION_DOWNLOADS) || "0";
  }

  function incrementSessionDownloads() {
    let n = Number(sessionStorage.getItem(LS_SESSION_DOWNLOADS) || "0") + 1;
    try { sessionStorage.setItem(LS_SESSION_DOWNLOADS, String(n)); } catch {}
    updateStatsDisplay();
  }

  // fire-and-forget: these two never block the UI and never surface errors —
  // they're purely informational for the admin "derniers visiteurs" panel
  function logVisit() {
    if (!state.code) return;
    api("/api/log-visit", {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-code": state.code },
      body: JSON.stringify({}),
    }).catch(() => {});
  }

  function logDownload(bookId, bookTitle) {
    if (!state.code || !bookId) return;
    api("/api/log-download", {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-code": state.code },
      body: JSON.stringify({ book_id: bookId, book_title: bookTitle || "" }),
    }).catch(() => {});
  }

  // exposed so the separate e-reader script (below, its own IIFE) can report
  // a download-link click without the two scripts needing to share scope
  window.__cdiTrackDownload = function (bookId, bookTitle) {
    incrementSessionDownloads();
    logDownload(bookId, bookTitle);
  };

  // ---------- "reprendre où je me suis arrêté" — reuses the e-reader's own
  // per-book localStorage progress (cdi_rb2_<code-hash>_<id>), scoped to the
  // access code in use on this browser ----------
  // Reading progress + bookmarks are scoped to the access code in use (each
  // code = one person/e-mail), so two codes on the same browser never see
  // each other's "resume" list or bookmarks. The code is hashed so the raw
  // code never ends up inside a storage key name.
  function readerScopeKey(code) {
    const c = String(code || "");
    let h = 5381;
    for (let i = 0; i < c.length; i++) h = ((h * 33) ^ c.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function readerKeyPrefix() { return "cdi_rb2_" + readerScopeKey(state.code) + "_"; }
  window.__cdiReaderKeyPrefix = readerKeyPrefix;

  function getResumeList() {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(readerKeyPrefix())) continue;
      let st;
      try { st = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      if (!st || !st.lastCfi) continue;
      const id = key.slice(readerKeyPrefix().length);
      const book = state.books.find((b) => String(b.id) === id);
      if (!book) continue; // not in the (currently loaded) library — skip
      items.push({ id, book, lastReadAt: st.lastReadAt || "" });
    }
    items.sort((a, b) => (a.lastReadAt < b.lastReadAt ? 1 : -1));
    return items.slice(0, 10);
  }

  async function resumeBook(id) {
    try {
      const data = await api(`/api/book/${encodeURIComponent(id)}?code=${encodeURIComponent(state.code)}`, {
        headers: { "x-access-code": state.code },
      });
      if (typeof window.__openEbookReader === "function") {
        window.__openEbookReader(data.book);
      }
    } catch (err) {
      alert("Impossible de reprendre ce livre : " + err.message);
    }
  }

  // removes a book's saved reading position — it drops out of the resume
  // rail immediately (the section hides itself if it was the last one)
  function forgetResumeBook(id) {
    try { localStorage.removeItem(readerKeyPrefix() + id); } catch {}
    renderResume();
  }

  function renderResume() {
    const section = $("#e-resume");
    const row = $("#e-resume-row");
    if (!section || !row) return;
    const items = getResumeList();
    row.innerHTML = "";
    if (!items.length) { section.hidden = true; return; }
    section.hidden = false;
    items.forEach(({ id, book }, i) => {
      const card = document.createElement("button");
      card.className = "e-recent-card e-resume-card";
      card.type = "button";
      card.dataset.bookId = id;
      card.innerHTML = `
        <span class="e-resume-remove" role="button" tabindex="0" title="Retirer de « Reprendre où je me suis arrêté »">&times;</span>
        <div class="e-recent-cover">${book.cover_url ? `<img loading="lazy" src="${API}${book.cover_url}" alt="Couverture de ${escapeHtml(book.title)}" />` : ""}</div>
        <div class="e-recent-card-title">${escapeHtml(book.title)}</div>
      `;
      // note: the remove control is a <span role="button">, not a real
      // <button> — <button> can't nest inside the card, which is itself a
      // <button>, without the browser mangling the DOM
      wireTilt(card);
      card.style.animation = `eFadeIn .5s ease both`;
      card.style.animationDelay = (i * 40) + "ms";
      card.addEventListener("click", () => resumeBook(id));
      const removeBtn = card.querySelector(".e-resume-remove");
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        forgetResumeBook(id);
      });
      removeBtn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          forgetResumeBook(id);
        }
      });
      row.appendChild(card);
    });
  }

  // the reader IIFE below calls this whenever it closes, so a book that was
  // just started (or just finished) updates the rail without a full reload
  window.__cdiRefreshResume = renderResume;

  // ---------- "Un moment d'honnêteté" — one reflection prompt per session ----------
  // Static carousel: a single random question is drawn once per browser
  // session (kept in sessionStorage so it survives a page refresh but not a
  // new session) and only changes when the reader clicks "Suivant".
  const HONESTY_QUESTIONS = [
    { theme: "Relations", q: "Est-ce que je me sens vraiment écouté(e) par les gens qui comptent pour moi ?" },
    { theme: "Relations", q: "Qu'est-ce que j'évite de dire à quelqu'un que j'aime ?" },
    { theme: "Relations", q: "Est-ce que je donne autant que je reçois dans mes relations les plus proches ?" },
    { theme: "Relations", q: "Quelle relation me draine, et pourquoi est-ce que je la maintiens ?" },
    { theme: "Relations", q: "Ai-je vraiment pardonné à quelqu'un que je prétends avoir pardonné ?" },
    { theme: "Relations", q: "Qu'est-ce que je recherche chez les autres : de la compagnie, ou de la validation ?" },
    { theme: "Relations", q: "Qu'est-ce que je n'ai jamais osé demander à quelqu'un que j'aime ?" },
    { theme: "Gratitude", q: "Quelle personne n'ai-je jamais assez remerciée ?" },
    { theme: "Gratitude", q: "Qu'est-ce qui, dans mon quotidien le plus ordinaire, mérite d'être remarqué aujourd'hui ?" },
    { theme: "Gratitude", q: "Quelle difficulté passée m'a, avec le recul, rendu service ?" },
    { theme: "Gratitude", q: "De quel confort matériel est-ce que je profite sans y penser ?" },
    { theme: "Gratitude", q: "Quelle qualité chez moi ai-je oublié d'apprécier ?" },
    { theme: "Gratitude", q: "Qu'est-ce que je continuerais à faire même si personne ne le remarquait jamais ?" },
    { theme: "Spiritualité", q: "Est-ce que mes actions du quotidien reflètent ce en quoi je dis croire ?" },
    { theme: "Spiritualité", q: "Qu'est-ce que le silence m'apprend quand je lui laisse vraiment de la place ?" },
    { theme: "Spiritualité", q: "Quelle certitude ancienne ai-je abandonnée sans jamais me le formuler clairement ?" },
    { theme: "Spiritualité", q: "Où est-ce que je cherche du sens quand tout semble absurde ?" },
    { theme: "Spiritualité", q: "Qu'est-ce qui, en moi, dépasse ce que je peux expliquer ou contrôler ?" },
    { theme: "Perspective", q: "Dans dix ans, qu'est-ce qui, aujourd'hui, me semblera avoir eu très peu d'importance ?" },
    { theme: "Perspective", q: "Quelle histoire est-ce que je me raconte sur ma propre vie, et est-elle vraie ?" },
    { theme: "Perspective", q: "Qu'est-ce que je verrais différemment si j'étais quelqu'un d'autre qui observait ma situation ?" },
    { theme: "Perspective", q: "Quel problème actuel grossis-je plus qu'il ne le mérite ?" },
    { theme: "Perspective", q: "Qu'est-ce que je considérerais comme une réussite si personne d'autre que moi ne le savait jamais ?" },
    { theme: "Perspective", q: "Qu'est-ce que je ferais aujourd'hui si je savais que je ne peux pas échouer ?" },
    { theme: "Conscience de soi", q: "Quelle émotion est-ce que j'évite systématiquement de ressentir ?" },
    { theme: "Conscience de soi", q: "Dans quelle situation est-ce que je deviens quelqu'un que je n'aime pas ?" },
    { theme: "Conscience de soi", q: "Qu'est-ce que je fais par habitude plutôt que par choix conscient ?" },
    { theme: "Conscience de soi", q: "Quel jugement que je porte sur les autres en dit-il long sur moi-même ?" },
    { theme: "Conscience de soi", q: "Qu'est-ce que je fuis en restant constamment occupé(e) ?" },
    { theme: "Conscience de soi", q: "Quelle version de moi-même ai-je laissée derrière, et me manque-t-elle ?" },
    { theme: "Conscience de soi", q: "Qu'est-ce que je fais pour être aimé(e) plutôt que parce que ça me correspond vraiment ?" },
    { theme: "Conscience de soi", q: "Quelle part de moi-même est-ce que je montre le moins souvent, et pourquoi ?" },
    { theme: "Carrière et développement", q: "Est-ce que je travaille pour construire quelque chose, ou pour fuir quelque chose ?" },
    { theme: "Carrière et développement", q: "Quelle compétence est-ce que je repousse toujours à plus tard par peur de ne pas être à la hauteur ?" },
    { theme: "Carrière et développement", q: "Si l'argent n'entrait pas en compte, est-ce que je ferais encore ce métier ?" },
    { theme: "Carrière et développement", q: "Qu'est-ce que je considère comme un échec alors que ça m'a fait progresser ?" },
    { theme: "Carrière et développement", q: "Quelle limite professionnelle est-ce que je n'ose pas poser ?" },
    { theme: "Carrière et développement", q: "Qu'est-ce que je voudrais qu'on dise de mon travail dans vingt ans ?" },
    { theme: "Santé et énergie", q: "À quel moment de la journée est-ce que je me sens vraiment moi-même ?" },
    { theme: "Santé et énergie", q: "Qu'est-ce que mon corps essaie de me dire depuis un moment, sans que je l'écoute ?" },
    { theme: "Santé et énergie", q: "Qu'est-ce que je fais par épuisement plutôt que par envie ?" },
    { theme: "Santé et énergie", q: "Quelle habitude sais-je nuisible, mais que je continue quand même ?" },
    { theme: "Santé et énergie", q: "Qu'est-ce qui me redonne vraiment de l'énergie, et à quand remonte la dernière fois où je l'ai fait ?" },
    { theme: "Santé et énergie", q: "Est-ce que je me repose vraiment, ou est-ce que je fuis simplement dans autre chose ?" },
    { theme: "Bilan hebdomadaire", q: "Qu'est-ce que j'ai remis à plus tard cette semaine, et pourquoi ?" },
    { theme: "Bilan hebdomadaire", q: "Quel moment de cette semaine choisirais-je de revivre ?" },
    { theme: "Bilan hebdomadaire", q: "Ai-je tenu une promesse que je m'étais faite à moi-même cette semaine ?" },
    { theme: "Bilan hebdomadaire", q: "Qu'est-ce qui m'a coûté le plus d'énergie cette semaine, et est-ce que ça en valait la peine ?" },
    { theme: "Bilan hebdomadaire", q: "Quelle conversation de cette semaine continue de tourner dans ma tête ?" },
    { theme: "Bilan hebdomadaire", q: "Qu'est-ce que je ferais différemment si je revivais cette semaine ?" },
  ];
  const HONESTY_SESSION_KEY = "cdi_honesty_question_index";

  function renderHonestyQuestion(index) {
    const item = HONESTY_QUESTIONS[index];
    if (!item) return;
    const themeEl = $("#e-honesty-theme");
    const questionEl = $("#e-honesty-question");
    if (themeEl) themeEl.textContent = item.theme;
    if (questionEl) questionEl.textContent = item.q;
  }

  function pickHonestyQuestion(opts) {
    const forceNew = !!(opts && opts.forceNew);
    let stored = null;
    try { stored = sessionStorage.getItem(HONESTY_SESSION_KEY); } catch (e) { /* private browsing, etc. */ }
    let index = Number(stored);
    const hasValidStored = Number.isInteger(index) && index >= 0 && index < HONESTY_QUESTIONS.length;
    if (!hasValidStored || forceNew) {
      let next;
      do {
        next = Math.floor(Math.random() * HONESTY_QUESTIONS.length);
      } while (HONESTY_QUESTIONS.length > 1 && hasValidStored && next === index);
      index = next;
      try { sessionStorage.setItem(HONESTY_SESSION_KEY, String(index)); } catch (e) { /* ignore */ }
    }
    renderHonestyQuestion(index);
  }

  $("#e-honesty-next")?.addEventListener("click", () => pickHonestyQuestion({ forceNew: true }));

  // ---------- switching screens ----------
  // No more oath screen: the library appears directly (behind the glitch
  // flicker when this follows a manual code entry — see playGlitchTransition).
  async function enterLibrary() {
    hide($("#decoy"));
    show($("#app"));
    show($("#e-dock-left"));
    show($("#e-dock-right"));
    const welcomeEl = $("#e-welcome");
    if (welcomeEl) welcomeEl.textContent = state.name ? `Bienvenue, ${state.name}` : "";
    setHidden("#e-add-book-btn", state.role !== "admin");
    setHidden("#e-book-requests-btn", state.role !== "admin");
    setHidden("#e-visitors-btn", state.role !== "admin");
    setHidden("#e-publish-update-btn", state.role !== "admin");
    setHidden("#e-dock-admin-sep", state.role !== "admin");
    updateStatsDisplay();
    pickHonestyQuestion();
    show($("#e-header"));
    show($("#e-library-content"));
    loadUpdates(); // fetch in the background so the "nouveautés" badge is ready early
    await loadBooks();
    await loadRecent();
    renderResume();
    logVisit();
  }

  function leaveLibrary() {
    clearSession();
    hide($("#app"));
    show($("#decoy"));
    // hide + collapse both docks so they don't linger visible/open over the
    // decoy page for the next visitor
    hide($("#e-dock-left"));
    hide($("#e-dock-right"));
    $("#e-dock-left")?.classList.remove("open");
    $("#e-dock-right")?.classList.remove("open");
  }
  $("#e-logout").addEventListener("click", leaveLibrary);

  // ---------- library data ----------
  function renderSkeletonGrid(count) {
    const grid = $("#e-grid");
    if (!grid) return;
    $("#e-empty").hidden = true;
    grid.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const card = document.createElement("div");
      card.className = "e-card skeleton";
      card.innerHTML = `
        <div class="e-card-cover"></div>
        <div class="e-card-title">&nbsp;</div>
        <div class="e-card-author">&nbsp;</div>
      `;
      grid.appendChild(card);
    }
  }

  // Groups every tome of the same saga next to each other, in ascending
  // "N° dans la saga" order, instead of leaving them scattered wherever their
  // individual add date happens to place them. Solo books (no series_name, or
  // the only book with that series_name in the current list) are ordered by
  // `primaryKeyFn`. A series block as a whole is anchored at the
  // `primaryKeyFn` value of its first-appearing member (in the incoming
  // array's own order) — e.g. with the default recency key that's its most
  // recently added tome; with an author-name key it's naturally that
  // series' author, so a saga still lands in the right alphabetical spot.
  // `primaryKeyFn` defaults to preserving the server's own order (created_at
  // DESC) — used for "Derniers ajouts". The main grid instead sorts by
  // author name (see loadBooks()).
  function sortBooksGrouped(books, primaryKeyFn) {
    const keyFn = primaryKeyFn || ((b, i) => i);
    const seriesKey = (b) => (b.series_name || "").trim().toLowerCase();
    const countBySeries = {};
    books.forEach((b) => {
      const key = seriesKey(b);
      if (key) countBySeries[key] = (countBySeries[key] || 0) + 1;
    });
    const anchorPrimary = {};
    const anchorIndex = {};
    books.forEach((b, i) => {
      const key = seriesKey(b);
      if (key && countBySeries[key] > 1 && !(key in anchorPrimary)) {
        anchorPrimary[key] = keyFn(b, i);
        anchorIndex[key] = i;
      }
    });
    const withSortKeys = books.map((b, i) => {
      const key = seriesKey(b);
      const grouped = key && countBySeries[key] > 1;
      const order = Number(b.series_order);
      return {
        book: b,
        primary: grouped ? anchorPrimary[key] : keyFn(b, i),
        // Distinguishes different sagas (or standalone books) that tie on
        // `primary` — e.g. two different series by the same author, whose
        // anchor primary key (the author name) is identical. Without this,
        // the sort would fall through straight to `secondary` (the tome
        // number) and interleave every saga's "Tome 1"s together, then
        // every "Tome 2", etc, regardless of which saga they belong to.
        group: grouped ? `s:${key}` : `b:${i}`,
        groupOrder: grouped ? anchorIndex[key] : i,
        secondary: grouped ? (Number.isFinite(order) ? order : 9999) : 0,
      };
    });
    withSortKeys.sort((a, b) => {
      const cmp = (typeof a.primary === "string" || typeof b.primary === "string")
        ? String(a.primary).localeCompare(String(b.primary), "fr", { sensitivity: "base" })
        : a.primary - b.primary;
      if (cmp) return cmp;
      if (a.group !== b.group) return a.groupOrder - b.groupOrder;
      return a.secondary - b.secondary;
    });
    return withSortKeys.map((x) => x.book);
  }

  // Sort key for the main grid: alphabetical by author name (trimmed,
  // accent/case-insensitive via localeCompare above); books with no author
  // listed sort to the very end rather than jumping to the front.
  function authorSortKey(b) {
    const a = (b.author || "").trim();
    return a || "￿";
  }

  // "Les Gardiens du Nord — Tome 4 / Spin-off Tome 1" — built from
  // series_name + series_order, with the optional series_note (for a book
  // that's simultaneously part of a derived spin-off/duology) appended after
  // a slash. Returns "" when the book has no series_name at all.
  function formatSeriesLabel(book) {
    const name = (book.series_name || "").trim();
    if (!name) return "";
    const order = Number(book.series_order);
    let label = name;
    if (Number.isFinite(order)) label += ` — Tome ${order}`;
    const note = (book.series_note || "").trim();
    if (note) label += ` / ${note}`;
    return label;
  }

  // Picks the `limit` most-recently-added books for the "Derniers ajouts"
  // rail, but if that cutoff would slice a saga in half, pulls in the
  // missing tome(s) too — a series should never be shown incomplete just
  // because one of its volumes landed one slot past the top-N line.
  function pickRecentGrouped(books, limit) {
    const seriesKey = (b) => (b.series_name || "").trim().toLowerCase();
    const countBySeries = {};
    books.forEach((b) => {
      const key = seriesKey(b);
      if (key) countBySeries[key] = (countBySeries[key] || 0) + 1;
    });
    const recentIds = new Set(books.slice(0, limit).map((b) => b.id));
    const recentSeries = new Set();
    books.forEach((b) => {
      const key = seriesKey(b);
      if (key && countBySeries[key] > 1 && recentIds.has(b.id)) recentSeries.add(key);
    });
    const picked = books.filter((b) => recentIds.has(b.id) || recentSeries.has(seriesKey(b)));
    return sortBooksGrouped(picked);
  }

  async function loadBooks() {
    renderSkeletonGrid(10);
    const params = new URLSearchParams({ code: state.code });
    if (state.activeGenre) params.set("genre", state.activeGenre);
    try {
      const data = await api("/api/books?" + params.toString(), {
        headers: { "x-access-code": state.code },
      });
      state.books = sortBooksGrouped(data.books || [], authorSortKey);
      state.genres = data.genres || [];
      // the total-library count should reflect ALL books, not the active genre
      // filter — only update it from an unfiltered fetch
      if (!state.activeGenre) {
        state.totalBooks = state.books.length;
        updateStatsDisplay();
      }
      renderGenres();
      renderGrid();
      fillGenreSuggestions();
      fillSeriesSuggestions();
    } catch (err) {
      if (String(err.message).includes("401")) leaveLibrary();
    }
  }

  function renderGenres() {
    const nav = $("#e-genre-list");
    nav.innerHTML = "";
    const allBtn = document.createElement("button");
    allBtn.className = "e-genre" + (state.activeGenre === "" ? " active" : "");
    allBtn.textContent = "Tous les livres";
    allBtn.addEventListener("click", () => { state.activeGenre = ""; loadBooks(); });
    nav.appendChild(allBtn);

    state.genres.forEach((g) => {
      const btn = document.createElement("button");
      btn.className = "e-genre" + (state.activeGenre === g ? " active" : "");
      btn.textContent = g;
      btn.addEventListener("click", () => { state.activeGenre = g; loadBooks(); });
      nav.appendChild(btn);
    });
  }

  function fillGenreSuggestions() {
    const dl = $("#genre-suggestions");
    if (!dl) return;
    dl.innerHTML = state.genres.map((g) => `<option value="${escapeHtml(g)}">`).join("");
  }

  function fillSeriesSuggestions() {
    const dl = $("#series-suggestions");
    if (!dl) return;
    const names = Array.from(new Set(
      state.books.map((b) => (b.series_name || "").trim()).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));
    dl.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">`).join("");
  }

  function matchesSearch(book, q) {
    if (!q) return true;
    const hay = [book.title, book.author, ...(book.tags || [])].join(" ").toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function renderGrid() {
    const grid = $("#e-grid");
    const items = state.books.filter((b) => matchesSearch(b, state.search));
    grid.innerHTML = "";
    $("#e-empty").hidden = items.length !== 0;

    items.forEach((book, i) => {
      const card = document.createElement("button");
      card.className = "e-card";
      card.type = "button";
      card.style.setProperty("--i", i);
      const seriesLabel = formatSeriesLabel(book);
      card.innerHTML = `
        <div class="e-card-cover">${book.cover_url ? `<img loading="lazy" src="${API}${book.cover_url}" alt="Couverture de ${escapeHtml(book.title)}" />` : ""}</div>
        <div class="e-card-title">${escapeHtml(book.title)}</div>
        <div class="e-card-author">${escapeHtml(book.author || "")}</div>
        ${seriesLabel ? `<div class="e-card-series">${escapeHtml(seriesLabel)}</div>` : ""}
      `;
      card.addEventListener("click", () => openBook(book.id));
      wireTilt(card);
      observeReveal(card, i % 12);
      grid.appendChild(card);
    });
  }

  $("#e-search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderGrid();
  });

  // ---------- "Derniers ajouts" rail — always the whole library's newest, regardless of the active genre filter ----------
  async function loadRecent() {
    try {
      const data = await api("/api/books?code=" + encodeURIComponent(state.code), {
        headers: { "x-access-code": state.code },
      });
      // this fetch is always unfiltered, so it's a reliable source for the
      // "total books in the library" stat regardless of the active genre
      state.totalBooks = (data.books || []).length;
      updateStatsDisplay();
      renderRecent(pickRecentGrouped(data.books || [], 10));
    } catch (err) {
      // silent — the rail simply stays empty if this fails
    }
  }

  function renderRecent(items) {
    const section = $("#e-recent");
    const row = $("#e-recent-row");
    row.innerHTML = "";
    if (!items.length) { section.hidden = true; return; }
    section.hidden = false;
    items.forEach((book, i) => {
      const card = document.createElement("button");
      card.className = "e-recent-card";
      card.type = "button";
      card.dataset.bookId = book.id;
      card.innerHTML = `
        <div class="e-recent-cover">${book.cover_url ? `<img loading="lazy" src="${API}${book.cover_url}" alt="Couverture de ${escapeHtml(book.title)}" />` : ""}</div>
        <div class="e-recent-card-title">${escapeHtml(book.title)}</div>
      `;
      wireTilt(card);
      card.style.animation = `eFadeIn .5s ease both`;
      card.style.animationDelay = (i * 40) + "ms";
      row.appendChild(card);
    });
    wireAutoScroll(row, items.length);
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- book detail ----------
  async function openBook(id) {
    try {
      const data = await api(`/api/book/${encodeURIComponent(id)}?code=${encodeURIComponent(state.code)}`, {
        headers: { "x-access-code": state.code },
      });
      const b = data.book;
      state.currentBook = b;
      $("#bm-cover").src = b.cover_url ? API + b.cover_url : "";
      $("#bm-cover").alt = "Couverture de " + b.title;
      $("#bm-title").textContent = b.title;
      $("#bm-author").textContent = b.author || "";
      const seriesEl = $("#bm-series");
      const seriesLabel = formatSeriesLabel(b);
      if (seriesEl) { seriesEl.textContent = seriesLabel; seriesEl.hidden = !seriesLabel; }
      $("#bm-date").textContent = b.release_date || "Date inconnue";
      $("#bm-genre").textContent = b.genre || "";
      $("#bm-summary").textContent = b.summary || "Pas de résumé pour ce livre.";
      const extractEl = $("#bm-extract");
      const extractTitle = $("#bm-extract-title");
      if (b.extract) { extractEl.textContent = b.extract; extractTitle.hidden = false; extractEl.hidden = false; }
      else { extractEl.hidden = true; extractTitle.hidden = true; }
      $("#bm-tags").innerHTML = (b.tags || []).map((t) => `<span>${escapeHtml(t)}</span>`).join("");
      const dl = $("#bm-download");
      if (b.download_url) { dl.href = API + b.download_url; dl.hidden = false; }
      else { dl.hidden = true; }
      $("#bm-edit-btn").hidden = state.role !== "admin";
      $("#bm-delete-btn").hidden = state.role !== "admin";
      openModal("book-modal");
    } catch (err) {
      alert("Impossible d'ouvrir ce livre : " + err.message);
    }
  }

  // ---------- track a download click from the book modal ----------
  $("#bm-download").addEventListener("click", () => {
    const b = state.currentBook;
    if (b) window.__cdiTrackDownload(b.id, b.title);
  });

  // ---------- read online (EPUB reader) ----------
  $("#bm-read-btn").addEventListener("click", () => {
    const b = state.currentBook;
    if (!b) return;
    closeModal("book-modal");
    if (typeof window.__openEbookReader === "function") {
      window.__openEbookReader(b);
    } else {
      alert("Le lecteur en ligne n'a pas pu se charger. Utilise le téléchargement pour lire ce livre.");
    }
  });

  // ---------- admin: edit an existing book's info ----------
  $("#bm-edit-btn").addEventListener("click", () => {
    const b = state.currentBook;
    if (!b) return;
    const form = $("#edit-book-form");
    form.book_id.value = b.id;
    form.title.value = b.title || "";
    form.author.value = b.author || "";
    form.genre.value = b.genre || "";
    form.release_date.value = b.release_date || "";
    form.series_name.value = b.series_name || "";
    form.series_order.value = (b.series_order === null || b.series_order === undefined) ? "" : b.series_order;
    form.series_note.value = b.series_note || "";
    form.tags.value = (b.tags || []).join(", ");
    form.summary.value = b.summary || "";
    form.extract.value = b.extract || "";
    form.cover.value = "";
    form.ebook.value = "";
    $("#edit-book-status").textContent = "";
    closeModal("book-modal");
    openModal("edit-book-modal");
  });

  $("#edit-book-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = $("#edit-book-status");
    const id = form.book_id.value;
    status.textContent = "Enregistrement…";
    try {
      const res = await fetch(API + "/api/admin/edit-book/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "x-access-code": state.code },
        body: new FormData(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur");
      status.textContent = "Modifications enregistrées !";
      await loadBooks();
      setTimeout(() => closeModal("edit-book-modal"), 800);
    } catch (err) {
      status.textContent = "Erreur : " + err.message;
    }
  });

  // ---------- admin: delete a book (with confirmation) ----------
  let pendingDeleteId = null;

  $("#bm-delete-btn").addEventListener("click", () => {
    const b = state.currentBook;
    if (!b) return;
    pendingDeleteId = b.id;
    $("#delete-confirm-title").textContent = b.title;
    $("#delete-confirm-status").textContent = "";
    closeModal("book-modal");
    openModal("delete-confirm-modal");
  });

  $("#delete-confirm-cancel").addEventListener("click", () => {
    pendingDeleteId = null;
    closeModal("delete-confirm-modal");
  });

  $("#delete-confirm-go").addEventListener("click", async () => {
    if (!pendingDeleteId) return;
    const status = $("#delete-confirm-status");
    status.textContent = "Suppression…";
    try {
      const res = await fetch(API + "/api/admin/book/" + encodeURIComponent(pendingDeleteId), {
        method: "DELETE",
        headers: { "x-access-code": state.code },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || "Erreur");
      pendingDeleteId = null;
      closeModal("delete-confirm-modal");
      await loadBooks();
      await loadRecent();
      renderResume();
    } catch (err) {
      status.textContent = "Erreur : " + err.message;
    }
  });

  // ---------- reader: request a missing book ----------
  $("#e-request-book-btn").addEventListener("click", () => {
    $("#request-book-status").textContent = "";
    $("#request-book-form").reset();
    openModal("request-book-modal");
  });

  $("#request-book-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = $("#request-book-status");
    status.textContent = "Envoi…";
    try {
      await api("/api/book-requests", {
        method: "POST",
        headers: { "content-type": "application/json", "x-access-code": state.code },
        body: JSON.stringify({
          title: form.title.value.trim(),
          author: form.author.value.trim(),
          note: form.note.value.trim(),
        }),
      });
      status.textContent = "Merci, ta demande a été transmise !";
      form.reset();
      setTimeout(() => closeModal("request-book-modal"), 900);
    } catch (err) {
      status.textContent = "Erreur : " + err.message;
    }
  });

  // ---------- admin: see & clear readers' book requests ----------
  $("#e-book-requests-btn").addEventListener("click", async () => {
    openModal("book-requests-modal");
    await loadBookRequests();
  });

  async function loadBookRequests() {
    try {
      const data = await api("/api/admin/book-requests", {
        headers: { "x-access-code": state.code },
      });
      renderBookRequests(data.requests || []);
    } catch (err) {
      $("#book-requests-list").innerHTML = "";
      const empty = $("#book-requests-empty");
      empty.hidden = false;
      empty.textContent = "Erreur : " + err.message;
    }
  }

  function renderBookRequests(list) {
    const container = $("#book-requests-list");
    const empty = $("#book-requests-empty");
    container.innerHTML = "";
    if (!list.length) {
      empty.hidden = false;
      empty.textContent = "Aucune demande en attente pour le moment.";
      return;
    }
    empty.hidden = true;
    list.forEach((r) => {
      const row = document.createElement("div");
      row.className = "e-request-row";
      row.innerHTML = `
        <div class="e-request-info">
          <strong>${escapeHtml(r.title)}</strong>${r.author ? " — " + escapeHtml(r.author) : ""}
          ${r.note ? `<div class="e-request-note">${escapeHtml(r.note)}</div>` : ""}
          <div class="e-request-meta">Demandé par ${escapeHtml(r.requested_by || "un lecteur")}</div>
        </div>
        <button class="e-btn e-btn-ghost" type="button" data-resolve="${r.id}">Marquer comme traité</button>
      `;
      container.appendChild(row);
    });
    container.querySelectorAll("[data-resolve]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api("/api/admin/book-requests/resolve", {
            method: "POST",
            headers: { "content-type": "application/json", "x-access-code": state.code },
            body: JSON.stringify({ id: btn.dataset.resolve }),
          });
          await loadBookRequests();
        } catch (err) {
          btn.disabled = false;
          alert("Erreur : " + err.message);
        }
      })
    );
  }

  // ---------- admin: last 10 visitors + what each one downloaded ----------
  $("#e-visitors-btn").addEventListener("click", async () => {
    openModal("visitors-modal");
    await loadRecentVisitors();
  });

  async function loadRecentVisitors() {
    try {
      const data = await api("/api/admin/recent-visitors", {
        headers: { "x-access-code": state.code },
      });
      renderRecentVisitors(data.visitors || []);
    } catch (err) {
      $("#visitors-list").innerHTML = "";
      const empty = $("#visitors-empty");
      empty.hidden = false;
      empty.textContent = "Erreur : " + err.message;
    }
  }

  function renderRecentVisitors(list) {
    const container = $("#visitors-list");
    const empty = $("#visitors-empty");
    container.innerHTML = "";
    if (!list.length) {
      empty.hidden = false;
      empty.textContent = "Aucune visite enregistrée pour le moment.";
      return;
    }
    empty.hidden = true;
    list.forEach((v) => {
      const row = document.createElement("div");
      row.className = "e-visitor-row";
      const date = new Date(v.last_visit);
      const dateLabel = isNaN(date)
        ? ""
        : date.toLocaleString("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
      const downloads = v.downloads || [];
      const downloadsHtml = downloads.length
        ? `<ul class="e-visitor-downloads">${downloads.map((d) => {
            const dd = new Date(d.downloaded_at);
            const ddLabel = isNaN(dd) ? "" : dd.toLocaleDateString("fr-FR");
            return `<li><span>${escapeHtml(d.book_title || d.book_id)}</span><span class="e-visitor-download-date">${ddLabel}</span></li>`;
          }).join("")}</ul>`
        : `<p class="e-visitor-no-downloads">Aucun téléchargement.</p>`;
      row.innerHTML = `
        <div class="e-visitor-head">
          <strong>${escapeHtml(v.name || "Anonyme")}</strong>
          <span class="e-visitor-role">${v.role === "admin" ? "Admin" : "Lecteur"}</span>
          <span class="e-visitor-date">${dateLabel}</span>
        </div>
        ${downloadsHtml}
      `;
      container.appendChild(row);
    });
  }

  // ---------- "Nouveautés" — admin-posted announcements, with an unread badge ----------
  const LS_UPDATES_SEEN = "cdi_updates_seen_at";
  let latestUpdates = [];

  async function loadUpdates() {
    try {
      const data = await api("/api/updates", { headers: { "x-access-code": state.code } });
      latestUpdates = data.updates || [];
      refreshUpdatesBadge();
    } catch (err) {
      // silent — the bell just won't show a badge if this fails
    }
  }

  function refreshUpdatesBadge() {
    const seenAt = localStorage.getItem(LS_UPDATES_SEEN) || "";
    const unread = latestUpdates.filter((u) => u.created_at > seenAt).length;
    const badge = $("#e-updates-badge");
    if (!badge) return;
    if (unread > 0) {
      badge.textContent = String(unread);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function renderUpdatesList() {
    const list = $("#updates-list");
    const empty = $("#updates-empty");
    list.innerHTML = "";
    empty.hidden = latestUpdates.length !== 0;
    latestUpdates.forEach((u) => {
      const row = document.createElement("div");
      row.className = "e-update-item";
      const date = new Date(u.created_at);
      const dateLabel = isNaN(date) ? "" : date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
      row.innerHTML = `
        <h3 class="e-update-title">${escapeHtml(u.title)}</h3>
        <div class="e-update-date">${dateLabel}</div>
        <p class="e-update-body">${escapeHtml(u.body)}</p>
        ${state.role === "admin" ? `<button type="button" class="e-update-remove" data-remove-update="${u.id}" title="Supprimer">&times;</button>` : ""}
      `;
      list.appendChild(row);
    });
    list.querySelectorAll("[data-remove-update]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Supprimer cette nouveauté ?")) return;
        try {
          await api("/api/admin/updates/" + encodeURIComponent(btn.dataset.removeUpdate), {
            method: "DELETE",
            headers: { "x-access-code": state.code },
          });
          await loadUpdates();
          renderUpdatesList();
        } catch (e) {
          alert("Erreur : " + e.message);
        }
      })
    );
  }

  $("#e-updates-btn").addEventListener("click", () => {
    renderUpdatesList();
    openModal("updates-modal");
    // mark everything as read the moment the panel is opened
    if (latestUpdates.length) {
      localStorage.setItem(LS_UPDATES_SEEN, latestUpdates[0].created_at);
      refreshUpdatesBadge();
    }
  });

  // ---------- neon color picker ----------
  // lives on <html>, not #app — see the note by applyStoredNeonTheme() above
  function currentNeonTheme() {
    return document.documentElement.dataset.neon || "cyan";
  }
  function applyNeonTheme(theme) {
    if (theme === "cyan") delete document.documentElement.dataset.neon;
    else document.documentElement.dataset.neon = theme;
    localStorage.setItem(LS_NEON, theme);
    $("#e-theme-dot").setAttribute("data-neon-preview", theme);
    $$("#theme-swatches .e-theme-swatch").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.neon === theme);
    });
  }
  $("#e-theme-dot").setAttribute("data-neon-preview", currentNeonTheme());
  $("#e-theme-btn").addEventListener("click", () => {
    $$("#theme-swatches .e-theme-swatch").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.neon === currentNeonTheme());
    });
    openModal("theme-modal");
  });
  $$("#theme-swatches .e-theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyNeonTheme(btn.dataset.neon);
      closeModal("theme-modal");
    });
  });

  $("#e-publish-update-btn").addEventListener("click", () => {
    $("#publish-update-status").textContent = "";
    $("#publish-update-form").reset();
    openModal("publish-update-modal");
  });

  $("#publish-update-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = $("#publish-update-status");
    status.textContent = "Publication…";
    try {
      await api("/api/admin/updates", {
        method: "POST",
        headers: { "content-type": "application/json", "x-access-code": state.code },
        body: JSON.stringify({ title: form.title.value.trim(), body: form.body.value.trim() }),
      });
      status.textContent = "Publié !";
      form.reset();
      await loadUpdates();
      setTimeout(() => closeModal("publish-update-modal"), 700);
    } catch (err) {
      status.textContent = "Erreur : " + err.message;
    }
  });

  // ---------- admin: add book ----------
  $("#e-add-book-btn").addEventListener("click", () => openModal("add-book-modal"));

  $("#add-book-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = $("#add-book-status");
    status.textContent = "Envoi en cours…";
    try {
      const res = await fetch(API + "/api/admin/add-book", {
        method: "POST",
        headers: { "x-access-code": state.code },
        body: new FormData(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erreur");
      status.textContent = "Livre ajouté !";
      form.reset();
      await loadBooks();
      setTimeout(() => closeModal("add-book-modal"), 800);
    } catch (err) {
      status.textContent = "Erreur : " + err.message;
    }
  });

  // ---------- boot ----------
  async function boot() {
    if (!state.code) return; // stay on the decoy page
    try {
      const data = await api("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: state.code }),
      });
      persistSession(state.code, data.role, data.name);
      await enterLibrary();
    } catch {
      clearSession();
    }
  }

  boot();
})();

// ================================================================
// E-reader — in-browser EPUB viewer with Kindle-style comfort settings
// (bookmarks, font size/family, line height, margins, justify,
//  paginated/continuous scroll, light/sepia/dark/black themes,
//  warm-light filter, brightness, table of contents, resume position)
// Download stays available separately (see #bm-download / #reader-download).
// ================================================================
(function () {
  "use strict";
  if (typeof ePub === "undefined") return; // epub.js failed to load from the CDN

  const $ = (sel) => document.querySelector(sel);
  if (!$("#reader-modal")) return; // markup not present on this page

  const READER_SETTINGS_KEY = "cdi_reader_settings";
  // per-access-code scope (same prefix as the library's "resume" rail)
  const readerBookKey = (id) =>
    (typeof window.__cdiReaderKeyPrefix === "function" ? window.__cdiReaderKeyPrefix() : "cdi_rb2__") + id;

  const DEFAULT_SETTINGS = {
    fontScale: 100,
    fontFamily: "original",
    lineHeight: "normal",
    margin: "normal",
    justify: false,
    scrollMode: "paginated",
    theme: "light",
    warmth: 0,
    brightness: 100,
    mode: "book",          // "book" = livre plein écran, "classic" = lecteur d'origine
    wordsPerPage: 300,     // taille de page du mode livre
    autoFullscreen: true,  // tente le plein écran à l'ouverture d'un livre
  };

  const THEME_COLORS = {
    light: { bg: "#f6f1e3", fg: "#241c12" },
    sepia: { bg: "#ead9b6", fg: "#3a2c17" },
    dark: { bg: "#3a352c", fg: "#e4dcc8" },
    black: { bg: "#050505", fg: "#c9c2b0" },
  };

  const FONT_STACKS = {
    original: null,
    serif: "'EB Garamond', Georgia, 'Times New Roman', serif",
    sans: "'Josefin Sans', Helvetica, Arial, sans-serif",
  };

  const LINE_HEIGHTS = { compact: "1.35", normal: "1.65", relaxed: "2" };
  const MARGINS = { narrow: "16px", normal: "44px", wide: "84px" };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(READER_SETTINGS_KEY);
      return raw ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)) : Object.assign({}, DEFAULT_SETTINGS);
    } catch { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function saveSettings(s) {
    try { localStorage.setItem(READER_SETTINGS_KEY, JSON.stringify(s)); } catch {}
  }
  function loadBookState(id) {
    try {
      const raw = localStorage.getItem(readerBookKey(id));
      return raw ? JSON.parse(raw) : { lastCfi: null, bookmarks: [], locations: null };
    } catch { return { lastCfi: null, bookmarks: [], locations: null }; }
  }
  function saveBookState(id, st) {
    try { localStorage.setItem(readerBookKey(id), JSON.stringify(st)); } catch {}
  }

  function isEpub(book) {
    return !!(book && book.download_url && /\.epub(\?|$)/i.test(book.download_url));
  }

  function escapeHtmlLocal(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  const rs = {
    settings: loadSettings(),
    book: null,
    rendition: null,
    bookId: null,
    bookState: null,
    bookRecord: null,
    locToken: 0,
    lastLocation: null, // set from the "relocated" event — avoids relying on
                         // rendition.currentLocation()'s return type, which
                         // differs between epub.js versions (sync vs promise)
  };

  // ---------- open / close ----------
  window.__openEbookReader = async function (bookRecord) {
    const modal = $("#reader-modal");
    modal.hidden = false;
    $("#reader-book-title").textContent = bookRecord.title || "";
    $("#reader-loc-label").textContent = "";
    $("#reader-download").href = window.ELVEN_API_BASE + bookRecord.download_url;
    $("#reader-loading").hidden = false;
    $("#reader-unsupported").hidden = true;
    $("#reader-viewer").innerHTML = "";
    closeAllPanels();
    rs.bookRecord = bookRecord;

    const epubOk = isEpub(bookRecord);
    setChromeEnabled(epubOk);
    modal.classList.toggle("rb-mode", epubOk && bookMode());

    if (!epubOk) {
      $("#reader-loading").hidden = true;
      $("#reader-unsupported").hidden = false;
      return;
    }
    if (bookMode()) tryAutoFullscreen();

    try {
      const res = await fetch(window.ELVEN_API_BASE + bookRecord.download_url);
      if (!res.ok) throw new Error("Téléchargement impossible (erreur " + res.status + ")");
      const buf = await res.arrayBuffer();

      if (rs.rendition) { try { rs.rendition.destroy(); } catch {} rs.rendition = null; }
      if (rs.book) { try { rs.book.destroy(); } catch {} }
      rs.lastLocation = null;

      rs.bookId = bookRecord.id;
      rs.bookState = loadBookState(bookRecord.id);
      rs.book = ePub(buf);

      await buildRendition(rs.bookState.lastCfi || undefined);

      rs.book.loaded.navigation.then((nav) => renderToc(nav.toc || [])).catch(() => {});
      renderBookmarks();
      updateBookmarkStar();
      wakeBars();
    } catch (err) {
      $("#reader-loading").hidden = true;
      $("#reader-unsupported").hidden = false;
      $("#reader-unsupported").innerHTML =
        "<p>Impossible d'ouvrir ce livre pour l'instant.</p><p>" + escapeHtmlLocal((err && err.message) || "") + "</p>";
    }
  };

  // (re)creates the epub.js rendition for the current book in the current
  // mode — used on open, on a mode switch, and when the window is resized
  // (the page box is fixed in pixels, so a new size needs a new rendition)
  async function buildRendition(startCfi) {
    if (!rs.book) return;
    if (rs.rendition) { try { rs.rendition.destroy(); } catch {} rs.rendition = null; }
    $("#reader-viewer").innerHTML = "";
    const modal = $("#reader-modal");
    const book = bookMode();
    modal.classList.toggle("rb-mode", book);

    let opts;
    if (book) {
      try {
        await Promise.race([
          document.fonts.load("100px 'EB Garamond'"),
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      } catch {}
      const g = computeGeom();
      bk.geom = g;
      bk.fs = computeFontSize(g);
      applyBookGeometry(g);
      opts = {
        width: g.viewW, height: g.viewH, flow: "paginated",
        spread: g.pages === 2 ? "always" : "none", minSpreadWidth: 1, gap: g.gap,
      };
    } else {
      bk.geom = null;
      opts = {
        width: "100%", height: "100%",
        flow: rs.settings.scrollMode === "scrolled" ? "scrolled-doc" : "paginated",
        spread: "none",
      };
    }

    $("#reader-loading").hidden = false;
    rs.rendition = rs.book.renderTo("reader-viewer", opts);
    rs.rendition.hooks.content.register((contents) => {
      try {
        const root = contents.document.documentElement;
        if (!root.getAttribute("lang") && !root.getAttribute("xml:lang")) root.setAttribute("lang", "fr");
      } catch {}
    });
    rs.rendition.on("relocated", onRelocated);
    rs.rendition.on("rendered", () => { $("#reader-loading").hidden = true; });

    applyAllStyles();
    await rs.rendition.display(startCfi || undefined);
    $("#reader-loading").hidden = true;
    ensureLocations();
    updateBookUI(rs.lastLocation);
  }

  // page numbers / progress: one "location" per page-worth of text in book
  // mode, 1000 characters in classic mode — stored separately per setting
  function ensureLocations() {
    if (!rs.book || !rs.bookState) return;
    const book = bookMode();
    const key = book ? "locBook_" + (Number(rs.settings.wordsPerPage) || 300) : "locations";
    const chars = book ? bk.pageChars : 1000;
    const token = ++rs.locToken;
    const done = () => { if (token === rs.locToken) { updateProgressFromLocation(rs.lastLocation); updateBookUI(rs.lastLocation); rtOnProgress(rs.lastLocation); } };
    if (rs.bookState[key]) {
      try { rs.book.locations.load(rs.bookState[key]); done(); return; } catch {}
    }
    rs.book.locations.generate(chars).then(() => {
      if (token !== rs.locToken) return;
      rs.bookState[key] = rs.book.locations.save();
      saveBookState(rs.bookId, rs.bookState);
      done();
    }).catch(() => {});
  }

  function setChromeEnabled(enabled) {
    ["#reader-toc-btn", "#reader-bookmark-btn", "#reader-bookmarks-list-btn", "#reader-settings-btn", "#reader-timer-btn", "#reader-prev", "#reader-next"].forEach((sel) => {
      $(sel).style.visibility = enabled ? "" : "hidden";
    });
    $(".reader-bottombar").style.visibility = enabled ? "" : "hidden";
  }

  function closeReader() {
    persistCurrentLocation();
    rtStop();
    if (document.fullscreenElement && document.exitFullscreen) { try { document.exitFullscreen().catch(() => {}); } catch {} }
    cancelTurn();
    clearTimeout(bk.idleTimer);
    $("#reader-modal").hidden = true;
    $("#reader-modal").classList.remove("rb-mode");
    closeAllPanels();
    if (rs.rendition) { try { rs.rendition.destroy(); } catch {} rs.rendition = null; }
    if (rs.book) { try { rs.book.destroy(); } catch {} rs.book = null; }
    rs.lastLocation = null;
    rs.bookRecord = null;
    // refresh the library's "reprendre où je me suis arrêté" rail — this
    // book may have just been started, or its progress just changed
    if (typeof window.__cdiRefreshResume === "function") window.__cdiRefreshResume();
  }
  $("#reader-close").addEventListener("click", closeReader);

  // ---------- track a download click from inside the reader ----------
  $("#reader-download").addEventListener("click", () => {
    if (rs.bookId && typeof window.__cdiTrackDownload === "function") {
      window.__cdiTrackDownload(rs.bookId, $("#reader-book-title").textContent || "");
    }
  });

  // ---------- navigation ----------
  // one entry point for every way of changing page (buttons, keys, taps,
  // swipes, wheel): the animated page turn in book mode, plain epub.js
  // paging in classic mode
  function go(dir) {
    if (!rs.rendition) return;
    if (bookMode() && bk.geom && $("#reader-modal").classList.contains("rb-mode")) { turnPage(dir); return; }
    if (dir > 0) rs.rendition.next(); else rs.rendition.prev();
  }
  $("#reader-prev").addEventListener("click", () => go(-1));
  $("#reader-next").addEventListener("click", () => go(1));
  document.addEventListener("keydown", (e) => {
    if ($("#reader-modal").hidden) return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); go(1); }
    else if ((e.key === "f" || e.key === "F") && !/input|textarea/i.test((e.target && e.target.tagName) || "")) toggleFullscreen();
    else if ((e.key === "t" || e.key === "T") && !/input|textarea/i.test((e.target && e.target.tagName) || "")) rtTogglePanel();
    else if (e.key === "Escape") closeReader();
  });

  function onRelocated(location) {
    rs.lastLocation = location;
    updateProgressFromLocation(location);
    updateBookUI(location);
    persistCurrentLocation(location);
    updateBookmarkStar();
    rtOnProgress(location);
  }

  function persistCurrentLocation(location) {
    if (!rs.rendition || !rs.bookId) return;
    const loc = location || rs.lastLocation;
    if (loc && loc.start && loc.start.cfi) {
      rs.bookState.lastCfi = loc.start.cfi;
      // used by the library's "reprendre où je me suis arrêté" rail to sort
      // started books by recency
      rs.bookState.lastReadAt = new Date().toISOString();
      saveBookState(rs.bookId, rs.bookState);
    }
  }

  function updateProgressFromLocation(location) {
    if (!location || !location.start) return;
    let pct = 0;
    try {
      if (rs.book.locations && rs.book.locations.length()) {
        pct = rs.book.locations.percentageFromCfi(location.start.cfi) || 0;
      }
    } catch {}
    const pctInt = Math.round(pct * 100);
    $("#reader-progress").value = Math.round(pct * 1000);
    $("#reader-progress-label").textContent = pctInt + " %";
    let chapterLabel = "";
    try {
      const item = rs.book.navigation && rs.book.navigation.get(location.start.href);
      if (item) chapterLabel = item.label.trim();
    } catch {}
    $("#reader-loc-label").textContent = chapterLabel;
  }

  $("#reader-progress").addEventListener("change", (e) => {
    if (!rs.book || !rs.rendition) return;
    const pct = Number(e.target.value) / 1000;
    try {
      const cfi = rs.book.locations.cfiFromPercentage(pct);
      if (cfi) rs.rendition.display(cfi);
    } catch {}
  });

  // ---------- table of contents ----------
  function renderToc(toc) {
    const list = $("#reader-toc-list");
    list.innerHTML = "";
    const walk = (items, depth) => {
      items.forEach((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "　".repeat(depth) + item.label.trim();
        btn.addEventListener("click", () => {
          rs.rendition.display(item.href);
          closeAllPanels();
        });
        list.appendChild(btn);
        if (item.subitems && item.subitems.length) walk(item.subitems, depth + 1);
      });
    };
    walk(toc, 0);
  }

  // ---------- bookmarks ----------
  function currentCfi() {
    const loc = rs.lastLocation;
    return loc && loc.start ? loc.start.cfi : null;
  }

  $("#reader-bookmark-btn").addEventListener("click", () => {
    if (!rs.rendition || !rs.bookId) return;
    const cfi = currentCfi();
    if (!cfi) return;
    const idx = rs.bookState.bookmarks.findIndex((b) => b.cfi === cfi);
    if (idx !== -1) {
      rs.bookState.bookmarks.splice(idx, 1);
    } else {
      let label = $("#reader-loc-label").textContent || "";
      if (!label) label = "Page marquée";
      rs.bookState.bookmarks.push({ cfi, label, addedAt: new Date().toISOString() });
      rs.bookState.bookmarks.sort((a, b) => (a.addedAt < b.addedAt ? -1 : 1));
    }
    saveBookState(rs.bookId, rs.bookState);
    updateBookmarkStar();
    renderBookmarks();
  });

  function updateBookmarkStar() {
    const cfi = currentCfi();
    const btn = $("#reader-bookmark-btn");
    const bookmarked = !!(cfi && rs.bookState && rs.bookState.bookmarks.some((b) => b.cfi === cfi));
    btn.textContent = bookmarked ? "★" : "☆";
    btn.classList.toggle("active", bookmarked);
  }

  function renderBookmarks() {
    const list = $("#reader-bookmarks-list");
    const empty = $("#reader-bookmarks-empty");
    list.innerHTML = "";
    const marks = (rs.bookState && rs.bookState.bookmarks) || [];
    empty.hidden = marks.length !== 0;
    marks.forEach((mark) => {
      const row = document.createElement("div");
      row.className = "reader-bookmark-row";
      const date = new Date(mark.addedAt);
      const dateLabel = isNaN(date) ? "" : date.toLocaleDateString("fr-FR");
      row.innerHTML =
        '<button type="button" class="reader-bookmark-item">' + escapeHtmlLocal(mark.label) +
        '<span class="reader-bookmark-meta">' + dateLabel + "</span></button>" +
        '<button type="button" class="reader-bookmark-remove" title="Supprimer ce marque-page">&times;</button>';
      row.querySelector(".reader-bookmark-item").addEventListener("click", () => {
        rs.rendition.display(mark.cfi);
        closeAllPanels();
      });
      row.querySelector(".reader-bookmark-remove").addEventListener("click", () => {
        rs.bookState.bookmarks = rs.bookState.bookmarks.filter((b) => b.cfi !== mark.cfi);
        saveBookState(rs.bookId, rs.bookState);
        renderBookmarks();
        updateBookmarkStar();
      });
      list.appendChild(row);
    });
  }

  // ---------- side panels ----------
  function closeAllPanels() {
    ["#reader-settings-panel", "#reader-toc-panel", "#reader-bookmarks-panel", "#reader-timer-panel"].forEach((sel) => { $(sel).hidden = true; });
    ["#reader-settings-btn", "#reader-toc-btn", "#reader-bookmarks-list-btn", "#reader-timer-btn"].forEach((sel) => $(sel).classList.remove("active"));
  }
  function togglePanel(panelSel, btnSel) {
    const isOpen = !$(panelSel).hidden;
    closeAllPanels();
    if (!isOpen) { $(panelSel).hidden = false; $(btnSel).classList.add("active"); }
  }
  $("#reader-settings-btn").addEventListener("click", () => togglePanel("#reader-settings-panel", "#reader-settings-btn"));
  $("#reader-toc-btn").addEventListener("click", () => togglePanel("#reader-toc-panel", "#reader-toc-btn"));
  $("#reader-bookmarks-list-btn").addEventListener("click", () => { renderBookmarks(); togglePanel("#reader-bookmarks-panel", "#reader-bookmarks-list-btn"); });
  document.querySelectorAll("[data-panel-close]").forEach((btn) => btn.addEventListener("click", closeAllPanels));

  // ---------- settings ----------
  function refreshSettingsUI() {
    $("#reader-font-size-label").textContent = rs.settings.fontScale + " %";
    document.querySelectorAll("#reader-font-family-group button").forEach((b) => b.classList.toggle("active", b.dataset.font === rs.settings.fontFamily));
    document.querySelectorAll("#reader-line-height-group button").forEach((b) => b.classList.toggle("active", b.dataset.lh === rs.settings.lineHeight));
    document.querySelectorAll("#reader-margin-group button").forEach((b) => b.classList.toggle("active", b.dataset.margin === rs.settings.margin));
    document.querySelectorAll("#reader-scroll-group button").forEach((b) => b.classList.toggle("active", b.dataset.scroll === rs.settings.scrollMode));
    document.querySelectorAll("#reader-theme-group button").forEach((b) => b.classList.toggle("active", b.dataset.theme === rs.settings.theme));
    document.querySelectorAll("#reader-mode-group button").forEach((b) => b.classList.toggle("active", b.dataset.mode === (rs.settings.mode === "classic" ? "classic" : "book")));
    document.querySelectorAll("#reader-wpp-group button").forEach((b) => b.classList.toggle("active", Number(b.dataset.wpp) === Number(rs.settings.wordsPerPage)));
    $("#reader-autofs-toggle").checked = !!rs.settings.autoFullscreen;
    $("#reader-justify-toggle").checked = !!rs.settings.justify;
    $("#reader-warmth-range").value = rs.settings.warmth;
    $("#reader-brightness-range").value = rs.settings.brightness;
  }

  function applyAllStyles() {
    if (!rs.rendition) return;
    if (bookMode() && bk.geom) { applyBookStyles(); return; }
    const colors = THEME_COLORS[rs.settings.theme] || THEME_COLORS.light;
    const css = {
      body: {
        background: colors.bg + " !important",
        color: colors.fg + " !important",
        "line-height": LINE_HEIGHTS[rs.settings.lineHeight] + " !important",
        padding: "0 " + MARGINS[rs.settings.margin] + " !important",
      },
      "p, li, div, span": { color: colors.fg + " !important" },
    };
    const fontStack = FONT_STACKS[rs.settings.fontFamily];
    if (fontStack) {
      css.body["font-family"] = fontStack + " !important";
      css["p, li, div, span"]["font-family"] = fontStack + " !important";
    }
    if (rs.settings.justify) {
      css.p = Object.assign({}, css.p, { "text-align": "justify !important" });
    }
    rs.rendition.themes.register("cdi-custom", css);
    rs.rendition.themes.select("cdi-custom");
    rs.rendition.themes.fontSize(rs.settings.fontScale + "%");

    $("#reader-warmth-overlay").style.opacity = String((rs.settings.warmth / 100) * 0.55);
    $("#reader-viewer-wrap").style.filter = "brightness(" + rs.settings.brightness + "%)";

    refreshSettingsUI();
  }

  function updateSetting(patch) {
    rs.settings = Object.assign({}, rs.settings, patch);
    saveSettings(rs.settings);
    applyAllStyles();
  }

  $("#reader-font-minus").addEventListener("click", () => updateSetting({ fontScale: Math.max(70, rs.settings.fontScale - 10) }));
  $("#reader-font-plus").addEventListener("click", () => updateSetting({ fontScale: Math.min(240, rs.settings.fontScale + 10) }));

  document.querySelectorAll("#reader-font-family-group button").forEach((b) => b.addEventListener("click", () => {
    updateSetting({ fontFamily: b.dataset.font });
    if (bookMode() && rs.book) rebuild(); // another typeface = another text width: recompute the page
  }));
  document.querySelectorAll("#reader-line-height-group button").forEach((b) => b.addEventListener("click", () => updateSetting({ lineHeight: b.dataset.lh })));
  document.querySelectorAll("#reader-margin-group button").forEach((b) => b.addEventListener("click", () => updateSetting({ margin: b.dataset.margin })));
  document.querySelectorAll("#reader-theme-group button").forEach((b) => b.addEventListener("click", () => updateSetting({ theme: b.dataset.theme })));
  $("#reader-justify-toggle").addEventListener("change", (e) => updateSetting({ justify: e.target.checked }));
  $("#reader-warmth-range").addEventListener("input", (e) => updateSetting({ warmth: Number(e.target.value) }));
  $("#reader-brightness-range").addEventListener("input", (e) => updateSetting({ brightness: Number(e.target.value) }));

  document.querySelectorAll("#reader-scroll-group button").forEach((b) => b.addEventListener("click", () => {
    rs.settings = Object.assign({}, rs.settings, { scrollMode: b.dataset.scroll });
    saveSettings(rs.settings);
    if (rs.rendition) {
      const cfi = currentCfi();
      rs.rendition.flow(rs.settings.scrollMode === "scrolled" ? "scrolled-doc" : "paginated");
      if (cfi) rs.rendition.display(cfi);
    }
    refreshSettingsUI();
  }));

  // ================================================================
  // MODE LIVRE — plein écran, pages de format poche à contenu constant,
  // double page sur grand écran, papier / tranche / pli, page qui se tourne
  // ================================================================
  const BK = {
    RATIO: 0.611,       // page de poche : 11 x 18 cm
    LINE: 1.36,         // interligne d'un roman imprimé
    EFFICIENCY: 0.84,   // part de la capacité théorique réellement remplie par du texte
    INSET_Y: 0.065,     // marge haut et bas, en fraction de la hauteur de page
    GAP_RATIO: 0.2,     // marges gauche + droite d'une page, en fraction de sa largeur
    TURN_MS: 680,
    SAMPLE: "Le soleil se couchait lentement derrière les collines, et la brume du soir montait des vallées vers le village endormi. Personne ne savait encore ce que la nuit allait apporter.",
    FONT_BOOK: "'EB Garamond', Georgia, 'Times New Roman', serif",
  };
  const BK_PAPER = {
    light: { p: "#f4ecd8", p2: "#ebe1c8", ink: "#2a2014" },
    sepia: { p: "#ead9b6", p2: "#dcc79b", ink: "#3a2c17" },
    dark:  { p: "#38332a", p2: "#2d2922", ink: "#e4dcc8" },
    black: { p: "#141414", p2: "#0b0b0b", ink: "#c9c2b0" },
  };
  const bk = { geom: null, fs: 16, pageChars: 1800, edgeMax: 15, idleTimer: 0, resizeTimer: 0, hintTimer: 0 };
  const FLAP = { raf: 0, busy: false, swapped: false, swapPromise: null, dir: 1, angle: 0 };

  function bookMode() { return rs.settings.mode !== "classic"; }
  function bookFontStack() { return rs.settings.fontFamily === "sans" ? FONT_STACKS.sans : BK.FONT_BOOK; }

  // size of the page box: pocket proportions, as large as the screen allows;
  // two pages side by side on a wide landscape screen, one page otherwise
  function computeGeom() {
    const wrap = $("#reader-viewer-wrap");
    const W = Math.max(280, wrap.clientWidth), H = Math.max(360, wrap.clientHeight);
    const pages = (W >= 820 && W / H >= 1.12) ? 2 : 1;
    const edge = Math.max(6, Math.min(15, Math.round(W * 0.02)));
    const sidePad = edge + 5 + (W < 640 ? W * 0.015 : Math.min(34, W * 0.03));
    const padY = Math.min(58, H * 0.075) + 8;
    let pageH = H - 2 * padY;
    let pageW = pageH * BK.RATIO;
    const maxW = (W - 2 * sidePad) / pages;
    if (pageW > maxW) { pageW = maxW; pageH = pageW / BK.RATIO; }
    pageW = Math.floor(pageW / 2) * 2;
    pageH = Math.floor(pageH);
    const iy = Math.round(pageH * BK.INSET_Y);
    const gap = Math.round((pageW * BK.GAP_RATIO) / 2) * 2;
    bk.edgeMax = edge;
    return {
      W, H, pages, pageW, pageH, iy, gap,
      viewW: pageW * pages, viewH: pageH - 2 * iy,
      bx: Math.round((W - pageW * pages) / 2), by: Math.round((H - pageH) / 2),
    };
  }

  // The font size is derived from the page box and the REAL width of the
  // typeface (measured on a French sample), so that a page holds the same
  // number of words on every screen: words/page =
  //   (text width / (fs x char width)) x (text height / (fs x line height)) x words per char
  function computeFontSize(g) {
    const wpp = Number(rs.settings.wordsPerPage) || 300;
    const words = BK.SAMPLE.trim().split(/\s+/).length;
    const wordsPerChar = words / BK.SAMPLE.length;
    let cw = 0.42; // em per character — fallback if canvas measuring is unavailable
    try {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = "100px " + bookFontStack();
      cw = ctx.measureText(BK.SAMPLE).width / BK.SAMPLE.length / 100 || cw;
    } catch {}
    const textW = g.pageW - g.gap, textH = g.viewH;
    // BK.EFFICIENCY: a real page never fills every line (short last lines of
    // paragraphs, dialogue, chapter headings), so the nominal capacity has to
    // be a bit higher than the words we want to actually see on the page
    let fs = Math.sqrt((textW * textH * wordsPerChar * BK.EFFICIENCY) / (cw * BK.LINE * wpp));
    fs = Math.max(8, Math.min(30, Math.round(fs * 10) / 10));
    bk.pageChars = Math.round(wpp / wordsPerChar);
    return fs;
  }

  function applyBookGeometry(g) {
    const b = $("#rb-book");
    b.style.setProperty("--bx", g.bx + "px");
    b.style.setProperty("--by", g.by + "px");
    b.style.setProperty("--bw", g.viewW + "px");
    b.style.setProperty("--bh", g.pageH + "px");
    b.style.setProperty("--pw", g.pageW + "px");
    b.style.setProperty("--iy", g.iy + "px");
    b.style.setProperty("--fs", bk.fs + "px");
    $("#reader-modal").classList.toggle("rb-single", g.pages === 1);
    applyPaperTheme();
  }

  function applyPaperTheme() {
    const t = BK_PAPER[rs.settings.theme] || BK_PAPER.light;
    const m = $("#reader-modal");
    m.style.setProperty("--rb-paper", t.p);
    m.style.setProperty("--rb-paper2", t.p2);
    m.style.setProperty("--rb-ink", t.ink);
  }

  // text styling inside the page: a printed novel (justified, hyphenated,
  // indented paragraphs without spacing) on a transparent background so the
  // paper texture shows through
  function applyBookStyles() {
    const t = BK_PAPER[rs.settings.theme] || BK_PAPER.light;
    const stack = bookFontStack();
    const ink = t.ink + " !important";
    const css = {
      body: {
        background: "transparent !important", color: ink,
        "font-family": stack + " !important", "font-size": bk.fs + "px !important",
        "line-height": BK.LINE + " !important", "text-align": "justify !important",
        hyphens: "auto !important", "-webkit-hyphens": "auto !important",
        "overflow-wrap": "break-word", "font-kerning": "normal", "text-rendering": "optimizeLegibility",
      },
      "p, li, blockquote, dd": {
        color: ink, "font-family": stack + " !important", "font-size": "1em !important",
        "line-height": "inherit !important", margin: "0 !important", "text-indent": "1.3em !important",
        "text-align": "justify !important", hyphens: "auto !important", "-webkit-hyphens": "auto !important",
        orphans: "2", widows: "2",
      },
      "div, span, a, em, i, b, strong": { color: ink, "font-family": stack + " !important" },
      "h1, h2, h3, h4, h5, h6": {
        color: ink, "font-family": stack + " !important", "text-align": "center !important",
        "text-indent": "0 !important", "line-height": "1.2 !important", margin: "1.1em 0 .8em !important",
        "break-after": "avoid",
      },
      "h1 + p, h2 + p, h3 + p, hr + p, p:first-child": { "text-indent": "0 !important" },
      "img, svg, image": { "max-width": "100% !important", "max-height": "100% !important", "object-fit": "contain !important" },
    };
    rs.rendition.themes.register("cdi-book", css);
    rs.rendition.themes.select("cdi-book");
    applyPaperTheme();
    $("#reader-warmth-overlay").style.opacity = String((rs.settings.warmth / 100) * 0.55);
    $("#reader-viewer-wrap").style.filter = "brightness(" + rs.settings.brightness + "%)";
    refreshSettingsUI();
  }

  // page numbers under each page, thickness of the two page stacks, and the
  // "n / total" label. Uses the paper page numbers when the EPUB carries a
  // page-list (the printed edition's pagination), page-worths of text otherwise.
  function updateBookUI(loc) {
    if (!bookMode() || !bk.geom || !loc || !loc.start || !rs.book) return;
    const g = bk.geom;
    let n = null, total = null, pct = 0;
    try {
      const L = rs.book.locations;
      if (L && L.length()) {
        n = L.locationFromCfi(loc.start.cfi) + 1;
        total = L.length();
        pct = L.percentageFromCfi(loc.start.cfi) || 0;
      }
    } catch {}
    let paperL = null, paperR = null;
    try {
      const pl = rs.book.pageList;
      if (pl && pl.pages && pl.pages.length) {
        const a = pl.pageFromCfi(loc.start.cfi);
        const b = loc.end ? pl.pageFromCfi(loc.end.cfi) : a;
        if (a !== -1 && a != null) paperL = a;
        if (b !== -1 && b != null) paperR = b;
      }
    } catch {}
    const left = paperL != null ? String(paperL) : (n != null ? String(n) : "");
    let right = "";
    if (g.pages === 2) {
      if (paperR != null && String(paperR) !== left) right = String(paperR);
      else if (paperL != null && !isNaN(Number(paperL))) right = String(Number(paperL) + 1);
      else if (n != null && n + 1 <= total) right = String(n + 1);
    }
    $("#rb-folio-l").textContent = left;
    $("#rb-folio-r").textContent = right;
    $("#rb-edge-l").style.width = (2 + pct * bk.edgeMax).toFixed(1) + "px";
    $("#rb-edge-r").style.width = (2 + (1 - pct) * bk.edgeMax).toFixed(1) + "px";
    if (n != null) {
      $("#reader-progress-label").textContent = (paperL != null ? "p. " + paperL : n + " / " + total);
    }
  }

  // ---------- the page turn ----------
  function flapSetup(dir) {
    const g = bk.geom, flap = $("#rb-flap"), cast = $("#rb-cast");
    const double = g.pages === 2;
    FLAP.dir = dir;
    const left = (dir > 0 && double) ? g.pageW : 0;
    const fromLeft = dir > 0 || !double;
    flap.style.width = cast.style.width = g.pageW + "px";
    flap.style.height = cast.style.height = g.pageH + "px";
    flap.style.left = cast.style.left = left + "px";
    flap.style.transformOrigin = fromLeft ? "left center" : "right center";
    cast.style.background = "linear-gradient(" + (fromLeft ? "90deg" : "270deg") + ", rgba(0,0,0,.55), rgba(0,0,0,0) 70%)";
    flap.classList.add("on");
  }
  // a = progress of the turn, 0 (flat) to 180 (fully turned)
  function setAngle(a) {
    const g = bk.geom, flap = $("#rb-flap");
    FLAP.angle = a;
    let rot;
    if (FLAP.dir > 0) rot = -a;                    // next: lifts on the right, flips to the left
    else if (g.pages === 2) rot = a;               // previous (2 pages): lifts on the left, flips to the right
    else rot = -(180 - a);                         // previous (1 page): comes back from the left onto the page
    flap.style.transform = "rotateY(" + rot.toFixed(2) + "deg)";
    const s = Math.sin((a * Math.PI) / 180);
    flap.style.setProperty("--lit", (0.3 * s).toFixed(3));
    flap.style.opacity = a > 168 ? String(Math.max(0, (180 - a) / 12)) : "1";
    $("#rb-cast").style.opacity = (0.9 * s).toFixed(3);
  }
  function finishFlap() {
    const flap = $("#rb-flap");
    flap.classList.remove("on");
    flap.style.transform = "";
    flap.style.opacity = "1";
    $("#rb-cast").style.opacity = "0";
    FLAP.angle = 0;
  }
  function cancelTurn() {
    cancelAnimationFrame(FLAP.raf);
    FLAP.busy = false;
    FLAP.swapped = false;
    if (bk.geom) finishFlap();
  }
  function doSwap() {
    FLAP.swapped = true;
    try {
      const r = FLAP.dir > 0 ? rs.rendition.next() : rs.rendition.prev();
      FLAP.swapPromise = Promise.resolve(r).catch(() => {});
    } catch { FLAP.swapPromise = Promise.resolve(); }
  }
  function runTurn(from, to, commit) {
    return new Promise((resolve) => {
      const start = performance.now();
      const dur = Math.max(240, BK.TURN_MS * Math.abs(to - from) / 180);
      const step = (now) => {
        const p = Math.min(1, (now - start) / dur);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // easeInOutCubic
        const a = from + (to - from) * e;
        setAngle(a);
        if (commit && !FLAP.swapped && a >= 90) doSwap();
        if (p < 1) FLAP.raf = requestAnimationFrame(step); else resolve();
      };
      FLAP.raf = requestAnimationFrame(step);
    });
  }
  async function endTurn() {
    if (FLAP.swapPromise) { try { await FLAP.swapPromise; } catch {} }
    FLAP.swapPromise = null;
    finishFlap();
    FLAP.busy = false;
  }
  async function turnPage(dir) {
    if (!rs.rendition || FLAP.busy) return;
    const loc = rs.lastLocation;
    const blocked = !!(loc && (dir > 0 ? loc.atEnd : loc.atStart));
    FLAP.busy = true; FLAP.swapped = false; FLAP.swapPromise = null;
    flapSetup(dir); setAngle(0);
    if (blocked) { await runTurn(0, 14, false); await runTurn(14, 0, false); }
    else await runTurn(0, 180, true);
    await endTurn();
  }

  // ---------- touch / mouse on the book: tap = turn, drag = follow the page ----------
  (function initTouch() {
    const touch = $("#rb-touch");
    let st = null;
    touch.addEventListener("pointerdown", (e) => {
      if (FLAP.busy || (e.pointerType === "mouse" && e.button !== 0)) return;
      st = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, drag: false, dir: 0 };
      try { touch.setPointerCapture(e.pointerId); } catch {}
    });
    touch.addEventListener("pointermove", (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.drag) {
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        st.drag = true; st.dir = dx < 0 ? 1 : -1;
        const loc = rs.lastLocation;
        st.blocked = !!(loc && (st.dir > 0 ? loc.atEnd : loc.atStart));
        FLAP.busy = true; FLAP.swapped = false; FLAP.swapPromise = null;
        flapSetup(st.dir); setAngle(0);
      }
      const reach = bk.geom.pageW * 0.85;
      const max = st.blocked ? 14 : 88;
      setAngle(Math.min(max, (Math.abs(dx) / reach) * 88));
    });
    const release = async (e) => {
      if (!st || e.pointerId !== st.id) return;
      const s = st; st = null;
      try { touch.releasePointerCapture(e.pointerId); } catch {}
      if (s.drag) {
        const a = FLAP.angle;
        if (!s.blocked && a > 28) await runTurn(a, 180, true); else await runTurn(a, 0, false);
        await endTurn();
        return;
      }
      if (e.type === "pointercancel") return;
      // a tap: left side = previous page, right side = next page
      const r = $("#rb-book").getBoundingClientRect();
      const frac = (e.clientX - r.left) / Math.max(1, r.width);
      const split = bk.geom.pages === 2 ? 0.5 : 0.33;
      go(frac < split ? -1 : 1);
    };
    touch.addEventListener("pointerup", release);
    touch.addEventListener("pointercancel", release);
    touch.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaY) + Math.abs(e.deltaX) < 20) return;
      go(e.deltaY + e.deltaX > 0 ? 1 : -1);
    }, { passive: false });
  })();

  // ---------- full screen + auto-hiding toolbars ----------
  function showHint(msg) {
    const h = $("#rb-hint");
    h.textContent = msg; h.hidden = false;
    clearTimeout(bk.hintTimer);
    bk.hintTimer = setTimeout(() => { h.hidden = true; }, 5200);
  }
  function fullscreenSupported() {
    const el = $("#reader-modal");
    return !!(el.requestFullscreen || el.webkitRequestFullscreen);
  }
  function toggleFullscreen() {
    const el = $("#reader-modal");
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch {}
      return;
    }
    if (!fullscreenSupported()) { showHint("Plein écran non disponible ici : la lecture occupe déjà tout l'écran."); return; }
    try {
      const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      if (r && r.catch) r.catch(() => showHint("Le navigateur a refusé le plein écran."));
    } catch { showHint("Le navigateur a refusé le plein écran."); }
  }
  function tryAutoFullscreen() {
    if (!rs.settings.autoFullscreen || document.fullscreenElement) return;
    if (!fullscreenSupported()) return;
    const el = $("#reader-modal");
    const hint = () => showHint("Appuie sur ⛶ (ou sur la touche F) pour lire en plein écran");
    try {
      const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      if (r && r.catch) r.catch(hint);
    } catch { hint(); }
  }
  $("#reader-fullscreen-btn").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => {
    $("#reader-modal").classList.toggle("rb-fullscreen", !!document.fullscreenElement);
  });

  function panelOpen() {
    return ["#reader-settings-panel", "#reader-toc-panel", "#reader-bookmarks-panel", "#reader-timer-panel"].some((sel) => !$(sel).hidden);
  }
  function wakeBars() {
    const frame = $(".reader-frame");
    frame.classList.remove("rb-idle");
    clearTimeout(bk.idleTimer);
    if (!bookMode() || $("#reader-modal").hidden) return;
    bk.idleTimer = setTimeout(() => { if (!panelOpen()) frame.classList.add("rb-idle"); }, 2800);
  }
  $(".reader-frame").addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") wakeBars(); });
  $(".reader-frame").addEventListener("pointerdown", () => wakeBars());

  // ---------- rebuild on resize / mode change ----------
  async function rebuild() {
    if (!rs.book) return;
    const cfi = (rs.lastLocation && rs.lastLocation.start && rs.lastLocation.start.cfi) || rs.bookState.lastCfi || undefined;
    cancelTurn();
    try { await buildRendition(cfi); } catch {}
    renderBookmarks(); updateBookmarkStar(); wakeBars();
  }
  window.addEventListener("resize", () => {
    clearTimeout(bk.resizeTimer);
    bk.resizeTimer = setTimeout(() => {
      if ($("#reader-modal").hidden || !rs.book || !bookMode() || !bk.geom) return;
      const g = computeGeom(), o = bk.geom;
      if (g.pages !== o.pages || Math.abs(g.pageW - o.pageW) > 2 || Math.abs(g.pageH - o.pageH) > 2) rebuild();
    }, 280);
  });

  // ---------- settings: mode, words per page, auto full screen ----------
  document.querySelectorAll("#reader-mode-group button").forEach((b) => b.addEventListener("click", () => {
    if ((rs.settings.mode === "classic" ? "classic" : "book") === b.dataset.mode) return;
    updateSetting({ mode: b.dataset.mode });
    if (rs.book) rebuild();
  }));
  document.querySelectorAll("#reader-wpp-group button").forEach((b) => b.addEventListener("click", () => {
    if (Number(rs.settings.wordsPerPage) === Number(b.dataset.wpp)) return;
    rs.settings = Object.assign({}, rs.settings, { wordsPerPage: Number(b.dataset.wpp) });
    saveSettings(rs.settings); refreshSettingsUI();
    if (rs.book && bookMode()) rebuild();
  }));
  $("#reader-autofs-toggle").addEventListener("change", (e) => {
    rs.settings = Object.assign({}, rs.settings, { autoFullscreen: e.target.checked });
    saveSettings(rs.settings);
  });


  // ================================================================
  // SÉANCE DE LECTURE — minuteur sans montre : durée, nombre de pages,
  // pourcentage du livre ou nombre de chapitres. Rien ne s'affiche
  // pendant la lecture (sauf la barre discrète si elle est activée) ;
  // une carte douce apparaît quand l'objectif est atteint.
  // ================================================================
  const RT_DEFAULTS = {
    mode: "time",                                       // time | pages | percent | chapters
    amounts: { time: 20, pages: 20, percent: 10, chapters: 1 },
    pctKind: "gain",                                    // gain = avancer de X % ; reach = aller jusqu'à X %
    bar: false, sound: true, autoPause: true,
  };
  const RT_MODES = {
    time:     { label: "Durée",       unit: "min",      presets: [10, 20, 30, 45, 60], step: 5, extra: 5, max: 600 },
    pages:    { label: "Pages",       unit: "pages",    presets: [10, 20, 30, 50, 100], step: 5, extra: 5, max: 2000 },
    percent:  { label: "Pourcentage", unit: "%",        presets: [5, 10, 25, 50],       step: 1, extra: 5, max: 100 },
    chapters: { label: "Chapitres",   unit: "chapitre(s)", presets: [1, 2, 3, 5],       step: 1, extra: 1, max: 200 },
  };
  const RT = {
    cfg: null, running: false, paused: false, autoPaused: false, ended: false,
    mode: "time", target: 0, pctKind: "gain", targetPct: 0,
    startedAt: 0, elapsed: 0, resumeAt: 0, tick: 0,
    startCfi: null, startPct: null, maxPct: null, startSpine: null, maxSpine: null,
  };

  function rtCfg() {
    const c = rs.settings.timer || {};
    return Object.assign({}, RT_DEFAULTS, c, { amounts: Object.assign({}, RT_DEFAULTS.amounts, c.amounts || {}) });
  }
  function rtSaveCfg(patch) {
    const c = Object.assign(rtCfg(), patch);
    rs.settings = Object.assign({}, rs.settings, { timer: c });
    saveSettings(rs.settings);
    return c;
  }

  // ---------- progress measures (independent of font size / words per page) ----------
  function rtLocs() {
    try { const L = rs.book && rs.book.locations; return L && L.length() ? L : null; } catch { return null; }
  }
  function rtPctOf(cfi) {
    const L = rtLocs();
    if (!L || !cfi) return null;
    try { const p = L.percentageFromCfi(cfi); return typeof p === "number" && !isNaN(p) ? p : null; } catch { return null; }
  }
  function rtCurrentPct() {
    const loc = rs.lastLocation;
    return loc && loc.start ? rtPctOf(loc.start.cfi) : null;
  }
  // pages read = furthest point reached minus the starting point, in pages of
  // the current layout (going back and forth never counts twice)
  function rtPagesRead() {
    const L = rtLocs();
    if (!L || RT.startPct == null || RT.maxPct == null) return null;
    return Math.max(0, Math.round((RT.maxPct - RT.startPct) * L.length()));
  }
  function rtElapsedMs() {
    return RT.elapsed + (RT.running && !RT.paused ? Date.now() - RT.resumeAt : 0);
  }
  function rtFmtDur(ms) {
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    if (m >= 60) return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0");
    return m + " min " + String(s).padStart(2, "0") + " s";
  }

  // fraction of the goal done, 0..1 (null = not measurable yet)
  function rtFraction() {
    if (RT.mode === "time") return Math.min(1, rtElapsedMs() / (RT.target * 60000));
    if (RT.mode === "pages") { const p = rtPagesRead(); return p == null ? null : Math.min(1, p / RT.target); }
    if (RT.mode === "percent") {
      if (RT.startPct == null || RT.maxPct == null) return null;
      const span = RT.targetPct - RT.startPct;
      return span <= 0 ? 1 : Math.min(1, Math.max(0, (RT.maxPct - RT.startPct) / span));
    }
    if (RT.mode === "chapters") {
      if (RT.startSpine == null || RT.maxSpine == null) return null;
      return Math.min(1, (RT.maxSpine - RT.startSpine) / RT.target);
    }
    return null;
  }

  // ---------- hooks called by the reader ----------
  function rtOnProgress(loc) {
    if (!RT.running || RT.ended) return;
    loc = loc || rs.lastLocation;
    if (!loc || !loc.start) return;
    // the starting point is measured as soon as the book's locations are ready
    if (RT.startPct == null && RT.startCfi) {
      RT.startPct = rtPctOf(RT.startCfi);
      if (RT.startPct != null && RT.mode === "percent") rtComputeTargetPct();
    }
    const pct = rtPctOf(loc.start.cfi);
    if (pct != null) RT.maxPct = RT.maxPct == null ? pct : Math.max(RT.maxPct, pct);
    const idx = typeof loc.start.index === "number" ? loc.start.index : null;
    if (idx != null) {
      if (RT.startSpine == null) RT.startSpine = idx;
      RT.maxSpine = RT.maxSpine == null ? idx : Math.max(RT.maxSpine, idx);
    }
    rtCheck();
  }
  function rtComputeTargetPct() {
    const x = RT.target / 100;
    RT.targetPct = RT.pctKind === "reach" ? Math.min(1, x) : Math.min(1, (RT.startPct || 0) + x);
  }

  function rtCheck() {
    if (!RT.running || RT.ended) return;
    const f = rtFraction();
    rtRenderBar(f);
    if (!$("#reader-timer-panel").hidden) rtRenderRun();
    let done = f != null && f >= 1;
    // the last page of the book also ends a page / percent / chapter session
    if (!done && RT.mode !== "time" && rs.lastLocation && rs.lastLocation.atEnd) done = true;
    if (done) rtFinish();
  }

  // ---------- start / pause / stop ----------
  function rtStart() {
    if (!rs.rendition) return;
    const c = rtCfg();
    RT.mode = c.mode;
    RT.target = Math.max(1, Number(c.amounts[c.mode]) || 1);
    RT.pctKind = c.pctKind;
    RT.running = true; RT.paused = false; RT.autoPaused = false; RT.ended = false;
    RT.startedAt = Date.now(); RT.resumeAt = Date.now(); RT.elapsed = 0;
    const loc = rs.lastLocation;
    RT.startCfi = loc && loc.start ? loc.start.cfi : null;
    RT.startPct = rtPctOf(RT.startCfi);
    RT.maxPct = RT.startPct;
    RT.startSpine = loc && loc.start && typeof loc.start.index === "number" ? loc.start.index : null;
    RT.maxSpine = RT.startSpine;
    if (RT.mode === "percent" && RT.startPct != null) rtComputeTargetPct();
    clearInterval(RT.tick);
    RT.tick = setInterval(rtCheck, 1000);
    $("#rt-end").hidden = true;
    $("#reader-timer-btn").classList.add("rt-running");
    closeAllPanels();
    rtRenderBar(0);
    showHint("Séance lancée. Bonne lecture, je te préviens à la fin.");
  }
  function rtPause(auto) {
    if (!RT.running || RT.paused) return;
    RT.elapsed += Date.now() - RT.resumeAt;
    RT.paused = true; RT.autoPaused = !!auto;
    rtRenderRun();
  }
  function rtResume() {
    if (!RT.running || !RT.paused) return;
    RT.paused = false; RT.autoPaused = false; RT.resumeAt = Date.now();
    rtRenderRun();
  }
  function rtStop() {
    clearInterval(RT.tick);
    RT.running = false; RT.paused = false; RT.ended = false;
    $("#reader-timer-btn").classList.remove("rt-running");
    $("#rt-bar").hidden = true;
    $("#rt-end").hidden = true;
    rtRenderPanel();
  }
  function rtFinish() {
    if (RT.mode === "time") { RT.elapsed = RT.target * 60000; RT.resumeAt = Date.now(); RT.paused = true; }
    else if (!RT.paused) { RT.elapsed += Date.now() - RT.resumeAt; RT.paused = true; }
    RT.ended = true;
    clearInterval(RT.tick);
    rtRenderBar(1);
    $("#reader-timer-btn").classList.remove("rt-running");
    const atEnd = RT.mode !== "time" && rs.lastLocation && rs.lastLocation.atEnd && (rtFraction() || 0) < 1;
    $("#rt-end-title").textContent = atEnd ? "Tu es arrivé à la fin du livre" : rtGoalText(true);
    $("#rt-end-stats").textContent = rtStatsText();
    const m = RT_MODES[RT.mode];
    $("#rt-end-more").textContent = "+" + m.extra + " " + (RT.mode === "chapters" ? "chapitre" : m.unit);
    $("#rt-end-more").hidden = !!atEnd;
    closeAllPanels();
    $("#rt-end").hidden = false;
    if (rtCfg().sound) rtChime();
  }
  // "+5 min / +5 pages…": the same session goes on, the goal moves further
  function rtExtend() {
    const m = RT_MODES[RT.mode];
    RT.target += m.extra;
    if (RT.mode === "percent") RT.targetPct = Math.min(1, RT.targetPct + m.extra / 100);
    RT.ended = false; RT.paused = false; RT.resumeAt = Date.now();
    clearInterval(RT.tick);
    RT.tick = setInterval(rtCheck, 1000);
    $("#rt-end").hidden = true;
    $("#reader-timer-btn").classList.add("rt-running");
    rtCheck();
  }

  // ---------- texts ----------
  function rtGoalText(done) {
    const t = RT.target;
    if (RT.mode === "time") return done ? t + " min de lecture" : "Lire pendant " + t + " min";
    if (RT.mode === "pages") return done ? t + " pages lues" : "Lire " + t + " pages";
    if (RT.mode === "percent") {
      if (RT.pctKind === "reach") return done ? Math.round(RT.targetPct * 100) + " % du livre atteint" : "Aller jusqu'à " + t + " % du livre";
      return done ? "+" + t + " % du livre" : "Avancer de " + t + " % dans le livre";
    }
    return done ? (t > 1 ? t + " chapitres lus" : "Chapitre terminé") : (t > 1 ? "Lire " + t + " chapitres" : "Finir ce chapitre");
  }
  function rtStatsText() {
    const parts = ["Temps de lecture : " + rtFmtDur(rtElapsedMs())];
    const p = rtPagesRead();
    if (p != null && !(RT.ended && RT.mode === "pages")) parts.push(p + " page" + (p > 1 ? "s" : "") + " lue" + (p > 1 ? "s" : ""));
    const cur = rtCurrentPct();
    if (cur != null) parts.push("tu es à " + Math.round(cur * 100) + " % du livre");
    return parts.join(" · ");
  }

  // ---------- rendering ----------
  function rtRenderBar(f) {
    const bar = $("#rt-bar");
    if (!RT.running || !rtCfg().bar) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.firstElementChild.style.width = ((f == null ? 0 : f) * 100).toFixed(2) + "%";
  }
  function rtRenderPanel() {
    const c = rtCfg();
    const run = RT.running && !RT.ended;
    $("#rt-setup").hidden = run;
    $("#rt-run").hidden = !run;
    if (run) { rtRenderRun(); return; }
    const m = RT_MODES[c.mode];
    document.querySelectorAll("#rt-mode-group button").forEach((b) => b.classList.toggle("active", b.dataset.rtmode === c.mode));
    const presets = $("#rt-preset-group");
    presets.innerHTML = "";
    m.presets.forEach((v) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = v + (c.mode === "percent" ? " %" : "");
      b.classList.toggle("active", Number(c.amounts[c.mode]) === v);
      b.addEventListener("click", () => { rtSetAmount(v); });
      presets.appendChild(b);
    });
    $("#rt-amount").value = c.amounts[c.mode];
    $("#rt-amount").max = m.max;
    $("#rt-unit").textContent = m.unit;
    $("#rt-pctkind-row").hidden = c.mode !== "percent";
    document.querySelectorAll("#rt-pctkind-group button").forEach((b) => b.classList.toggle("active", b.dataset.pctkind === c.pctKind));
    $("#rt-bar-toggle").checked = !!c.bar;
    $("#rt-sound-toggle").checked = !!c.sound;
    $("#rt-autopause-toggle").checked = !!c.autoPause;
    $("#rt-preview").textContent = rtPreview(c);
  }
  function rtPreview(c) {
    const v = Number(c.amounts[c.mode]) || 0;
    const L = rtLocs(), cur = rtCurrentPct();
    if (c.mode === "time") return "Tu seras prévenu vers " + new Date(Date.now() + v * 60000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) + ".";
    if (c.mode === "pages") {
      if (!L || cur == null) return "Calcul des pages du livre en cours…";
      const end = Math.min(1, cur + v / L.length());
      return "Arrivée prévue vers " + Math.round(end * 100) + " % du livre." + (bookMode() ? "" : " En mode classique, 1 page ≈ 1 000 signes.");
    }
    if (c.mode === "percent") {
      if (cur == null) return "Calcul de la position en cours…";
      if (c.pctKind === "reach") {
        if (v / 100 <= cur) return "Attention : tu es déjà à " + Math.round(cur * 100) + " %. Choisis une valeur plus haute.";
        return "Tu es à " + Math.round(cur * 100) + " %" + (L ? ", soit environ " + Math.round((v / 100 - cur) * L.length()) + " pages à lire." : ".");
      }
      return "De " + Math.round(cur * 100) + " % à " + Math.min(100, Math.round(cur * 100 + v)) + " %" + (L ? ", soit environ " + Math.round(Math.min(v / 100, 1 - cur) * L.length()) + " pages." : ".");
    }
    return v > 1 ? "La séance s'arrête au début du " + (v + 1) + "e chapitre à partir d'ici." : "La séance s'arrête au début du chapitre suivant.";
  }
  function rtRenderRun() {
    if (!RT.running) return;
    const f = rtFraction();
    $("#rt-goal").textContent = rtGoalText(false);
    $("#rt-meter-fill").style.width = ((f || 0) * 100).toFixed(1) + "%";
    let left = "";
    if (RT.mode === "time") left = "Reste " + rtFmtDur(Math.max(0, RT.target * 60000 - rtElapsedMs()));
    else if (f == null) left = "Mesure en cours…";
    else if (RT.mode === "pages") left = "Reste " + Math.max(0, RT.target - (rtPagesRead() || 0)) + " page(s)";
    else if (RT.mode === "percent") left = "Reste " + Math.max(0, Math.round((RT.targetPct - (RT.maxPct || 0)) * 1000) / 10) + " %";
    else left = "Reste " + Math.max(0, RT.target - (RT.maxSpine - RT.startSpine)) + " chapitre(s)";
    $("#rt-left").textContent = (RT.paused ? "En pause · " : "") + left;
    $("#rt-status").textContent = rtStatsText();
    $("#rt-pause").textContent = RT.paused ? "Reprendre" : "Pause";
    $("#rt-pause").hidden = RT.mode !== "time";
  }

  // gentle two-note chime (Web Audio, no file to download)
  function rtChime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = RT.audio || (RT.audio = new AC());
      if (ctx.state === "suspended") ctx.resume();
      [[659.25, 0], [880, 0.28], [1318.5, 0.56]].forEach(([freq, at]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = freq;
        const t0 = ctx.currentTime + at;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.12, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 1.7);
      });
    } catch {}
  }

  function rtSetAmount(v) {
    const c = rtCfg(), m = RT_MODES[c.mode];
    v = Math.max(1, Math.min(m.max, Math.round(Number(v) || 1)));
    c.amounts[c.mode] = v;
    rtSaveCfg({ amounts: c.amounts });
    rtRenderPanel();
  }
  function rtTogglePanel() {
    if ($("#reader-modal").hidden || !rs.rendition) return;
    rtRenderPanel();
    togglePanel("#reader-timer-panel", "#reader-timer-btn");
    if (RT.running) $("#reader-timer-btn").classList.add("rt-running");
  }

  // ---------- wiring ----------
  $("#reader-timer-btn").addEventListener("click", rtTogglePanel);
  document.querySelectorAll("#rt-mode-group button").forEach((b) => b.addEventListener("click", () => { rtSaveCfg({ mode: b.dataset.rtmode }); rtRenderPanel(); }));
  document.querySelectorAll("#rt-pctkind-group button").forEach((b) => b.addEventListener("click", () => { rtSaveCfg({ pctKind: b.dataset.pctkind }); rtRenderPanel(); }));
  $("#rt-minus").addEventListener("click", () => { const c = rtCfg(); rtSetAmount(Number(c.amounts[c.mode]) - RT_MODES[c.mode].step); });
  $("#rt-plus").addEventListener("click", () => { const c = rtCfg(); rtSetAmount(Number(c.amounts[c.mode]) + RT_MODES[c.mode].step); });
  $("#rt-amount").addEventListener("change", (e) => rtSetAmount(e.target.value));
  $("#rt-amount").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") rtSetAmount(e.target.value); });
  $("#rt-bar-toggle").addEventListener("change", (e) => { rtSaveCfg({ bar: e.target.checked }); rtRenderBar(rtFraction()); });
  $("#rt-sound-toggle").addEventListener("change", (e) => rtSaveCfg({ sound: e.target.checked }));
  $("#rt-autopause-toggle").addEventListener("change", (e) => rtSaveCfg({ autoPause: e.target.checked }));
  $("#rt-start").addEventListener("click", () => {
    const c = rtCfg(), cur = rtCurrentPct();
    if (c.mode === "percent" && c.pctKind === "reach" && cur != null && c.amounts.percent / 100 <= cur) { rtRenderPanel(); return; }
    // unlock audio on this click so the end chime can play later
    if (c.sound) { try { const AC = window.AudioContext || window.webkitAudioContext; if (AC && !RT.audio) RT.audio = new AC(); } catch {} }
    rtStart();
  });
  $("#rt-pause").addEventListener("click", () => { if (RT.paused) rtResume(); else rtPause(false); });
  $("#rt-stop").addEventListener("click", () => { rtStop(); closeAllPanels(); showHint("Séance arrêtée."); });
  $("#rt-end-finish").addEventListener("click", () => { rtStop(); });
  $("#rt-end-more").addEventListener("click", rtExtend);
  $("#rt-end-close").addEventListener("click", () => { rtStop(); closeReader(); });
  document.addEventListener("visibilitychange", () => {
    if (!RT.running || RT.ended || RT.mode !== "time" || !rtCfg().autoPause) return;
    if (document.hidden) rtPause(true);
    else if (RT.autoPaused) { rtResume(); showHint("Séance reprise."); }
  });

  refreshSettingsUI();
})();