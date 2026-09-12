#include "VfxVerifyCommandlet.h"

#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

#include "NiagaraSystem.h"
#include "NiagaraEmitter.h"
#include "NiagaraEmitterHandle.h"
#include "NiagaraScript.h"
#include "NiagaraExternalSystemEditorUtilities.h"
#include "NiagaraSpriteRendererProperties.h"
#include "NiagaraMeshRendererProperties.h"
#include "NiagaraRibbonRendererProperties.h"

#include "Engine/StaticMesh.h"
#include "Materials/MaterialInterface.h"
#include "StructUtils/InstancedStruct.h"

DEFINE_LOG_CATEGORY_STATIC(LogVfxVerify, Log, All);

int32 UVfxVerifyCommandlet::Main(const FString& Params)
{
	TArray<FString> Tokens;
	TArray<FString> Switches;
	TMap<FString, FString> Arguments;
	ParseCommandLine(*Params, Tokens, Switches, Arguments);

	const FString Path = Arguments.FindRef(TEXT("system"));
	if (Path.IsEmpty())
	{
		UE_LOG(LogVfxVerify, Error, TEXT("-system=/Game/ImportedVfx/Name is required"));
		return 2;
	}

	const FString ObjectPath = Path + TEXT(".") + FPaths::GetCleanFilename(Path);
	UNiagaraSystem* System = LoadObject<UNiagaraSystem>(nullptr, *ObjectPath);
	if (System == nullptr)
	{
		UE_LOG(LogVfxVerify, Error, TEXT("could not load %s"), *ObjectPath);
		return 1;
	}

	// COMPILE FIRST: the event GENERATORS an emitter declares are produced by
	// compiling its update script, so before that the list is empty and the
	// question "what is this event actually called" has no answer.
	System->RequestCompile(false);
	System->WaitForCompilationComplete();

	FNiagaraExternalEditContext Context(System);
	FString Text = FString::Printf(TEXT("=== VERIFY %s (%d emitters) ===\n"),
		*FPaths::GetCleanFilename(Path), System->GetEmitterHandles().Num());

	for (const FNiagaraEmitterHandle& Handle : System->GetEmitterHandles())
	{
		const FName EmitterName = Handle.GetName();
		FVersionedNiagaraEmitter Versioned = Handle.GetInstance();
		FVersionedNiagaraEmitterData* Data = Versioned.GetEmitterData();
		Text += FString::Printf(TEXT("\n-- %s%s\n"), *EmitterName.ToString(),
			Data != nullptr && Data->bRequiresPersistentIDs ? TEXT("  [persistent ids]") : TEXT(""));

		// The module stacks, with every input value the importer wrote. A
		// refused write shows up here as the module's default sitting where the
		// authored number should be.
		FNiagaraExt_StackItemReference EmitterRef(System, EmitterName);
		TArray<FNiagaraExt_ModuleInputValues> Values;
		Context.Errors.Reset();
		UNiagaraExternalEditUtilities::GetEmitterInputValues(EmitterRef, Values, Context);
		for (const FNiagaraExt_ModuleInputValues& Module : Values)
		{
			Text += FString::Printf(TEXT("   %s\n"), *Module.ModuleName.ToString());
			for (const FNiagaraExt_StackInputValueEntry& Input : Module.Inputs)
			{
				// The value is an FInstancedStruct whose payload type varies per
				// input - a float, an enum name, a data interface blob. Exported
				// as text rather than switched on: the point of this file is a
				// diff, and the exported form is stable enough to diff.
				FString Summary;
				const UScriptStruct* Type = Input.Value.GetScriptStruct();
				if (Type != nullptr && Input.Value.GetMemory() != nullptr)
				{
					Type->ExportText(Summary, Input.Value.GetMemory(), nullptr, nullptr,
						PPF_None, nullptr);
				}
				if (Summary.IsEmpty()) { continue; }
				Text += FString::Printf(TEXT("      %-38s %s\n"),
					*Input.Name.ToString(), *Summary);
			}
		}

		if (Data == nullptr) { continue; }

		for (const FNiagaraEventGeneratorProperties& Generator :
			Data->UpdateScriptProps.EventGenerators)
		{
			Text += FString::Printf(TEXT("   EVENT GENERATOR id=%s\n"), *Generator.ID.ToString());
		}

		for (const FNiagaraEventScriptProperties& Event : Data->GetEventHandlers())
		{
			Text += FString::Printf(
				TEXT("   EVENT HANDLER spawn=%u maxPerFrame=%u mode=%d event='%s' source=%s\n"),
				Event.SpawnNumber, Event.MaxEventsPerFrame,
				static_cast<int32>(Event.ExecutionMode), *Event.SourceEventName.ToString(),
				*Event.SourceEmitterID.ToString(EGuidFormats::DigitsWithHyphens));
		}

		for (UNiagaraRendererProperties* Renderer : Data->GetRenderers())
		{
			if (const UNiagaraSpriteRendererProperties* Sprite =
				Cast<UNiagaraSpriteRendererProperties>(Renderer))
			{
				Text += FString::Printf(
					TEXT("   RENDERER Sprite material=%s subImage=%.0fx%.0f align=%d facing=%d sort=%d\n"),
					Sprite->Material != nullptr ? *Sprite->Material->GetName() : TEXT("<none>"),
					Sprite->SubImageSize.X, Sprite->SubImageSize.Y,
					static_cast<int32>(Sprite->Alignment), static_cast<int32>(Sprite->FacingMode),
					static_cast<int32>(Sprite->SortMode));
			}
			else if (const UNiagaraMeshRendererProperties* Mesh =
				Cast<UNiagaraMeshRendererProperties>(Renderer))
			{
				const UStaticMesh* First = Mesh->Meshes.Num() > 0 ? Mesh->Meshes[0].Mesh : nullptr;
				const UMaterialInterface* Override = Mesh->OverrideMaterials.Num() > 0
					? Mesh->OverrideMaterials[0].ExplicitMat : nullptr;
				Text += FString::Printf(TEXT("   RENDERER Mesh mesh=%s material=%s sort=%d\n"),
					First != nullptr ? *First->GetName() : TEXT("<none>"),
					Override != nullptr ? *Override->GetName() : TEXT("<none>"),
					static_cast<int32>(Mesh->SortMode));
			}
			else if (Renderer != nullptr)
			{
				Text += FString::Printf(TEXT("   RENDERER %s\n"), *Renderer->GetClass()->GetName());
			}
		}
	}

	TArray<FString> Lines;
	Text.ParseIntoArrayLines(Lines, false);
	for (const FString& Line : Lines) { UE_LOG(LogVfxVerify, Display, TEXT("%s"), *Line); }

	if (Arguments.Contains(TEXT("out")))
	{
		FFileHelper::SaveStringToFile(Text, *Arguments[TEXT("out")],
			FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
	}
	return 0;
}
