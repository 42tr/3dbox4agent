"""Lossless conversion between scoped world observations and typed protobuf views.

Unknown and null-valued fields live in each message's extra JSON object. This
lets clients adopt named fields without discarding newer world data.
"""
import json
from .grpc_protocol import message

SCHEMAS = {
 'AgentSelf': [('id','id'),('role','role'),('x','x'),('y','y'),('battery','battery'),('status','status'),('sensor_range','sensorRange'),('communication_range','communicationRange'),('move_energy_per_unit','moveEnergyPerUnit'),('work_energy_per_tick','workEnergyPerTick'),('capabilities','capabilities','str[]'),('communication_interrupted','communicationInterrupted'),('mobility','mobility'),('communication_line_of_sight','communicationLineOfSight'),('communication_bytes_per_tick','communicationBytesPerTick'),('route_blocked_since','routeBlockedSince'),('return_energy_estimate','returnEnergyEstimate')],
 'SeenItem': [('kind','kind'),('id','id'),('x','x'),('y','y'),('observed_tick','observedTick'),('role','role'),('status','status'),('source','source'),('current','current'),('age','age')],
 'AssignedTask': [('id','id'),('name','name'),('target','target','point'),('status','status'),('behavior','behavior'),('phase','phase'),('waypoint','waypoint','point'),('within_reach','withinReach')],
 'ObservedAction': [('agent_id','agentId'),('request_id','requestId'),('type','type'),('status','status'),('target_tick','targetTick'),('expires_tick','expiresTick'),('submitted_tick','submittedTick'),('updated_tick','updatedTick'),('task_id','taskId'),('reason','reason'),('target','target','object_point')],
 'PeerMessage': [('id','id'),('from','from'),('to','to'),('text','text'),('sent_tick','sentTick'),('received_tick','receivedTick')],
 'AgentObservation': [('version','version'),('tick','tick'),('done','done'),('execution_mode','executionMode'),('self','self','AgentSelf'),('nearby','nearby','SeenItem[]'),('visible_targets','visibleTargets','SeenItem[]'),('assigned_tasks','assignedTasks','AssignedTask[]'),('memory','memory','SeenItem[]'),('actions','actions','ObservedAction[]'),('inbox','inbox','PeerMessage[]')],
 'Candidate': [('id','id'),('x','x'),('y','y'),('battery','battery'),('speed','speed')],
 'ReadyTask': [('id','id'),('capability','capability'),('target','target','point'),('name','name'),('behavior','behavior'),('duration','duration'),('priority','priority'),('deadline','deadline'),('candidates','candidates','Candidate[]')],
 'ActiveTask': [('id','id'),('name','name'),('assignee','assignee'),('assignment_id','assignmentId')],
 'CoordinatorObservation': [('version','version'),('tick','tick'),('done','done'),('failed','failed'),('tasks','tasks','ReadyTask[]'),('active','active','ActiveTask[]'),('world_revision','worldRevision'),('coordinator_id','coordinatorId')],
}

def encode(kind, data):
    if not isinstance(data, dict): raise ValueError('expected observation object')
    result = message(kind)()
    remaining = dict(data)
    for spec in SCHEMAS[kind]:
        field, key = spec[:2]; field_type = spec[2] if len(spec)>2 else ''
        if key not in remaining or remaining[key] is None: continue
        value = remaining.pop(key)
        if field_type in ('point','object_point'):
            x,y = (value['x'],value['y']) if field_type=='object_point' else value
            getattr(result,field).CopyFrom(message('Point')(x=x,y=y))
        elif field_type == 'str[]': getattr(result,field).extend(value)
        elif field_type.endswith('[]'):
            for item in value: getattr(result,field).add().CopyFrom(encode(field_type[:-2],item))
        elif field_type: getattr(result,field).CopyFrom(encode(field_type,value))
        else:
            try: setattr(result,field,value)
            except UnicodeEncodeError: remaining[key] = value
    if remaining:
        result.extra_json_utf8 = json.dumps(remaining,ensure_ascii=True,allow_nan=False,separators=(',',':')).encode('utf-8')
    return result

def decode(kind, value):
    extras = json.loads(value.extra_json_utf8) if value.extra_json_utf8 else {}
    if not isinstance(extras,dict): raise ValueError('invalid observation extension')
    result = dict(extras)
    for spec in SCHEMAS[kind]:
        field,key=spec[:2];field_type=spec[2] if len(spec)>2 else ''
        desc=value.DESCRIPTOR.fields_by_name[field]
        if desc.has_presence and not value.HasField(field): continue
        v=getattr(value,field)
        if field_type == 'point': v=[v.x,v.y]
        elif field_type == 'object_point': v={'x':v.x,'y':v.y}
        elif field_type == 'str[]': v=list(v)
        elif field_type.endswith('[]'): v=[decode(field_type[:-2],item) for item in v]
        elif field_type: v=decode(field_type,v)
        result[key]=v
    return result
