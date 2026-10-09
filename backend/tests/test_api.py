import os
import sys
import unittest
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite:///:memory:"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.main import AuditEvent, Base, Fact, SessionLocal, Source, Task, _build_task_plan, _recover_explicit_required_items, _safe_evidence, app, engine
from app.llm import GemmaField


class CaptureApiTests(unittest.TestCase):
    def test_explicit_include_clause_is_preserved_as_required_item_evidence(self):
        source = "Please send the report by Friday. Include the latest budget sheet."
        recovered = _recover_explicit_required_items(source)

        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]["value"], "latest budget sheet")
        self.assertEqual(recovered[0]["source"], "Include the latest budget sheet")
        self.assertFalse(recovered[0]["uncertain"])

    def test_plan_blocks_unconfirmed_prerequisites_and_requires_approval(self):
        interpretation, plan = _build_task_plan([
            {"label": "Requested action", "value": "Send revised project report", "uncertain": False},
            {"label": "Deadline", "value": "Friday", "uncertain": True},
            {"label": "Required item", "value": "latest budget sheet", "uncertain": False},
            {"label": "Owner", "value": "", "uncertain": True},
        ])
        steps = {step["title"]: step for step in plan}

        self.assertIn("latest budget sheet", interpretation)
        self.assertIn("No message has been sent", interpretation)
        self.assertEqual(steps["Confirm the responsible person or recipient"]["status"], "Blocked")
        self.assertEqual(steps["Verify required documents"]["status"], "Waiting")
        self.assertEqual(steps["Prepare the outgoing document and message preview"]["status"], "Blocked")
        self.assertEqual(steps["Approve any eventual send"]["status"], "Needs approval")
        self.assertNotIn("Verified", [step["status"] for step in plan])

    def test_model_fields_must_be_supported_by_their_exact_quote(self):
        source = "Please send the revised project report by Friday."
        supported = _safe_evidence("Deadline", GemmaField(value="Friday", source_quote="by Friday", uncertain=False), source)
        invented = _safe_evidence("Deadline", GemmaField(value="Monday", source_quote="by Friday", uncertain=False), source)

        self.assertEqual(supported["value"], "Friday")
        self.assertFalse(supported["uncertain"])
        self.assertEqual(invented["value"], "")
        self.assertTrue(invented["uncertain"])

    def test_accounts_protect_workspace_and_capture_is_idempotent(self):
        Base.metadata.drop_all(engine)

        payload = {
            "idempotency_key": "capture-once",
            "title": "Send revised project report",
            "deadline": "Friday",
            "owner": None,
            "required_items": ["latest budget sheet"],
            "source_name": "request.txt",
            "source_type": "MESSAGE",
            "source_content": "Please send the revised project report by Friday.",
            "facts": [{
                "label": "Deadline",
                "value": "Friday",
                "source": "by Friday",
                "uncertain": True,
            }],
        }

        with TestClient(app) as client:
            self.assertEqual(client.get("/api/tasks").status_code, 401)
            self.assertEqual(client.post("/api/model/check").status_code, 401)

            registration = client.post("/api/auth/signup", json={
                "email": "student@example.test",
                "password": "correct-horse-battery-22",
            })
            self.assertEqual(registration.status_code, 201)
            self.assertEqual(registration.json()["email"], "student@example.test")
            self.assertTrue(client.cookies.get("looppilot_session"))

            first = client.post("/api/tasks", json=payload)
            self.assertEqual(first.status_code, 201)
            self.assertEqual(first.json()["status"], "To do")

            duplicate = client.post("/api/tasks", json=payload)
            self.assertEqual(duplicate.json()["id"], first.json()["id"])
            self.assertEqual(len(client.get("/api/tasks").json()), 1)
            self.assertEqual(len(client.get("/api/audit").json()), 1)
            self.assertEqual(client.get("/api/health").json()["status"], "ok")
            model_status = client.get("/api/model/status").json()
            self.assertIsInstance(model_status["key_configured"], bool)
            self.assertNotIn("key", model_status)

            self.assertEqual(client.post("/api/auth/logout").status_code, 200)
            self.assertEqual(client.get("/api/tasks").status_code, 401)

            second_account = client.post("/api/auth/signup", json={
                "email": "colleague@example.test",
                "password": "another-secure-passphrase-48",
            })
            self.assertEqual(second_account.status_code, 201)
            self.assertEqual(client.get("/api/tasks").json(), [])

            self.assertEqual(client.post("/api/auth/logout").status_code, 200)
            login = client.post("/api/auth/login", json={
                "email": "student@example.test",
                "password": "correct-horse-battery-22",
            })
            self.assertEqual(login.status_code, 200)
            self.assertEqual(len(client.get("/api/tasks").json()), 1)

        with SessionLocal() as session:
            task = session.get(Task, first.json()["id"])
            self.assertEqual(task.source.name, "request.txt")
            self.assertEqual(task.source.content, payload["source_content"])
            self.assertEqual(len(task.facts), 1)
            self.assertTrue(task.facts[0].uncertain)
            self.assertEqual(session.query(Source).count(), 1)
            self.assertEqual(session.query(Fact).count(), 1)
            self.assertEqual(session.query(AuditEvent).count(), 1)
            self.assertEqual(session.query(Task).filter(Task.user_id == registration.json()["id"]).count(), 1)


if __name__ == "__main__":
    unittest.main()