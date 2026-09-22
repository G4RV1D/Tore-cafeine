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
