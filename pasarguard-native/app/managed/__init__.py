"""Optional real PasarGuard protocol-worker management extension."""
import asyncio
import os


def _sub_origin():
    """Public origin for subscription links.

    Order: PG_MANAGED_SUB_ORIGIN, then the address the launcher detected on this
    boot (vpn/data/public-host.txt), then SERVER_IP, then loopback. Nothing is
    tied to a specific machine, so a moved panel never shows dead links.
    """
    env = (os.getenv('PG_MANAGED_SUB_ORIGIN') or '').strip()
    if env:
        return env
    host = ''
    for path in ('/home/container/vpn/data/public-host.txt', 'vpn/data/public-host.txt'):
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                host = fh.read().strip()
        except OSError:
            host = ''
        if host:
            break
    if not host:
        host = (os.getenv('SERVER_IP') or os.getenv('PANEL_HOST') or '127.0.0.1').strip()
    port = (os.getenv('SERVER_PORT') or os.getenv('PORT') or '20250').strip()
    host = host.replace('http://', '').replace('https://', '').split('/')[0].split(':')[0]
    scheme = (os.getenv('PG_MANAGED_SUB_SCHEME') or 'http').strip().lower()
    if scheme not in ('http', 'https'):
        scheme = 'http'
    return '%s://%s:%s' % (scheme, host or '127.0.0.1', port or '20250')

async def subscription_url(username, db=None):
    if os.getenv('PG_MANAGED_ENABLED') != '1':return None
    from sqlalchemy import select
    from app.db import GetDB
    from .models import ManagedBinding
    async def lookup(session):
        token=(await session.execute(select(ManagedBinding.subscription_id).where(ManagedBinding.username==username))).scalar_one_or_none()
        if not token:return None
        # [kb] user request (3x-ui style): http://host:port/sub/<sub_id> where
        # sub_id is the user's own dedicated sub id.
        return _sub_origin().rstrip('/')+'/sub/'+token

    # Reuse the request transaction: opening child sessions while its parent
    # holds a pooled connection can exhaust the pool under dashboard polling.
    if db is not None:
        return await lookup(db)
    async with GetDB() as session:
        return await lookup(session)

async def tags():
    if os.getenv('PG_MANAGED_ENABLED') != '1':return []
    from sqlalchemy import select
    from app.db import GetDB
    from .models import ManagedService
    async with GetDB() as db:
        return list((await db.execute(select(ManagedService.tag))).scalars())

def install(app):
    if os.getenv('PG_MANAGED_ENABLED') != '1':return
    from fastapi import APIRouter, Depends, HTTPException, Body, Request
    from sqlalchemy import select
    from app import on_startup,on_shutdown,scheduler
    from app.db import GetDB
    from app.db.base import engine
    from app.models.admin import AdminDetails
    from app.routers.authentication import require_permission
    from .models import ManagedService,ManagedBinding,ManagedAction
    from .runtime import runtime,drain,refresh_usage
    router=APIRouter(prefix='/api/managed',tags=['Managed protocol workers'])
    def owner(admin):
        if not admin.role or not admin.role.is_owner:raise HTTPException(403,'Owner permission required')
    @router.get('/service-groups')
    async def service_groups(admin:AdminDetails=Depends(require_permission('groups','read'))):
        from .service_groups import options
        async with GetDB() as db:return await options(db,admin)
    # ---- پنل اختصاصی هر مدیر (آدرس /<pass>/) --------------------------------
    @router.get('/admin-panels')
    async def admin_panels(admin:AdminDetails=Depends(require_permission('admins','read'))):
        from .admin_panels import list_panels
        async with GetDB() as db:return await list_panels(db,_sub_origin())
    @router.post('/admin-panels/{admin_id}/rotate')
    async def rotate_admin_panel(admin_id:int,admin:AdminDetails=Depends(require_permission('admins','update'))):
        from .admin_panels import list_panels,rotate
        async with GetDB() as db:
            rotate(db,admin_id)
            return await list_panels(db,_sub_origin())
    @router.post('/admin-session')
    async def admin_session(request:Request,payload:dict=Body(...)):
        """توکن نشست یک مدیر از روی پسورد پنلش؛ فقط لبه با هدر مشترک."""
        import hmac as _hmac
        from app.db.models import Admin
        from app.utils.jwt import create_admin_token
        from .admin_panels import edge_secret,find_by_pass
        given=str(request.headers.get('x-pg-edge') or '')
        if not _hmac.compare_digest(given,edge_secret()):raise HTTPException(403,'edge secret required')
        entry=find_by_pass(str(payload.get('pass') or ''))
        if not entry:raise HTTPException(404,'unknown panel')
        async with GetDB() as db:
            row=(await db.execute(select(Admin).where(Admin.id==int(entry['admin_id'])))).scalar_one_or_none()
            if not row:raise HTTPException(404,'unknown panel')
            from app.db.models import AdminRole as _AdminRole
            _is_owner=bool((await db.execute(select(_AdminRole.is_owner).where(_AdminRole.id==row.role_id))).scalar()) if row.role_id else False
            if not _is_owner:
                from .admin_panels import admin_expired as _panel_expired
                from .quota import admin_blocked as _panel_blocked
                if _panel_blocked(row) or _panel_expired(row.id):raise HTTPException(404,'unknown panel')
            token=await create_admin_token(row.id,row.username,row.hashed_password)
            return {'access_token':token,'admin_id':int(row.id),'username':row.username,
                    'status':str(getattr(row,'status','active'))}
    # ---- محدودیت زمانی مدیر (تاریخ انقضا) -----------------------------------
    @router.post('/admin-panels/{admin_id}/expiry')
    async def set_admin_expiry(admin_id:int,payload:dict=Body(...),admin:AdminDetails=Depends(require_permission('admins','update'))):
        from .admin_panels import list_panels,set_expiry
        async with GetDB() as db:
            await list_panels(db,_sub_origin())          # make sure every admin has an entry
            try:
                set_expiry(db,admin_id,payload or {})
            except KeyError:
                raise HTTPException(404,'admin panel not found')
            except ValueError as exc:
                raise HTTPException(400,str(exc))
            return await list_panels(db,_sub_origin())
    @router.get('/services')
    async def services(admin:AdminDetails=Depends(require_permission('system','read'))):
        owner(admin)
        async with GetDB() as db:
            return [{'id':r.runtime_id,'tag':r.tag,'protocol':r.protocol,'config':r.config} for r in (await db.execute(select(ManagedService))).scalars()]
    @router.put('/services/{runtime_id}')
    async def update_service(runtime_id:int,config:dict=Body(...),admin:AdminDetails=Depends(require_permission('cores','update'))):
        owner(admin)
        from .runtime import WRITES_ENABLED
        if not WRITES_ENABLED:raise HTTPException(503,'Staging: runtime writes are disabled')
        async with GetDB() as db:
            row=(await db.execute(select(ManagedService).where(ManagedService.runtime_id==runtime_id))).scalar_one_or_none()
            if not row:raise HTTPException(404,'Not found')
            if config.get('id',runtime_id)!=runtime_id:raise HTTPException(400,'Inbound identity cannot be changed')
            if config.get('protocol',row.config['protocol'])!=row.config['protocol']:raise HTTPException(400,'Protocol changes require an explicit migration')
            fields={**row.config,**config}
            fields.pop('clientStats',None)
            for key in ['settings','streamSettings','sniffing']:
                if isinstance(fields.get(key),dict):
                    import json
                    fields[key]=json.dumps(fields[key])
            await runtime.request('/panel/api/inbounds/update/'+str(runtime_id),fields)
            inbounds,_=await runtime.snapshot()
            row.config=next(i for i in inbounds if i['id']==runtime_id)
            await db.commit()
            return {'applied':True}
    @router.get('/user/{username}/openvpn')
    async def get_openvpn_credentials(username:str,admin:AdminDetails=Depends(require_permission('users','update'))):
        owner(admin)
        def pick(profiles):
            return next((p for p in profiles.get('accounts',[]) if p['email'].lower()==username.lower()),None)
        async def fetch(refresh=False):
            path='/panel/api/openvpn/profiles'+('?refresh=1' if refresh else '')
            try:
                return await runtime.request(path)
            except Exception:
                return {}
        # A user created a second ago is not mirrored into the worker database yet,
        # so the first look-up asks the runtime to reconcile and we then poll for a
        # few seconds instead of answering the dashboard with a 404.
        profiles=await fetch(True)
        row=pick(profiles)
        for _attempt in range(5):
            if row:
                break
            await asyncio.sleep(1.2)
            row=pick(await fetch(_attempt >= 1))
        if not row:raise HTTPException(404,'OpenVPN account not found')
        from fastapi.responses import JSONResponse
        return JSONResponse({'username':row['username'],'password':row['password']},headers={'Cache-Control':'no-store'})
    @router.put('/user/{username}/openvpn')
    async def openvpn_credentials(username:str,credentials:dict=Body(...),admin:AdminDetails=Depends(require_permission('users','update'))):
        owner(admin)
        from .runtime import WRITES_ENABLED
        if not WRITES_ENABLED:raise HTTPException(503,'Staging: runtime writes are disabled')
        if not credentials.get('username') or not credentials.get('password'):raise HTTPException(400,'Username and password are required')
        if any(not isinstance(credentials[k],str) or len(credentials[k])>64 or any(c in credentials[k] for c in '\r\n\x00') for k in ['username','password']):raise HTTPException(400,'Credentials must be 1–64 characters without line breaks')
        return await runtime.request('/panel/api/openvpn/credentials',json_body={'email':username,'username':credentials['username'],'password':credentials['password']})
    @router.get('/user/{username}')
    async def binding(username:str,admin:AdminDetails=Depends(require_permission('users','read'))):
        owner(admin)
        async with GetDB() as db:
            row=(await db.execute(select(ManagedBinding).where(ManagedBinding.username==username))).scalar_one_or_none()
            if not row:raise HTTPException(404,'Not found')
            return {'username':row.username,'snapshot':row.snapshot}
    @router.get('/queue')
    async def queue(admin:AdminDetails=Depends(require_permission('system','read'))):
        owner(admin)
        async with GetDB() as db:
            return [{'id':r.id,'username':r.username,'action':r.action,'status':r.status,'attempts':r.attempts,'error':r.error} for r in (await db.execute(select(ManagedAction).order_by(ManagedAction.id.desc()).limit(100))).scalars()]
    app.include_router(router)
    @on_startup
    async def start():
        async with engine.begin() as conn:
            for table in [ManagedService.__table__,ManagedBinding.__table__,ManagedAction.__table__]:
                await conn.run_sync(lambda sync_conn,t=table:t.create(sync_conn,checkfirst=True))
        from .proxy_settings import backfill
        async with GetDB() as db:
            await backfill(db)
        # [kb] UDP must work on the Shadowsocks node too (see repair_shadowsocks_udp).
        try:
            from .runtime import repair_shadowsocks_udp
            repair_shadowsocks_udp()
        except Exception:
            pass
        # First usage sync runs from _usage_loop seconds after startup; doing
        # it inline here spikes CPU/RAM during the fragile boot window (308 MB plan).
        import gc
        def release_unused_heap():
            gc.collect()
            try:
                import ctypes
                ctypes.CDLL(None).malloc_trim(0)
            except (AttributeError,OSError):
                pass
            try:
                _rss='?'
                for _line in open('/proc/self/status',encoding='utf8',errors='ignore'):
                    if _line.startswith('VmRSS:'):_rss=_line.split()[1];break
                _cur=open('/sys/fs/cgroup/memory.current',encoding='utf8',errors='ignore').read().strip()
                _max=open('/sys/fs/cgroup/memory.max',encoding='utf8',errors='ignore').read().strip()
                _st={}
                for _kv in open('/sys/fs/cgroup/memory.stat',encoding='utf8',errors='ignore'):
                    _parts=_kv.split()
                    if len(_parts)==2:_st[_parts[0]]=_parts[1]
                print(f"[kb-mem] backend VmRSS={_rss}kB cgroup={_cur}/{_max} anon={_st.get('anon','?')} file={_st.get('file','?')} slab={_st.get('slab','?')}",flush=True)
            except Exception:
                pass
        release_unused_heap()
        scheduler.add_job(release_unused_heap,'interval',seconds=20,id='managed-memory-trim',replace_existing=True,max_instances=1,coalesce=True)
        scheduler.add_job(drain,'interval',seconds=5,id='managed-runtime-outbox',replace_existing=True,max_instances=1,coalesce=True)
        # refresh_usage is driven only by the single-flight _usage_loop below;
        # a second APScheduler tick used to run it concurrently with itself.
        # Also drive the refresh from our own task: the shared APScheduler can be
        # shared with a not-yet-started instance, and a missed tick then leaves
        # every user stuck on an old "online/usage" value for minutes.
        if getattr(app.state,'managed_usage_loop',None) is None:
            async def _usage_loop():
                while True:
                    try:
                        await asyncio.sleep(5)
                        await refresh_usage()
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        print('[managed] usage loop error: '+type(exc).__name__+': '+str(exc)[:160],flush=True)
                        await asyncio.sleep(5)
            app.state.managed_usage_loop=asyncio.create_task(_usage_loop())
    on_shutdown(runtime.close)

async def inbound_metadata():
    if os.getenv('PG_MANAGED_ENABLED')!='1':return {}
    import json
    from sqlalchemy import select
    from app.db import GetDB
    from .models import ManagedService
    async with GetDB() as db:
        rows=list((await db.execute(select(ManagedService))).scalars())
    result={}
    for row in rows:
        config=row.config
        stream=json.loads(config.get('streamSettings') or '{}')
        result[row.tag]={'tag':row.tag,'protocol':row.protocol,'network':stream.get('network','udp' if row.protocol in ['wireguard','amneziawg','hysteria'] else 'tcp'),'tls':stream.get('security','none'),'port':config['port'],'managed_runtime_id':row.runtime_id}
    return result
