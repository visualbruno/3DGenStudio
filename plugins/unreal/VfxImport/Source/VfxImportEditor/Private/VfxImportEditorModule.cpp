// The editor module, plus a commandlet that proves the Niagara authoring API is
// reachable from here.
//
// WHY A C++ PLUGIN AND NOT A PYTHON SCRIPT. Phase 0 measured it (see
// plugins/unreal/Spikes/): `UNiagaraExternalEditUtilities` is the API that can
// create a Niagara system and add emitters, renderers and modules to it - and
// its header carries ZERO `UFUNCTION` macros, so nothing on it is exposed to
// Blueprint or Python, despite the class deriving from UBlueprintFunctionLibrary
// and its own comment claiming to be "C++ and Blueprint accessible". Python can
// create an empty system asset and nothing else; UNiagaraSystem exposes no
// emitter members to reflection at all.
//
// So the importer is a compiled editor module. That is a heavier deliverable
// than a script, and it buys something the plan did not expect: Niagara CAN be
// authored structurally, so an imported effect gets real emitters and real
// module stacks rather than parameters bound onto a template.
#include "Modules/ModuleManager.h"
#include "Commandlets/Commandlet.h"
#include "Misc/Paths.h"
#include "UObject/SavePackage.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "FileHelpers.h"

#include "NiagaraSystem.h"
#include "NiagaraEmitter.h"
#include "NiagaraExternalSystemEditorUtilities.h"

#include "VfxImportCommandlet.h"

DEFINE_LOG_CATEGORY_STATIC(LogVfxImport, Log, All);

class FVfxImportEditorModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		UE_LOG(LogVfxImport, Log, TEXT("VfxImportEditor loaded"));
	}

	virtual void ShutdownModule() override {}
};

IMPLEMENT_MODULE(FVfxImportEditorModule, VfxImportEditor);

// ---------------------------------------------------------------------------
// The reachability probe.
//
// Deliberately small: create a system, add one emitter from a stock template,
// and report what the API said. If this links and runs, every other call in
// UNiagaraExternalEditUtilities is available too, and the mapping table is
// ordinary work. If it does not, no amount of mapping table matters.
// ---------------------------------------------------------------------------
int32 UVfxImportCommandlet::Main(const FString& Params)
{
	TArray<FString> Tokens;
	TArray<FString> Switches;
	TMap<FString, FString> Arguments;
	ParseCommandLine(*Params, Tokens, Switches, Arguments);

	const FString AssetName = Arguments.Contains(TEXT("name"))
		? Arguments[TEXT("name")]
		: TEXT("VfxProbeSystem");
	const FString AssetPath = Arguments.Contains(TEXT("path"))
		? Arguments[TEXT("path")]
		: TEXT("/Game/VfxProbe");

	// A DEFAULT-CONSTRUCTED CONTEXT HAS NO SYSTEM AND THEREFORE NO VIEW MODEL.
	// Every stack-editing call resolves through FNiagaraSystemViewModel - the
	// editor's edit session for a system - so with a default context AddEmitter
	// fails with "System view model is invalid", which reads like a broken
	// asset rather than a missing constructor argument. Creation is the one
	// call that legitimately has no system yet.
	FNiagaraExternalEditContext CreateContext;

	UE_LOG(LogVfxImport, Display, TEXT("PROBE creating %s in %s"), *AssetName, *AssetPath);
	UNiagaraSystem* System = UNiagaraExternalEditUtilities::CreateNiagaraSystem(
		AssetName, AssetPath, /*TemplateSystem*/ nullptr, CreateContext);

	for (const FText& Error : CreateContext.Errors)
	{
		UE_LOG(LogVfxImport, Warning, TEXT("PROBE createError %s"), *Error.ToString());
	}

	if (System == nullptr)
	{
		UE_LOG(LogVfxImport, Error, TEXT("PROBE RESULT create=failed"));
		return 1;
	}
	UE_LOG(LogVfxImport, Display, TEXT("PROBE create=ok %s"), *System->GetPathName());

	// Bound to the system, which is what gives the context a view model.
	FNiagaraExternalEditContext Context(System);

	// The system has to be the one being edited for the stack calls to have a
	// target; GetSystemSummary is the cheapest way to confirm the context can
	// see it at all.
	Context.Errors.Reset();
	FNiagaraExt_SystemSummary Summary;
	UNiagaraExternalEditUtilities::GetSystemSummary(System, Summary, Context);
	UE_LOG(LogVfxImport, Display, TEXT("PROBE summary emitters=%d errors=%d"),
		Summary.Emitters.Num(), Context.Errors.Num());

	// A stock template emitter, so AddEmitter has something to clone. Niagara
	// ships fourteen of these; `Minimal` is the smallest honest starting point.
	Context.Errors.Reset();
	UNiagaraEmitter* Template = LoadObject<UNiagaraEmitter>(
		nullptr, TEXT("/Niagara/DefaultAssets/Templates/Emitters/Minimal.Minimal"));
	UE_LOG(LogVfxImport, Display, TEXT("PROBE template=%s"),
		Template ? *Template->GetPathName() : TEXT("NOT FOUND"));

	if (Template != nullptr)
	{
		FNiagaraExt_EmitterTopology Topology;
		UNiagaraExternalEditUtilities::AddEmitter(
			Template, FName(TEXT("Probe")), Topology, Context);
		for (const FText& Error : Context.Errors)
		{
			UE_LOG(LogVfxImport, Warning, TEXT("PROBE addEmitterError %s"), *Error.ToString());
		}
		UE_LOG(LogVfxImport, Display, TEXT("PROBE addEmitter errors=%d"), Context.Errors.Num());

		// DID IT LAND? "AddEmitter reported no errors" and "the system has an
		// emitter" are different claims, and only the second one matters.
		Context.Errors.Reset();
		FNiagaraExt_SystemSummary After;
		UNiagaraExternalEditUtilities::GetSystemSummary(System, After, Context);
		UE_LOG(LogVfxImport, Display, TEXT("PROBE afterAdd emitters=%d"), After.Emitters.Num());
	}

	// Saved, because an asset that exists only in memory proves nothing about
	// what an author would end up with.
	UPackage* Package = System->GetOutermost();
	Package->MarkPackageDirty();
	FSavePackageArgs SaveArgs;
	SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
	const FString FileName = FPackageName::LongPackageNameToFilename(
		Package->GetName(), FPackageName::GetAssetPackageExtension());
	const bool bSaved = UPackage::SavePackage(Package, System, *FileName, SaveArgs);
	UE_LOG(LogVfxImport, Display, TEXT("PROBE save=%s %s"),
		bSaved ? TEXT("ok") : TEXT("failed"), *FileName);

	// Reloaded from disk under a fresh context, which is the only version of
	// this question an author cares about.
	const FString ObjectPath = AssetPath / AssetName + TEXT(".") + AssetName;
	UNiagaraSystem* Reloaded = LoadObject<UNiagaraSystem>(nullptr, *ObjectPath);
	int32 ReloadedEmitters = -1;
	if (Reloaded != nullptr)
	{
		FNiagaraExternalEditContext ReloadContext(Reloaded);
		FNiagaraExt_SystemSummary ReloadedSummary;
		UNiagaraExternalEditUtilities::GetSystemSummary(Reloaded, ReloadedSummary, ReloadContext);
		ReloadedEmitters = ReloadedSummary.Emitters.Num();
	}
	UE_LOG(LogVfxImport, Display, TEXT("PROBE reloaded emitters=%d"), ReloadedEmitters);

	UE_LOG(LogVfxImport, Display, TEXT("PROBE RESULT create=ok save=%s emittersOnDisk=%d"),
		bSaved ? TEXT("ok") : TEXT("failed"), ReloadedEmitters);
	return (bSaved && ReloadedEmitters == 1) ? 0 : 1;
}
