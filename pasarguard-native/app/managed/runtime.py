"""Management driver for the existing isolated protocol workers.

The real PasarGuard database/API owns accounts. This driver projects them onto
existing workers, retaining per-inbound credentials and public subscription IDs.
Writes are opt-in; a staging backend cannot change the live workers.
"""
import asyncio
import json
import os
import secrets
from datetime import UTC, datetime
from pathlib import Path
import aiohttp
from sqlalchemy import select, delete
from sqlalchemy.orm import selectinload
from app.db import GetDB
from app.db.models import Group, User, UserStatus
from .models import ManagedAction, ManagedBinding, ManagedService

ENABLED = os.getenv('PG_MANAGED_ENABLED') == '1'
WRITES_ENABLED = os.getenv('PG_MANAGED_RUNTIME_WRITES') == '1'
_lock = asyncio.Lock()

class RuntimeDriver:
    def __init__(self):
        self._session = None
        self._auth = None
        self._session_lock = asyncio.Lock()

    def credentials(self):
        p = os.environ.get('PG_MANAGED_AUTH_FILE', '/home/container/vpn/state.json')
        return json.loads(Path(p).read_text())

    async def session(self):
        async with self._session_lock:
            if self._session is None or self._session.closed:
                self._session = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True), timeout=aiohttp.ClientTimeout(total=15))
                cfg = self.credentials()
                self._base = os.getenv('PG_MANAGED_RUNTIME_URL', 'http://127.0.0.1:18080/TeamGuccI').rstrip('/')
                async with self._session.post(self._base + '/login', data={'username':cfg.get('username','admin'), 'password':cfg['password']}, allow_redirects=False) as r:
                    data = await r.json()
                    if not data.get('success'):
                        await self.close()
                        raise RuntimeError('Protocol worker authentication failed')
            return self._session

    async def close(self):
        if self._session:
            await self._session.close()
            self._session = None

    async def request(self, path, data=None, *, method=None, json_body=None, _retry_auth=True):
        method = method or ('POST' if data is not None or json_body is not None else 'GET')
        # POST statistics endpoints are read-only. All configuration mutation is gated.
        readonly_posts = {'/panel/api/inbounds/onlines','/panel/api/inbounds/lastOnline','/panel/setting/defaultSettings'}
        if method != 'GET' and path not in readonly_posts and not WRITES_ENABLED:
            raise RuntimeError('Staging mode: runtime writes are disabled')
        session = await self.session()
        pairs = None
        if data is not None:
            pairs=[]
            for k,v in data.items():
                for value in (v if isinstance(v,list) else [v]):
                    pairs.append((k, 'true' if value is True else 'false' if value is False else str(value)))
        auth_expired = False
        async with session.request(method, self._base+path, data=pairs, json=json_body, allow_redirects=False) as r:
            # The preserved worker intentionally masks expired login sessions
            # with a non-JSON 404. Invalidate that cookie instead of retrying it
            # forever and flooding the native log with JSON decoding traces.
            auth_expired = r.status in (301,302,303,401,403,404)
            if not auth_expired:
                payload=await r.json()
                if not r.ok or not payload.get('success'):
                    raise RuntimeError('Protocol worker operation failed')
                return payload.get('obj')
        if auth_expired:
            async with self._session_lock:
                if self._session is session:
                    await self.close()
            # Only known read-only operations may be retried automatically.
            # Mutations fail closed so a quota reset/edit cannot run twice.
            if _retry_auth and (method == 'GET' or path in readonly_posts):
                return await self.request(path, data, method=method, json_body=json_body, _retry_auth=False)
            raise RuntimeError('Protocol worker session expired')

    async def snapshot(self):
        # The worker API caps a clients page at 50 rows regardless of the
        # requested size. A single unpaged read used to hide every account
        # beyond the first page, so edits for those users were mistaken for
        # new accounts and failed with "Duplicate email ... already used".
        inbounds=await self.request('/panel/api/inbounds/list')
        rows=[];page=1
        while page<=40:
            payload=await self.request('/panel/api/clients/list?page=%d&size=100'%page) or {}
            batch=payload.get('rows') or []
            rows.extend(batch)
            try:total=int(payload.get('total') or 0)
            except (TypeError,ValueError):total=0
            if not batch or len(batch)<100 or (total and len(rows)>=total):break
            page+=1
        return inbounds, rows

    async def apply(self, username, *, remove=False, rotate=False, reset=False):
        from urllib.parse import quote
        inbounds,rows=await self.snapshot()
        old=next((r for r in rows if r['email']==username),None)
        async with GetDB() as db:
            user=(await db.execute(select(User).where(User.username==username).options(selectinload(User.groups).selectinload(Group.inbounds)))).scalar_one_or_none()
            services=list((await db.execute(select(ManagedService))).scalars())
            binding=(await db.execute(select(ManagedBinding).where(ManagedBinding.username==username))).scalar_one_or_none()
            if not user:
                if old:
                    members=old.get('memberships',[])
                    if members:
                        await self.request('/panel/api/inbounds/bulkMembership',{'data':json.dumps({'op':'removeInbounds','inboundIds':[m['inboundId'] for m in members],'targets':[{'inboundId':m['inboundId'],'email':username} for m in members]})})
                    _,remaining=await self.snapshot()
                    if any(r['email']==username for r in remaining):
                        await self.request('/panel/api/inbounds/delAccount/'+quote(username,safe=''),{})
                await db.execute(delete(ManagedBinding).where(ManagedBinding.username==username))
                await db.commit()
                return
            tags={i.tag for g in user.groups if not g.is_disabled for i in g.inbounds}
            wanted=sorted(s.runtime_id for s in services if s.tag in tags)
            from app.db.models import Admin
            from .quota import admin_blocked
            account_admin = await db.get(Admin, user.admin_id)
            active=not remove and user.status in (UserStatus.active,UserStatus.on_hold) and not admin_blocked(account_admin)
            expires=int(user.expire.timestamp()*1000) if user.expire else -(user.on_hold_expire_duration*1000) if user.status==UserStatus.on_hold and user.on_hold_expire_duration else 0
            members=(old or {}).get('memberships',[])
            anchor=members[0] if members else None
            first=next((ib for ib in inbounds if ib['id']==(anchor or {}).get('inboundId')),None)
            c=next((c for c in json.loads((first or {}).get('settings','{}')).get('clients',[]) if c.get('email')==username),{}).copy()
            settings=user.proxy_settings or {}
            previous=(binding.snapshot or {}).get('proxy_settings',{}) if binding else {}
            # The preserved worker's shared-account contract uses a common UUID
            # and common Trojan/SS secret. Keep native PG's stored fields honest.
            settings=json.loads(json.dumps(settings))
            for protocols,field in [(('vless','vmess'),'id')]:
                changed=[p for p in protocols if settings.get(p,{}).get(field)!=previous.get(p,{}).get(field)]
                if not old or changed:
                    chosen=(changed[0] if changed else protocols[0])
                    value=settings.get(chosen,{}).get(field)
                    if value:
                        for protocol in protocols:settings.setdefault(protocol,{})[field]=value
                        if field=='id':c.update({'id':value,'uuid':value})
                        else:c['password']=value
            if not old or settings.get('trojan')!=previous.get('trojan'):
                c['password']=settings.get('trojan',{}).get('password') or secrets.token_urlsafe(24)
            if not old or settings.get('hysteria')!=previous.get('hysteria'):
                c['auth']=settings.get('hysteria',{}).get('auth') or secrets.token_urlsafe(24)
            wg=settings.get('wireguard',{})
            if wg.get('private_key') and (not old or wg.get('private_key')!=previous.get('wireguard',{}).get('private_key')):
                c.update({'privKey':wg['private_key'],'pubKey':wg.get('public_key')})
            if rotate:
                from app.utils.crypto import generate_wireguard_keypair
                private_key,public_key=generate_wireguard_keypair()
                c.update({'secret':secrets.token_hex(16),'openvpnPassword':secrets.token_urlsafe(24),'privKey':private_key,'pubKey':public_key})
                settings['wireguard']={**settings.get('wireguard',{}),'private_key':private_key,'public_key':public_key}
            user.proxy_settings=settings
            if not old:
                c.update({'secret':secrets.token_hex(16), 'vpnUsername':username, 'openvpnPassword':secrets.token_urlsafe(24)})
            # The certificate/credential store is authoritative across unrelated user edits.
            if old:
                profiles=await self.request('/panel/api/openvpn/profiles')
                profile=next((p for p in profiles.get('accounts',[]) if p['email'].lower()==username.lower()),None)
                if profile:c.update({'vpnUsername':profile['username'],'openvpnPassword':profile['password']})
            if isinstance(c.get('secret'),str) and len(c['secret'])==34 and c['secret'].startswith('dd'):c['secret']=c['secret'][2:]
            c.update({'email':username,'enable':active,'totalGB':user.data_limit or 0,'expiryTime':expires,'comment':user.note or '', 'subId': binding.subscription_id if binding else (old or {}).get('subId') or secrets.token_urlsafe(24)})
            body={'settings':json.dumps({'clients':[c]})}
            if wanted:body['inboundIds']=wanted
            else:body['noInbounds']=True
            if anchor:
                body['id']=anchor['inboundId']
                await self.request('/panel/api/inbounds/updateClient/'+quote(anchor.get('clientId') or username,safe=''),body)
            elif old:
                await self.request('/panel/api/inbounds/saveAccount',body)
            elif wanted:
                # A client row can be missing while the inbound still carries
                # its config (old interrupted writes). Adding it again would be
                # rejected as a duplicate email, so update the existing entry.
                holder=next((ib['id'] for ib in inbounds if any((c.get('email')==username) for c in parse_clients(ib))),None)
                body['id']=holder or wanted[0]
                try:
                    await self.request('/panel/api/inbounds/addClient',body)
                except RuntimeError:
                    await self.request('/panel/api/inbounds/updateClient/'+quote(username,safe=''),body)
            else:
                await self.request('/panel/api/inbounds/saveAccount',body)
            removed=[m['inboundId'] for m in members if m['inboundId'] not in wanted]
            if removed:
                await self.request('/panel/api/inbounds/bulkMembership',{'data':json.dumps({'op':'removeInbounds','inboundIds':removed,'targets':[{'inboundId':m['inboundId'],'email':username} for m in members]})})
            # SS-2022 PSKs and WG devices are per-inbound extensions, not common
            # account passwords. Update them against their own native schemas.
            current_inbounds,updated=await self.snapshot()
            current_row=next((r for r in updated if r['email']==username),None)
            specialized=False
            for inbound in current_inbounds:
                if inbound['id'] not in wanted:continue
                protocol=inbound['protocol']
                ss_change=protocol=='shadowsocks' and (not old or rotate or settings.get('shadowsocks',{}).get('password')!=previous.get('shadowsocks',{}).get('password'))
                wg_change=protocol=='wireguard' and (rotate or (wg.get('private_key') and wg.get('private_key')!=previous.get('wireguard',{}).get('private_key') and inbound.get('remark')!='AmneziaWG'))
                if not ss_change and not wg_change:continue
                client=next((client for client in json.loads(inbound['settings']).get('clients',[]) if client.get('email')==username),None)
                membership=next((m for m in (current_row or {}).get('memberships',[]) if m['inboundId']==inbound['id']),None)
                if client is None or membership is None:continue
                client=json.loads(json.dumps(client))
                if ss_change:client['password']=settings['shadowsocks']['password']
                if wg_change:
                    from app.utils.crypto import generate_wireguard_keypair
                    if inbound.get('remark')=='AmneziaWG':private_key,public_key=generate_wireguard_keypair()
                    else:
                        private_key=settings['wireguard']['private_key'];public_key=settings['wireguard']['public_key']
                    client.update({'privKey':private_key,'pubKey':public_key})
                    devices=client.get('devices') or []
                    for index,device in enumerate(devices):
                        if index==0:device.update({'privKey':private_key,'pubKey':public_key})
                        elif rotate:
                            pk,pub=generate_wireguard_keypair();device.update({'privKey':pk,'pubKey':pub})
                await self.request('/panel/api/inbounds/updateClient/'+quote(membership.get('clientId') or username,safe=''),{'id':inbound['id'],'inboundIds':wanted,'settings':json.dumps({'clients':[client]})})
                specialized=True
                current_inbounds,updated=await self.snapshot()
                current_row=next((r for r in updated if r['email']==username),None)
            if specialized and wanted:
                membership=next((m for m in (current_row or {}).get('memberships',[]) if m['inboundId']==wanted[0]),None)
                if membership:
                    restored={**body,'id':membership['inboundId']}
                    await self.request('/panel/api/inbounds/updateClient/'+quote(membership.get('clientId') or username,safe=''),restored)
            # Snapshot after success so generated credentials/sub URLs become durable.
            current_inbounds,updated=await self.snapshot()
            row=next((r for r in updated if r['email']==username),None)
            if row:
                ss=next(((ib,next((client for client in json.loads(ib['settings']).get('clients',[]) if client.get('email')==username),None)) for ib in current_inbounds if ib['protocol']=='shadowsocks'),None)
                if ss and ss[1]:
                    settings['shadowsocks']={'password':ss[1]['password'],'method':json.loads(ss[0]['settings']).get('method','chacha20-ietf-poly1305')}
                    user.proxy_settings=json.loads(json.dumps(settings))
                primary_wg=next((next((client for client in json.loads(ib['settings']).get('clients',[]) if client.get('email')==username),None) for ib in current_inbounds if ib['protocol']=='wireguard' and ib.get('remark')!='AmneziaWG'),None)
                if primary_wg and primary_wg.get('privKey'):
                    addresses=primary_wg.get('addresses') or []
                    settings['wireguard']={'private_key':primary_wg['privKey'],'public_key':primary_wg.get('pubKey'),'peer_ips':[addresses] if isinstance(addresses,str) else addresses}
                    user.proxy_settings=json.loads(json.dumps(settings))
                profiles=await self.request('/panel/api/openvpn/profiles')
                snapshot={'account':row,'clients':{str(ib['id']):next((client for client in json.loads(ib['settings']).get('clients',[]) if client.get('email')==username),None) for ib in current_inbounds},'profiles':[p for p in profiles.get('accounts',[]) if p['email']==username],'proxy_settings':settings,'usage_checkpoint':{'up':0,'down':0} if reset else (binding.snapshot or {}).get('usage_checkpoint',{'up':0,'down':0}) if binding else {'up':0,'down':0}}
                if binding is None:
                    db.add(ManagedBinding(username=username,subscription_id=row['subId'],snapshot=snapshot))
                else:
                    binding.snapshot=snapshot
                    binding.subscription_id=row['subId']
                await db.commit()

def parse_clients(inbound):
    try:return json.loads((inbound or {}).get('settings') or '{}').get('clients') or []
    except (TypeError,ValueError):return []


def repair_shadowsocks_udp(db_file=None):
    """The stored Shadowsocks inbounds carry network='tcp', so DNS/QUIC/game UDP
    silently dies through that node (the runtime config is patched to tcp,udp,
    but the database and therefore the panel/config generators were not).
    Idempotent: rewrites only rows that are still wrong."""
    import sqlite3
    path=db_file or os.getenv('PG_MANAGED_RUNTIME_DB','/home/container/vpn/data/vpn-ui.db')
    if not os.path.exists(path):
        return 0
    fixed=0
    try:
        con=sqlite3.connect(path,timeout=8)
        try:
            con.execute('PRAGMA busy_timeout=8000')
            for inbound_id,settings in list(con.execute("SELECT id,settings FROM inbounds WHERE protocol='shadowsocks'")):
                try:
                    parsed=json.loads(settings or '{}')
                except (TypeError,ValueError):
                    continue
                current=str(parsed.get('network') or '').replace(' ','').lower()
                if current=='tcp,udp' or current=='udp,tcp':
                    continue
                parsed['network']='tcp,udp'
                con.execute("UPDATE inbounds SET settings=? WHERE id=?",(json.dumps(parsed),inbound_id))
                fixed+=1
            if fixed:
                con.commit()
        finally:
            con.close()
    except Exception as exc:
        print('[managed] shadowsocks udp repair skipped: '+type(exc).__name__,flush=True)
        return 0
    if fixed:
        print('[managed] repaired %d Shadowsocks inbound(s) to network=tcp,udp' % fixed,flush=True)
    return fixed

runtime=RuntimeDriver()

async def enqueue(username, action='sync'):
    if not ENABLED:return
    async with GetDB() as db:
        if action=='sync':
            binding=(await db.execute(select(ManagedBinding).where(ManagedBinding.username==username))).scalar_one_or_none()
            if binding is None:
                from .transactions import subscription_token
                token=subscription_token(username)
                db.add(ManagedBinding(username=username,subscription_id=token,snapshot={'account':{'subId':token},'clients':{},'profiles':[],'proxy_settings':{}}))
        db.add(ManagedAction(username=username,action=action))
        await db.commit()


def _release_heap():
    """Return freed Python/glibc arenas to the OS after a heavy worker sync.

    On the 308 MB plan a burst of snapshot/apply cycles can leave the
    allocator holding tens of MB of freed arenas; the cgroup OOM killer then
    SIGKILLs the backend and the dashboard shows "Failed to fetch".
    """
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    try:
        import ctypes
        ctypes.CDLL(None).malloc_trim(0)
    except Exception:
        pass


def _cgroup_memory_ratio():
    """Current cgroup memory pressure (0..1); 0 when unavailable."""
    try:
        current = int(Path('/sys/fs/cgroup/memory.current').read_text())
        maximum = int(Path('/sys/fs/cgroup/memory.max').read_text())
        return current / maximum if maximum > 0 else 0.0
    except Exception:
        return 0.0

async def drain():
    if not ENABLED or not WRITES_ENABLED or _lock.locked():return
    # [kbq8] Do not starve the outbox under memory pressure: this box sits
    # near the cgroup ceiling permanently, so a pressure-skip here disabled
    # worker user sync indefinitely. Safety comes from limit=1 + the 45s
    # apply timeout below, not from skipping quota-critical sync.
    # Quota reconciliation is owned by refresh_usage (throttled, and forced on
    # a blocked-signature change). Running it again at the head of every drain
    # made the outbox job hold the runtime lock for a full membership scan and
    # starved the API on this quarter-core box.
    from sqlalchemy import update
    async with _lock:
        async with GetDB() as db:
            statement=select(ManagedAction.id,ManagedAction.username,ManagedAction.action,ManagedAction.status).where(ManagedAction.status.in_(['pending','reset_done']))
            canary=os.getenv('PG_MANAGED_CANARY_PREFIX')
            if canary:statement=statement.where(ManagedAction.username.startswith(canary))
            actions=list((await db.execute(statement.order_by(ManagedAction.id).limit(1))).all())
        for event_id,username,action,status in actions:
            try:
                if action=='reset' and status=='pending':
                    from urllib.parse import quote
                    _,rows=await runtime.snapshot()
                    row=next((r for r in rows if r['email']==username),None)
                    if row and row.get('memberships'):
                        await runtime.request('/panel/api/inbounds/'+str(row['memberships'][0]['inboundId'])+'/resetClientTraffic/'+quote(username,safe=''),{})
                    async with GetDB() as db:
                        await db.execute(update(ManagedAction).where(ManagedAction.id==event_id).values(status='reset_done'))
                        await db.commit()
                # A snapshot of every inbound plus every client page takes ~10-30s on
                # this quarter-core box; 45s turned a slow-but-correct save into a
                # failed action that the user saw as "the panel did not come up".
                await asyncio.wait_for(runtime.apply(username,remove=action=='remove',rotate=action=='revoke',reset=action=='reset'), timeout=150)
                async with GetDB() as db:
                    await db.execute(update(ManagedAction).where(ManagedAction.id==event_id).values(status='applied',error=None))
                    await db.commit()
            except Exception as exc:
                # One user that the worker refuses must never freeze every
                # later action: record the failure, quarantine it after a few
                # attempts and keep draining the queue.
                async with GetDB() as db:
                    await db.execute(update(ManagedAction).where(ManagedAction.id==event_id).values(attempts=ManagedAction.attempts+1,error=type(exc).__name__))
                    await db.execute(update(ManagedAction).where(ManagedAction.id==event_id,ManagedAction.attempts>=8).values(status='failed'))
                    await db.commit()
                continue
            finally:
                _release_heap()
                await asyncio.sleep(0)

_last_refresh_error = 0.0

async def _safe_runtime_request(path, default):
    """Read-only statistics call that never takes the refresh loop down with it."""
    for _ in range(2):
        try:
            value = await asyncio.wait_for(runtime.request(path, {}), timeout=8)
            return default if value is None else value
        except asyncio.CancelledError:
            raise
        except Exception:
            await runtime.close()
            await asyncio.sleep(0.2)
    return default

def _local_client_rows():
    """Per-client usage straight from the protocol worker's SQLite file.

    The worker's HTTP API drops connections and answers 404 for its statistics
    routes, which used to abort the whole refresh; the database is the same
    truth without the round-trips and works while the worker is restarting.
    """
    import sqlite3
    path = os.getenv('PG_MANAGED_RUNTIME_DB', '/home/container/vpn/data/vpn-ui.db')
    if not os.path.exists(path):
        return None
    try:
        con = sqlite3.connect('file:%s?mode=ro' % path, uri=True, timeout=3)
    except Exception:
        return None
    try:
        cur = con.execute("SELECT email, COALESCE(up,0), COALESCE(down,0), COALESCE(expiry_time,0), COALESCE(last_online,0) FROM client_traffics")
        return [
            {'email': row[0], 'up': int(row[1]), 'down': int(row[2]), 'expiryTime': int(row[3]), 'lastOnline': int(row[4])}
            for row in cur.fetchall() if row and row[0]
        ]
    except Exception:
        return None
    finally:
        try: con.close()
        except Exception: pass


_last_accounting = 0.0
_last_blocked_signature = None


async def refresh_usage():
    global _last_refresh_error, _last_accounting, _last_blocked_signature
    if not ENABLED:return
    rows = await asyncio.to_thread(_local_client_rows)
    if rows is None:
        try:
            _, rows = await asyncio.wait_for(runtime.snapshot(), timeout=12)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await runtime.close()
            now=datetime.now(UTC).timestamp()
            if now-_last_refresh_error>60:
                _last_refresh_error=now
                print('[managed] usage refresh skipped: '+type(exc).__name__,flush=True)
            return
    last_online = {row['email']: row['lastOnline'] for row in rows if row.get('lastOnline')}
    if not isinstance(last_online,dict):last_online={}
    async with GetDB() as db:
        users={u.username:u for u in (await db.execute(select(User))).scalars()}
        pending=set((await db.execute(select(ManagedAction.username).where(ManagedAction.status.in_(['pending','reset_done'])))).scalars())
        from .monitoring import update_accounting
        # Per-user usage is refreshed every couple of seconds so the panel is
        # live; the historical usage log and the system counters only move on
        # their own slower cadence to keep the tiny database calm.
        import time as _time
        _now = _time.monotonic()
        if _last_accounting == 0.0:
            _last_accounting = _now
        elif _now - _last_accounting >= 30:
            _last_accounting = _now
            try:
                await update_accounting(db,users,rows,pending)
            except Exception as exc:
                print('[managed] accounting error: '+type(exc).__name__+': '+str(exc)[:120],flush=True)
        for row in rows:
            user=users.get(row['email'])
            if user and row['email'] not in pending:
                user.used_traffic=int(row.get('up',0))+int(row.get('down',0))
                ts=last_online.get(row['email']) or row.get('lastOnline') or 0
                if isinstance(ts,(int,float)) and ts>0:
                    user.online_at=datetime.fromtimestamp(ts/(1000 if ts>100000000000 else 1),UTC)
                if row.get('expiryTime',0)>0:
                    expire=datetime.fromtimestamp(row['expiryTime']/1000,UTC)
                    if user.status==UserStatus.on_hold:
                        user.status=UserStatus.active;user.expire=expire

        # [arena] Absolute admin usage. The stored counter never exceeds the
        # assigned quota, so the panel shows exactly "5 GB / 5 GB" instead of a
        # number above the limit; raising the quota immediately restores the
        # true value, which is recomputed from the users on every tick.
        from app.db.models import Admin as _ArenaAdmin
        blocked_signature=[]
        for _admin in (await db.execute(select(_ArenaAdmin))).scalars():
            _total=sum(int(_u.used_traffic or 0) for _u in users.values() if _u.admin_id==_admin.id)
            _limit=int(getattr(_admin,'data_limit',None) or 0)
            _admin.used_traffic=(min(_total,_limit) if _limit>0 else _total)
            if _limit>0 and _total>=_limit:
                blocked_signature.append((int(_admin.id),_limit))
        await db.commit()

    # Quota enforcement is independent of the ordinary outbox, which may contain
    # unrelated invalid user edits. Its worker operation preserves credentials.
    # A state change (an admin crossing the limit) is applied immediately; the
    # periodic pass only re-checks memberships added later.
    from .quota import reconcile_admin_quotas
    signature=tuple(sorted(blocked_signature))
    force=signature!=_last_blocked_signature
    _last_blocked_signature=signature
    # A newly blocked admin (force) must reconcile immediately regardless of
    # pressure; only the periodic non-force pass may wait for headroom.
    if force or _cgroup_memory_ratio() <= 0.97:
        await reconcile_admin_quotas(force=force)
