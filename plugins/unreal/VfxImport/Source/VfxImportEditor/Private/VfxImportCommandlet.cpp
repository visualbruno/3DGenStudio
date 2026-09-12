// The headless entry point.
//
//   UnrealEditor-Cmd.exe <project> -run=VfxImport -bundle=<folder> [-path=/Game/ImportedVfx]
//     [-report=<file>]
//
// A commandlet rather than only a menu item because this is what makes the
// importer testable: a real exit code and a written report, with no human
// watching. The menu item in VfxImportEditorModule.cpp calls the same code.
#include "VfxImportCommandlet.h"

#include "VfxBundleImporter.h"
#include "VfxImportReport.h"

#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

DEFINE_LOG_CATEGORY_STATIC(LogVfxImportCmd, Log, All);

int32 UVfxImportCommandlet::Main(const FString& Params)
{
	TArray<FString> Tokens;
	TArray<FString> Switches;
	TMap<FString, FString> Arguments;
	ParseCommandLine(*Params, Tokens, Switches, Arguments);

	const FString Bundle = Arguments.FindRef(TEXT("bundle"));
	if (Bundle.IsEmpty())
	{
		UE_LOG(LogVfxImportCmd, Error,
			TEXT("-bundle=<folder> is required (the folder holding manifest.json)"));
		return 2;
	}
	const FString Destination = Arguments.Contains(TEXT("path"))
		? Arguments[TEXT("path")] : TEXT("/Game/ImportedVfx");

	FVfxImportReport Report;
	FString AssetPath;
	const bool bOk = FVfxBundleImporter::Import(Bundle, Destination, Report, AssetPath);

	const FString Text = FString::Printf(TEXT("======== %s ========\n%s\n%s\n"),
		*FPaths::GetCleanFilename(Bundle.TrimChar('/')),
		*Report.ToText(),
		bOk ? *FString::Printf(TEXT("asset: %s"), *AssetPath) : TEXT("asset: NONE"));

	// Printed line by line rather than as one blob: a multi-line UE_LOG is a
	// single entry whose tail is the first thing a log viewer truncates.
	TArray<FString> Lines;
	Text.ParseIntoArrayLines(Lines, /*bCullEmpty*/ false);
	for (const FString& Line : Lines)
	{
		UE_LOG(LogVfxImportCmd, Display, TEXT("%s"), *Line);
	}

	if (Arguments.Contains(TEXT("report")))
	{
		// UTF-8, NOT the default. SaveStringToFile auto-detects and writes
		// UTF-16 the moment one non-ASCII character appears - a degree sign
		// in a cone report is enough - so the file a build step diffs changed
		// encoding depending on which blocks the effect happened to use.
		FFileHelper::SaveStringToFile(Text, *Arguments[TEXT("report")],
			FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
	}

	UE_LOG(LogVfxImportCmd, Display, TEXT("IMPORT RESULT %s | %s"),
		bOk ? TEXT("ok") : TEXT("failed"), *Report.Summary());
	return bOk ? 0 : 1;
}
