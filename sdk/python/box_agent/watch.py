"""Convenience functions for observing asynchronous actions without admin access."""
import math
import time
from .client import SandboxError

_TERMINAL = frozenset(('completed', 'failed', 'rejected', 'cancelled'))


def wait_for_action(client, request_id, timeout=30.0, poll_interval=0.2):
    """Return the final action record from scoped observations.

    The caller must submit the action first and arrange for the world to advance.
    Failures and cancellations are returned as records; transport errors propagate.
    Timeout uses wall-clock time and cannot interrupt an in-flight HTTP request.
    Waiting does not resubmit or cancel the action.
    """
    if not isinstance(request_id, str) or not request_id:
        raise ValueError('request_id is required')
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or x <= 0 for x in (timeout, poll_interval)):
        raise ValueError('timeout and poll_interval must be finite positive numbers')
    deadline = time.monotonic() + timeout
    while True:
        observation = client.observe()
        action = next((a for a in observation['actions'] if a['requestId'] == request_id), None)
        if action is not None and action['status'] in _TERMINAL:
            return action
        error = observation.get('sessionError') or observation.get('simulationError')
        if error in ('world_step_failed', 'journal_write_failed'):
            raise SandboxError(503, error)
        if observation['done']:
            raise LookupError('world ended before the requested action could be observed as terminal')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('action did not finish before timeout')
        time.sleep(min(poll_interval, remaining))
