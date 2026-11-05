"""Run with BOX_SESSION, BOX_AGENT, BOX_TOKEN, and optionally BOX_URL in the environment."""
import os
from box_agent import AgentClient

client = AgentClient(os.environ['BOX_SESSION'], os.environ['BOX_AGENT'], os.environ['BOX_TOKEN'], os.environ.get('BOX_URL', 'http://127.0.0.1:8787'))
observation = client.observe()
print('tick:', observation['tick'], 'agent:', observation['self']['id'], 'nearby:', len(observation['nearby']))
