/* Browser-local data store used by static deployments (for example, Vercel). */
(() => {
  const STORAGE_KEY = "recall-garden-v1";

  const emptyData = () => ({ decks: [], cards: [], reviews: [] });
  const nowIso = () => new Date().toISOString();

  function readData() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyData();
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.decks) || !Array.isArray(data.cards) || !Array.isArray(data.reviews)) {
        throw new Error();
      }
      return data;
    } catch {
      throw new Error("Saved browser data could not be read. Try restoring a JSON backup.");
    }
  }

  function saveData(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      throw new Error("Couldn't save your data in this browser. Check available storage space.");
    }
  }

  function mutate(change, startingData = readData()) {
    const data = JSON.parse(JSON.stringify(startingData));
    const result = change(data);
    saveData(data);
    return result;
  }

  function cleanText(value, label, limit) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} can't be empty.`);
    const text = value.trim();
    if (text.length > limit) throw new Error(`${label} must be ${limit} characters or fewer.`);
    return text;
  }

  function positiveId(raw) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error("ID must be a positive integer.");
    return value;
  }

  function nextId(items) {
    return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  }

  function parseDate(value) {
    let input = value;
    if (typeof input === "string" && /^\d{4}-\d\d-\d\dT/.test(input) && !/(?:Z|[+-]\d\d:\d\d)$/i.test(input)) {
      input += "Z";
    }
    const date = new Date(input);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid date.");
    return date;
  }

  function withDeckName(data, card) {
    const deck = data.decks.find(item => item.id === card.deck_id);
    return { ...card, deck_name: deck?.name || "" };
  }

  function decks(data) {
    const now = Date.now();
    return data.decks.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map(deck => {
      const cards = data.cards.filter(card => card.deck_id === deck.id);
      return {
        ...deck,
        card_count: cards.length,
        due_count: cards.filter(card => new Date(card.due_at).getTime() <= now).length,
      };
    });
  }

  function summary(data) {
    const now = Date.now();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return {
      total_cards: data.cards.length,
      due_cards: data.cards.filter(card => new Date(card.due_at).getTime() <= now).length,
      reviewed_today: data.reviews.filter(review => new Date(review.reviewed_at).getTime() >= today.getTime()).length,
    };
  }

  function importData(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.format !== "recall-garden-v1") {
      throw new Error("This file isn't a Recall Garden export.");
    }
    if (!Array.isArray(payload.decks) || payload.decks.length > 100) {
      throw new Error("The export must contain a list of at most 100 decks.");
    }

    let startingData;
    try { startingData = readData(); }
    catch { startingData = emptyData(); }
    return mutate(data => {
      let added = 0;
      for (const item of payload.decks) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid deck in import file.");
        const name = cleanText(item.name, "Deck name", 60);
        let deck = data.decks.find(existing => existing.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (!deck) {
          deck = { id: nextId(data.decks), name, created_at: nowIso() };
          data.decks.push(deck);
        }
        const cards = item.cards === undefined ? [] : item.cards;
        if (!Array.isArray(cards) || cards.length > 5000) throw new Error("Each deck can contain at most 5,000 cards.");
        for (const card of cards) {
          if (!card || typeof card !== "object" || Array.isArray(card)) throw new Error("Invalid card in import file.");
          const question = cleanText(card.question, "Question", 1000);
          const answer = cleanText(card.answer, "Answer", 5000);
          const interval = Number(card.interval_days ?? 0);
          const ease = Number(card.ease ?? 2.5);
          const repetitions = Number(card.repetitions ?? 0);
          const rawDue = card.due_at === undefined ? nowIso() : card.due_at;
          if (!Number.isFinite(interval) || interval < 0 || interval > 36500 ||
              !Number.isFinite(ease) || ease < 1.3 || ease > 100 ||
              !Number.isInteger(repetitions) || repetitions < 0 || repetitions > 1_000_000_000 ||
              typeof rawDue !== "string") {
            throw new Error("A flashcard in the backup has invalid scheduling data.");
          }
          let dueAt;
          try { dueAt = parseDate(rawDue).toISOString(); }
          catch { throw new Error("A flashcard in the backup has invalid scheduling data."); }
          data.cards.push({
            id: nextId(data.cards), deck_id: deck.id, question, answer,
            created_at: nowIso(), due_at: dueAt, interval_days: interval,
            ease, repetitions,
          });
          added++;
        }
      }
      return { added };
    }, startingData);
  }

  async function request(path, options = {}) {
    const url = new URL(path, window.location.href);
    const method = (options.method || "GET").toUpperCase();
    const pathname = url.pathname;
    let body = {};
    if (options.body) {
      try { body = typeof options.body === "string" ? JSON.parse(options.body) : options.body; }
      catch { throw new Error("Request body must be valid JSON."); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be a JSON object.");
    }
    if (method === "POST" && pathname === "/api/import") return importData(body);
    const data = readData();

    if (method === "GET" && pathname === "/api/decks") return decks(data);
    if (method === "POST" && pathname === "/api/decks") {
      const name = cleanText(body.name, "Deck name", 60);
      return mutate(current => {
        if (current.decks.some(deck => deck.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
          throw new Error("A deck with that name already exists.");
        }
        const deck = { id: nextId(current.decks), name, created_at: nowIso() };
        current.decks.push(deck);
        return { ...deck, card_count: 0, due_count: 0 };
      });
    }
    if (method === "GET" && pathname === "/api/cards") {
      const rawDeckId = url.searchParams.get("deck_id");
      const deckId = rawDeckId ? positiveId(rawDeckId) : null;
      return data.cards.filter(card => deckId === null || card.deck_id === deckId)
        .slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)
        .map(card => withDeckName(data, card));
    }
    if (method === "POST" && pathname === "/api/cards") {
      const deckId = positiveId(body.deck_id);
      const question = cleanText(body.question, "Question", 1000);
      const answer = cleanText(body.answer, "Answer", 5000);
      return mutate(current => {
        if (!current.decks.some(deck => deck.id === deckId)) throw new Error("Deck not found.");
        const now = nowIso();
        const card = {
          id: nextId(current.cards), deck_id: deckId, question, answer,
          created_at: now, due_at: now, interval_days: 0, ease: 2.5, repetitions: 0,
        };
        current.cards.push(card);
        return card;
      });
    }
    if (method === "GET" && pathname === "/api/summary") return summary(data);
    if (method === "GET" && pathname === "/api/review/next") {
      const rawDeckId = url.searchParams.get("deck_id");
      const deckId = rawDeckId ? positiveId(rawDeckId) : null;
      const now = Date.now();
      const card = data.cards.filter(item => new Date(item.due_at).getTime() <= now && (deckId === null || item.deck_id === deckId))
        .sort((a, b) => new Date(a.due_at) - new Date(b.due_at) || a.id - b.id)[0];
      return card ? withDeckName(data, card) : null;
    }
    if (method === "POST" && pathname === "/api/review") {
      const cardId = positiveId(body.card_id);
      const rating = body.rating;
      if (!["again", "hard", "good", "easy"].includes(rating)) throw new Error("Choose Again, Hard, Good, or Easy.");
      return mutate(current => {
        const card = current.cards.find(item => item.id === cardId);
        if (!card) throw new Error("Card not found.");
        let { ease, repetitions, interval_days: interval } = card;
        const now = new Date();
        if (rating === "again") {
          ease = Math.max(1.3, ease - 0.2);
          interval = 10 / (24 * 60);
          repetitions = 0;
          now.setMinutes(now.getMinutes() + 10);
        } else {
          if (rating === "hard") {
            ease = Math.max(1.3, ease - 0.15);
            interval = repetitions === 0 ? 1 : Math.max(1, interval * 1.2);
          } else if (rating === "good") {
            interval = repetitions === 0 ? 1 : repetitions === 1 ? 3 : interval * ease;
          } else {
            ease += 0.15;
            interval = repetitions === 0 ? 4 : Math.max(4, interval * ease * 1.3);
          }
          repetitions++;
          interval = Math.round(interval * 100) / 100;
          now.setTime(now.getTime() + interval * 24 * 60 * 60 * 1000);
        }
        card.ease = ease;
        card.interval_days = interval;
        card.repetitions = repetitions;
        card.due_at = now.toISOString();
        current.reviews.push({
          id: nextId(current.reviews), card_id: cardId, rating,
          reviewed_at: nowIso(), interval_days: interval,
        });
        return { card_id: cardId, rating, due_at: card.due_at, interval_days: interval, repetitions };
      });
    }
    if (method === "GET" && pathname === "/api/export") {
      return {
        format: "recall-garden-v1",
        decks: data.decks.slice().sort((a, b) => a.id - b.id).map(deck => ({
          name: deck.name,
          cards: data.cards.filter(card => card.deck_id === deck.id).sort((a, b) => a.id - b.id)
            .map(({ question, answer, interval_days, ease, repetitions, due_at }) => ({ question, answer, interval_days, ease, repetitions, due_at })),
        })),
      };
    }
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 3 && parts[0] === "api" && parts[1] === "decks" && method === "DELETE") {
      const id = positiveId(parts[2]);
      return mutate(current => {
        if (!current.decks.some(deck => deck.id === id)) throw new Error("Deck not found.");
        current.decks = current.decks.filter(deck => deck.id !== id);
        const removedIds = new Set(current.cards.filter(card => card.deck_id === id).map(card => card.id));
        current.cards = current.cards.filter(card => card.deck_id !== id);
        current.reviews = current.reviews.filter(review => !removedIds.has(review.card_id));
        return { ok: true };
      });
    }
    if (parts.length === 3 && parts[0] === "api" && parts[1] === "cards") {
      const id = positiveId(parts[2]);
      if (method === "PATCH") {
        const question = cleanText(body.question, "Question", 1000);
        const answer = cleanText(body.answer, "Answer", 5000);
        return mutate(current => {
          const card = current.cards.find(item => item.id === id);
          if (!card) throw new Error("Card not found.");
          card.question = question;
          card.answer = answer;
          return card;
        });
      }
      if (method === "DELETE") {
        return mutate(current => {
          if (!current.cards.some(card => card.id === id)) throw new Error("Card not found.");
          current.cards = current.cards.filter(card => card.id !== id);
          current.reviews = current.reviews.filter(review => review.card_id !== id);
          return { ok: true };
        });
      }
    }
    throw new Error("Not found.");
  }

  window.RecallGardenLocalStore = { request };
})();
