# Phase 0 spikes for the Unreal / Niagara importer.
#
# The Unity equivalents established that a target's *authoring* API decides the
# whole design, so the same questions get asked here before anything is built:
#
#   1. Can a NiagaraSystem be CREATED from script?
#   2. Can its structure - emitters, modules - be built or edited from script,
#      or can a script only set User Parameters on a system somebody authored?
#   3. What is the coordinate and unit convention, measured rather than recalled?
#   4. What can actually be set on a component: floats, vectors, colours,
#      curves, textures, meshes?
#
# Writes JSON to spike-niagara.json at the project root. Never trusts the log:
# an Unreal commandlet log is thousands of lines of asset registry noise.
#
#   UnrealEditor-Cmd.exe <uproject> -run=pythonscript -script="<this file>"
import json
import os
import unreal


def members(cls, prefix=None):
    """Callable names on a class, optionally filtered by prefix."""
    if cls is None:
        return []
    names = []
    for name in dir(cls):
        if name.startswith('_'):
            continue
        if prefix and not name.startswith(prefix):
            continue
        names.append(name)
    return sorted(names)


def find(name):
    """A class from the `unreal` module, or None."""
    return getattr(unreal, name, None)


result = {}

# --- what version, and is Niagara really here? ------------------------------
result['engineVersion'] = unreal.SystemLibrary.get_engine_version()
result['niagaraClassesPresent'] = {
    name: find(name) is not None
    for name in [
        'NiagaraSystem',
        'NiagaraEmitter',
        'NiagaraComponent',
        'NiagaraActor',
        'NiagaraSystemFactoryNew',
        'NiagaraEmitterFactoryNew',
        'NiagaraDataInterfaceCurve',
        'NiagaraDataInterfaceTexture',
        'NiagaraDataInterfaceStaticMesh',
        'NiagaraEditorUtilities',
    ]
}

# ---------------------------------------------------------------------------
# SPIKE U1: can a NiagaraSystem be created at all?
#
# If the factory is exposed, an importer can at least produce an asset. If not,
# the only route is copying a template asset with the asset tools.
# ---------------------------------------------------------------------------
spike = {}
factory_cls = find('NiagaraSystemFactoryNew')
spike['factoryExposed'] = factory_cls is not None

created = None
if factory_cls is not None:
    try:
        tools = unreal.AssetToolsHelpers.get_asset_tools()
        created = tools.create_asset(
            asset_name='SpikeSystem',
            package_path='/Game/VfxSpike',
            asset_class=unreal.NiagaraSystem,
            factory=factory_cls(),
        )
        spike['created'] = created is not None
        spike['createdPath'] = created.get_path_name() if created else None
    except Exception as error:  # noqa: BLE001 - a spike reports, it does not raise
        spike['created'] = False
        spike['createError'] = str(error)
else:
    spike['created'] = False

# What does a system expose to script?
spike['systemMembers'] = members(unreal.NiagaraSystem)
spike['systemSetters'] = members(unreal.NiagaraSystem, 'set')
# Emitter handles are the structural question: adding one means adding a system.
spike['emitterRelated'] = [
    name for name in members(unreal.NiagaraSystem)
    if 'emitter' in name.lower()
]
result['spikeU1_systemAuthoring'] = spike

# ---------------------------------------------------------------------------
# SPIKE U2: what can be BOUND on a component?
#
# The Unity answer was "everything, including curves and gradients", which
# removed LUT baking from the design. The same question decides how much of the
# IR survives here.
# ---------------------------------------------------------------------------
component_setters = members(unreal.NiagaraComponent, 'set')
result['spikeU2_binding'] = {
    'componentSetters': component_setters,
    # The ones the IR needs by name.
    'required': {
        name: name in component_setters
        for name in [
            'set_variable_float',
            'set_variable_int',
            'set_variable_bool',
            'set_variable_vec2',
            'set_variable_vec3',
            'set_variable_vec4',
            'set_variable_linear_color',
            'set_variable_quaternion',
            'set_variable_material',
            'set_variable_object',
            'set_variable_texture_render_target',
            'set_variable_static_mesh',
            'set_variable_actor',
        ]
    },
    # A curve has no set_variable_* form; it is a Data Interface. Whether one
    # can be built from script decides if curves travel as curves or as baked
    # samples.
    'curveDataInterface': members(find('NiagaraDataInterfaceCurve')),
    'niagaraFunctionLibrary': members(find('NiagaraFunctionLibrary')),
}

# ---------------------------------------------------------------------------
# SPIKE U3: coordinate space and units, MEASURED.
#
# Unreal is documented as left-handed, Z-up, 1 unit = 1 cm. The default gravity
# proves both at once: -980 on Z is centimetres per second squared on a Z-up
# axis. Recalling it is not the same as reading it out of this install.
# ---------------------------------------------------------------------------
physics = unreal.PhysicsSettings.get_default_object()
gravity_z = physics.get_editor_property('default_gravity_z')
result['spikeU3_conventions'] = {
    'defaultGravityZ': gravity_z,
    # -980 cm/s2 rather than -9.8 m/s2.
    'unitIsCentimetre': abs(abs(gravity_z) - 980.0) < 20.0,
    'upAxis': 'Z',
    # X forward, Y right, Z up, and X cross Y = +Z makes it left-handed. Read
    # off the engine's own axis vectors rather than asserted.
    'forward': str(unreal.Vector.FORWARD) if hasattr(unreal.Vector, 'FORWARD') else 'n/a',
    'right': str(unreal.Vector.RIGHT) if hasattr(unreal.Vector, 'RIGHT') else 'n/a',
    'up': str(unreal.Vector.UP) if hasattr(unreal.Vector, 'UP') else 'n/a',
}

# ---------------------------------------------------------------------------
# SPIKE U4: is there ANY editor-side Niagara scripting surface?
#
# The Unity finding was that the graph model is `internal` and a plugin can only
# bind a hand-authored template. The equivalent question here.
# ---------------------------------------------------------------------------
editor_surface = {}
for name in dir(unreal):
    if not name.startswith('Niagara'):
        continue
    cls = getattr(unreal, name)
    if isinstance(cls, type):
        editor_surface[name] = len(members(cls))
result['spikeU4_niagaraSurface'] = {
    'classCount': len(editor_surface),
    'classes': dict(sorted(editor_surface.items())),
}

out = os.path.join(unreal.Paths.project_dir(), 'spike-niagara.json')
with open(out, 'w', encoding='utf-8') as handle:
    json.dump(result, handle, indent=1, sort_keys=False)
unreal.log('[NiagaraSpike] wrote ' + out)
