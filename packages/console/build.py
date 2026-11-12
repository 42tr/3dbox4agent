from pathlib import Path
import json
import subprocess
from tempfile import NamedTemporaryFile


CONSOLE = Path(__file__).resolve().parent
ROOT = CONSOLE.parents[1]
html = (ROOT / 'packages/console/src/app.html').read_text()
engine = (ROOT / 'packages/world/src/echelons.js').read_text()+'\n'+(ROOT / 'packages/world/src/world-core.js').read_text().replace('/* SHORE_RESCUE_SCENE */ null', json.dumps(json.loads((ROOT / 'packages/world/scenes/shore-rescue.json').read_text()), ensure_ascii=True)).replace('/* SHORE_ECHELONS_SCENE */ null', json.dumps(json.loads((ROOT / 'packages/world/scenes/shore-echelons.json').read_text()), ensure_ascii=True)).replace('/* SHORE_SEA_STATE_SCENE */ null', json.dumps(json.loads((ROOT / 'packages/world/scenes/shore-sea-state.json').read_text()), ensure_ascii=True)).replace('/* SHORE_SURFACE_SCENE */ null', json.dumps(json.loads((ROOT / 'packages/world/scenes/shore-surface.json').read_text()), ensure_ascii=True))
thermal = (ROOT / 'packages/world/src/thermal.js').read_text()
operating_power = (ROOT / 'packages/world/src/operating-power.js').read_text()
materials = (ROOT / 'packages/world/src/materials.js').read_text()
relay = (ROOT / 'packages/world/src/relay.js').read_text()
construction = (ROOT / 'packages/world/src/construction.js').read_text()
rescue = (ROOT / 'packages/world/src/rescue.js').read_text()
elevation = (ROOT / 'packages/world/src/elevation.js').read_text()
surface_domain = (ROOT / 'packages/world/src/surface-domain.js').read_text()
navigation = (ROOT / 'packages/world/src/navigation.js').read_text()
sensors = (ROOT / 'packages/world/src/sensors.js').read_text()
experiments = (ROOT / 'packages/world/src/experiments.js').read_text()
service_load_report = (ROOT / 'packages/world/src/reports/service-load-report.js').read_text()
replay = (ROOT / 'packages/world/src/replay.js').read_text()
recording_context = (ROOT / 'packages/world/src/recording-context.js').read_text()
observer_access = (ROOT / 'packages/console/src/observer-access.js').read_text()
safety_report = (ROOT / 'packages/world/src/reports/safety-report.js').read_text()
catalog_handoff = (ROOT / 'packages/console/src/catalog-handoff.js').read_text()
delta = (ROOT / 'packages/world/src/delta.js').read_text()
planner_report = (ROOT / 'packages/world/src/reports/planner-report.js').read_text()
policy_report = (ROOT / 'packages/world/src/reports/policy-report.js').read_text()
experiment_assets = (ROOT / 'packages/console/src/experiment-assets.js').read_text()
policy_validation_path = (ROOT / 'examples/experiments/policy-acceptance-public-codex.json')
policy_validation = json.dumps(json.loads(policy_validation_path.read_text())['example'] if policy_validation_path.exists() else None, ensure_ascii=True).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
policy_trace = (ROOT / 'packages/world/src/reports/policy-trace.js').read_text()
policy_rerun_report = (ROOT / 'packages/world/src/reports/policy-rerun-report.js').read_text()
task_graph = (ROOT / 'packages/world/src/task-graph.js').read_text()
links = (ROOT / 'packages/world/src/links.js').read_text()
server_link_report = (ROOT / 'packages/world/src/reports/server-link-report.js').read_text()
roadblock_report = (ROOT / 'packages/world/src/reports/roadblock-report.js').read_text()
server_risk_report = (ROOT / 'packages/world/src/reports/server-risk-report.js').read_text()
system_report = (ROOT / 'packages/world/src/reports/system-report.js').read_text()
patrol_review = (ROOT / 'packages/console/src/patrol-review.js').read_text()
sample_followup = (ROOT / 'packages/world/src/reports/sample-followup.js').read_text()
agent_visual = (ROOT / 'packages/console/src/agent-visual.js').read_text()
deadline_scene = json.dumps(json.loads((ROOT / 'packages/world/scenes/priority-deadline-tradeoff.json').read_text()), ensure_ascii=True)
yaml_scene = json.dumps((ROOT / 'packages/world/scenes/laxity-example.yaml').read_text(), ensure_ascii=True)
laxity_scene = json.dumps(json.loads((ROOT / 'packages/world/scenes/laxity-tradeoff.json').read_text()), ensure_ascii=True)
scene_diagnostics = (ROOT / 'packages/world/src/scene-diagnostics.js').read_text()
scheduled_plan = (ROOT / 'packages/world/src/scheduled-plan.js').read_text()
scheduled_audit = (ROOT / 'packages/world/src/scheduled-audit.js').read_text()
scheduled_policy_report = (ROOT / 'packages/world/src/reports/scheduled-policy-report.js').read_text()
scheduled_plan_example = json.dumps(json.loads((ROOT / 'examples/experiments/park-disturbances.json').read_text()), ensure_ascii=True)
relay_comparison = (ROOT / 'packages/world/src/reports/relay-comparison.js').read_text()
server_relay_report = (ROOT / 'packages/world/src/reports/server-relay-report.js').read_text()
control_events = (ROOT / 'packages/world/src/reports/control-events.js').read_text()
coordinator_report = (ROOT / 'packages/world/src/reports/coordinator-report.js').read_text()
auction_comparison_report = (ROOT / 'packages/world/src/reports/auction-comparison-report.js').read_text()
auction_trace = (ROOT / 'packages/world/src/reports/auction-trace.js').read_text()
fork_roadblock_report = (ROOT / 'packages/world/src/reports/fork-roadblock-report.js').read_text()
observation_report = (ROOT / 'packages/world/src/reports/observation-report.js').read_text()
license_text = (ROOT / 'node_modules/three/LICENSE').read_text()
mission_licenses = '\n\n'.join((ROOT / p).read_text() for p in ['node_modules/react/LICENSE','node_modules/react-dom/LICENSE','node_modules/@phosphor-icons/react/LICENSE','packages/console/assets/mission-control/kenney-space-kit/LICENSE.txt','packages/console/assets/mission-control/kenney-pirate-kit/LICENSE.txt'])
yaml_license = (ROOT / 'node_modules/yaml/LICENSE').read_text()
protobuf_licenses = '\n'.join(p.read_text() for p in [(ROOT / 'node_modules/protobufjs/LICENSE'), *sorted((ROOT / 'node_modules/@protobufjs').glob('*/LICENSE'))])
stream_protobuf = subprocess.check_output(['node_modules/.bin/esbuild', 'packages/console/src/stream-protobuf-browser.js', '--bundle', '--minify', '--format=iife', '--target=es2020'], cwd=ROOT, text=True)
scene_format = subprocess.check_output(['node_modules/.bin/esbuild', 'packages/console/src/scene-format-browser.js', '--bundle', '--minify', '--format=iife', '--target=es2020'], cwd=ROOT, text=True)
mission_ui = subprocess.check_output(['node_modules/.bin/esbuild', 'packages/console/src/mission-control.tsx', '--bundle', '--minify', '--format=iife', '--target=es2020', '--loader:.css=text', '--define:process.env.NODE_ENV="production"'], cwd=ROOT, text=True)
scene = subprocess.check_output(['node_modules/.bin/esbuild', 'packages/console/src/scene3d.js', '--loader:.png=dataurl', '--loader:.glb=dataurl', '--bundle', '--minify', '--format=iife', '--target=es2020'], cwd=ROOT, text=True)
if '</script' in mission_ui.lower() or '</script' in scene.lower() or '</script' in scene_format.lower() or '</script' in stream_protobuf.lower():
    raise ValueError('JavaScript bundle contains an HTML script closing tag')

replacements = {
    '/* MISSION_UI */': '/*\n' + mission_licenses + '\n*/\n' + mission_ui,
    '/* OPERATING_POWER */': operating_power,
    '/* THERMAL */': thermal,
    '/* MATERIALS */': materials,
    '/* RELAY */': relay,
    '/* RESCUE */': rescue,
    '/* CONSTRUCTION */': construction,
    '/* ELEVATION */': elevation,
    '/* SURFACE_DOMAIN */': surface_domain,
    '/* NAVIGATION */': navigation,
    '/* SENSORS */': sensors,
    '/* ENGINE */': engine,
    '/* EXPERIMENTS */': experiments,
    '/* SERVICE_LOAD_REPORT */': service_load_report,
    '/* RECORDING_CONTEXT */': recording_context,
    '/* OBSERVER_ACCESS */': observer_access,
    '/* REPLAY */': replay,
    '/* SAFETY_REPORT */': safety_report,
    '/* CATALOG_HANDOFF */': catalog_handoff,
    '/* DELTA */': delta,
    '/* PLANNER_REPORT */': planner_report,
    '/* POLICY_REPORT */': policy_report,
    '/* POLICY_VALIDATION_EXAMPLE */': policy_validation,
    '/* EXPERIMENT_ASSETS */': experiment_assets,
    '/* POLICY_TRACE */': policy_trace,
    '/* POLICY_RERUN_REPORT */': policy_rerun_report,
    '/* TASK_GRAPH */': task_graph,
    '/* LINKS */': links,
    '/* SERVER_LINK_REPORT */': server_link_report,
    '/* ROADBLOCK_REPORT */': roadblock_report,
    '/* SERVER_RISK_REPORT */': server_risk_report,
    '/* SYSTEM_REPORT */': system_report,
    '/* PATROL_REVIEW */': patrol_review,
    '/* SAMPLE_FOLLOWUP */': sample_followup,
    '/* AGENT_VISUAL */': agent_visual,
    '/* DEADLINE_SCENE */': deadline_scene,
    '/* LAXITY_SCENE */': laxity_scene,
    '/* YAML_SCENE */': yaml_scene,
    '/* SCENE_DIAGNOSTICS */': scene_diagnostics,
    '/* SCHEDULED_PLAN */': scheduled_plan,
    '/* SCHEDULED_AUDIT */': scheduled_audit,
    '/* SCHEDULED_POLICY_REPORT */': scheduled_policy_report,
    '/* SCHEDULED_PLAN_EXAMPLE */': scheduled_plan_example,
    '/* RELAY_COMPARISON */': relay_comparison,
    '/* SERVER_RELAY_REPORT */': server_relay_report,
    '/* CONTROL_EVENTS */': control_events,
    '/* COORDINATOR_REPORT */': coordinator_report,
    '/* AUCTION_COMPARISON_REPORT */': auction_comparison_report,
    '/* AUCTION_TRACE */': auction_trace,
    '/* FORK_ROADBLOCK_REPORT */': fork_roadblock_report,
    '/* OBSERVATION_REPORT */': observation_report,
    '/* STREAM_PROTOBUF */': '/*\n' + protobuf_licenses + '\n*/\n' + stream_protobuf,
    '/* SCENE_FORMAT */': '/*\n' + yaml_license + '\n*/\n' + scene_format,
    '/* SCENE3D */': '/*\n' + license_text + '\n*/\n' + scene,
}

for marker, content in replacements.items():
    html = html.replace(marker, content)

dist = CONSOLE / 'dist'
dist.mkdir(exist_ok=True)
with NamedTemporaryFile(mode='w', encoding='utf-8', dir=dist, delete=False) as output:
    temporary_path = Path(output.name)
    try:
        output.write(html)
        output.close()
        temporary_path.chmod(0o644)
        temporary_path.replace(dist / 'index.html')
    finally:
        temporary_path.unlink(missing_ok=True)
