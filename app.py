#!/usr/bin/env python3
"""Recall Garden: a tiny, local-first spaced-repetition study app."""
from __future__ import annotations

import json
import math
import os
import sqlite3
import threading
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("RECALL_DB", BASE_DIR / "recall.db"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


class StudyStore:
    """SQLite persistence and scheduling rules, kept separate from HTTP/UI."""

    def __init__(self, path: str | Path = DB_PATH):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS decks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    due_at TEXT NOT NULL,
                    interval_days REAL NOT NULL DEFAULT 0,
                    ease REAL NOT NULL DEFAULT 2.5,
                    repetitions INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                    rating TEXT NOT NULL,
                    reviewed_at TEXT NOT NULL,
                    interval_days REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS cards_due_idx ON cards(due_at);
                CREATE INDEX IF NOT EXISTS cards_deck_idx ON cards(deck_id);
                CREATE INDEX IF NOT EXISTS reviews_date_idx ON reviews(reviewed_at);
            """)

    @staticmethod
    def _clean_text(value: object, label: str, limit: int) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} can't be empty.")
        value = value.strip()
        if len(value) > limit:
            raise ValueError(f"{label} must be {limit} characters or fewer.")
        return value

    def decks(self) -> list[dict]:
        now = iso(utc_now())
        with self._connect() as db:
            rows = db.execute("""
                SELECT d.id, d.name, d.created_at,
                       COUNT(c.id) AS card_count,
                       COALESCE(SUM(CASE WHEN c.due_at <= ? THEN 1 ELSE 0 END), 0) AS due_count
                FROM decks d LEFT JOIN cards c ON c.deck_id = d.id
                GROUP BY d.id ORDER BY d.name COLLATE NOCASE
            """, (now,)).fetchall()
            return [dict(row) for row in rows]

    def create_deck(self, name: object) -> dict:
        name = self._clean_text(name, "Deck name", 60)
        with self._connect() as db:
            try:
                cur = db.execute("INSERT INTO decks(name, created_at) VALUES (?, ?)",
                                 (name, iso(utc_now())))
            except sqlite3.IntegrityError as exc:
                raise ValueError("A deck with that name already exists.") from exc
            return {"id": cur.lastrowid, "name": name, "card_count": 0, "due_count": 0}

    def delete_deck(self, deck_id: int) -> None:
        with self._connect() as db:
            cur = db.execute("DELETE FROM decks WHERE id = ?", (deck_id,))
            if not cur.rowcount:
                raise LookupError("Deck not found.")

    def create_card(self, deck_id: int, question: object, answer: object) -> dict:
        question = self._clean_text(question, "Question", 1000)
        answer = self._clean_text(answer, "Answer", 5000)
        now = iso(utc_now())
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM decks WHERE id = ?", (deck_id,)).fetchone():
                raise LookupError("Deck not found.")
            cur = db.execute("""
                INSERT INTO cards(deck_id, question, answer, created_at, due_at)
                VALUES (?, ?, ?, ?, ?)
            """, (deck_id, question, answer, now, now))
            return {"id": cur.lastrowid, "deck_id": deck_id, "question": question,
                    "answer": answer, "due_at": now, "interval_days": 0,
                    "repetitions": 0}

    def update_card(self, card_id: int, question: object, answer: object) -> dict:
        question = self._clean_text(question, "Question", 1000)
        answer = self._clean_text(answer, "Answer", 5000)
        with self._connect() as db:
            cur = db.execute("UPDATE cards SET question = ?, answer = ? WHERE id = ?",
                             (question, answer, card_id))
            if not cur.rowcount:
                raise LookupError("Card not found.")
            row = db.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
            return dict(row)

    def delete_card(self, card_id: int) -> None:
        with self._connect() as db:
            cur = db.execute("DELETE FROM cards WHERE id = ?", (card_id,))
            if not cur.rowcount:
                raise LookupError("Card not found.")

    def cards(self, deck_id: int | None = None) -> list[dict]:
        with self._connect() as db:
            if deck_id is None:
                rows = db.execute("""
                    SELECT c.*, d.name AS deck_name FROM cards c
                    JOIN decks d ON d.id = c.deck_id ORDER BY c.created_at DESC
                """).fetchall()
            else:
                rows = db.execute("""
                    SELECT c.*, d.name AS deck_name FROM cards c
                    JOIN decks d ON d.id = c.deck_id WHERE c.deck_id = ?
                    ORDER BY c.created_at DESC
                """, (deck_id,)).fetchall()
            return [dict(row) for row in rows]

    def next_due(self, deck_id: int | None = None) -> dict | None:
        now = iso(utc_now())
        with self._connect() as db:
            if deck_id is None:
                row = db.execute("""
                    SELECT c.*, d.name AS deck_name FROM cards c
                    JOIN decks d ON d.id = c.deck_id WHERE c.due_at <= ?
                    ORDER BY c.due_at, c.id LIMIT 1
                """, (now,)).fetchone()
            else:
                row = db.execute("""
                    SELECT c.*, d.name AS deck_name FROM cards c
                    JOIN decks d ON d.id = c.deck_id
                    WHERE c.due_at <= ? AND c.deck_id = ?
                    ORDER BY c.due_at, c.id LIMIT 1
                """, (now, deck_id)).fetchone()
            return dict(row) if row else None

    def review(self, card_id: int, rating: object) -> dict:
        if rating not in {"again", "hard", "good", "easy"}:
            raise ValueError("Choose Again, Hard, Good, or Easy.")
        now = utc_now()
        with self._connect() as db:
            card = db.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
            if not card:
                raise LookupError("Card not found.")
            ease = float(card["ease"])
            repetitions = int(card["repetitions"])
            interval = float(card["interval_days"])
            if rating == "again":
                ease = max(1.3, ease - 0.2)
                interval = 10 / (24 * 60)  # Give it another try in ten minutes.
                repetitions = 0
                due = now + timedelta(minutes=10)
            else:
                if rating == "hard":
                    ease = max(1.3, ease - 0.15)
                    interval = 1 if repetitions == 0 else max(1, interval * 1.2)
                elif rating == "good":
                    interval = 1 if repetitions == 0 else (3 if repetitions == 1 else interval * ease)
                else:  # easy
                    ease += 0.15
                    interval = 4 if repetitions == 0 else max(4, interval * ease * 1.3)
                repetitions += 1
                interval = round(interval, 2)
                due = now + timedelta(days=interval)
            due_at = iso(due)
            db.execute("""
                UPDATE cards SET due_at = ?, interval_days = ?, ease = ?, repetitions = ?
                WHERE id = ?
            """, (due_at, interval, ease, repetitions, card_id))
            db.execute("""
                INSERT INTO reviews(card_id, rating, reviewed_at, interval_days)
                VALUES (?, ?, ?, ?)
            """, (card_id, rating, iso(now), interval))
            return {"card_id": card_id, "rating": rating, "due_at": due_at,
                    "interval_days": interval, "repetitions": repetitions}

    def summary(self) -> dict:
        now = utc_now()
        start = iso(now.replace(hour=0, minute=0, second=0, microsecond=0))
        with self._connect() as db:
            row = db.execute("""
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END), 0) AS due
                FROM cards
            """, (iso(now),)).fetchone()
            reviewed = db.execute("SELECT COUNT(*) FROM reviews WHERE reviewed_at >= ?",
                                  (start,)).fetchone()[0]
            return {"total_cards": row["total"], "due_cards": row["due"],
                    "reviewed_today": reviewed}

    def export_data(self) -> dict:
        with self._connect() as db:
            decks = db.execute("SELECT id, name FROM decks ORDER BY id").fetchall()
            result = []
            for deck in decks:
                cards = db.execute("""
                    SELECT question, answer, interval_days, ease, repetitions, due_at
                    FROM cards WHERE deck_id = ? ORDER BY id
                """, (deck["id"],)).fetchall()
                result.append({"name": deck["name"], "cards": [dict(c) for c in cards]})
            return {"format": "recall-garden-v1", "decks": result}

    def import_data(self, payload: object) -> int:
        if not isinstance(payload, dict) or payload.get("format") != "recall-garden-v1":
            raise ValueError("This file isn't a Recall Garden export.")
        decks = payload.get("decks")
        if not isinstance(decks, list) or len(decks) > 100:
            raise ValueError("The export must contain a list of at most 100 decks.")
        added = 0
        with self._connect() as db:
            for item in decks:
                if not isinstance(item, dict):
                    raise ValueError("Invalid deck in import file.")
                name = self._clean_text(item.get("name"), "Deck name", 60)
                cur = db.execute("INSERT OR IGNORE INTO decks(name, created_at) VALUES (?, ?)",
                                 (name, iso(utc_now())))
                if cur.rowcount:
                    deck_id = cur.lastrowid
                else:
                    deck_id = db.execute("SELECT id FROM decks WHERE name = ?", (name,)).fetchone()[0]
                cards = item.get("cards", [])
                if not isinstance(cards, list) or len(cards) > 5000:
                    raise ValueError("Each deck can contain at most 5,000 cards.")
                for card in cards:
                    if not isinstance(card, dict):
                        raise ValueError("Invalid card in import file.")
                    q = self._clean_text(card.get("question"), "Question", 1000)
                    a = self._clean_text(card.get("answer"), "Answer", 5000)
                    try:
                        interval = float(card.get("interval_days", 0))
                        ease = float(card.get("ease", 2.5))
                        repetitions = int(card.get("repetitions", 0))
                        raw_due = card.get("due_at", iso(utc_now()))
                        if not math.isfinite(interval) or not 0 <= interval <= 36500:
                            raise ValueError
                        if not math.isfinite(ease) or not 1.3 <= ease <= 100:
                            raise ValueError
                        if not 0 <= repetitions <= 1_000_000_000:
                            raise ValueError
                        if not isinstance(raw_due, str):
                            raise ValueError
                        due = datetime.fromisoformat(raw_due.replace("Z", "+00:00"))
                        if due.tzinfo is None:
                            due = due.replace(tzinfo=timezone.utc)
                    except (TypeError, ValueError, OverflowError) as exc:
                        raise ValueError("A flashcard in the backup has invalid scheduling data.") from exc
                    db.execute("""
                        INSERT INTO cards(deck_id, question, answer, created_at, due_at,
                                          interval_days, ease, repetitions)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, (deck_id, q, a, iso(utc_now()), iso(due), interval, ease, repetitions))
                    added += 1
        return added


STORE = StudyStore()


class Handler(BaseHTTPRequestHandler):
    server_version = "RecallGarden/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _send(self, status: int, payload: object, content_type: str = "application/json; charset=utf-8") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid request size.") from exc
        if length > 1_000_000:
            raise ValueError("Request is too large.")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError("Request body must be valid JSON.") from exc
        if not isinstance(value, dict):
            raise ValueError("Request body must be a JSON object.")
        return value

    @staticmethod
    def _id(raw: str) -> int:
        try:
            value = int(raw)
            if value < 1:
                raise ValueError
            return value
        except ValueError as exc:
            raise ValueError("ID must be a positive integer.") from exc

    def _api(self, method: str, path: str, query: dict[str, list[str]]) -> None:
        if method == "GET" and path == "/api/decks":
            self._send(200, STORE.decks())
        elif method == "POST" and path == "/api/decks":
            deck = STORE.create_deck(self._body().get("name"))
            self._send(201, deck)
        elif method == "GET" and path == "/api/cards":
            raw = query.get("deck_id", [None])[0]
            self._send(200, STORE.cards(self._id(raw) if raw else None))
        elif method == "POST" and path == "/api/cards":
            data = self._body()
            self._send(201, STORE.create_card(self._id(str(data.get("deck_id", ""))),
                                               data.get("question"), data.get("answer")))
        elif method == "GET" and path == "/api/summary":
            self._send(200, STORE.summary())
        elif method == "GET" and path == "/api/review/next":
            raw = query.get("deck_id", [None])[0]
            self._send(200, STORE.next_due(self._id(raw) if raw else None))
        elif method == "POST" and path == "/api/review":
            data = self._body()
            self._send(200, STORE.review(self._id(str(data.get("card_id", ""))), data.get("rating")))
        elif method == "GET" and path == "/api/export":
            self._send(200, STORE.export_data())
        elif method == "POST" and path == "/api/import":
            self._send(200, {"added": STORE.import_data(self._body())})
        else:
            parts = path.strip("/").split("/")
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "decks" and method == "DELETE":
                STORE.delete_deck(self._id(parts[2]))
                self._send(200, {"ok": True})
            elif len(parts) == 3 and parts[0] == "api" and parts[1] == "cards":
                card_id = self._id(parts[2])
                if method == "PATCH":
                    data = self._body()
                    self._send(200, STORE.update_card(card_id, data.get("question"), data.get("answer")))
                elif method == "DELETE":
                    STORE.delete_card(card_id)
                    self._send(200, {"ok": True})
                else:
                    self._send(404, {"error": "Not found."})
            else:
                self._send(404, {"error": "Not found."})

    def _handle(self, method: str) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self._api(method, parsed.path, parse_qs(parsed.query))
            elif method == "GET" and parsed.path in ("/", "/index.html", "/app.js", "/local-store.js", "/styles.css"):
                filename = "index.html" if parsed.path in ("/", "/index.html") else parsed.path[1:]
                types = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8",
                         "local-store.js": "text/javascript; charset=utf-8", "styles.css": "text/css; charset=utf-8"}
                self._send(200, (BASE_DIR / "static" / filename).read_bytes(), types[filename])
            else:
                self._send(404, {"error": "Not found."})
        except ValueError as exc:
            self._send(400, {"error": str(exc)})
        except LookupError as exc:
            self._send(404, {"error": str(exc)})
        except (sqlite3.Error, OSError) as exc:
            print(f"Request failed: {exc}")
            self._send(500, {"error": "Something went wrong. Please try again."})

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PATCH(self) -> None:
        self._handle("PATCH")

    def do_DELETE(self) -> None:
        self._handle("DELETE")


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    if HOST in {"0.0.0.0", "::"}:
        print(f"Recall Garden is listening on {HOST}:{PORT}.")
        print(f"Open forwarded port {PORT} in your development environment.\nPress Ctrl+C to stop.")
    else:
        url = f"http://{HOST}:{PORT}"
        print(f"Recall Garden is running at {url}\nPress Ctrl+C to stop.")
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Recall Garden.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
