"""Expose preserved worker configurations through the original PG config API."""
import base64,os
from html.parser import HTMLParser
from urllib.parse import urlsplit
from fastapi import HTTPException,Response
from sqlalchemy import select
from app.db import GetDB
from .models import ManagedBinding

class LinkText(HTMLParser):
    def __init__(self):super().__init__();self.active=False;self.parts=[]
    def handle_starttag(self,tag,attrs):
        if tag=='textarea' and dict(attrs).get('id')=='subscription-links':self.active=True
    def handle_endtag(self,tag):
        if tag=='textarea':self.active=False
    def handle_data(self,data):
        if self.active:self.parts.append(data)

async def response(username,client_type):
    if os.getenv('PG_MANAGED_ENABLED')!='1':return None
    async with GetDB() as db:
        binding=(await db.execute(select(ManagedBinding).where(ManagedBinding.username==username))).scalar_one_or_none()
        token=binding.subscription_id if binding else None
    if not token:return None
    from .runtime import runtime
    session=await runtime.session()
    origin=urlsplit(runtime._base)
    root=origin.scheme+'://'+origin.netloc
    fmt=getattr(client_type,'value',str(client_type))
    if fmt=='wireguard':
        async with session.get(root+'/wg/'+token+'.conf') as r:
            if r.status!=200:raise HTTPException(404,'WireGuard profile is unavailable for this account')
            return Response(await r.read(),media_type='text/plain')
    if fmt not in ['links','links_base64']:
        raise HTTPException(406,'This format is not enabled for the preserved worker subscription. Use its subscription URL or protocol configuration download.')
    async with session.get(root+'/sublink/'+token,headers={'User-Agent':'Mozilla/5.0','Accept':'text/html'}) as r:
        if r.status!=200:raise HTTPException(503,'Worker configuration is pending or unavailable')
        parser=LinkText();parser.feed(await r.text());text=''.join(parser.parts).strip()
    if not text:raise HTTPException(503,'Worker configuration is pending or unavailable')
    if fmt=='links_base64':text=base64.b64encode(text.encode()).decode()
    return Response(text,media_type='text/plain',headers={'Cache-Control':'no-store'})
