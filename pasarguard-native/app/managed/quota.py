"""Enforce reseller quotas on the managed protocol worker without deleting credentials."""
import asyncio
import json
import os
import sqlite3
from pathlib import Path
from sqlalchemy import select
from app.db import GetDB
from app.db.models import Admin, AdminStatus, User, UserStatus

_state_path = Path('/home/container/pasarguard-native/data/admin-quota-blocks.json')

def admin_blocked(admin):
    if admin is None:
        return True
    value = getattr(admin.status, 'value', admin.status)
    return value in ('limited', 'disabled') or (
        int(getattr(admin, 'data_limit', None) or 0) > 0 and int(getattr(admin, 'used_traffic', 0) or 0) >= int(admin.data_limit)
    )

def _worker_clients():
    path = os.getenv('PG_MANAGED_RUNTIME_DB', '/home/container/vpn/data/vpn-ui.db')
    con = sqlite3.connect('file:' + path + '?mode=ro', uri=True, timeout=2)
    try:
        clients = {}
        for inbound_id, settings in con.execute('SELECT id,settings FROM inbounds'):
            for client in json.loads(settings or '{}').get('clients', []):
                email = client.get('email')
                if email:
                    clients[(int(inbound_id), email)] = bool(client.get('enable', True))
        return clients
    finally:
        con.close()

def _load_state():
    if not _state_path.exists():
        return set()
    return {(int(item[0]), str(item[1])) for item in json.loads(_state_path.read_text())}

def _save_state(state):
    tmp = _state_path.with_suffix('.tmp')
    tmp.write_text(json.dumps(sorted(state)))
    tmp.chmod(0o600)
    os.replace(tmp, _state_path)

async def _reconcile_admin_quotas():
    from .runtime import ENABLED, WRITES_ENABLED, runtime, _lock
    if not ENABLED or not WRITES_ENABLED or _lock.locked():
        return
    async with _lock:
        async with GetDB() as db:
            admins = {a.id: a for a in (await db.execute(select(Admin))).scalars()}
            users = {u.username: u for u in (await db.execute(select(User))).scalars()}
            blocked = {name for name, user in users.items() if admin_blocked(admins.get(user.admin_id))}
            for admin in admins.values():
                if admin.status == AdminStatus.active and admin_blocked(admin):
                    admin.status = AdminStatus.limited
            await db.commit()
            # Copy values before closing the session; never alter individual user status.
            restorable = {name for name, user in users.items() if name not in blocked and user.status in (UserStatus.active, UserStatus.on_hold)}
        clients = await asyncio.to_thread(_worker_clients)
        state = _load_state()
        disable = {key for key, enabled in clients.items() if enabled and key[1] in blocked}
        # Persist original enabled memberships BEFORE mutation, making retries safe.
        if disable:
            state.update(disable)
            _save_state(state)
            await runtime.request('/panel/api/inbounds/bulkUpdateClients', {'data': json.dumps({'op': 'disable', 'targets': [{'inboundId': key[0], 'email': key[1]} for key in sorted(disable)]})})
        restore = {key for key in state if key in clients and key[1] in restorable}
        if restore:
            await runtime.request('/panel/api/inbounds/bulkUpdateClients', {'data': json.dumps({'op': 'enable', 'targets': [{'inboundId': key[0], 'email': key[1]} for key in sorted(restore)]})})
            state.difference_update(restore)
            _save_state(state)
        # Stale/deleted memberships must never be recreated by a top-up.
        stale = {key for key in state if key not in clients}
        if stale:
            state.difference_update(stale)
            _save_state(state)

_last_attempt = 0.0

async def reconcile_admin_quotas(force=False, interval=6.0):
    global _last_attempt
    if not force:
        # Polling every two seconds must not hammer the protocol worker with a
        # full membership scan; a state change still enforces immediately.
        import time
        now = time.monotonic()
        if now - _last_attempt < interval:
            return
        _last_attempt = now
    try:
        await _reconcile_admin_quotas()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # A temporarily unavailable worker must not prevent panel startup.
        # Durable markers are retained and the next usage/drain tick retries.
        print('[managed] admin quota reconciliation pending: ' + type(exc).__name__, flush=True)
