"""Search a supplied patrol route and report the first observed anomaly."""
import argparse
import os
import time
from box_agent import AgentClient, SandboxError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--waypoint', type=float, nargs=2, action='append', required=True, metavar=('X','Y'))
    parser.add_argument('--poll', type=float, default=.03)
    parser.add_argument('--lead-ticks', type=int, default=1)
    args = parser.parse_args()
    if not .01 <= args.poll <= 60 or not 1 <= args.lead_ticks <= 50:
        parser.error('invalid poll interval or lead-ticks')
    client = AgentClient(os.environ['BOX_SESSION'], os.environ['BOX_AGENT'], os.environ['BOX_TOKEN'], os.environ['BOX_URL'])
    def wait_for(collection, request_id):
        while True:
            obs = client.observe()
            item = next((a for a in obs.get(collection, []) if a['requestId'] == request_id), None)
            if item and item['status'] in ('completed', 'delivered', 'failed', 'rejected', 'cancelled'):
                return item
            if obs['done']:
                raise ValueError('world ended before operation completed')
            time.sleep(args.poll)
    def submit_action(kind, request_id, x=None, y=None):
        for _ in range(5):
            tick = client.observe()['tick'] + args.lead_ticks
            try:
                if kind == 'move':
                    return client.move_to(request_id, x, y, tick, tick + 40)
                return client.scan(request_id, tick, tick + 40)
            except SandboxError as error:
                if error.status != 409 or error.code != 'invalid_schedule':
                    raise
        raise ValueError('could not schedule action within five attempts')
    if len(args.waypoint) > 20 or any(not 0 <= coordinate <= 100 for point in args.waypoint for coordinate in point):
        parser.error('provide at most 20 waypoints within 0–100')
    scan_id = None
    for index, (x, y) in enumerate(args.waypoint, start=1):
        move_id = f'patrol-move-{index}'
        submit_action('move', move_id, x, y)
        move = wait_for('actions', move_id)
        if move['status'] != 'completed':
            raise ValueError(f"patrol movement {index} failed: {move.get('reason')}")
        scan_id = f'patrol-scan-{index}'
        submit_action('scan', scan_id)
        scan = wait_for('actions', scan_id)
        if scan['status'] != 'completed':
            raise ValueError(f"patrol scan {index} failed: {scan.get('reason')}")
        memory = client.read_memory()
        previous = memory['value'].get('patrolScans', [])
        client.write_memory({**memory['value'], 'patrolScans': [*previous, {'waypoint': [x, y], 'result': scan['result']}]}, memory['revision'])
        print(f"巡检点 {index}：{scan['result']['kind']}，已保存本设备记忆。", flush=True)
        if scan['result']['kind'] == 'anomaly':
            break
    else:
        raise ValueError('no anomaly detected along patrol route')
    for attempt in range(1, 6):
        report_id = 'patrol-report-' + str(attempt)
        client.report_scan(report_id, scan_id)
        report = wait_for('evidenceReports', report_id)
        print(f"报告 {attempt}: {report['status']} {report.get('reason', '')}", flush=True)
        if report['status'] == 'delivered':
            return 0
    raise ValueError('evidence delivery failed after five attempts')


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (KeyError, ValueError, SandboxError) as error:
        raise SystemExit(f'巡检设备停止：{error}')
