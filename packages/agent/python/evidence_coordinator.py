"""Create a survey task from an explicitly delivered anomaly report."""
import argparse
import os
import time

from box_agent import CoordinatorClient, SandboxError
from box_agent.client import CONTROL_HTTP_ORIGIN


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--poll', type=float, default=0.2)
    parser.add_argument('--once', action='store_true', help='check once and exit')
    parser.add_argument('--max-age', type=int, default=60, help='maximum scan age in simulation ticks')
    args = parser.parse_args()
    if not 0.01 <= args.poll <= 60 or not 1 <= args.max_age <= 10000:
        parser.error('poll must be 0.01–60 seconds and max-age 1–10000 ticks')
    client = CoordinatorClient(os.environ['BOX_SESSION'], os.environ['BOX_COORDINATOR_TOKEN'],
                               os.environ.get('BOX_URL', CONTROL_HTTP_ORIGIN))
    while True:
        obs = client.observe()
        session_error = obs.get('sessionError') or obs.get('simulationError')
        if session_error in ('world_step_failed', 'journal_write_failed'):
            raise SandboxError(503, session_error)
        if obs['done']:
            print('实验已结束，未再创建任务。', flush=True)
            return 0
        for evidence in obs.get('evidence', []):
            result = evidence['result']
            if result['kind'] != 'anomaly' or not evidence['canSurvey'] or obs['tick'] - result['observedTick'] > min(args.max_age, 60):
                continue
            task_id = f"evidence-survey-{evidence['id']}"
            prior = next((p for p in obs.get('proposals', []) if p['status'] == 'accepted' and p['task']['id'] == task_id), None)
            if prior:
                continue
            if any(t['id'] == task_id for t in obs.get('knownTasks', [])):
                raise ValueError('evidence task ID already exists')
            response = client.propose_survey(f"evidence-{evidence['id']}-{obs['tick']}", task_id,
                                             '异常位置复勘', evidence['role'], result['position'], 5, obs['tick'], evidence_id=evidence['id'])
            proposal = response['proposal']
            print(f"报告 {evidence['id']}：{proposal['status']} {proposal.get('reason', '')}", flush=True)
            if proposal['status'] == 'accepted':
                return 0
        if args.once:
            print('没有需要处理的已送达异常报告。', flush=True)
            return 0
        time.sleep(args.poll)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (KeyError, ValueError, SandboxError) as error:
        raise SystemExit(f'证据协调器停止：{error}')
