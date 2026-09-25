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
  // per-book localStorage progress (cdi_reader_book_<id>), scoped to this
  // browser/visitor exactly like the neon theme preference ----------
  const READER_KEY_PREFIX = "cdi_reader_book_";

  function getResumeList() {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(READER_KEY_PREFIX)) continue;
      let st;
      try { st = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      if (!st || !st.lastCfi) continue;
      const id = key.slice(READER_KEY_PREFIX.length);
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
    try { localStorage.removeItem(READER_KEY_PREFIX + id); } catch {}
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
  // the only book with that series_name in the current list) are left exactly
  // where the server put them (created_at DESC). A series block is anchored
  // at the position of its most-recently-added tome, since `books` arrives
  // newest-first: that's the smallest index among that series' books.
  function sortBooksGrouped(books) {
    const seriesKey = (b) => (b.series_name || "").trim().toLowerCase();
    const countBySeries = {};
    books.forEach((b) => {
      const key = seriesKey(b);
      if (key) countBySeries[key] = (countBySeries[key] || 0) + 1;
    });
    const anchorIndex = {};
    books.forEach((b, i) => {
      const key = seriesKey(b);
      if (key && countBySeries[key] > 1 && !(key in anchorIndex)) anchorIndex[key] = i;
    });
    const withSortKeys = books.map((b, i) => {
      const key = seriesKey(b);
      const grouped = key && countBySeries[key] > 1;
      const order = Number(b.series_order);
      return {
        book: b,
        primary: grouped ? anchorIndex[key] : i,
        secondary: grouped ? (Number.isFinite(order) ? order : 9999) : 0,
      };
    });
    withSortKeys.sort((a, b) => (a.primary - b.primary) || (a.secondary - b.secondary));
    return withSortKeys.map((x) => x.book);
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
      state.books = sortBooksGrouped(data.books || []);
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
      card.innerHTML = `
        <div class="e-card-cover">${book.cover_url ? `<img loading="lazy" src="${API}${book.cover_url}" alt="Couverture de ${escapeHtml(book.title)}" />` : ""}</div>
        <div class="e-card-title">${escapeHtml(book.title)}</div>
        <div class="e-card-author">${escapeHtml(book.author || "")}</div>
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
  const readerBookKey = (id) => "cdi_reader_book_" + id;

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

    const epubOk = isEpub(bookRecord);
    setChromeEnabled(epubOk);

    if (!epubOk) {
      $("#reader-loading").hidden = true;
      $("#reader-unsupported").hidden = false;
      return;
    }

    try {
      const res = await fetch(window.ELVEN_API_BASE + bookRecord.download_url);
      if (!res.ok) throw new Error("Téléchargement impossible (erreur " + res.status + ")");
      const buf = await res.arrayBuffer();

      if (rs.rendition) { try { rs.rendition.destroy(); } catch {} }
      if (rs.book) { try { rs.book.destroy(); } catch {} }
      rs.lastLocation = null;

      rs.bookId = bookRecord.id;
      rs.bookState = loadBookState(bookRecord.id);
      rs.book = ePub(buf);
      rs.rendition = rs.book.renderTo("reader-viewer", {
        width: "100%",
        height: "100%",
        flow: rs.settings.scrollMode === "scrolled" ? "scrolled-doc" : "paginated",
        spread: "none",
      });

      rs.rendition.on("relocated", onRelocated);
      rs.rendition.on("rendered", () => { $("#reader-loading").hidden = true; });

      applyAllStyles();
      await rs.rendition.display(rs.bookState.lastCfi || undefined);

      rs.book.loaded.navigation.then((nav) => renderToc(nav.toc || [])).catch(() => {});

      if (rs.bookState.locations) {
        try {
          rs.book.locations.load(rs.bookState.locations);
          updateProgressFromLocation(rs.lastLocation);
        } catch {}
      } else {
        rs.book.locations.generate(1000).then(() => {
          rs.bookState.locations = rs.book.locations.save();
          saveBookState(rs.bookId, rs.bookState);
          updateProgressFromLocation(rs.lastLocation);
        }).catch(() => {});
      }

      renderBookmarks();
      updateBookmarkStar();
    } catch (err) {
      $("#reader-loading").hidden = true;
      $("#reader-unsupported").hidden = false;
      $("#reader-unsupported").innerHTML =
        "<p>Impossible d'ouvrir ce livre pour l'instant.</p><p>" + escapeHtmlLocal((err && err.message) || "") + "</p>";
    }
  };

  function setChromeEnabled(enabled) {
    ["#reader-toc-btn", "#reader-bookmark-btn", "#reader-bookmarks-list-btn", "#reader-settings-btn", "#reader-prev", "#reader-next"].forEach((sel) => {
      $(sel).style.visibility = enabled ? "" : "hidden";
    });
    $(".reader-bottombar").style.visibility = enabled ? "" : "hidden";
  }

  function closeReader() {
    persistCurrentLocation();
    $("#reader-modal").hidden = true;
    closeAllPanels();
    if (rs.rendition) { try { rs.rendition.destroy(); } catch {} rs.rendition = null; }
    if (rs.book) { try { rs.book.destroy(); } catch {} rs.book = null; }
    rs.lastLocation = null;
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
  $("#reader-prev").addEventListener("click", () => rs.rendition && rs.rendition.prev());
  $("#reader-next").addEventListener("click", () => rs.rendition && rs.rendition.next());
  document.addEventListener("keydown", (e) => {
    if ($("#reader-modal").hidden) return;
    if (e.key === "ArrowLeft") rs.rendition && rs.rendition.prev();
    if (e.key === "ArrowRight") rs.rendition && rs.rendition.next();
    if (e.key === "Escape") closeReader();
  });

  function onRelocated(location) {
    rs.lastLocation = location;
    updateProgressFromLocation(location);
    persistCurrentLocation(location);
    updateBookmarkStar();
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
    ["#reader-settings-panel", "#reader-toc-panel", "#reader-bookmarks-panel"].forEach((sel) => { $(sel).hidden = true; });
    ["#reader-settings-btn", "#reader-toc-btn", "#reader-bookmarks-list-btn"].forEach((sel) => $(sel).classList.remove("active"));
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
    $("#reader-justify-toggle").checked = !!rs.settings.justify;
    $("#reader-warmth-range").value = rs.settings.warmth;
    $("#reader-brightness-range").value = rs.settings.brightness;
  }

  function applyAllStyles() {
    if (!rs.rendition) return;
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
    $("#reader-viewer").style.filter = "brightness(" + rs.settings.brightness + "%)";

    refreshSettingsUI();
  }

  function updateSetting(patch) {
    rs.settings = Object.assign({}, rs.settings, patch);
    saveSettings(rs.settings);
    applyAllStyles();
  }

  $("#reader-font-minus").addEventListener("click", () => updateSetting({ fontScale: Math.max(70, rs.settings.fontScale - 10) }));
  $("#reader-font-plus").addEventListener("click", () => updateSetting({ fontScale: Math.min(240, rs.settings.fontScale + 10) }));

  document.querySelectorAll("#reader-font-family-group button").forEach((b) => b.addEventListener("click", () => updateSetting({ fontFamily: b.dataset.font })));
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

  refreshSettingsUI();
})();
