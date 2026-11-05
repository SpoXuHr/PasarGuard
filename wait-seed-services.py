import os, time, json, urllib.request, urllib.parse, http.cookiejar, sqlite3, subprocess
root='/home/container';marker='/persistent/services-seeded'
if os.path.exists(marker): raise SystemExit(0)
con=sqlite3.connect('/persistent/native-data/pasarguard.db')
try:
 n=con.execute('select count(*) from managed_services').fetchone()[0]
 if n==10:
  open(marker,'w').write('ready\n');raise SystemExit(0)
 if n!=0: raise SystemExit('Unexpected partial service state: refusing to overwrite')
finally:con.close()
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
for attempt in range(240):
 try:
  body=urllib.parse.urlencode({'username':'GUCCi','password':os.environ['ADMIN_PASSWORD']}).encode()
  with opener.open('http://127.0.0.1:18080/TeamGuccI/login',data=body,timeout=5) as r: logged=json.load(r)
  if not logged.get('success'): raise RuntimeError('UI login not ready')
  with opener.open('http://127.0.0.1:18080/TeamGuccI/panel/api/inbounds/list',timeout=5) as r: result=json.load(r)
  rows=result.get('obj') or []
  if len(rows)!=10: raise RuntimeError('Expected 10 inbounds, got '+str(len(rows)))
  p=root+'/managed-inbounds-once.json';open(p,'w').write(json.dumps(rows));os.chmod(p,0o600)
  subprocess.run([root+'/.venv/bin/python',root+'/seed-services.py'],check=True)
  open(marker,'w').write('ready\n');print('All 10 managed protocol services registered',flush=True);break
 except Exception as e:
  if attempt%10==0: print('Waiting for protocol initialization:',type(e).__name__,str(e)[:120],flush=True)
  time.sleep(5)
else: print('Could not register services; inspect runtime',flush=True)
