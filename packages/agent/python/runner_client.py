"""HTTP client for the version 1 Control runner protocol."""

import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID

from box_agent import AgentClient


class RunnerControl:
    def __init__(self, base):
        AgentClient('_', '_', '_', base)
        self.base = base.rstrip('/')

    def request(self, path, method='POST', body=None, token=None):
        data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
        request = Request(self.base + '/runners/v1' + path, data=data, method=method,
                          headers={'Content-Type': 'application/json'})
        if token:
            request.add_unredirected_header('Authorization', 'Bearer ' + token)
        with urlopen(request, timeout=12) as response:
            return json.load(response)


class RunClient:
    def __init__(self, control, run_id, lease_token):
        self.control = control
        self.base = control.base
        self.run_id = str(UUID(run_id))
        self.lease_token = lease_token
        self.path = '/runs/' + self.run_id

    def open_session(self):
        return self.control.request(self.path + '/session', token=self.lease_token)

    def renew(self):
        return self.control.request(self.path + '/heartbeat', token=self.lease_token)

    def finish(self, status, reason=None):
        return self.control.request(self.path + '/finish', body={'status': status, 'reason': reason},
                                    token=self.lease_token)

    def world_request(self, path, method='GET', data=None, token=None):
        return self.control.request(self.path + '/world' + path, method, data, token or self.lease_token)


def lease_rejected(error):
    if not isinstance(error, HTTPError):
        return False
    if error.code in (401, 403, 404):
        return True
    if error.code == 409:
        try:
            error.runner_code = json.load(error).get('error')
        except (ValueError, AttributeError):
            error.runner_code = None
        return error.runner_code == 'runner_lease_inactive'
    return False
