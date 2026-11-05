"""Worker actions recorded in the same SQL transaction as native account actions."""
import os,secrets,base64,hashlib,hmac
from sqlalchemy import select

def subscription_token(username,user_id=0):
    # [kb] 3x-ui style sub id (user request): a dedicated short random value
    # per user. The link is http://host:port/sub/<sub_id> and the worker keeps
    # this value verbatim as the account's sub_id.
    alphabet='abcdefghijklmnopqrstuvwxyz0123456789'
    return ''.join(alphabet[b % len(alphabet)] for b in secrets.token_bytes(16))

def queue(db,username,action):
    if os.getenv('PG_MANAGED_ENABLED')=='1':
        from .models import ManagedAction
        db.add(ManagedAction(username=username,action=action))

async def revoke(db,user):
    if os.getenv('PG_MANAGED_ENABLED')!='1':return
    from .models import ManagedBinding
    binding=(await db.execute(select(ManagedBinding).where(ManagedBinding.username==user.username))).scalar_one_or_none()
    if binding:
        binding.subscription_id=subscription_token(user.username,user.id)
        queue(db,user.username,'revoke')
