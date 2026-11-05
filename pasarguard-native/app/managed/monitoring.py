"""Real container resources and account-counter integration for the managed worker."""
import os,time,json,threading
from pathlib import Path
from datetime import datetime,UTC
from sqlalchemy import select
from .models import ManagedBinding
ROOT=Path(__file__).resolve().parents[2]
_cpu_last=None
_cpu_percent=0.0
_cpu_lock=threading.Lock()
_disk_last=(0.0,None)

# [kb-accrual] last usage this process booked, per email.
_ACCOUNTED = {}

def _accounted_usage():
    return _ACCOUNTED

def memory():
    try:
        total=int(Path('/sys/fs/cgroup/memory.max').read_text())
        current=int(Path('/sys/fs/cgroup/memory.current').read_text())
        return total,min(current,total)
    except (OSError,ValueError):return None

def cpu():
    global _cpu_last,_cpu_percent
    try:
        cores=16.0
        used=int(dict(line.split() for line in Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())['usage_usec'])
        now=time.monotonic()
        with _cpu_lock:
            if _cpu_last and now-_cpu_last[0]>=0.25:
                _cpu_percent=max(0,min(100,(used-_cpu_last[1])/1e6/(now-_cpu_last[0])/0.25*100))
                _cpu_last=(now,used)
            elif _cpu_last is None:_cpu_last=(now,used)
        return cores,_cpu_percent
    except (OSError,ValueError,KeyError,ZeroDivisionError):return None

def disk():
    global _disk_last
    now=time.monotonic()
    if now-_disk_last[0]<300:return _disk_last[1]
    try:
        limits=json.loads((ROOT/'data/resource-limits.json').read_text())
        total=int(limits.get('disk_bytes') or 0);used=0
        if total<=0:
            st=os.statvfs('/');total=st.f_blocks*st.f_frsize
        for parent,dirs,files in os.walk(limits['disk_path'],followlinks=False):
            for name in files:
                try:used+=os.stat(os.path.join(parent,name),follow_symlinks=False).st_size
                except OSError:pass
        result=(total,used)
    except (OSError,ValueError,KeyError):result=None
    _disk_last=(now,result)
    return result

# [kb-accrual] The historical table must accrue against the last value THIS
# module booked, not against users.used_traffic: the 5s live loop writes
# that column first, so a 30s comparison only ever saw a 5s window and
# every history chart undercounted by roughly six times.
async def update_accounting(db,users,rows,pending):
    from app.db.models import System,Admin,AdminUsageLogs,NodeUserUsage
    valid=[r for r in rows if r['email'] in users and r['email'] not in pending]
    system=(await db.execute(select(System))).scalar_one_or_none()
    if system is None:system=System();db.add(system)
    seed_system=system.uplink+system.downlink==0
    if seed_system:
        system.uplink=sum(int(r.get('up',0)) for r in valid)
        system.downlink=sum(int(r.get('down',0)) for r in valid)
    accounted=_accounted_usage()
    # [arena] absolute admin usage
    # admin totals are recomputed absolutely in runtime.refresh_usage();
    # additive deltas here undercount whenever a cycle is skipped.
    bindings={b.username:b for b in (await db.execute(select(ManagedBinding))).scalars()}
    now=datetime.now(UTC);bucket=now.replace(minute=(now.minute//10)*10,second=0,microsecond=0)
    logs={r.user_id:r for r in (await db.execute(select(NodeUserUsage).where(NodeUserUsage.created_at==bucket,NodeUserUsage.node_id.is_(None)))).scalars()}
    for row in valid:
        user=users[row['email']];up=int(row.get('up',0));down=int(row.get('down',0))
        total_now=up+down
        previous=accounted.get(row['email'])
        if previous is None:
            # First sight after a restart: fall back to the stored counter
            # so a restart never re-books a user's whole history.
            delta=max(0,total_now-int(user.used_traffic or 0))
        elif total_now>=previous:
            delta=total_now-previous
        else:
            # A reset moved the counter backwards; book nothing and re-anchor.
            delta=0
        accounted[row['email']]=total_now
        if delta:
            if user.id in logs:logs[user.id].used_traffic+=delta
            else:db.add(NodeUserUsage(created_at=bucket,user_id=user.id,node_id=None,used_traffic=delta))
        binding=bindings.get(row['email'])
        if binding:
            snapshot=json.loads(json.dumps(binding.snapshot or {}))
            previous=snapshot.get('usage_checkpoint')
            if previous is not None and not seed_system:
                system.uplink+=max(0,up-previous.get('up',0));system.downlink+=max(0,down-previous.get('down',0))
            snapshot['usage_checkpoint']={'up':up,'down':down};binding.snapshot=snapshot
