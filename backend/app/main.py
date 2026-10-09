import os
import hashlib
import re
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pwdlib import PasswordHash
from pydantic import BaseModel, Field
from sqlalchemy import JSON, CheckConstraint, DateTime, ForeignKey, String, Text, UniqueConstraint, create_engine, inspect, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import gemma_status
from app.llm import GoogleGemmaClient, ModelNotConfigured, ModelOutputInvalid, ModelRequestFailed


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./backend/data/loop_pilot.db")
if DATABASE_URL.startswith("sqlite:///"):
    database_path = DATABASE_URL.removeprefix("sqlite:///")
    if database_path != ":memory:":
        Path(database_path).parent.mkdir(parents=True, exist_ok=True)

engine_options = {
    "connect_args": {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
    "pool_pre_ping": True,
}
if DATABASE_URL == "sqlite:///:memory:":
    engine_options["poolclass"] = StaticPool
engine = create_engine(DATABASE_URL, **engine_options)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
password_hash = PasswordHash.recommended()
SESSION_COOKIE = "looppilot_session"
SESSION_LIFETIME = timedelta(days=30)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class UserSession(Base):
    __tablename__ = "user_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (CheckConstraint(
        "status IN ('To do', 'Waiting', 'Blocked', 'Needs approval', 'Verified', 'Unresolved')",
        name="ck_tasks_status",
    ),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(500))
    deadline: Mapped[str | None] = mapped_column(String(160), nullable=True)
    owner: Mapped[str | None] = mapped_column(String(200), nullable=True)
    required_items: Mapped[list[str]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(32), default="To do")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    source: Mapped["Source"] = relationship(back_populates="task", cascade="all, delete-orphan", uselist=False)
    facts: Mapped[list["Fact"]] = relationship(back_populates="task", cascade="all, delete-orphan")


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    source_type: Mapped[str] = mapped_column(String(40))
    content: Mapped[str] = mapped_column(Text)
    task: Mapped[Task] = relationship(back_populates="source")


class Fact(Base):
    __tablename__ = "facts"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    field: Mapped[str] = mapped_column(String(100))
    value: Mapped[str] = mapped_column(Text)
    source_excerpt: Mapped[str] = mapped_column(Text)
    uncertain: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    task: Mapped[Task] = relationship(back_populates="facts")


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True)
    event_type: Mapped[str] = mapped_column(String(80))
    message: Mapped[str] = mapped_column(String(500))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class FactInput(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    value: str = Field(max_length=2000)
    source: str = Field(max_length=2000)
    uncertain: bool


class CaptureInput(BaseModel):
    idempotency_key: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=500)
    deadline: str | None = Field(default=None, max_length=160)
    owner: str | None = Field(default=None, max_length=200)
    required_items: list[str] = Field(default_factory=list, max_length=30)
    source_name: str = Field(min_length=1, max_length=255)
    source_type: str = Field(min_length=1, max_length=40)
    source_content: str = Field(max_length=20000)
    facts: list[FactInput] = Field(default_factory=list, max_length=20)


class AuthInput(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)


class AuthOutput(BaseModel):
    id: int
    email: str


class ExtractionInput(BaseModel):
    source_content: str = Field(min_length=1, max_length=20000)


class PlanStepOutput(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    status: Literal["To do", "Waiting", "Blocked", "Needs approval", "Verified", "Unresolved"]
    reason: str = Field(min_length=1, max_length=500)


class ExtractionOutput(BaseModel):
    fields: list[FactInput]
    interpretation: str
    plan: list[PlanStepOutput]
    model: str


class TaskOutput(BaseModel):
    id: int
    title: str
    deadline: str | None
    owner: str | None
    required_items: list[str]
    status: Literal["To do", "Waiting", "Blocked", "Needs approval", "Verified", "Unresolved"]
    source_name: str
    source_type: str
    created_at: datetime


class AuditOutput(BaseModel):
    id: int
    task_id: int | None
    event_type: str
    message: str
    details: dict
    created_at: datetime


def task_output(task: Task) -> TaskOutput:
    return TaskOutput(
        id=task.id,
        title=task.title,
        deadline=task.deadline,
        owner=task.owner,
        required_items=task.required_items,
        status=task.status,
        source_name=task.source.name,
        source_type=task.source.source_type,
        created_at=task.created_at,
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    _migrate_legacy_account_columns()
    yield


app = FastAPI(title="LoopPilot API", version="0.1.0", lifespan=lifespan)


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _normalized_email(email: str) -> str:
    normalized = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    return normalized


def _issue_session(user: User, response: Response, session) -> None:
    token = secrets.token_urlsafe(32)
    session.add(UserSession(
        token_hash=_token_digest(token),
        user_id=user.id,
        expires_at=datetime.now(timezone.utc) + SESSION_LIFETIME,
    ))
    session.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        secure=os.getenv("COOKIE_SECURE", "false").lower() == "true",
        samesite="lax",
        path="/",
    )


def current_user(request: Request) -> User:
    raw_token = request.cookies.get(SESSION_COOKIE)
    if not raw_token:
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    with SessionLocal() as session:
        user_session = session.get(UserSession, _token_digest(raw_token))
        if not user_session:
            raise HTTPException(status_code=401, detail="Sign in to continue.")
        expiry = user_session.expires_at
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if expiry <= datetime.now(timezone.utc):
            session.delete(user_session)
            session.commit()
            raise HTTPException(status_code=401, detail="Your session expired. Sign in again.")
        user = session.get(User, user_session.user_id)
        if not user:
            raise HTTPException(status_code=401, detail="Sign in to continue.")
        return user


def _safe_evidence(label: str, field, source: str) -> dict:
    quote = field.source_quote.strip()
    start = source.casefold().find(quote.casefold()) if quote else -1
    value = field.value.strip()
    value_terms = re.findall(r"[a-z0-9]+", value.casefold())
    if label == "Requested action" and value_terms and value_terms[0] in {"send", "share", "submit", "forward", "deliver"}:
        value_terms = value_terms[1:]
    quote_terms = re.findall(r"[a-z0-9]+", quote.casefold())
    quote_position = 0
    for term in value_terms:
        try:
            quote_position = quote_terms.index(term, quote_position) + 1
        except ValueError:
            value_terms = []
            break
    supported = bool(value and value_terms and quote and start >= 0)
    return {
        "label": label,
        "value": value if supported else "",
        "source": source[start:start + len(quote)] if supported else "No exact supporting quote was found in the source.",
        "uncertain": field.uncertain or not supported,
    }


def _recover_explicit_required_items(source: str) -> list[dict]:
    recovered = []
    for match in re.finditer(r"\b(?:include|attach)\s+(?:the\s+)?([^.!?\n]+)", source, flags=re.IGNORECASE):
        value = match.group(1).strip(" \t,;:")
        if value:
            recovered.append({
                "label": "Required item",
                "value": value,
                "source": match.group(0).strip(),
                "uncertain": False,
            })
    return recovered


def _build_task_plan(fields: list[dict]) -> tuple[str, list[dict]]:
    action = next((field for field in fields if field["label"] == "Requested action"), None)
    deadline = next((field for field in fields if field["label"] == "Deadline"), None)
    owner = next((field for field in fields if field["label"] == "Owner"), None)
    required_items = [field for field in fields if field["label"] == "Required item" and field["value"]]
    uncertain_fields = [field["label"] for field in fields if field["uncertain"]]

    interpretation_parts = []
    if action and action["value"]:
        interpretation_parts.append(action["value"])
    if deadline and deadline["value"]:
        interpretation_parts.append(f"due {deadline['value']}")
    if required_items:
        interpretation_parts.append("including " + ", ".join(item["value"] for item in required_items))
    interpretation = "Gemma understood this as: " + ("; ".join(interpretation_parts) or "an unresolved document request") + "."
    if uncertain_fields:
        interpretation += " Review uncertain fields: " + ", ".join(uncertain_fields) + "."
    interpretation += " No message has been sent."

    owner_unresolved = not owner or not owner["value"] or owner["uncertain"]
    plan = [
        {
            "title": "Review the source-linked request",
            "status": "To do",
            "reason": "Confirm the extracted action, deadline, and exact source quotes before proceeding.",
        },
        {
            "title": "Confirm the responsible person or recipient",
            "status": "Blocked" if owner_unresolved else "To do",
            "reason": "No source-supported owner or recipient is confirmed." if owner_unresolved else f"Review the identified value: {owner['value']}.",
        },
        {
            "title": "Verify required documents",
            "status": "Waiting" if required_items else "To do",
            "reason": "Required items were identified, but their availability has not been checked. Do not assume they exist." if required_items else "No required attachment was confirmed; check whether the request needs one.",
        },
        {
            "title": "Prepare the outgoing document and message preview",
            "status": "Blocked" if owner_unresolved or required_items else "To do",
            "reason": "Wait for the responsible person or recipient and any named documents to be confirmed." if owner_unresolved or required_items else "Prepare a preview for the user to inspect.",
        },
        {
            "title": "Connect a sending tool",
            "status": "Blocked",
            "reason": "No email integration is configured, so LoopPilot cannot send this request yet.",
        },
        {
            "title": "Approve any eventual send",
            "status": "Needs approval",
            "reason": "Any external send requires a preview and explicit approval; no action is taken by this plan.",
        },
    ]
    return interpretation, plan


def _migrate_legacy_account_columns() -> None:
    for table in ("tasks", "audit_events"):
        existing_columns = {column["name"] for column in inspect(engine).get_columns(table)}
        if "user_id" not in existing_columns:
            with engine.begin() as connection:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN user_id INTEGER REFERENCES users(id)"))


@app.get("/api/health")
def health():
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return {"status": "ok", "storage": "connected"}
    except Exception as error:
        raise HTTPException(status_code=503, detail="Storage unavailable") from error


@app.get("/api/model/status")
def model_status():
    return gemma_status()


@app.post("/api/auth/signup", response_model=AuthOutput, status_code=201)
def signup(payload: AuthInput, response: Response):
    email = _normalized_email(payload.email)
    with SessionLocal() as session:
        if session.scalar(select(User.id).where(User.email == email)):
            raise HTTPException(status_code=409, detail="An account with this email already exists.")
        user = User(email=email, password_hash=password_hash.hash(payload.password))
        session.add(user)
        try:
            session.flush()
            session.query(Task).filter(Task.user_id.is_(None)).update({Task.user_id: user.id})
            session.query(AuditEvent).filter(AuditEvent.user_id.is_(None)).update({AuditEvent.user_id: user.id})
            _issue_session(user, response, session)
        except Exception:
            session.rollback()
            raise
        return AuthOutput(id=user.id, email=user.email)


@app.post("/api/auth/login", response_model=AuthOutput)
def login(payload: AuthInput, response: Response):
    email = _normalized_email(payload.email)
    with SessionLocal() as session:
        user = session.scalar(select(User).where(User.email == email))
        stored_hash = user.password_hash if user else password_hash.hash("loop-pilot-invalid-login-placeholder")
        valid_password = password_hash.verify(payload.password, stored_hash)
        if not user or not valid_password:
            raise HTTPException(status_code=401, detail="Email or password is incorrect.")
        _issue_session(user, response, session)
        return AuthOutput(id=user.id, email=user.email)


@app.get("/api/auth/me", response_model=AuthOutput)
def get_account(user: User = Depends(current_user)):
    return AuthOutput(id=user.id, email=user.email)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    raw_token = request.cookies.get(SESSION_COOKIE)
    if raw_token:
        with SessionLocal() as session:
            user_session = session.get(UserSession, _token_digest(raw_token))
            if user_session:
                session.delete(user_session)
                session.commit()
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax")
    return {"ok": True}


@app.post("/api/model/check")
async def check_model(_: User = Depends(current_user)):
    try:
        client = GoogleGemmaClient()
        await client.check()
        return {"status": "connected", "model": client.model}
    except ModelNotConfigured as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except (ModelRequestFailed, ModelOutputInvalid) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/extract", response_model=ExtractionOutput)
async def extract_with_gemma(payload: ExtractionInput, _: User = Depends(current_user)):
    try:
        extraction = await GoogleGemmaClient().generate_capture(payload.source_content)
    except ModelNotConfigured as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ModelOutputInvalid as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ModelRequestFailed as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    fields = [
        _safe_evidence("Requested action", extraction.requested_action, payload.source_content),
        _safe_evidence("Deadline", extraction.deadline, payload.source_content),
    ]
    model_required_items = [_safe_evidence("Required item", item, payload.source_content) for item in extraction.required_items]
    fields.extend(item for item in model_required_items if item["value"])
    recovered_items = _recover_explicit_required_items(payload.source_content)
    existing_items = {field["value"].casefold() for field in fields if field["label"] == "Required item" and field["value"]}
    fields.extend(item for item in recovered_items if item["value"].casefold() not in existing_items)
    if not any(field["label"] == "Required item" and field["value"] for field in fields):
        fields.append({"label": "Required item", "value": "", "source": "No required item was identified.", "uncertain": True})
    fields.append(_safe_evidence("Owner", extraction.owner, payload.source_content))
    interpretation, plan = _build_task_plan(fields)
    return {"fields": fields, "interpretation": interpretation, "plan": plan, "model": gemma_status()["model"]}


@app.get("/api/tasks", response_model=list[TaskOutput])
def list_tasks(user: User = Depends(current_user)):
    with SessionLocal() as session:
        tasks = session.scalars(select(Task).where(Task.user_id == user.id).order_by(Task.created_at.desc(), Task.id.desc())).all()
        return [task_output(task) for task in tasks]


@app.post("/api/tasks", response_model=TaskOutput, status_code=201)
def create_task(payload: CaptureInput, user: User = Depends(current_user)):
    with SessionLocal() as session:
        existing = session.scalar(select(Task).where(Task.idempotency_key == payload.idempotency_key, Task.user_id == user.id))
        if existing:
            return task_output(existing)

        task = Task(
            user_id=user.id,
            idempotency_key=payload.idempotency_key,
            title=payload.title,
            deadline=payload.deadline,
            owner=payload.owner,
            required_items=payload.required_items,
            status="To do",
        )
        task.source = Source(name=payload.source_name, source_type=payload.source_type, content=payload.source_content)
        task.facts = [
            Fact(field=fact.label, value=fact.value, source_excerpt=fact.source, uncertain=fact.uncertain)
            for fact in payload.facts
        ]
        session.add(task)
        session.flush()
        session.add(AuditEvent(
            user_id=user.id,
            task_id=task.id,
            event_type="capture.confirmed",
            message="User confirmed a captured request; no external action was taken.",
            details={"source_name": payload.source_name, "source_type": payload.source_type},
        ))
        session.commit()
        session.refresh(task)
        return task_output(task)


@app.get("/api/audit", response_model=list[AuditOutput])
def list_audit_events(user: User = Depends(current_user)):
    with SessionLocal() as session:
        events = session.scalars(select(AuditEvent).where(AuditEvent.user_id == user.id).order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())).all()
        return events