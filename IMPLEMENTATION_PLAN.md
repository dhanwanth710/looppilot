# LoopPilot Implementation Plan

## Current constraints

- The workspace is empty. No existing app, repository instructions, or `.agent/skills/frontend-design` skill file is present, so its UI guidance could not be read. Please provide that skill before UI implementation if it lives outside this workspace.
- No OAuth credentials or model runtime are present. Gmail will be the intended least-privilege integration, limited to creating/sending drafts with explicit approval. Until a real Gmail authorization is configured and verified, the app will use an unmistakably labelled SANDBOX email tool and will not imply a real send occurred.
- Build and browser verification will stop after each of P1-P6 for review, as requested. This plan is not authorization to begin implementation.

## Architecture

```text
React UI (capture, review, board, task, approval, ledger)
  -> FastAPI API / input processing (text, PDF, image OCR; voice optional)
  -> LLMClient (Gemma 4 runtime selected by environment)
       schema-constrained Pydantic output; one repair attempt; then uncertain
  -> SQLAlchemy context store (SQLite default; PostgreSQL-compatible schema)
  -> deterministic workflow state machine and dependency planner
  -> deterministic policy gate (approval, permissions, idempotency)
  -> Gmail integration when authorized, otherwise labelled SANDBOX tool
  -> objective verifier using persisted tool result/evidence
  -> append-only audit events and evidence-linked UI
```

Model output proposes structured facts and plans only. Backend rules own permissions, status transitions, conflict persistence, approval checks, idempotency, tool execution, and verification. A task can become `Verified` only after its objective condition is supported by a persisted tool result. External sends always require an approval record containing the exact action preview.

## Proposed file tree

```text
loop-pilot/
  frontend/
    src/
      app/                 # routing, layout, theme, shared status vocabulary
      components/          # capture, source highlights, cards, timeline, ledger
      features/            # capture, today, task detail, conflicts, approvals, demo
      lib/                 # typed API client and UI utilities
      styles/              # CSS-variable light/dark themes and accessible tokens
  backend/
    app/
      api/                 # FastAPI routes and request/response models
      processing/          # extraction, OCR, date normalization
      llm/                 # LLMClient interface and runtime adapters
      models/              # SQLAlchemy entities and Pydantic schemas
      workflow/            # transitions, DAG planner, conflict and recovery logic
      policy/              # approval and idempotency gates
      tools/               # Gmail and explicitly labelled SANDBOX implementations
      verification/         # objective checks against tool evidence
      audit/               # append-only event recording
    tests/                 # state machine, policy, conflict, idempotency tests
  eval/
    scenarios/             # 20-30 deterministic workflow cases
    runner.py               # system and naive baseline comparison / metrics table
  seed/                     # reproducible example task and source material
  docker-compose.yml
  Makefile                  # one-command setup, run, test, and evaluation targets
  .env.example
  .gitignore
  LICENSE                   # MIT
  README.md
```

The UI will use React, TypeScript, Vite, Tailwind, Framer Motion, and React Flow. The API will use Python, FastAPI, Pydantic, and SQLAlchemy. SQLite is the default store. The workflow is a plain Python state machine, not a framework. PDF extraction uses a small supported parser with OCR fallback for images; voice transcription stays optional and is not a dependency of the core document-request workflow.

## Build order and gates

Each phase ends with focused automated checks and browser verification of its user-visible path. I will stop and show the result for approval before starting the next phase.

1. **P1 Capture & confirm**: Scaffold the app; implement text/file capture, extraction schema, evidence references, uncertainty, and accept/correct. Done when a user can inspect and correct an extracted document request and its cited source. Browser check: paste/upload the seeded instruction, inspect evidence and uncertainty, edit, accept.
2. **P2 Memory & conflict detection**: Persist tasks, sources, and dated facts; detect rather than overwrite contradictions. Done when a changed deadline presents both sourced values and requires a user choice. Browser check: inject and resolve a conflicting deadline.
3. **P3 Planning & dependencies**: Add dependency DAG and deterministic eligibility/blocker reasoning. Done when missing prerequisites block only the affected step and the UI explains why. Browser check: resolve the deadline and expose a missing required document.
4. **P4 Approved integration**: Add exact-action preview, durable approval record, tool adapter, result persistence, and evidence-backed verification. Prefer real Gmail only after credentials and least-privilege OAuth work; otherwise exercise the clearly labelled SANDBOX. Done when an approved action executes in the configured mode and its actual result is captured. Browser check: inspect preview, approve, execute, inspect result.
5. **P5 Recovery & idempotency**: Classify retryable/permanent/uncertain failures, prevent duplicate sends with idempotency keys and prior-attempt checks, and replan only affected dependencies. Done when failure cannot produce false success or an unsafe duplicate. Browser check: inject clearly labelled simulated failure and duplicate trigger, inspect recovery and ledger.
6. **P6 Evaluation & finish**: Add 20-30 scenarios, naive single-prompt baseline, required metrics and failure cases; complete landing page, demo controls, audit filters, responsive/accessibility polish, docs, seed data, and one-command setup. Done when the seeded end-to-end demo is repeatable, metrics are computed from scenario results, and final statuses use only the specified vocabulary. Browser check: run the complete demo and inspect final evidence/audit trail.

## Evaluation and verification

The evaluation runner will use fixed scenario inputs and expected facts/actions, report extraction and evidence accuracy, conflict-detection rate, recovery success, duplicate-action prevention, approval compliance, and verified-completion rate, and compare the workflow with a naive single-prompt baseline on the same cases. It will print measured results and concrete failure cases only; no numbers will be fabricated. Unit tests cover state transitions, policy approval, idempotency, conflict detection, and verification. Browser checks are performed at each phase gate, not deferred to the end.

## Product and UI decisions

- Keep the single workflow centered on sending a requested document by a deadline; do not add unrelated productivity features.
- Use the requested editorial mission-control direction: paper/ink foundation, one vermilion or teal signal accent, semantic status colors, serif display type, compact sans-serif UI, and monospace audit details. Define light/dark themes with CSS variables and maintain visible focus, keyboard operation, reduced-motion behavior, and mobile layouts.
- Make the loop-ring motif close only on evidence-backed `Verified` state. Show source references wherever extracted facts or conflicts are displayed. Label all injected failures as simulated.
- Keep the exact six status labels: `To do`, `Waiting`, `Blocked`, `Needs approval`, `Verified`, and `Unresolved`.

## Risks and mitigations

- **Required design skill missing**: UI work must wait until `.agent/skills/frontend-design` is available or you explicitly approve proceeding without it.
- **Gemma 4 runtime/API variance**: Isolate providers behind `LLMClient`; validate all outputs; allow one schema-repair retry, then persist an uncertain result without executing actions.
- **Gmail OAuth setup and send scope**: Keep credentials out of source control, request only required scopes, and retain SANDBOX as an explicit fallback. Never label sandbox results as real tool evidence.
- **OCR/date ambiguity**: Preserve source coordinates/snippets and uncertainty; ask only when ambiguity changes the next safe action; never invent missing document contents.
- **False completion or duplicate external effects**: Enforce approval, idempotency, state transitions, and verification in deterministic backend code, with unit tests and persisted tool evidence.
- **Hack-day breadth**: Honor the six phase gates and single workflow; keep voice transcription optional and defer anything outside the requested scope.