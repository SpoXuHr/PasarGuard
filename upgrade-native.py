"""Back up the persistent SQLite database before an upstream schema upgrade."""
import os, sqlite3, subprocess, sys, time
path='/persistent/native-data/pasarguard.db'
con=sqlite3.connect(path, timeout=30)
revision=con.execute('select version_num from alembic_version').fetchone()[0]
if revision != '1a2b3c4d5e6f':
    target='/persistent/native-data/pre-upgrade-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'.db'
    dest=sqlite3.connect(target); con.backup(dest)
    assert dest.execute('pragma integrity_check').fetchone()[0]=='ok'
    dest.close();os.chmod(target,0o600)
    print('Safe native pre-upgrade SQLite backup made:',target,flush=True)
con.close()
r=subprocess.run([sys.executable,'-m','alembic','upgrade','head'],cwd='/home/container/pasarguard-native')
if r.returncode: raise SystemExit(r.returncode)
con=sqlite3.connect(path);assert con.execute('pragma integrity_check').fetchone()[0]=='ok';con.close()
