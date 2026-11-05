#!/bin/bash
set -eu
cd /home/container/pasarguard-native
export PYTHONPATH="/home/container/pasarguard-native/pylibs:/home/container/pasarguard-native"
export PYTHONDONTWRITEBYTECODE=1
PY=/home/container/.venv/bin/python
$PY - <<'INNER'
import sqlite3
c=sqlite3.connect('data/pasarguard.db')
for table in ('admins','users','settings','admin_roles','jwt'):
 if c.execute('select count(*) from '+table).fetchone()[0]: raise SystemExit('Existing data found; refusing to rebuild database')
print('Empty native database confirmed')
INNER
rm -f data/fresh-build.db data/fresh-build.db-wal data/fresh-build.db-shm
export SQLALCHEMY_DATABASE_URL=sqlite+aiosqlite:////home/container/pasarguard-native/data/fresh-build.db
$PY -m alembic upgrade head
$PY - <<'INNER'
import sqlite3, json, bcrypt, datetime, os
u,p='GUCCi',os.environ['ADMIN_PASSWORD']
c=sqlite3.connect('data/fresh-build.db')
assert c.execute('select count(*) from settings').fetchone()[0] == 1
assert c.execute('select count(*) from jwt').fetchone()[0] == 1
assert c.execute('select count(*) from admin_roles where id=1 and is_owner=1').fetchone()[0] == 1
assert c.execute('select count(*) from admins').fetchone()[0] == 0
hashed=bcrypt.hashpw(p.encode(),bcrypt.gensalt(rounds=10)).decode()
c.execute('insert into admins (username,hashed_password,created_at,role_id,used_traffic,status) values (?,?,?,?,?,?)',(u,hashed,datetime.datetime.now(datetime.timezone.utc).isoformat(),1,0,'active'))
c.commit();c.execute('PRAGMA wal_checkpoint(TRUNCATE)');c.close()
os.rename('data/pasarguard.db','data/pasarguard-empty-backup.db')
os.rename('data/fresh-build.db','data/pasarguard.db')
print('Native database initialized and owner created')
INNER
