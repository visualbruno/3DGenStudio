#include "VfxAssetImport.h"

#include "VfxIr.h"
#include "VfxImportReport.h"

#include "AssetToolsModule.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetImportTask.h"
#include "AssetCompilingManager.h"
#include "Containers/Ticker.h"
#include "HAL/PlatformProcess.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "Factories/TextureFactory.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionParticleColor.h"
#include "Materials/MaterialExpressionTextureSampleParameter2D.h"
#include "Materials/MaterialExpressionVertexColor.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

DEFINE_LOG_CATEGORY_STATIC(LogVfxAssets, Log, All);

namespace
{
	/** An asset name that Unreal can hold: a package name is not a label. */
	FString SafeName(const FString& In)
	{
		FString Out;
		for (const TCHAR Ch : In)
		{
			Out.AppendChar(FChar::IsAlnum(Ch) || Ch == TEXT('_') ? Ch : TEXT('_'));
		}
		if (Out.IsEmpty()) { Out = TEXT("Asset"); }
		// A package cannot start with a digit without confusing the reference
		// parser, and the bundle names its files after a timestamp.
		if (FChar::IsDigit(Out[0])) { Out = TEXT("A") + Out; }
		return Out;
	}

	/**
	 * Import one file through AssetTools.
	 *
	 * bAutomated IS LOAD-BEARING: without it Interchange raises its options
	 * dialog, which in a commandlet is a window nobody can click and a hang
	 * that looks like a slow mesh.
	 */
	UObject* ImportFile(const FString& SourceFile, const FString& DestinationPath,
		const FString& AssetName, UClass* Wanted)
	{
		// Already imported - by an earlier run, or by the emitter before this
		// one referencing the same slot. Re-importing would work and would also
		// recompile a texture per emitter.
		const FString ObjectPath = DestinationPath / AssetName + TEXT(".") + AssetName;
		if (UObject* Existing = LoadObject<UObject>(nullptr, *ObjectPath))
		{
			if (Existing->IsA(Wanted)) { return Existing; }
		}

		UAssetImportTask* Task = NewObject<UAssetImportTask>();
		Task->AddToRoot();
		Task->Filename = SourceFile;
		Task->DestinationPath = DestinationPath;
		Task->DestinationName = AssetName;
		Task->bAutomated = true;
		Task->bSave = true;
		Task->bReplaceExisting = true;
		// SYNCHRONOUS, OR THE MESH IS NOT THERE YET. A GLB goes through
		// Interchange, which imports asynchronously by default: ImportAssetTasks
		// returns, GetObjects() is empty, and the importer concludes the bundle
		// had no mesh - so the emitter keeps its sprite renderer and the report
		// blames the glTF importer. Running the SAME import a second time found
		// the asset and worked, which is what gave it away.
		Task->bAsync = false;

		IAssetTools& AssetTools =
			FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
		TArray<UAssetImportTask*> Tasks = { Task };
		AssetTools.ImportAssetTasks(Tasks);

		// AND THEN WAIT FOR IT, by hand.
		//
		// A GLB goes through Interchange, which QUEUES the work and returns:
		// `bAsync = false` on the task does not change that, and the two APIs
		// that would wait properly are both out of reach - WaitUntilAllTasksDone
		// is protected on the manager, and FImportResult::WaitUntilDone is
		// declared in a public header with no export macro, so it links against
		// nothing. Both were tried.
		//
		// Measured without this: the import returns, the task has no objects,
		// the asset registry has no entry, the importer reports "the bundle
		// carried no mesh" - and the .uasset appears on disk moments later. The
		// same import run a second time then finds it, which is what gave it
		// away.
		//
		// So: pump the ticker and the asset compiler until the thing exists, or
		// for thirty seconds, whichever comes first. A timeout is not a hang.
		const FString Stem = FPaths::GetBaseFilename(SourceFile);
		UObject* Result = nullptr;
		const double Deadline = FPlatformTime::Seconds() + 30.0;
		for (;;)
		{
			for (UObject* Object : Task->GetObjects())
			{
				// ONLY THE CLASS THE CALLER ASKED FOR. A textured GLB imports as
				// four objects - the static mesh, its material, and two textures
				// - and taking the first "mesh or texture" took a TEXTURE, which
				// then failed the caller's cast and was reported as "the glTF
				// importer did not produce a static mesh". An untextured GLB
				// produces only the mesh, which is why the bench's arrow worked
				// and every real asset did not.
				if (Object != nullptr && Object->IsA(Wanted)) { Result = Object; break; }
			}

			if (Result == nullptr)
			{
				// THE REGISTRY IS THE AUTHORITY ON WHERE IT LANDED, because
				// Interchange names and places the result itself: a GLB goes to
				// <dest>/<source file stem>/StaticMeshes/<the name inside the
				// glTF>, so DestinationName is ignored and the expected path
				// misses. The source file's stem IS in the package path, so that
				// is what this searches on.
				FAssetRegistryModule& Registry =
					FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
				TArray<FString> Roots = { DestinationPath };
				Registry.Get().ScanPathsSynchronous(Roots, /*bForceRescan*/ true);
				TArray<FAssetData> Found;
				Registry.Get().GetAssetsByPath(FName(*DestinationPath), Found, /*bRecursive*/ true);
				for (const FAssetData& Asset : Found)
				{
					const FString AssetPath = Asset.GetObjectPathString();
					if (!AssetPath.Contains(Stem)
						&& !Asset.AssetName.ToString().Contains(AssetName))
					{
						continue;
					}
					UObject* Candidate = Asset.GetAsset();
					if (Candidate != nullptr && Candidate->IsA(Wanted))
					{
						Result = Candidate;
						break;
					}
				}
			}

			if (Result != nullptr || FPlatformTime::Seconds() > Deadline) { break; }
			FTSTicker::GetCoreTicker().Tick(0.1f);
			FAssetCompilingManager::Get().ProcessAsyncTasks();
			FPlatformProcess::Sleep(0.1f);
		}

		Task->RemoveFromRoot();
		return Result;
	}
}

void FVfxAssetImport::ImportReferences(const FVfxIr& Ir, const FString& BundleDir,
	const FString& PackagePath, FVfxImportReport& Report, FVfxImportedAssets& Out)
{
	const TArray<TSharedPtr<FJsonValue>>* References = nullptr;
	if (!Ir.Manifest()->TryGetArrayField(TEXT("references"), References)) { return; }

	// THE INDEX IS WHAT A BLOCK CARRIES. A block says `assetSlots: {texture: 1}`
	// and 1 is an index into `ir.assets`, whose entry carries the SLOT NAME -
	// and the slot name is what the manifest's references list is keyed by. Two
	// hops, and skipping either one silently pairs an emitter with the wrong
	// picture.
	TMap<FString, int32> SlotToIndex;
	const TArray<TSharedPtr<FJsonValue>>* Assets = nullptr;
	if (Ir.Ir()->TryGetArrayField(TEXT("assets"), Assets))
	{
		for (int32 i = 0; i < Assets->Num(); ++i)
		{
			const TSharedPtr<FJsonObject> Asset = (*Assets)[i]->AsObject();
			if (Asset.IsValid()) { SlotToIndex.Add(Asset->GetStringField(TEXT("slot")), i); }
		}
	}

	const FString TexturePath = PackagePath / TEXT("Textures");
	const FString MeshPath = PackagePath / TEXT("Meshes");

	for (const TSharedPtr<FJsonValue>& Entry : *References)
	{
		const TSharedPtr<FJsonObject> Reference = Entry->AsObject();
		if (!Reference.IsValid()) { continue; }

		const FString Slot = Reference->GetStringField(TEXT("slot"));
		const FString Kind = Reference->GetStringField(TEXT("kind"));
		const FString File = Reference->GetStringField(TEXT("file"));
		const int32* Index = SlotToIndex.Find(Slot);
		if (Index == nullptr)
		{
			Report.Dropped(TEXT("effect"), TEXT("referenced asset"),
				FString::Printf(TEXT("the bundle lists '%s' but no block uses it"), *Slot));
			continue;
		}

		const FString SourceFile = FPaths::Combine(BundleDir, File);
		if (!FPaths::FileExists(SourceFile))
		{
			Report.Dropped(TEXT("effect"), TEXT("referenced asset"),
				FString::Printf(TEXT("'%s' is listed in the manifest but %s is not in the bundle"),
					*Slot, *File));
			continue;
		}

		// Named after the SLOT, not the file. The file is a timestamp, and a
		// content browser full of 1789212570465_404597726 helps nobody; the
		// slot is what the author typed.
		FString Name = Reference->GetStringField(TEXT("assetName"));
		if (Name.IsEmpty()) { Name = Slot; }
		Name = SafeName(Name);

		const bool bMesh = Kind == TEXT("mesh");
		UObject* Imported = ImportFile(SourceFile, bMesh ? MeshPath : TexturePath, Name,
			bMesh ? static_cast<UClass*>(UStaticMesh::StaticClass()) : UTexture2D::StaticClass());

		if (bMesh)
		{
			if (UStaticMesh* Mesh = Cast<UStaticMesh>(Imported))
			{
				Out.Meshes.Add(*Index, Mesh);
				Report.Native(TEXT("effect"), TEXT("mesh"),
					FString::Printf(TEXT("%s -> %s"), *Slot, *Mesh->GetPathName()));
			}
			else
			{
				Report.Dropped(TEXT("effect"), TEXT("mesh"),
					FString::Printf(TEXT("'%s' (%s) did not import as a Static Mesh; is the ")
						TEXT("Interchange glTF importer enabled?"), *Slot, *File));
			}
			continue;
		}

		if (UTexture2D* Texture = Cast<UTexture2D>(Imported))
		{
			Out.Textures.Add(*Index, Texture);
			Report.Native(TEXT("effect"), TEXT("texture"),
				FString::Printf(TEXT("%s -> %s"), *Slot, *Texture->GetPathName()));
		}
		else
		{
			Report.Dropped(TEXT("effect"), TEXT("texture"),
				FString::Printf(TEXT("'%s' (%s) did not import as a texture"), *Slot, *File));
		}
	}
}

UMaterialInterface* FVfxAssetImport::MaterialFor(UTexture2D* Texture, const FString& Blend,
	bool bForMesh, const FString& PackagePath, FVfxImportReport& Report)
{
	// ONE MATERIAL PER (texture, blend, renderer). Twenty emitters sharing a
	// spark sheet share one shader; the name carries all three so the sharing
	// is visible in the content browser rather than accidental.
	const FString Key = FString::Printf(TEXT("M_%s_%s_%s"),
		Texture != nullptr ? *SafeName(Texture->GetName()) : TEXT("Untextured"),
		*SafeName(Blend), bForMesh ? TEXT("Mesh") : TEXT("Sprite"));
	const FString MaterialPath = PackagePath / TEXT("Materials");
	const FString ObjectPath = MaterialPath / Key + TEXT(".") + Key;
	if (UMaterialInterface* Existing = LoadObject<UMaterialInterface>(nullptr, *ObjectPath))
	{
		return Existing;
	}

	UPackage* Package = CreatePackage(*(MaterialPath / Key));
	if (Package == nullptr) { return nullptr; }
	UMaterial* Material = NewObject<UMaterial>(Package, *Key, RF_Public | RF_Standalone);
	if (Material == nullptr) { return nullptr; }

	// UNLIT, because a particle is light rather than a surface lit by it, and
	// TWO SIDED because a billboard seen from behind is still a billboard.
	Material->SetShadingModel(MSM_Unlit);
	Material->TwoSided = true;
	if (Blend == TEXT("additive")) { Material->BlendMode = BLEND_Additive; }
	else if (Blend == TEXT("premultiplied")) { Material->BlendMode = BLEND_AlphaComposite; }
	else if (Blend == TEXT("opaque")) { Material->BlendMode = BLEND_Opaque; }
	else { Material->BlendMode = BLEND_Translucent; }

	// THE USAGE FLAGS ARE NOT OPTIONAL. A material without the matching usage
	// bit does not fail to render - it renders as the engine's checkerboard
	// "default material", and the author sees a grey grid instead of their
	// effect with no error anywhere to explain it.
	Material->bUsedWithNiagaraSprites = !bForMesh;
	Material->bUsedWithNiagaraMeshParticles = bForMesh;
	Material->bUsedWithNiagaraRibbons = !bForMesh;

	UMaterialEditorOnlyData* EditorOnly = Material->GetEditorOnlyData();

	UMaterialExpressionParticleColor* ParticleColour =
		NewObject<UMaterialExpressionParticleColor>(Material);
	ParticleColour->MaterialExpressionEditorX = -200;
	ParticleColour->MaterialExpressionEditorY = 200;
	Material->GetExpressionCollection().AddExpression(ParticleColour);

	UMaterialExpression* ColourSource = ParticleColour;
	UMaterialExpression* AlphaSource = ParticleColour;
	int32 ColourOutput = 0;
	int32 AlphaOutput = 4; // ParticleColor's A pin.

	if (Texture != nullptr)
	{
		UMaterialExpressionTextureSampleParameter2D* Sample =
			NewObject<UMaterialExpressionTextureSampleParameter2D>(Material);
		Sample->ParameterName = TEXT("MainTexture");
		Sample->Texture = Texture;
		Sample->SamplerType = SAMPLERTYPE_Color;
		Sample->MaterialExpressionEditorX = -400;
		Sample->MaterialExpressionEditorY = -100;
		Material->GetExpressionCollection().AddExpression(Sample);

		UMaterialExpressionMultiply* Rgb = NewObject<UMaterialExpressionMultiply>(Material);
		Rgb->A.Connect(0, Sample);
		Rgb->B.Connect(0, ParticleColour);
		Rgb->MaterialExpressionEditorX = -150;
		Rgb->MaterialExpressionEditorY = -100;
		Material->GetExpressionCollection().AddExpression(Rgb);

		UMaterialExpressionMultiply* Alpha = NewObject<UMaterialExpressionMultiply>(Material);
		Alpha->A.Connect(4, Sample);         // the texture's alpha
		Alpha->B.Connect(4, ParticleColour); // the particle's alpha
		Alpha->MaterialExpressionEditorX = -150;
		Alpha->MaterialExpressionEditorY = 100;
		Material->GetExpressionCollection().AddExpression(Alpha);

		ColourSource = Rgb;
		ColourOutput = 0;
		AlphaSource = Alpha;
		AlphaOutput = 0;
	}

	EditorOnly->EmissiveColor.Connect(ColourOutput, ColourSource);
	if (Material->BlendMode != BLEND_Opaque)
	{
		EditorOnly->Opacity.Connect(AlphaOutput, AlphaSource);
	}

	Material->PreEditChange(nullptr);
	Material->PostEditChange();
	Material->MarkPackageDirty();

	FAssetRegistryModule::AssetCreated(Material);
	FSavePackageArgs SaveArgs;
	SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
	const FString FileName = FPackageName::LongPackageNameToFilename(
		Package->GetName(), FPackageName::GetAssetPackageExtension());
	UPackage::SavePackage(Package, Material, *FileName, SaveArgs);

	Report.Native(TEXT("effect"), TEXT("material"),
		FString::Printf(TEXT("%s (%s, unlit, %s)"), *Key, *Blend,
			bForMesh ? TEXT("mesh particles") : TEXT("sprites")));
	return Material;
}
