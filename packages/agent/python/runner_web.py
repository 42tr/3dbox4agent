"""Run the built-in experiment worker and expose its health over HTTP."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Lock, Thread
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote

from box_agent.client import CONTROL_HTTP_ORIGIN
from multi_agent_demo import run_managed
from planner_demo import SCENES
from runner_client import RunClient, RunnerControl, lease_rejected


CAPABILITIES = {
    'scenes': list(SCENES),
    'physics': ['kinematic', 'rapier'],
    'faults': ['none', 'transport', 'recoverable', 'resident'],
    'strategies': ['planner'],
    'maxCoordinators': 4,
    'concurrency': 1,
}


class Worker:
    def __init__(self, control, runner_id, token, stop):
        self.control = control
        self.route = '/runners/' + quote(runner_id, safe='')
        self.token = token
        self.stop = stop
        self.lock = Lock()
        self.state = {'registered': False, 'runId': None, 'protocolVersion': 1}

    def update(self, **changes):
        with self.lock:
            self.state.update(changes)

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    def serve(self):
        while not self.stop.is_set():
            try:
                self.control.request(self.route + '/register', body={
                    'protocolVersion': 1, 'capabilities': CAPABILITIES,
                }, token=self.token)
                self.update(registered=True)
                while not self.stop.is_set():
                    job = self.control.request(self.route + '/claim', token=self.token)['job']
                    if job is None:
                        self.stop.wait(0.5)
                        continue
                    self.update(runId=job['runId'])
                    try:
                        self.run(job)
                    finally:
                        self.update(runId=None)
            except (OSError, ValueError, KeyError) as error:
                self.update(registered=False)
                print(f'Runner unavailable: {error}', file=sys.stderr, flush=True)
                self.stop.wait(2)

    def run(self, job):
        client = RunClient(self.control, job['runId'], job['leaseToken'])
        environment = {key: value for key, value in os.environ.items()
                       if key not in ('BOX_RUNNER_TOKEN', 'BOX_RUNNER_TOKEN_FILE')}
        environment['BOX_CONTROL_URL'] = self.control.base
        process = subprocess.Popen(
            [sys.executable, __file__, '--execute'], env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, text=True,
        )
        try:
            with process.stdin:
                process.stdin.write(json.dumps(job))
            renew_at = time.monotonic() + min(2, job['leaseSeconds'] / 3)
            expires = time.monotonic() + job['leaseSeconds']
            while process.poll() is None:
                if self.stop.wait(0.1):
                    return
                if time.monotonic() < renew_at:
                    continue
                try:
                    client.renew()
                except (URLError, TimeoutError) as error:
                    if lease_rejected(error) or time.monotonic() >= expires:
                        return
                    renew_at = time.monotonic() + 0.5
                    continue
                renew_at = time.monotonic() + 2
                expires = time.monotonic() + job['leaseSeconds']
            if process.returncode == 0:
                outcome = json.load(process.stdout)
            else:
                outcome = {'status': 'failed', 'reason': 'runner_process_failed'}
            while not self.stop.is_set():
                try:
                    client.finish(outcome['status'], outcome.get('reason'))
                    return
                except (URLError, TimeoutError) as error:
                    if lease_rejected(error) or time.monotonic() >= expires:
                        return
                    self.stop.wait(0.5)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            process.stdout.close()


def serve(control, runner_id, token, host, port):
    stop = Event()
    worker = Worker(control, runner_id, token, stop)

    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != '/health':
                self.send_error(404)
                return
            state = worker.snapshot()
            payload = json.dumps({'ok': state['registered'], **state}).encode()
            self.send_response(200 if state['registered'] else 503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    def stop_signal(*_args):
        stop.set()

    signal.signal(signal.SIGINT, stop_signal)
    signal.signal(signal.SIGTERM, stop_signal)
    with ThreadingHTTPServer((host, port), HealthHandler) as server:
        server.timeout = 0.5
        print(f'Runner listening on {host}:{server.server_port}', flush=True)
        thread = Thread(target=worker.serve, daemon=True)
        thread.start()
        while not stop.is_set():
            server.handle_request()
        thread.join(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    control = RunnerControl(os.environ.get('BOX_CONTROL_URL', CONTROL_HTTP_ORIGIN))
    if args.execute:
        def terminate(*_args):
            raise SystemExit(1)

        signal.signal(signal.SIGTERM, terminate)
        job = json.load(sys.stdin)
        client = RunClient(control, job['runId'], job['leaseToken'])
        try:
            status, reason = run_managed(job['config'], client)
        except HTTPError as error:
            if lease_rejected(error):
                return 1
            reason = getattr(error, 'runner_code', None)
            if not reason:
                try:
                    reason = json.load(error).get('error', 'runner_world_error')
                except (ValueError, AttributeError):
                    reason = 'runner_world_error'
            status = 'failed'
        except (OSError, ValueError, KeyError) as error:
            print(f'Experiment failed: {error}', file=sys.stderr)
            status, reason = 'failed', 'runner_experiment_error'
        print(json.dumps({'status': status, 'reason': reason}), flush=True)
        return 0
    token = os.environ.get('BOX_RUNNER_TOKEN')
    if not token:
        token_file = os.environ.get('BOX_RUNNER_TOKEN_FILE')
        if token_file:
            token = Path(token_file).read_text().strip()
    if not token:
        parser.error('set BOX_RUNNER_TOKEN or BOX_RUNNER_TOKEN_FILE')
    serve(control, os.environ.get('BOX_RUNNER_ID', 'builtin'), token,
          os.environ.get('BOX_RUNNER_BIND', '127.0.0.1'), int(os.environ.get('BOX_RUNNER_PORT', '8790')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
