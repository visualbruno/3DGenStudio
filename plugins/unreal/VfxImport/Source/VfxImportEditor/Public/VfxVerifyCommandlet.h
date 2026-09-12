// Read an imported system back off disk and print what is actually in it.
//
//   UnrealEditor-Cmd.exe <project> -run=VfxVerify -system=/Game/ImportedVfx/BenchA
//     [-out=<file>]
//
// WHY THIS EXISTS RATHER THAN A SIMULATION. Stepping Niagara headlessly is not
// available: UNiagaraComponent::ActivateInternal refuses to activate in a
// commandlet world (it reaches the "asset is not ready, retry on tick" path and
// the retry never comes), and the one API that could drive an instance without
// a component - FNiagaraSystemInstanceController::Initialize - is declared in a
// public header with no export macro, so nothing outside Niagara can link it.
// Both were tried; both are recorded here so the next person does not.
//
// WHAT IT DOES CATCH is the importer's actual failure mode, and the one that
// cost the most time on the Unity side: a write that was silently refused. An
// input hidden behind an unset static switch, an enum entry name that does not
// exist in this engine, a renderer that kept its default material - each of
// those leaves the module at its default and reports nothing. Reading the saved
// asset back and printing every module's inputs turns all of them into a diff.
//
// What it does NOT catch is a mapping that wrote the wrong NUMBER: whether a 30
// degree cone reads as 30 degrees is a question only the preview and the
// viewport can answer side by side.
#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "VfxVerifyCommandlet.generated.h"

UCLASS()
class UVfxVerifyCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	virtual int32 Main(const FString& Params) override;
};
