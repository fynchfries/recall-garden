const state = {
  view: "home",
  decks: [],
  summary: { total_cards: 0, due_cards: 0, reviewed_today: 0 },
  activeDeckId: null,
  cards: [],
  reviewCard: null,
  revealed: false,
  reviewedThisSession: 0,
  sessionStartDue: 0,
  search: "",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const content = $("#main-content");
let toastTimer;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

async function api(path, options = {}) {
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(window.location.hostname)) {
    return window.RecallGardenLocalStore.request(path, options);
  }
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.error || "Something went wrong.");
  return data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2800);
}

function setBreadcrumb(text) { $("#breadcrumb").innerHTML = `Your learning space <span>/</span> ${escapeHtml(text)}`; }
function deckName(id) { return state.decks.find(deck => deck.id === Number(id))?.name || "All decks"; }

async function refreshData() {
  [state.decks, state.summary] = await Promise.all([api("/api/decks"), api("/api/summary")]);
  renderSidebar();
}

function renderSidebar() {
  $$(".nav-link[data-view]").forEach(item => item.classList.toggle("active",
    (state.view === "home" && item.dataset.view === "home") ||
    (state.view === "cards" && item.dataset.view === "cards")));
  const list = $("#deck-list");
  if (!state.decks.length) {
    list.innerHTML = '<div style="padding:8px 10px;color:#9aa39a;font-size:11px">No decks yet</div>';
    return;
  }
  list.innerHTML = state.decks.map(deck => `
    <button class="deck-link ${state.view === "cards" && state.activeDeckId === deck.id ? "active" : ""}" data-deck="${deck.id}">
      <span class="deck-dot"></span><span class="deck-name">${escapeHtml(deck.name)}</span><span class="deck-count">${deck.card_count}</span>
    </button>`).join("");
}

function renderHome() {
  state.view = "home";
  state.activeDeckId = null;
  renderSidebar();
  setBreadcrumb("Overview");
  const date = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  $("#date-label").textContent = date;
  if (!state.decks.length) {
    content.innerHTML = `
      <div class="eyebrow">A calmer way to learn</div>
      <div class="hero-row"><div><h1>Make room for<br>what matters.</h1><p class="subtitle">Turn the things you're learning into knowledge that sticks.</p></div></div>
      <div class="empty-panel"><div class="empty-illustration">✳</div><h2>Start your first learning garden</h2><p>Create a deck, add a few flashcards, and Recall Garden will help you review them at just the right time.</p><button class="button" data-action="new-deck">＋ Create your first deck</button></div>
      <p class="footer-note">Your study notes stay private on this device. No account or internet connection required.</p>`;
    return;
  }
  const due = state.summary.due_cards;
  const deckTiles = state.decks.map((deck, index) => `
    <button class="deck-card" data-deck="${deck.id}" aria-label="Open ${escapeHtml(deck.name)} deck">
      <div class="deck-card-top"><span class="deck-art">${["✳", "❋", "✿"][index % 3]}</span><span class="due-tag ${deck.due_count ? "" : "none"}">${deck.due_count ? `${deck.due_count} to review` : "All caught up"}</span></div>
      <h3>${escapeHtml(deck.name)}</h3><p>${deck.card_count} ${deck.card_count === 1 ? "flashcard" : "flashcards"}</p>
    </button>`).join("");
  content.innerHTML = `
    <div class="eyebrow">${escapeHtml(date)}</div>
    <div class="hero-row"><div><h1>Good things grow<br>with a little practice.</h1><p class="subtitle">Keep showing up. Your memory will do the rest.</p></div><button class="button" data-action="add-card">＋ New flashcard</button></div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon">◷</div><div><div class="stat-value">${due}</div><div class="stat-label">Ready to review</div></div></div>
      <div class="stat-card"><div class="stat-icon">▤</div><div><div class="stat-value">${state.summary.total_cards}</div><div class="stat-label">Flashcards planted</div></div></div>
      <div class="stat-card"><div class="stat-icon">✦</div><div><div class="stat-value">${state.summary.reviewed_today}</div><div class="stat-label">Reviewed today</div></div></div>
    </div>
    <div class="study-banner"><div class="banner-copy"><h2>${due ? `${due} ${due === 1 ? "little reminder" : "little reminders"} are waiting.` : "Your garden is flourishing."}</h2><p>${due ? "A few minutes now can make a big difference later." : "Nothing is due right now. Come back when you're ready."}</p></div><button class="button banner-action" data-action="study" ${due ? "" : "disabled"}>${due ? "Start a study session  →" : "All caught up  ✓"}</button></div>
    <div class="section-heading"><h2>Your decks</h2><button class="text-button" data-action="new-deck">＋ Create a deck</button></div>
    <div class="deck-grid">${deckTiles}</div>
    <p class="footer-note">Recall Garden uses a gentle spaced-repetition schedule. Your study data stays in this device's local storage.</p>`;
}

async function renderCards(deckId = null) {
  state.view = "cards";
  state.activeDeckId = deckId ? Number(deckId) : null;
  renderSidebar();
  setBreadcrumb(state.activeDeckId ? deckName(state.activeDeckId) : "All flashcards");
  state.cards = await api(state.activeDeckId ? `/api/cards?deck_id=${state.activeDeckId}` : "/api/cards");
  const activeDeck = state.decks.find(deck => deck.id === state.activeDeckId);
  const filtered = state.cards.filter(card => `${card.question} ${card.answer} ${card.deck_name}`.toLowerCase().includes(state.search.toLowerCase()));
  content.innerHTML = `
    <div class="eyebrow">Your study materials</div>
    <div class="hero-row"><div><h1>${escapeHtml(activeDeck ? activeDeck.name : "All flashcards")}</h1><p class="subtitle">${activeDeck ? `${activeDeck.card_count} cards · ${activeDeck.due_count} ready to review` : `${state.summary.total_cards} cards across ${state.decks.length} ${state.decks.length === 1 ? "deck" : "decks"}`}</p></div><button class="button" data-action="add-card">＋ New flashcard</button></div>
    <div class="cards-toolbar"><input class="search-input" id="card-search" type="search" placeholder="Search your flashcards…" value="${escapeHtml(state.search)}" aria-label="Search flashcards">${!activeDeck ? `<select id="deck-filter" class="select-input" aria-label="Filter by deck"><option value="">All decks</option>${state.decks.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")}</select>` : `<button class="button ghost small" data-action="study-deck">◷ Review this deck</button>`}${activeDeck ? `<button class="button ghost small" data-action="delete-deck">Delete deck</button>` : ""}</div>
    <div id="card-list" class="card-list">${state.cards.length ? renderCardRows(filtered) : ""}</div>
    ${!state.cards.length ? `<div class="empty-panel"><div class="empty-illustration">▤</div><h2>This deck is waiting to grow</h2><p>Add your first question and answer to start learning.</p><button class="button" data-action="add-card">＋ Add a flashcard</button></div>` : ""}`;
  const search = $("#card-search");
  search.addEventListener("input", () => {
    state.search = search.value;
    const selectedDeck = $("#deck-filter")?.value;
    let list = state.cards.filter(card => `${card.question} ${card.answer} ${card.deck_name}`.toLowerCase().includes(state.search.toLowerCase()));
    if (selectedDeck) list = list.filter(card => card.deck_id === Number(selectedDeck));
    $("#card-list").innerHTML = renderCardRows(list);
  });
  $("#deck-filter")?.addEventListener("change", event => {
    const selected = event.target.value;
    const list = state.cards.filter(card => `${card.question} ${card.answer} ${card.deck_name}`.toLowerCase().includes(state.search.toLowerCase()) && (!selected || card.deck_id === Number(selected)));
    $("#card-list").innerHTML = renderCardRows(list);
  });
}

function renderCardRows(cards) {
  if (!cards.length) return '<div class="empty-panel"><div class="empty-illustration">⌕</div><h2>No matching flashcards</h2><p>Try another search, or create a new card.</p></div>';
  return cards.map(card => `
    <article class="flashcard-row"><div class="flashcard-text"><div class="flashcard-question">${escapeHtml(card.question)}</div><div class="flashcard-answer">${escapeHtml(card.answer)}</div><div class="flashcard-meta">${escapeHtml(card.deck_name)} · ${card.repetitions ? `Reviewed ${card.repetitions} ${card.repetitions === 1 ? "time" : "times"}` : "Not reviewed yet"}</div></div>
      <div class="row-actions"><button class="icon-action" data-edit-card="${card.id}" aria-label="Edit flashcard" title="Edit">✎</button><button class="icon-action" data-delete-card="${card.id}" aria-label="Delete flashcard" title="Delete">×</button></div></article>`).join("");
}

function renderCardForm(card = null, chosenDeck = null) {
  state.view = card ? "edit-card" : "new-card";
  renderSidebar();
  setBreadcrumb(card ? "Edit flashcard" : "New flashcard");
  if (!state.decks.length) {
    content.innerHTML = `<div class="eyebrow">A new idea</div><h1>One small step.</h1><div class="empty-panel"><h2>Create a deck first</h2><p>Flashcards belong to a deck. Start with a subject or topic you want to remember.</p><button class="button" data-action="new-deck">＋ Create a deck</button></div>`;
    return;
  }
  const fallback = state.decks[0].id;
  const selected = Number(chosenDeck || card?.deck_id || state.activeDeckId || fallback);
  content.innerHTML = `
    <div class="eyebrow">${card ? "Tend to a card" : "Plant a new idea"}</div>
    <h1>${card ? "Edit your flashcard." : "What do you want to remember?"}</h1>
    <p class="subtitle">Keep it simple: one clear prompt, one helpful answer.</p>
    <form class="form-panel" id="card-form">
      <div class="form-field"><label for="card-deck">Deck</label><select class="field-input" id="card-deck" required>${state.decks.map(d => `<option value="${d.id}" ${d.id === selected ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("")}</select></div>
      <div class="form-field"><label for="card-question">Question or prompt</label><textarea class="field-textarea" id="card-question" maxlength="1000" rows="3" placeholder="For example: What is the capital of Japan?" required>${escapeHtml(card?.question || "")}</textarea></div>
      <div class="form-field"><label for="card-answer">Answer</label><textarea class="field-textarea" id="card-answer" maxlength="5000" rows="4" placeholder="Write the answer in your own words…" required>${escapeHtml(card?.answer || "")}</textarea></div>
      <p class="inline-message" id="form-error"></p>
      <div class="form-actions"><button type="button" class="button ghost" data-action="cancel-form">Cancel</button><div class="form-actions-right"><button type="submit" class="button">${card ? "Save changes" : "Add flashcard"}</button></div></div>
    </form>`;
  $("#card-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("#card-form button[type=submit]");
    button.disabled = true;
    try {
      const data = { deck_id: Number($("#card-deck").value), question: $("#card-question").value, answer: $("#card-answer").value };
      if (card) await api(`/api/cards/${card.id}`, { method: "PATCH", body: JSON.stringify(data) });
      else await api("/api/cards", { method: "POST", body: JSON.stringify(data) });
      await refreshData();
      toast(card ? "Flashcard updated." : "A new flashcard is planted.");
      renderCards(state.activeDeckId || data.deck_id);
    } catch (error) {
      $("#form-error").textContent = error.message;
      button.disabled = false;
    }
  });
}

async function startReview(deckId = null) {
  state.view = "review";
  state.activeDeckId = deckId ? Number(deckId) : null;
  state.reviewedThisSession = 0;
  state.sessionStartDue = deckId ? (state.decks.find(d => d.id === Number(deckId))?.due_count || 0) : state.summary.due_cards;
  state.revealed = false;
  setBreadcrumb("Study session");
  renderSidebar();
  await loadNextReview();
}

async function loadNextReview() {
  try {
    state.reviewCard = await api(`/api/review/next${state.activeDeckId ? `?deck_id=${state.activeDeckId}` : ""}`);
    state.revealed = false;
    renderReview();
  } catch (error) { toast(error.message); renderHome(); }
}

function renderReview() {
  setBreadcrumb("Study session");
  if (!state.reviewCard) {
    content.innerHTML = `
      <div class="review-wrap"><div class="eyebrow">Beautiful work</div><h1>That's today's growth.</h1><p class="subtitle">${state.reviewedThisSession ? `You reviewed ${state.reviewedThisSession} ${state.reviewedThisSession === 1 ? "card" : "cards"}. Every little practice counts.` : "There are no cards due in this deck right now. Come back when the next ones are ready."}</p>
      <div class="empty-panel" style="margin-top:25px"><div class="empty-illustration">✿</div><h2>${state.reviewedThisSession ? "Your memory just got stronger" : "All caught up"}</h2><p>New cards will appear here when it's time to review them. You're doing great.</p><button class="button" data-action="finish-review">Back to overview</button></div></div>`;
    return;
  }
  const card = state.reviewCard;
  const progress = state.sessionStartDue ? Math.min(100, Math.round(state.reviewedThisSession / state.sessionStartDue * 100)) : 0;
  content.innerHTML = `
    <div class="review-wrap"><div class="review-header"><div><div class="eyebrow">A moment to remember</div><h1 style="font-size:31px;margin-bottom:0">Study session</h1></div><span class="progress-copy">${state.reviewedThisSession} reviewed</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
      <div class="review-card" id="review-card" role="button" tabindex="0" aria-label="Flashcard. Click to reveal the answer.">
        <div class="card-side-label">${state.revealed ? "The answer" : "Your prompt"}</div>
        <div class="${state.revealed ? "review-answer" : "review-question"}">${escapeHtml(state.revealed ? card.answer : card.question)}</div>
        ${state.revealed ? "" : '<p class="flip-hint">Click or press Space to reveal</p>'}
      </div>
      ${state.revealed ? `<div class="rating-row"><button class="rating-button again" data-rating="again">Again <small>· 10 min</small></button><button class="rating-button" data-rating="hard">Hard <small>· soon</small></button><button class="rating-button" data-rating="good">Good <small>· 1+ day</small></button><button class="rating-button easy" data-rating="easy">Easy <small>· longer</small></button></div>` : `<div style="text-align:center;margin-top:16px"><button class="button secondary" data-action="reveal">Show the answer&nbsp; ↓</button></div>`}
      <div class="review-deck-name">${escapeHtml(card.deck_name)}</div>
    </div>`;
}

async function recordReview(rating) {
  const buttons = $$("[data-rating]");
  buttons.forEach(button => button.disabled = true);
  try {
    await api("/api/review", { method: "POST", body: JSON.stringify({ card_id: state.reviewCard.id, rating }) });
    state.reviewedThisSession++;
    await refreshData();
    await loadNextReview();
  } catch (error) {
    buttons.forEach(button => button.disabled = false);
    toast(error.message);
  }
}

function renderDeckModal() {
  $("#modal-root").innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><form class="modal" id="deck-form"><h2>Plant a new deck</h2><p>Choose a name that makes it easy to find what you're learning.</p><div class="form-field"><label for="deck-name">Deck name</label><input class="field-input" id="deck-name" maxlength="60" placeholder="e.g. Biology, Spanish, CS50" required autofocus></div><p class="inline-message" id="deck-error"></p><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button" type="submit">Create deck</button></div></form></div>`;
  $("#deck-name").focus();
  $("#deck-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("#deck-form button[type=submit]");
    button.disabled = true;
    try {
      const deck = await api("/api/decks", { method: "POST", body: JSON.stringify({ name: $("#deck-name").value }) });
      $("#modal-root").innerHTML = "";
      await refreshData();
      toast("Your new deck is ready.");
      renderCardForm(null, deck.id);
    } catch (error) {
      $("#deck-error").textContent = error.message;
      button.disabled = false;
    }
  });
}

function renderBackupModal() {
  $("#modal-root").innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><div class="modal"><h2>Your data, your choice.</h2><p>Download a JSON backup of all your decks and flashcards, or restore a backup on this device. Your study data stays in this browser and isn't synced between devices.</p><div class="modal-actions" style="justify-content:space-between"><button type="button" class="button ghost" data-action="close-modal">Close</button><div class="form-actions-right"><button class="button secondary" data-action="import">Import backup</button><button class="button" data-action="download">Download backup</button></div></div></div></div>`;
}

async function downloadBackup() {
  try {
    const data = await api("/api/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `recall-garden-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast("Backup downloaded.");
  } catch (error) { toast(error.message); }
}

async function importBackup(file) {
  try {
    const payload = JSON.parse(await file.text());
    const result = await api("/api/import", { method: "POST", body: JSON.stringify(payload) });
    await refreshData();
    $("#modal-root").innerHTML = "";
    toast(`${result.added} ${result.added === 1 ? "flashcard" : "flashcards"} imported.`);
    renderHome();
  } catch (error) { toast(`Couldn't import backup: ${error.message}`); }
}

async function deleteCurrentDeck() {
  const deck = state.decks.find(d => d.id === state.activeDeckId);
  if (!deck || !confirm(`Delete “${deck.name}” and all ${deck.card_count} of its flashcards? This can't be undone.`)) return;
  try {
    await api(`/api/decks/${deck.id}`, { method: "DELETE" });
    state.search = "";
    await refreshData();
    toast("Deck deleted.");
    renderHome();
  } catch (error) { toast(error.message); }
}

content.addEventListener("click", async event => {
  const actionEl = event.target.closest("[data-action]");
  const deckEl = event.target.closest("[data-deck]");
  const editEl = event.target.closest("[data-edit-card]");
  const deleteEl = event.target.closest("[data-delete-card]");
  const ratingEl = event.target.closest("[data-rating]");
  if (deckEl) { state.search = ""; renderCards(Number(deckEl.dataset.deck)); return; }
  if (editEl) {
    const card = state.cards.find(item => item.id === Number(editEl.dataset.editCard));
    if (card) renderCardForm(card, card.deck_id);
    return;
  }
  if (deleteEl) {
    const id = Number(deleteEl.dataset.deleteCard);
    if (!confirm("Delete this flashcard? This can't be undone.")) return;
    try { await api(`/api/cards/${id}`, { method: "DELETE" }); await refreshData(); toast("Flashcard deleted."); await renderCards(state.activeDeckId); }
    catch (error) { toast(error.message); }
    return;
  }
  if (ratingEl) { await recordReview(ratingEl.dataset.rating); return; }
  if (!actionEl) return;
  switch (actionEl.dataset.action) {
    case "new-deck": renderDeckModal(); break;
    case "add-card": state.search = ""; renderCardForm(); break;
    case "study": await startReview(); break;
    case "study-deck": await startReview(state.activeDeckId); break;
    case "reveal": state.revealed = true; renderReview(); break;
    case "finish-review": await refreshData(); renderHome(); break;
    case "cancel-form": state.search = ""; await refreshData(); renderCards(state.activeDeckId); break;
    case "delete-deck": await deleteCurrentDeck(); break;
  }
});

$("#deck-list").addEventListener("click", event => {
  const deck = event.target.closest("[data-deck]");
  if (deck) { state.search = ""; renderCards(Number(deck.dataset.deck)); }
});

document.addEventListener("click", async event => {
  const nav = event.target.closest("[data-view]");
  const action = event.target.closest("[data-action]");
  if (nav) {
    $$(".nav-link[data-view]").forEach(item => item.classList.toggle("active", item === nav));
    if (nav.dataset.view === "home") renderHome();
    else { state.search = ""; renderCards(); }
    return;
  }
  if (!action) return;
  switch (action.dataset.action) {
    case "new-deck": renderDeckModal(); break;
    case "close-modal": $("#modal-root").innerHTML = ""; break;
    case "download": await downloadBackup(); break;
    case "import": $("#import-file").click(); break;
  }
});

$("#add-deck").addEventListener("click", renderDeckModal);
$("#export-data").addEventListener("click", renderBackupModal);
$("#import-file").addEventListener("change", event => {
  const file = event.target.files[0];
  if (file) importBackup(file);
  event.target.value = "";
});

$("#main-content").addEventListener("keydown", event => {
  if (state.view !== "review" || !state.reviewCard) return;
  if ((event.code === "Space" || event.code === "Enter") && !state.revealed && event.target.id !== "review-card") {
    event.preventDefault(); state.revealed = true; renderReview();
  } else if ((event.code === "Space" || event.code === "Enter") && event.target.id === "review-card") {
    event.preventDefault(); state.revealed = true; renderReview();
  }
});

$("#main-content").addEventListener("click", event => {
  if (event.target.closest("#review-card") && !state.revealed) { state.revealed = true; renderReview(); }
});

async function init() {
  $("#date-label").textContent = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date());
  try { await refreshData(); renderHome(); }
  catch (error) {
    content.innerHTML = `<div class="empty-panel"><div class="empty-illustration">!</div><h2>Couldn't open your garden</h2><p>${escapeHtml(error.message)} Try refreshing the page. If this continues, restore a JSON backup or check your browser storage settings.</p></div>`;
  }
}
init();
