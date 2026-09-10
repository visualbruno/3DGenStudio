// A commandlet, so the importer can be driven headlessly.
//
// The eventual user-facing entry point is a menu item, but a commandlet is what
// makes the thing testable: `UnrealEditor-Cmd.exe <project> -run=VfxImport ...`
// runs it with no editor window and a real exit code, which is the only way to
// verify an import without a human watching.
#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "VfxImportCommandlet.generated.h"

UCLASS()
class UVfxImportCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	virtual int32 Main(const FString& Params) override;
};
