"""Run with BOX_SESSION, BOX_AGENT, BOX_TOKEN, and optionally BOX_URL in the environment."""
import os
from box_agent import AgentClient
from box_agent.client import CONTROL_HTTP_ORIGIN

client = AgentClient(os.environ['BOX_SESSION'], os.environ['BOX_AGENT'], os.environ['BOX_TOKEN'], os.environ.get('BOX_URL', CONTROL_HTTP_ORIGIN))
observation = client.observe()
print('tick:', observation['tick'], 'agent:', observation['self']['id'], 'nearby:', len(observation['nearby']))
