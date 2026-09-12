#include "VfxBundleImporter.h"

#include "VfxIr.h"
#include "VfxImportReport.h"
#include "VfxNiagaraBuilder.h"
#include "VfxAssetImport.h"

#include "NiagaraSystem.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "HAL/FileManager.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "AssetRegistry/AssetRegistryModule.h"

DEFINE_LOG_CATEGORY_STATIC(LogVfxBundle, Log, All);

bool FVfxBundleImporter::Import(const FString& BundleDir, const FString& DestinationPath,
	FVfxImportReport& Report, FString& OutAssetPath)
{
	// THE BUNDLE IS A FOLDER, not an archive: there is no zip library on the
	// app side, so the export writes `manifest.json` plus an `assets/<kind>/`
	// tree. Accepting the manifest file itself as well, because that is what a
	// file picker hands back and refusing it would be a pointless lesson.
	FString ManifestPath = BundleDir;
	if (!ManifestPath.EndsWith(TEXT(".json")))
	{
		ManifestPath = FPaths::Combine(BundleDir, TEXT("manifest.json"));
	}

	if (!IFileManager::Get().FileExists(*ManifestPath))
	{
		Report.Fail(FString::Printf(TEXT("no manifest.json under %s"), *BundleDir));
		return false;
	}

	FVfxIr Ir;
	FString Error;
	if (!Ir.LoadFromFile(ManifestPath, Error))
	{
		Report.Fail(Error);
		return false;
	}

	const FString Fallback = FPaths::GetCleanFilename(FPaths::GetPath(ManifestPath));
	FString AssetName = Ir.EffectName(Fallback);
	// Asset names are not labels: a space or a dash here becomes an unopenable
	// package rather than an error at the point of naming.
	AssetName = AssetName.Replace(TEXT(" "), TEXT("_")).Replace(TEXT("-"), TEXT("_"));

	// THE ART, FIRST. The builder needs the objects, not the file paths: a
	// sprite renderer takes a material and a material takes a texture, so
	// nothing about the renderer can be decided until these exist.
	FVfxImportedAssets Assets;
	FVfxAssetImport::ImportReferences(Ir, FPaths::GetPath(ManifestPath), DestinationPath,
		Report, Assets);

	FVfxNiagaraBuilder Builder(Ir, Report, Assets);
	UNiagaraSystem* System = Builder.Build(AssetName, DestinationPath);
	if (System == nullptr) { return false; }

	UPackage* Package = System->GetOutermost();
	Package->MarkPackageDirty();
	FSavePackageArgs SaveArgs;
	SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
	const FString FileName = FPackageName::LongPackageNameToFilename(
		Package->GetName(), FPackageName::GetAssetPackageExtension());
	if (!UPackage::SavePackage(Package, System, *FileName, SaveArgs))
	{
		Report.Fail(FString::Printf(TEXT("could not save %s"), *FileName));
		return false;
	}

	FAssetRegistryModule::AssetCreated(System);
	OutAssetPath = System->GetPathName();
	return !Report.HasFailures();
}
