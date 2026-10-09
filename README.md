# LoopPilot

LoopPilot captures document requests, keeps their source evidence, and tracks confirmed requests in a local workspace. The current slice includes heuristic extraction, optional Gemma-backed extraction, email/password accounts, a six-status board, and a capture audit ledger. It does not send email or perform external actions.

## Run with Docker Compose

1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` locally if you want Gemma extraction. Never commit `.env` or put the key in frontend code.
2. Run `docker compose up --build` from the repository root.
3. Open `http://localhost:8080`.

The API stores data in SQLite on a persistent Compose volume. For local development without Docker, install `backend/requirements.txt`, run `uvicorn app.main:app --app-dir backend --reload`, then run `npm ci` and `npm run dev` in `frontend`. Vite proxies `/api` to `http://127.0.0.1:8000`.

## Gemma configuration

The backend reads `GEMINI_API_KEY` and `GEMMA_MODEL` from its environment or the root `.env`. The key is never sent to the browser. Sign in, open the account menu, and use **Test Gemma connection** to check live access. Free-tier availability, quotas, model IDs, and data terms depend on Google AI Studio; check Google's current documentation before use.

## Backend and safety

FastAPI, Pydantic, SQLAlchemy, and SQLite provide health, account, task, audit, and extraction endpoints. Passwords are hashed, sessions use HttpOnly cookies, and task/audit reads require sign-in. Email ownership verification and password reset are not implemented. Gemma extraction returns structured proposals and verifies cited text against the original source; users must review fields before saving. Saved requests begin at `To do`. No email sends or external actions are implemented, and model output cannot mark a task `Verified`.

## Checks

```powershell
python -m unittest discover -s backend/tests -v
cd frontend
npm run lint
npm run build
```

## Architecture

```text
React/Vite UI -> FastAPI -> input validation / Gemma client
                          -> SQLAlchemy context store (SQLite)
                          -> authenticated task and audit routes
```

## License

MIT. See [LICENSE](LICENSE).