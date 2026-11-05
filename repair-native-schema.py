import sqlite3
old=sqlite3.connect('/home/container/pasarguard-native/data/pasarguard-empty-backup.db')
new=sqlite3.connect('/home/container/pasarguard-native/data/pasarguard.db')
for name in ('managed_services','managed_bindings','managed_actions'):
 if new.execute("select 1 from sqlite_master where type='table' and name=?",(name,)).fetchone(): continue
 rows=old.execute("select sql from sqlite_master where tbl_name=? and sql is not null order by case type when 'table' then 0 else 1 end",(name,)).fetchall()
 if not rows: raise RuntimeError('Missing expected schema: '+name)
 for (sql,) in rows:new.execute(sql)
 print('Created',name)
new.commit();new.close();old.close()
