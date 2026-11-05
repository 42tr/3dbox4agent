import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'sdk/python/experiment_catalog.py'

class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.db = self.root / 'catalog db.sqlite3'
        self.report = self.root / 'report.json'
        self.raw = '{"format":"3dbox-server-risk-comparison-v1","config":{"sceneId":"园区"},"pairs":[]}\n'.encode()
        self.report.write_bytes(self.raw)
    def tearDown(self): self.tmp.cleanup()
    def call(self, *args, ok=True):
        p = subprocess.run([sys.executable,str(SCRIPT),'--db',str(self.db),*map(str,args)],capture_output=True,text=True)
        self.assertEqual(p.returncode, 0 if ok else 1, p.stderr)
        return json.loads(p.stdout) if ok else p.stderr
    def test_lifecycle_and_duplicate(self):
        first = self.call('add',self.report,'--label','对照实验'); report_id=hashlib.sha256(self.raw).hexdigest()
        self.assertTrue(first['inserted']); self.assertEqual(first['report']['id'],report_id); self.assertEqual(first['report']['scene'],'园区')
        second=self.call('add',self.report,'--label','other'); self.assertFalse(second['inserted']); self.assertEqual(second['report']['label'],'对照实验')
        self.assertEqual(len(self.call('list','--scene','园区')),1); self.assertEqual(self.call('list','--scene','none'),[])
        self.assertEqual(self.call('show',report_id)['format'],'3dbox-server-risk-comparison-v1')
        out=self.root/'output.json'; self.call('export',report_id,out); self.assertEqual(out.read_bytes(),self.raw)
        self.call('export',report_id,out,ok=False); self.assertEqual(out.read_bytes(),self.raw)
        self.assertEqual(self.call('verify'),{'verified':1})
    def test_standard_streams_preserve_bytes(self):
        command=[sys.executable,str(SCRIPT),'--db',str(self.db)]
        added=subprocess.run(command+['add','-','--label=-stream'],input=self.raw,capture_output=True)
        self.assertEqual(added.returncode,0,added.stderr); report_id=json.loads(added.stdout)['report']['id']
        output=subprocess.run(command+['read',report_id],capture_output=True)
        self.assertEqual(output.returncode,0,output.stderr); self.assertEqual(output.stdout,self.raw)
    def test_reject_invalid_input_and_foreign_db(self):
        self.report.write_text('{"format":"3dbox-x","format":"3dbox-y"}'); self.call('add',self.report,ok=False); self.assertFalse(self.db.exists())
        self.report.write_text('{"format":"3dbox-x","value":NaN}'); self.call('add',self.report,ok=False)
        self.report.write_text('{"format":"else"}'); self.call('add',self.report,ok=False)
        with sqlite3.connect(self.db) as con: con.execute('create table valuable_data(x)'); con.execute('insert into valuable_data values (42)')
        before=self.db.read_bytes(); self.report.write_bytes(self.raw); self.call('add',self.report,ok=False); self.assertEqual(self.db.read_bytes(),before)
    def test_corruption_and_missing(self):
        self.call('list',ok=False)
        ident=self.call('add',self.report)['report']['id']; self.call('show','abc',ok=False)
        with sqlite3.connect(self.db) as con: con.execute('update reports set payload=?',(b'X'*len(self.raw),))
        self.assertIn('checksum',self.call('verify',ok=False)); self.call('export',ident,self.root/'out',ok=False); self.assertFalse((self.root/'out').exists())
        self.assertIn('checksum',self.call('add',self.report,ok=False))
    def test_concurrent_writers_and_large_file(self):
        self.call('add',self.report)
        files = []
        for i in range(4):
            path = self.root / f'report-{i}.json'; path.write_text(json.dumps({'format':'3dbox-batch-v1','run':i})); files.append(path)
        children = [subprocess.Popen([sys.executable,str(SCRIPT),'--db',str(self.db),'add',str(path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for path in files]
        for process in children:
            out,err=process.communicate(timeout=20); self.assertEqual(process.returncode,0,err); self.assertTrue(json.loads(out)['inserted'])
        self.assertEqual(self.call('verify'),{'verified':5})
        huge=self.root/'large.json'
        with open(huge,'wb') as stream: stream.truncate(50*1024*1024+1)
        self.assertIn('50 MiB',self.call('add',huge,ok=False)); self.assertEqual(self.call('verify'),{'verified':5})
    def test_cursor_and_filters_with_equal_timestamps(self):
        for i in range(6):
            self.report.write_text(json.dumps({'format':'3dbox-test-v1','config':{'sceneId':'same'},'index':i}))
            self.call('add',self.report,'--label', 'blue' if i % 2 else 'red')
        with sqlite3.connect(self.db) as con:
            con.execute("update reports set created_at='2026-11-02T00:00:00+00:00'")
        all_rows=self.call('list','--scene','same')
        page=self.call('list','--scene','same','--limit',2)
        seen=[]
        while page:
            seen.extend(page)
            last=page[-1]
            page=self.call('list','--scene','same','--limit',2,'--before-created-at',last['created_at'],'--before-id',last['id'])
        self.assertEqual([r['id'] for r in seen],[r['id'] for r in all_rows])
        self.assertEqual(len(self.call('list','--label','blu')),3)
        self.assertEqual(self.call('list','--label','missing'),[])
        self.call('list','--before-id','a'*64,ok=False)
        self.call('list','--before-created-at','invalid','--before-id','a'*64,ok=False)

    def test_read_limit(self):
        self.call('add',self.report)
        self.assertEqual(len(self.call('list','--format','3dbox-server-risk-comparison-v1')),1)
        self.call('list','--limit',0,ok=False)

if __name__=='__main__': unittest.main()
