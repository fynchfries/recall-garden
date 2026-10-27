import tempfile
import unittest
from pathlib import Path
from datetime import timedelta

from app import StudyStore, iso, utc_now


class StudyStoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = StudyStore(Path(self.tempdir.name) / "test.db")

    def tearDown(self):
        self.tempdir.cleanup()

    def make_card(self):
        deck = self.store.create_deck("Biology")
        card = self.store.create_card(deck["id"], "What is a cell?", "The basic unit of life.")
        return deck, card

    def test_new_card_is_ready_to_review(self):
        deck, card = self.make_card()
        self.assertEqual(card["question"], "What is a cell?")
        self.assertEqual(self.store.summary()["total_cards"], 1)
        self.assertEqual(self.store.summary()["due_cards"], 1)
        self.assertEqual(self.store.next_due()["id"], card["id"])
        self.assertEqual(self.store.decks()[0]["due_count"], 1)

    def test_review_rating_schedules_card_and_records_history(self):
        _, card = self.make_card()
        result = self.store.review(card["id"], "good")
        self.assertEqual(result["repetitions"], 1)
        self.assertEqual(result["interval_days"], 1)
        self.assertIsNone(self.store.next_due())
        self.assertEqual(self.store.summary()["reviewed_today"], 1)

        # Make it due again to verify the next step of the interval schedule.
        with self.store._connect() as db:
            db.execute("UPDATE cards SET due_at = ? WHERE id = ?", (iso(utc_now() - timedelta(days=1)), card["id"]))
        result = self.store.review(card["id"], "good")
        self.assertEqual(result["repetitions"], 2)
        self.assertEqual(result["interval_days"], 3)

    def test_again_sets_short_retry_and_resets_streak(self):
        _, card = self.make_card()
        result = self.store.review(card["id"], "again")
        self.assertEqual(result["repetitions"], 0)
        self.assertLess(result["interval_days"], 0.01)
        self.assertIsNone(self.store.next_due())

    def test_duplicate_deck_names_are_case_insensitive(self):
        self.store.create_deck("Chemistry")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.store.create_deck("chemistry")

    def test_validation_rejects_empty_content_and_bad_ratings(self):
        deck = self.store.create_deck("History")
        with self.assertRaisesRegex(ValueError, "Question"):
            self.store.create_card(deck["id"], "  ", "Answer")
        card = self.store.create_card(deck["id"], "Question", "Answer")
        with self.assertRaisesRegex(ValueError, "Choose Again"):
            self.store.review(card["id"], "maybe")

    def test_export_import_preserves_deck_and_schedule(self):
        chemistry = self.store.create_deck("Chemistry")
        self.store.create_card(chemistry["id"], "What is H₂O?", "Water.")
        _, card = self.make_card()
        self.store.review(card["id"], "good")
        exported = self.store.export_data()

        other = StudyStore(Path(self.tempdir.name) / "imported.db")
        existing_biology = other.create_deck("Biology")
        self.assertEqual(other.import_data(exported), 2)
        imported = other.cards()
        chemistry_card = next(c for c in imported if c["question"] == "What is H₂O?")
        biology_card = next(c for c in imported if c["question"] == "What is a cell?")
        self.assertNotEqual(chemistry_card["deck_id"], existing_biology["id"])
        self.assertEqual(biology_card["deck_id"], existing_biology["id"])
        self.assertEqual(biology_card["repetitions"], 1)
        self.assertEqual(biology_card["interval_days"], 1)
        self.assertEqual(biology_card["answer"], "The basic unit of life.")
        self.assertEqual(other.import_data(exported), 2)  # Import adds cards to existing decks.
        self.assertEqual(other.summary()["total_cards"], 4)

    def test_deleting_deck_also_deletes_cards(self):
        deck, card = self.make_card()
        self.store.delete_deck(deck["id"])
        self.assertEqual(self.store.cards(), [])
        with self.assertRaises(LookupError):
            self.store.delete_card(card["id"])


if __name__ == "__main__":
    unittest.main()
