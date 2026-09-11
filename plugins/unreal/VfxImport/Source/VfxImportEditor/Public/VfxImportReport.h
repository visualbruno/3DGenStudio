// What the import actually did, in three buckets.
//
// THIS IS NOT LOGGING. A fallback with no report is indistinguishable from a
// broken feature: an author who sees no sparks cannot tell whether the emitter
// failed, the mapping dropped it, or they authored it wrong - and they will
// spend an hour on the wrong one of those three. So every block that goes in
// lands in exactly one bucket:
//
//   NATIVE        Niagara does this, and it does it the same way.
//   APPROXIMATED  something survives, but not exactly - and the note says how
//                 it differs, in terms of what the author will SEE.
//   DROPPED       nothing survived, and the note says what to do instead.
//
// The same three buckets as the Unity importer, deliberately. An author who
// exports to both engines is comparing two reports, and a difference in the
// wording of the buckets would read as a difference in the effect.
#pragma once

#include "CoreMinimal.h"

class FVfxImportReport
{
public:
	void Native(const FString& Emitter, const FString& Item, const FString& Note = FString());
	void Approximated(const FString& Emitter, const FString& Item, const FString& Note);
	void Dropped(const FString& Emitter, const FString& Item, const FString& Note);

	/** A hard failure - the import could not proceed. */
	void Fail(const FString& Message);

	int32 NumNative() const { return Natives.Num(); }
	int32 NumApproximated() const { return Approximations.Num(); }
	int32 NumDropped() const { return Drops.Num(); }
	bool HasFailures() const { return Failures.Num() > 0; }

	/** One-line summary, for a toast or a log. */
	FString Summary() const;

	/** The full report, in the order an author wants to read it. */
	FString ToText() const;

private:
	struct FEntry
	{
		FString Emitter;
		FString Item;
		FString Note;
	};

	TArray<FEntry> Natives;
	TArray<FEntry> Approximations;
	TArray<FEntry> Drops;
	TArray<FString> Failures;
};
