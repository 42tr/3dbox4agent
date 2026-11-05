"""Protocol 2 example: propose a survey from a fresh delivered anomaly, else assign."""
import hashlib
import json
import sys

obs = json.load(sys.stdin)
known = {task['id'] for task in obs.get('knownTasks', [])}
choice = None
for report in obs.get('evidence', []):
    result = report['result']
    task_id = f"evidence-policy-{report['id']}"
    if result['kind'] == 'anomaly' and report['canSurvey'] and obs['tick'] - result['observedTick'] <= 60 and task_id not in known:
        choice = {'type':'propose_survey', 'evidenceId':report['id'], 'task':{'id':task_id, 'name':'异常位置复勘', 'role':report['role'], 'target':result['position'], 'duration':5, 'dependsOn':[]}}
        break
if choice is None:
    for report in obs.get('fixedSensorReports', []):
        if not report.get('reportId'):
            continue
        task_id = "sensor-policy-" + hashlib.sha256(report['sensorId'].encode()).hexdigest()[:16]
        if report['result'] == 'anomaly' and report.get('surveyRoles') and obs['tick'] - report['observedTick'] <= 60 and task_id not in known:
            choice = {'type':'propose_survey', 'sensorEvidenceId':report['reportId'], 'task':{'id':task_id, 'name':'固定传感器异常复勘', 'role':report['surveyRoles'][0], 'target':report['position'], 'duration':5, 'dependsOn':[]}}
            break
if choice is None:
    for report in obs.get('sampleReports', []):
        task_id = 'sample-policy-' + hashlib.sha256(report['taskId'].encode()).hexdigest()[:16]
        if report.get('surveyRoles') and 0 <= obs['tick'] - report['collectedTick'] <= 60 and task_id not in known:
            choice = {'type':'propose_survey', 'sampleReportId':report['id'], 'task':{'id':task_id, 'name':'采样地点复勘', 'role':report['surveyRoles'][0], 'target':report['position'], 'duration':5, 'dependsOn':[]}}
            break
if choice is None:
    for task in obs['tasks']:
        if task['candidates']:
            agent = sorted(task['candidates'], key=lambda a:(-a['battery'],a['id']))[0]
            choice = {'taskId':task['id'], 'agentId':agent['id']}
            break
json.dump(choice, sys.stdout, ensure_ascii=False)
