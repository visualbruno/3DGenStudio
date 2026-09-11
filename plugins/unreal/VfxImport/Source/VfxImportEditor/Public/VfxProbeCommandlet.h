// The discovery commandlet.
//
// NOT PART OF THE IMPORTER. It dumps what Niagara actually calls things - the
// script names inside an emitter, the module names a template starts with, and
// the exact input names and types of every module the mapping intends to drive.
//
// It exists because the alternative is guessing. "SpawnRate" or "Spawn Rate",
// "Lifetime" or "LifeTime", a uniform range as one input or as two: each wrong
// guess is a full UE build and editor launch to discover, and a wrong input
// name does not fail loudly - SetStackInputData reports one error among many
// and the module keeps its default, so the effect imports looking almost right.
// Dumping the schema once and writing the table against the dump turns a day of
// that into an afternoon.
#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "VfxProbeCommandlet.generated.h"

UCLASS()
class UVfxProbeCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	virtual int32 Main(const FString& Params) override;
};
