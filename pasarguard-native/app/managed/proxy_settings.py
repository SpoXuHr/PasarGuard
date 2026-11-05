"""Validate PG credentials against the preserved server-side cipher contract."""
import os,json,base64,secrets
from sqlalchemy import select
from .models import ManagedService

async def prepare(db,proxy_settings,groups,*,new=False,rotate=False,existing_user_id=None):
    if os.getenv('PG_MANAGED_ENABLED')!='1':return proxy_settings
    tags=set()
    for group in groups:
        tags.update(i.tag for i in await group.awaitable_attrs.inbounds)
    services=(await db.execute(select(ManagedService).where(ManagedService.tag.in_(tags),ManagedService.protocol=='shadowsocks'))).scalars()
    for service in services:
        method=json.loads(service.config['settings']).get('method')
        sizes={'2022-blake3-aes-128-gcm':16,'2022-blake3-aes-256-gcm':32,'2022-blake3-chacha20-poly1305':32}
        size=sizes.get(method)
        if not size:continue
        # Cipher belongs to the inbound, not to the user's form defaults.
        # Membership-only edits must never fail on stale per-user metadata.
        proxy_settings.shadowsocks.method=method
        password=proxy_settings.shadowsocks.password
        try:valid=len(base64.b64decode(password,validate=True))==size
        except (ValueError,TypeError):valid=False
        existing_client=None
        current_password=None
        if existing_user_id is not None:
            from app.db.models import User
            from .models import ManagedBinding
            current_user=await db.get(User,existing_user_id)
            current_password=(current_user.proxy_settings or {}).get('shadowsocks',{}).get('password') if current_user else None
            binding=(await db.execute(select(ManagedBinding).where(ManagedBinding.username==current_user.username))).scalar_one_or_none() if current_user else None
            existing_client=(binding.snapshot or {}).get('clients',{}).get(str(service.runtime_id)) if binding else None
        preserved_password=(existing_client or {}).get('password')
        try:preserved_valid=len(base64.b64decode(preserved_password,validate=True))==size
        except (ValueError,TypeError):preserved_valid=False
        if not valid and not rotate and preserved_valid and password==current_password:
            proxy_settings.shadowsocks.password=preserved_password
            valid=True
        if rotate or (new and not valid) or (not valid and existing_user_id is not None and existing_client is None):
            proxy_settings.shadowsocks.password=base64.b64encode(secrets.token_bytes(size)).decode()
        elif not valid:
            raise ValueError(f'This managed Shadowsocks inbound requires a base64 {size}-byte PSK for {method}')
        proxy_settings.shadowsocks.method=method
    return proxy_settings

async def backfill(db):
    """Correct PG's cipher metadata from existing bindings; never writes to workers."""
    from app.db.models import User
    from .models import ManagedBinding
    services=list((await db.execute(select(ManagedService).where(ManagedService.protocol=='shadowsocks'))).scalars())
    for binding in (await db.execute(select(ManagedBinding))).scalars():
        snapshot=json.loads(json.dumps(binding.snapshot or {}))
        for service in services:
            client=snapshot.get('clients',{}).get(str(service.runtime_id))
            if not client or not client.get('password'):continue
            method=json.loads(service.config['settings']).get('method')
            if not method:continue
            user=(await db.execute(select(User).where(User.username==binding.username))).scalar_one_or_none()
            if not user:continue
            settings=json.loads(json.dumps(user.proxy_settings or {}))
            settings['shadowsocks']={'password':client['password'],'method':method}
            user.proxy_settings=settings
            snapshot.setdefault('proxy_settings',{})['shadowsocks']=settings['shadowsocks'].copy()
            binding.snapshot=snapshot
    await db.commit()
