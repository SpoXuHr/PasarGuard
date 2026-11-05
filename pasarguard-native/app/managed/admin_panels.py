"""پنل اختصاصی هر مدیر: یک «پسورد کوتاه» تصادفی برای هر ادمین.

هر مدیر (و خود مالک) یک آدرس مستقل دارد:  http://host:port/<pass>/
* پسورد کاملاً تصادفی و برای هر ادمین متفاوت است.
* نگاشت پسورد→ادمین در همین فایل JSON ذخیره می‌شود تا هم بک‌اند و هم لبه
  (index.js) بتوانند آن را بخوانند.
* توکن نشست هر ادمین فقط از سمت لبه و با هدر مشترک ساخته می‌شود
  (X-PG-Edge) تا هیچ پسوردی داخل پنل ذخیره نشود.
"""
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

DATA_DIR = Path("/home/container/pasarguard-native/data")
PANELS_FILE = DATA_DIR / "admin_panels.json"
SECRET_FILE = DATA_DIR / "edge_secret.txt"
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
PASS_LEN = 12


_CACHE = {"mtime": None, "data": {"panels": {}}}


def _read():
    """Read the store, cached on the file mtime.

    The store is touched by the panel API and read on every admin request (the
    expiry check runs inside the auth dependency), so a cached read keeps that
    path free of disk I/O while staying correct across processes.
    """
    try:
        mtime = PANELS_FILE.stat().st_mtime_ns
    except OSError:
        return {"panels": {}}
    if _CACHE["mtime"] == mtime:
        return _CACHE["data"]
    try:
        data = json.loads(PANELS_FILE.read_text("utf-8"))
        if not (isinstance(data, dict) and isinstance(data.get("panels"), dict)):
            data = {"panels": {}}
    except Exception:
        data = _CACHE["data"] if isinstance(_CACHE.get("data"), dict) else {"panels": {}}
    _CACHE["mtime"] = mtime
    _CACHE["data"] = data
    return data


def _write(data):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PANELS_FILE.with_name(PANELS_FILE.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, PANELS_FILE)
    try:
        _CACHE["mtime"] = PANELS_FILE.stat().st_mtime_ns
        _CACHE["data"] = data
    except OSError:
        _CACHE["mtime"] = None


def edge_secret():
    """کلید مشترک لبه و بک‌اند (فقط یک‌بار ساخته می‌شود)."""
    try:
        value = SECRET_FILE.read_text("utf-8").strip()
        if value:
            return value
    except Exception:
        pass
    value = secrets.token_hex(32)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SECRET_FILE.write_text(value, "utf-8")
    try:
        os.chmod(SECRET_FILE, 0o600)
    except OSError:
        pass
    return value


def _new_pass(taken):
    for _ in range(200):
        value = "".join(secrets.choice(ALPHABET) for _ in range(PASS_LEN))
        if value not in taken:
            return value
    raise RuntimeError("could not allocate a unique panel password")


def _entry(panels, admin_id, username):
    key = str(int(admin_id))
    taken = {str(item.get("pass")) for item in panels.values() if isinstance(item, dict)}
    current = panels.get(key)
    if isinstance(current, dict) and current.get("pass"):
        if current.get("username") != username:
            current["username"] = username
        return current
    entry = {
        "pass": _new_pass(taken),
        "username": username,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    panels[key] = entry
    return entry


def panel_url(pass_value, origin):
    return "%s/%s/" % (str(origin).rstrip("/"), pass_value)


async def list_panels(db, origin):
    """همهٔ ادمین‌ها؛ برای هرکدام پسورد کوتاه اختصاصی ساخته/برگردانده می‌شود."""
    from sqlalchemy import select
    from app.db.models import Admin

    admins = list((await db.execute(select(Admin).order_by(Admin.id))).scalars())
    data = _read()
    panels = data["panels"]
    before = json.dumps(data, sort_keys=True)
    result = []
    for admin in admins:
        entry = _entry(panels, admin.id, admin.username)
        status = getattr(admin, "status", "active")
        result.append(
            {
                "admin_id": int(admin.id),
                "username": admin.username,
                "admin_status": str(getattr(status, "value", status)),
                "is_owner": _is_owner(admin),
                "pass": entry["pass"],
                "url": panel_url(entry["pass"], origin),
                "created_at": entry.get("created_at"),
                "rotated_at": entry.get("rotated_at"),
                **limit_info(admin.id),
            }
        )
    # Only touch the file when something actually changed (no disk churn on polling).
    if json.dumps(data, sort_keys=True) != before:
        _write(data)
    return result


# --------------------------------------------------------------- time limits
def _parse(ts):
    """Parse the stored ISO timestamp; None when unset/broken."""
    text = str(ts or "").strip()
    if not text:
        return None
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value


def entry_for(admin_id):
    return _read()["panels"].get(str(int(admin_id)))


def limit_info(admin_id):
    """{expire_at, seconds_left, expired} for one admin."""
    entry = entry_for(admin_id) or {}
    when = _parse(entry.get("expire_at"))
    if when is None:
        return {"expire_at": None, "seconds_left": None, "expired": False}
    left = (when - datetime.now(UTC)).total_seconds()
    return {"expire_at": when.isoformat(timespec="seconds"), "seconds_left": int(left), "expired": left <= 0}


def admin_expired(admin_id):
    """True when this admin's time limit has passed (never raises)."""
    try:
        return bool(limit_info(admin_id)["expired"])
    except Exception:
        return False


def set_expiry(db, admin_id, payload):
    """Set / extend / clear an admin's time limit.

    payload: {"days": 30} or {"expire_at": "2026-12-31T23:59:59+00:00"} or {"clear": true}
    """
    data = _read()
    panels = data["panels"]
    key = str(int(admin_id))
    entry = panels.get(key)
    if not isinstance(entry, dict):
        raise KeyError(str(admin_id))
    clear = bool(payload.get("clear"))
    days = payload.get("days")
    expire_at = payload.get("expire_at")
    if clear:
        entry.pop("expire_at", None)
        entry["expire_updated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    elif expire_at:
        when = _parse(expire_at)
        if when is None:
            raise ValueError("bad expire_at")
        entry["expire_at"] = when.isoformat(timespec="seconds")
        entry["expire_updated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    elif days is not None:
        try:
            value = float(days)
        except (TypeError, ValueError):
            raise ValueError("bad days")
        if value < 0:
            raise ValueError("bad days")
        when = datetime.now(UTC) + timedelta(seconds=value * 86400)
        entry["expire_at"] = when.isoformat(timespec="seconds")
        entry["expire_updated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    else:
        raise ValueError("nothing to change")
    panels[key] = entry
    _write(data)
    return limit_info(admin_id)


def _is_owner(admin):
    return str(getattr(admin, "id", "")) == "1" or str(getattr(admin, "username", "")).lower() in ("gucci",)


def find_by_pass(pass_value):
    value = str(pass_value or "").strip()
    if not value:
        return None
    for admin_id, entry in _read()["panels"].items():
        if isinstance(entry, dict) and entry.get("pass") == value:
            return {"admin_id": int(admin_id), "username": entry.get("username"), "pass": value}
    return None


def rotate(db, admin_id):
    data = _read()
    panels = data["panels"]
    key = str(int(admin_id))
    entry = panels.get(key) or {}
    taken = {str(item.get("pass")) for k, item in panels.items() if isinstance(item, dict) and k != key}
    entry["pass"] = _new_pass(taken)
    entry["rotated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    panels[key] = entry
    _write(data)
    return entry["pass"]
