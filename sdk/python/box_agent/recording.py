"""Bounded session provenance for reports; these diagnostics do not authenticate a file."""
import re

UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
BACKENDS = {'physicsBackend': ('wasm', 'rust'), 'taskBackend': ('js', 'rust'),
            'communicationBackend': ('js', 'rust'), 'navigationBackend': ('js', 'rust'), 'worldLedgerBackend': ('js', 'rust'), 'worldMotionBackend': ('js', 'rust'), 'worldTasksBackend': ('js', 'rust'), 'worldExecutionBackend': ('js', 'rust'), 'worldActionsBackend': ('js', 'rust'), 'worldPeerBackend': ('js', 'rust'), 'worldReportsBackend': ('js', 'rust'), 'worldDispatchBackend': ('js', 'rust'), 'worldResourcesBackend': ('js', 'rust'), 'worldPerceptionsBackend': ('js', 'rust'), 'worldEnvironmentBackend': ('js', 'rust'), 'worldRequestsBackend': ('js', 'rust'), 'worldControlBackend': ('js', 'rust')}


def _uuid(value):
    return isinstance(value, str) and UUID.fullmatch(value) is not None


def normalize_runtime(value):
    if not isinstance(value, dict) or not _uuid(value.get('instanceId')):
        raise ValueError('invalid recording runtime')
    source = value.get('sourceSha256')
    if not isinstance(source, dict) or not 1 <= len(source) <= 128:
        raise ValueError('invalid recording source hashes')
    for name, digest in source.items():
        if (not isinstance(name, str) or len(name) > 240 or
                re.fullmatch(r'[A-Za-z0-9_./-]+', name) is None or
                any(part in ('', '.', '..') for part in name.split('/')) or
                name in ('__proto__', 'constructor', 'prototype') or
                not isinstance(digest, str) or re.fullmatch(r'[a-f0-9]{64}', digest) is None):
            raise ValueError('invalid recording source hashes')
    result = {'instanceId': value['instanceId'], 'sourceSha256': dict(source)}
    for name, allowed in BACKENDS.items():
        if name in value:
            if value[name] not in allowed:
                raise ValueError('invalid recording backend')
            result[name] = value[name]
    for name in ('worldStationaryVersion', 'worldWorkVersion', 'worldActivationVersion', 'worldLifecycleVersion', 'worldAssignmentVersion', 'worldInterruptionVersion', 'worldRevocationVersion', 'worldProposalVersion', 'worldTimeVersion', 'worldEndingVersion', 'worldFinalizationVersion', 'worldTaskEventsVersion', 'worldRouteEventsVersion', 'worldStationaryEventsVersion', 'worldLifecycleEventsVersion', 'worldActivationEventsVersion', 'worldPeerEventsVersion', 'worldReportEventsVersion', 'worldDispatchEventsVersion', 'worldAutomaticDispatchVersion', 'worldCollisionReplanVersion', 'worldActivationPlanningVersion', 'worldAssignmentPlanningVersion', 'worldEnvironmentPlanningVersion', 'worldAgentObservationVersion', 'worldCoordinatorObservationVersion', 'worldTaskAdvanceVersion', 'worldActionAdvanceVersion', 'worldAdvanceVersion','worldInitializationVersion'):
        if name in value:
            if type(value[name]) is not int or value[name] != 1:
                raise ValueError('invalid native phase version')
            result[name] = 1
    if 'worldRouteVersion' in value:
        if type(value['worldRouteVersion']) is not int or value['worldRouteVersion'] != 1:
            raise ValueError('invalid world route version')
        result['worldRouteVersion'] = 1
    if 'worldRollbackVersion' in value:
        if type(value['worldRollbackVersion']) is not int or value['worldRollbackVersion'] != 1:
            raise ValueError('invalid world rollback version')
        result['worldRollbackVersion'] = 1
    for name in ('node', 'platform', 'arch', 'rapierPackage', 'rapierNativeVersion'):
        if name in value:
            item = value[name]
            if not isinstance(item, str) or not 1 <= len(item) <= 80 or re.fullmatch(r'[A-Za-z0-9_.+/-]+', item) is None:
                raise ValueError('invalid recording platform')
            result[name] = item
    for name in ('eventJournalEnabled', 'replayJournalEnabled'):
        if name in value:
            if type(value[name]) is not bool:
                raise ValueError('invalid recording journal metadata')
            result[name] = value[name]
    return result


def backend_profile(value):
    return {key: item for key, item in normalize_runtime(value).items() if key != 'instanceId'}


def capture_recording_context(session, service_runtime=None):
    """Copy only known diagnostics and bind them to the response's actual session ID."""
    if 'recordingContext' not in session:
        return None
    value = session['recordingContext']
    if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1 or
            not _uuid(value.get('sessionId')) or value['sessionId'] != session.get('sessionId')):
        raise ValueError('recording context does not match the session')
    result = {'version': 1, 'sessionId': value['sessionId'], 'runtime': normalize_runtime(value.get('runtime'))}
    parent = value.get('forkedFrom')
    if parent is not None:
        if (not isinstance(parent, dict) or not _uuid(parent.get('sessionId')) or parent['sessionId'] == result['sessionId'] or
                type(parent.get('revision')) is not int or parent['revision'] < 0):
            raise ValueError('invalid recording parent')
        result['forkedFrom'] = {'sessionId': parent['sessionId'], 'revision': parent['revision']}
        for name in ('sourceClosed', 'sourcePartialTail'):
            if name in parent:
                if type(parent[name]) is not bool:
                    raise ValueError('invalid recording parent')
                result['forkedFrom'][name] = parent[name]
    if service_runtime is not None and backend_profile(result['runtime']) != backend_profile(service_runtime):
        raise ValueError('world runtime differs from service configuration')
    return result
