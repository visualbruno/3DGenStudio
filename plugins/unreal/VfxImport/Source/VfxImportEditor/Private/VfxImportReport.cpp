#include "VfxImportReport.h"

void FVfxImportReport::Native(const FString& Emitter, const FString& Item, const FString& Note)
{
	Natives.Add({ Emitter, Item, Note });
}

void FVfxImportReport::Approximated(const FString& Emitter, const FString& Item, const FString& Note)
{
	Approximations.Add({ Emitter, Item, Note });
}

void FVfxImportReport::Dropped(const FString& Emitter, const FString& Item, const FString& Note)
{
	Drops.Add({ Emitter, Item, Note });
}

void FVfxImportReport::Fail(const FString& Message)
{
	Failures.Add(Message);
}

FString FVfxImportReport::Summary() const
{
	return FString::Printf(TEXT("%d native, %d approximated, %d dropped"),
		Natives.Num(), Approximations.Num(), Drops.Num());
}

namespace
{
	void Append(FString& Out, const TCHAR* Heading, const TArray<FString>& Lines)
	{
		if (Lines.Num() == 0) { return; }
		Out += FString::Printf(TEXT("\n%s\n"), Heading);
		for (const FString& Line : Lines) { Out += Line + TEXT("\n"); }
	}
}

FString FVfxImportReport::ToText() const
{
	FString Out = Summary() + TEXT("\n");

	// FAILURES FIRST, then what was lost, and only then what worked. An author
	// reads the top of a report and stops; putting the thirty things that went
	// right above the one that did not is how a real problem goes unread.
	Append(Out, TEXT("FAILED"), Failures);

	auto Format = [](const TArray<FEntry>& Entries)
	{
		TArray<FString> Lines;
		for (const FEntry& Entry : Entries)
		{
			Lines.Add(FString::Printf(TEXT("  %-16s %-30s %s"),
				*Entry.Emitter, *Entry.Item, *Entry.Note));
		}
		return Lines;
	};

	Append(Out, TEXT("DROPPED"), Format(Drops));
	Append(Out, TEXT("APPROXIMATED"), Format(Approximations));
	Append(Out, TEXT("NATIVE"), Format(Natives));
	return Out;
}
