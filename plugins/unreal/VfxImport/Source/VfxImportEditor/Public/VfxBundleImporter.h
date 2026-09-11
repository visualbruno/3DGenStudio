// Bundle folder -> a Niagara system asset in the project.
//
// The thin outer layer: find the manifest, hand it to the builder, save. Split
// from the builder so the mapping can be read without wading through package
// plumbing, and so a future drag-and-drop factory has one call to make.
#pragma once

#include "CoreMinimal.h"

class FVfxImportReport;

class FVfxBundleImporter
{
public:
	/**
	 * @param BundleDir      the exported folder, or its manifest.json
	 * @param DestinationPath a content path such as /Game/ImportedVfx
	 * @param OutAssetPath   the object path of what was built
	 */
	static bool Import(const FString& BundleDir, const FString& DestinationPath,
		FVfxImportReport& Report, FString& OutAssetPath);
};
