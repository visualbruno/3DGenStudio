# Phase 0, spike U5: what is NiagaraExternalEditContext, and can it build a
# system from script?
#
# The first spike found that UNiagaraSystem exposes no emitter members, which
# looked like Unity's VFX Graph answer: bind a hand-authored template and
# nothing more. But the class list also carried a whole `NiagaraExt_*` family -
# EmitterTopology, ModuleSchema, StackInputData, SystemData - and a class named
# `NiagaraExternalEditContext`, which is not the shape of an API that only
# reads.
#
# If Niagara really can be edited from outside the editor UI, the Unreal
# importer is a very different and much better program than the plan assumed:
# real emitters and modules built from the IR, rather than parameters bound onto
# a template somebody drew.
#
# Dumps the Python docstrings, which for the `unreal` module carry full
# signatures and property lists - the most accurate description available
# without reading engine C++.
import json
import os
import unreal

INTERESTING = [
    'NiagaraExternalEditContext',
    'NiagaraClipboardEditorScriptingUtilities',
    'NiagaraExt_SystemSchema',
    'NiagaraExt_SystemData',
    'NiagaraExt_EmitterSchema',
    'NiagaraExt_EmitterData',
    'NiagaraExt_EmitterTopology',
    'NiagaraExt_ModuleSchema',
    'NiagaraExt_ModuleData',
    'NiagaraExt_ModuleTopology',
    'NiagaraExt_ModuleInputValues',
    'NiagaraExt_RendererSchema',
    'NiagaraExt_RendererData',
    'NiagaraExt_StackInputSchema',
    'NiagaraExt_StackInputData',
    'NiagaraExt_StackInputValue',
    'NiagaraExt_SetParameterEntry',
    'NiagaraExt_UserVariables',
    'NiagaraExt_UserVariable',
    'NiagaraExt_Variable',
    'NiagaraExt_VariableValue',
    'NiagaraExt_DynamicInputSchema',
    'NiagaraExt_StackIssues',
    'NiagaraPythonEmitter',
    'NiagaraPythonModule',
]

result = {'engineVersion': unreal.SystemLibrary.get_engine_version(), 'classes': {}}

for name in INTERESTING:
    cls = getattr(unreal, name, None)
    if cls is None:
        result['classes'][name] = {'present': False}
        continue

    callables = []
    properties = []
    for member in sorted(dir(cls)):
        if member.startswith('_'):
            continue
        try:
            attr = getattr(cls, member)
        except Exception:  # noqa: BLE001
            properties.append(member)
            continue
        if callable(attr):
            callables.append(member)
        else:
            properties.append(member)

    result['classes'][name] = {
        'present': True,
        'doc': (cls.__doc__ or '').strip(),
        'callables': callables,
        'properties': properties,
    }

out = os.path.join(unreal.Paths.project_dir(), 'spike-niagara-ext.json')
with open(out, 'w', encoding='utf-8') as handle:
    json.dump(result, handle, indent=1)
unreal.log('[NiagaraExtSpike] wrote ' + out)
