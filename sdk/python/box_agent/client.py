"""Observe and send messages without access to the global world API."""
import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


class SandboxError(Exception):
    def __init__(self, status, code):
        self.status = status
        self.code = code
        super().__init__(f"sandbox request failed ({status}): {code}")


class AgentClient:
    def __init__(self, session_id, agent_id, token, base_url='http://127.0.0.1:8787', timeout=5):
        parsed = urlsplit(base_url)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
            raise ValueError('base_url must be an HTTP loopback origin')
        if not all(isinstance(x, str) and x for x in (session_id, agent_id, token)):
            raise ValueError('session_id, agent_id and token are required')
        self._base = base_url.rstrip('/')
        self._session = quote(session_id, safe='')
        self._agent = quote(agent_id, safe='')
        self._token = token
        self._timeout = timeout

    def _request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
        request = Request(self._base + path, data=data, headers={'Authorization': 'Bearer ' + self._token, 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=self._timeout) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                code = json.load(error).get('error', 'http_error')
            except (ValueError, AttributeError):
                code = 'http_error'
            raise SandboxError(error.code, code) from None
        except URLError as error:
            raise SandboxError(0, 'connection_error') from error
        except (TimeoutError, ConnectionError) as error:
            raise SandboxError(0, 'connection_error') from error

    def observe(self):
        return self._request(f'/sessions/{self._session}/observations/{self._agent}')

    def lidar(self, count=36, max_range=None):
        """Return an instantaneous scoped 360-degree horizontal range scan."""
        payload = {'count': count}
        if max_range is not None:
            payload['range'] = max_range
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/lidar', payload)

    def read_memory(self):
        """Read this agent's private, session-scoped JSON memory and its revision."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/memory')

    def write_memory(self, value, expected_revision):
        """Replace private memory if its revision matches; conflicts raise SandboxError."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/memory', {
            'value': value, 'expectedRevision': expected_revision,
        })

    def send_message(self, recipient_id, text, via=None, request_id=None):
        """Send directly or via relays; supply request_id for safe submission retries."""
        payload = {'to': recipient_id, 'text': text}
        if via is not None:
            payload['via'] = via
        if request_id is not None:
            payload['requestId'] = request_id
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/messages', payload)

    def cancel_action(self, request_id):
        """Cancel this agent's pending or active action; retrying a cancellation is safe."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/actions/cancel', {
            'requestId': request_id,
        })

    def move_to(self, request_id, x, y, target_tick, expires_tick):
        """Submit an intention; inspect observe()['actions'] for its lifecycle."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/actions', {
            'requestId': request_id, 'type': 'move', 'target': {'x': x, 'y': y},
            'targetTick': target_tick, 'expiresTick': expires_tick,
        })


    def rescue(self, request_id, target_agent_id, observed_tick, target_tick, expires_tick, fault_generation):
        """Reset one observed mechanical fault after reaching the target on site."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/actions', {
            'requestId': request_id, 'type': 'rescue', 'targetAgentId': target_agent_id,
            'observedTick': observed_tick, 'faultGeneration': fault_generation, 'targetTick': target_tick, 'expiresTick': expires_tick,
        })

    def execute_task(self, request_id, task_id, target_tick, expires_tick):
        """Start a task assigned to this agent when agent execution mode is enabled."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/actions', {
            'requestId': request_id, 'type': 'execute_task', 'taskId': task_id,
            'targetTick': target_tick, 'expiresTick': expires_tick,
        })

    def work_task(self, request_id, task_id, target_tick, expires_tick):
        """Perform the current phase of an assigned task in primitive execution mode."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/actions', {
            'requestId': request_id, 'type': 'work_task', 'taskId': task_id,
            'targetTick': target_tick, 'expiresTick': expires_tick,
        })

    def report_scan(self, request_id, scan_request_id):
        """Send a completed own scan through the simulated coordinator link."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/evidence', {
            'requestId': request_id, 'scanRequestId': scan_request_id,
        })

    def report_sample(self, request_id, task_id):
        """Report an own completed sampling task through the simulated coordinator link."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/sample-reports', {
            'requestId': request_id, 'taskId': task_id,
        })

    def charge(self, request_id, target_tick, expires_tick):
        """Travel to the shared charging point and recharge to 80 percent."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/actions', {
            'requestId': request_id, 'type': 'charge',
            'targetTick': target_tick, 'expiresTick': expires_tick,
        })

    def scan(self, request_id, target_tick, expires_tick):
        """Scan from the current position; inspect observe()['actions'] for the result."""
        return self._request(f'/sessions/{self._session}/agents/{self._agent}/actions', {
            'requestId': request_id, 'type': 'scan',
            'targetTick': target_tick, 'expiresTick': expires_tick,
        })


class CoordinatorClient:
    """Scoped dispatch observations and decisions, without global snapshots."""
    def __init__(self, session_id, token, base_url='http://127.0.0.1:8787', timeout=5):
        self._client = AgentClient(session_id, '_coordinator', token, base_url, timeout)

    def observe(self):
        return self._client._request(f'/sessions/{self._client._session}/coordinator/observation')

    def assign(self, request_id, task_id, agent_id, observed_tick):
        return self._client._request(f'/sessions/{self._client._session}/coordinator/decisions', {
            'requestId': request_id, 'taskId': task_id, 'agentId': agent_id, 'observedTick': observed_tick,
        })

    def revoke(self, request_id, task_id, agent_id, assignment_id, observed_tick, require_blocked_since=None):
        """Revoke an assignment, optionally only if its reported route wait persists."""
        body = {'requestId': request_id, 'taskId': task_id, 'agentId': agent_id,
                'assignmentId': assignment_id, 'observedTick': observed_tick}
        if require_blocked_since is not None:
            body['requireBlockedSince'] = require_blocked_since
        return self._client._request(f'/sessions/{self._client._session}/coordinator/revocations', body)

    def propose_survey(self, request_id, task_id, name, role, target, duration, observed_tick, depends_on=None, priority=None, deadline=None, evidence_id=None, sensor_evidence_id=None, sample_report_id=None):
        """Propose a bounded survey task; the world validates the task and dependencies."""
        task = {'id': task_id, 'name': name, 'role': role, 'target': target,
                'duration': duration, 'dependsOn': [] if depends_on is None else depends_on}
        if priority is not None:
            task['priority'] = priority
        if deadline is not None:
            task['deadline'] = deadline
        payload = {'requestId': request_id, 'task': task, 'observedTick': observed_tick}
        if evidence_id is not None:
            payload['evidenceId'] = evidence_id
        if sensor_evidence_id is not None:
            payload['sensorEvidenceId'] = sensor_evidence_id
        if sample_report_id is not None:
            payload['sampleReportId'] = sample_report_id
        return self._client._request(f'/sessions/{self._client._session}/coordinator/proposals', payload)
