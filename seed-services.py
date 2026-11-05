import json,sqlite3,os
root='/home/container'; path=root+'/managed-inbounds-once.json'
rows=json.load(open(path))
c=sqlite3.connect(root+'/pasarguard-native/data/pasarguard.db',timeout=20)
assert c.execute('select count(*) from managed_services').fetchone()[0]==0
assert c.execute('select count(*) from groups').fetchone()[0]==0
with c:
 for obj in rows:
  tag=obj['tag'];proto=obj['protocol'];label=obj['remark']
  family='AmneziaWG' if label=='AmneziaWG' else 'WireGuard' if proto=='wireguard' else 'OpenVPN' if label=='OpenVPN' else 'Telegram' if proto=='mtproto' else 'V2Ray'
  c.execute('insert or ignore into groups(name,is_disabled) values (?,0)',(family,)) if not c.execute('select 1 from groups where name=?',(family,)).fetchone() else None
  gid=c.execute('select id from groups where name=?',(family,)).fetchone()[0]
  cur=c.execute('insert into inbounds(tag) values (?)',(tag,)); iid=cur.lastrowid
  c.execute('insert into inbounds_groups_association(inbound_id,group_id) values(?,?)',(iid,gid))
  c.execute('insert into managed_services(runtime_id,tag,protocol,config) values(?,?,?,?)',(obj['id'],tag,proto,json.dumps(obj,ensure_ascii=False)))
print('Imported',len(rows),'protocol services and groups')
c.close();os.remove(path)
