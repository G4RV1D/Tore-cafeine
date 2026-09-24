(function () {
  "use strict";

  const API = window.ELVEN_API_BASE;
  const LS_CODE = "elven_access_code";
  const LS_ROLE = "elven_role";
  const LS_NAME = "elven_name";

  let state = {
    code: localStorage.getItem(LS_CODE) || "",
    role: localStorage.getItem(LS_ROLE) || "",
    name: localStorage.getItem(LS_NAME) || "",
    books: [],
    genres: [],
    activeGenre: "",
    search: "",
  };

  // ---------- tiny helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }

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
      enterLibrary();
    } catch (err) {
      status.textContent = "Code invalide.";
    }
  });

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

  // ---------- switching screens ----------
  async function enterLibrary() {
    hide($("#decoy"));
    show($("#app"));
    $("#e-welcome").textContent = state.name ? `Bienvenue, ${state.name}` : "";
    $("#e-add-book-btn").hidden = state.role !== "admin";
    $("#e-book-requests-btn").hidden = state.role !== "admin";
    // Only the oath is visible at first — header and library reveal after it's sworn.
    hide($("#e-header"));
    show($("#e-oath"));
    hide($("#e-library-content"));
  }

  $("#e-oath-btn").addEventListener("click", async () => {
    const oath = $("#e-oath");
    oath.classList.add("leaving");
    setTimeout(() => {
      hide(oath);
      oath.classList.remove("leaving");
      show($("#e-header"));
      show($("#e-library-content"));
    }, 500);
    await loadBooks();
    await loadRecent();
  });

  function leaveLibrary() {
    clearSession();
    hide($("#app"));
    show($("#decoy"));
  }
  $("#e-logout").addEventListener("click", leaveLibrary);

  // ---------- library data ----------
  async function loadBooks() {
    const params = new URLSearchParams({ code: state.code });
    if (state.activeGenre) params.set("genre", state.activeGenre);
    try {
      const data = await api("/api/books?" + params.toString(), {
        headers: { "x-access-code": state.code },
      });
      state.books = data.books || [];
      state.genres = data.genres || [];
      renderGenres();
      renderGrid();
      fillGenreSuggestions();
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
      renderRecent((data.books || []).slice(0, 10));
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
    items.forEach((book) => {
      const card = document.createElement("button");
      card.className = "e-recent-card";
      card.type = "button";
      card.innerHTML = `
        <div class="e-recent-cover">${book.cover_url ? `<img loading="lazy" src="${API}${book.cover_url}" alt="Couverture de ${escapeHtml(book.title)}" />` : ""}</div>
        <div class="e-recent-card-title">${escapeHtml(book.title)}</div>
      `;
      card.addEventListener("click", () => openBook(book.id));
      row.appendChild(card);
    });
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
  }
  $("#reader-close").addEventListener("click", closeReader);

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
