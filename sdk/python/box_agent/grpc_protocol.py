"""Runtime message classes for the versioned agent gRPC contract."""
from pathlib import Path
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

_descriptor = descriptor_pb2.FileDescriptorSet.FromString((Path(__file__).parent / 'agent.desc').read_bytes())
if len(_descriptor.file) != 1:
    raise ValueError('invalid bundled agent descriptor')
_pool = descriptor_pool.DescriptorPool()
_pool.AddSerializedFile(_descriptor.file[0].SerializeToString())

def message(name):
    return message_factory.GetMessageClass(_pool.FindMessageTypeByName('box.agent.v1.' + name))

METHODS = {'ObserveAgent': 'AgentRef', 'ObserveCoordinator': 'SessionRef',
           'SubmitAction': 'Action', 'CancelAction': 'Cancel', 'Lidar': 'LidarRequest',
           'SendMessage': 'Message', 'Assign': 'Assignment', 'ReportSample': 'SampleReport',
           'ReportScan': 'ScanReport', 'ReadMemory': 'AgentRef', 'WriteMemory': 'MemoryWrite',
           'Revoke': 'Revocation', 'ProposeSurvey': 'SurveyProposal'}
TYPED_METHODS = {'ObserveAgentTyped': ('AgentRef', 'AgentObservation'), 'ObserveCoordinatorTyped': ('SessionRef', 'CoordinatorObservation')}
TYPED_STREAM_METHODS = {'StreamAgentObservationsTyped': 'AgentSubscription', 'StreamCoordinatorObservationsTyped': 'CoordinatorSubscription'}
STREAM_METHODS = {'StreamAgentObservations': 'AgentSubscription', 'StreamCoordinatorObservations': 'CoordinatorSubscription'}
SERVICE = 'box.agent.v1.AgentWorld'
