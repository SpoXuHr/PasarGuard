from datetime import UTC, datetime
from sqlalchemy import JSON, String, DateTime, Integer
from sqlalchemy.orm import Mapped, mapped_column
from app.db import Base
from app.db.models import IdMixin

class ManagedService(Base, IdMixin):
    __tablename__ = 'managed_services'
    runtime_id: Mapped[int] = mapped_column(Integer, unique=True)
    tag: Mapped[str] = mapped_column(String(256), unique=True)
    protocol: Mapped[str] = mapped_column(String(32))
    config: Mapped[dict] = mapped_column(JSON)

class ManagedBinding(Base, IdMixin):
    __tablename__ = 'managed_bindings'
    username: Mapped[str] = mapped_column(String(128), unique=True)
    subscription_id: Mapped[str] = mapped_column(String(256))
    snapshot: Mapped[dict] = mapped_column(JSON)

class ManagedAction(Base, IdMixin):
    __tablename__ = 'managed_actions'
    username: Mapped[str] = mapped_column(String(128), index=True)
    action: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default='pending')
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(String(256), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default_factory=lambda: datetime.now(UTC))
