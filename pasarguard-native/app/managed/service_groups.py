"""Service-family choices over the existing PG groups; no membership migration."""
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.db.models import Group
from app.operation.permissions import apply_group_access
from .models import ManagedService

async def options(db,admin):
    groups=(await db.execute(select(Group).options(selectinload(Group.inbounds)))).scalars().all()
    allowed=apply_group_access(admin,[g.id for g in groups])
    groups=[g for g in groups if allowed is None or g.id in allowed]
    services=(await db.execute(select(ManagedService))).scalars().all()
    families={}
    for service in services:
        protocol=service.protocol.lower();name=service.config.get('remark','').lower()
        if 'amnezia' in name or protocol=='amneziawg':family='amneziawg'
        elif protocol=='wireguard':family='wireguard'
        elif protocol in ['openvpn','mixed']:family='openvpn'
        elif protocol=='mtproto' or 'mtproto' in name:family='proxy'
        elif protocol in ['vless','vmess','trojan','shadowsocks','hysteria','hysteria2']:family='v2ray'
        else:continue
        families[service.tag]=family
    labels={'v2ray':'v2ray','wireguard':'WireGuard','openvpn':'OpenVPN','amneziawg':'AmneziaWG','proxy':'Proxy (Telegram)'}
    result=[]
    for family,label in labels.items():
        # A mixed/custom group is kept separately rather than silently broadening its scope.
        members=[g for g in groups if g.inbounds and {families.get(i.tag) for i in g.inbounds}=={family}]
        if members:result.append({'id':family,'name':label,'group_ids':[g.id for g in members],'inbound_count':len({i.tag for g in members for i in g.inbounds})})
    return result
