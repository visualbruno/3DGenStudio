// The bundle's textures and meshes, brought into the project.
//
// WITHOUT THIS THE IMPORT IS A MOTION TEST. An effect is a texture as much as
// it is a trajectory: a spark sheet, a smoke puff, a rune mesh. The first pass
// of this plugin built the emitters and told the author to go and import the
// art themselves, which meant every imported effect opened as white squares -
// technically an honest report, practically an effect nobody could look at and
// judge.
//
// TWO HALVES, and the second is the one with teeth:
//
//   1. The FILES. `UAssetImportTask` through AssetTools, which is the same road
//      a drag-and-drop takes - so a PNG lands as a UTexture2D with the project's
//      own settings, and a GLB goes through Interchange and lands as a
//      UStaticMesh. Nothing here re-implements an importer.
//
//   2. The MATERIAL. Unreal has no "additive" checkbox on a particle renderer:
//      a blend mode is a property of the material, and Niagara will not render
//      a material that was not compiled with the sprite (or mesh) usage flag
//      set. So a material has to be BUILT per (texture, blend, renderer) - and
//      built once and shared, or a twenty-emitter effect compiles twenty
//      identical shaders.
#pragma once

#include "CoreMinimal.h"
#include "VfxNiagaraBuilder.h"

class FVfxImportReport;
class FVfxIr;
class UMaterialInterface;
class UTexture2D;

struct FVfxAssetImport
{
	/**
	 * Import every file the manifest references.
	 *
	 * @param Ir            the parsed manifest
	 * @param BundleDir     the folder holding manifest.json
	 * @param PackagePath   where the Niagara system is going; assets land beside it
	 * @param Report        what was imported, and what could not be
	 * @param Out           filled with the imported objects, keyed by IR asset index
	 */
	static void ImportReferences(const FVfxIr& Ir, const FString& BundleDir,
		const FString& PackagePath, FVfxImportReport& Report, FVfxImportedAssets& Out);

	/**
	 * A material for one texture and one blend mode, created on first use.
	 *
	 * @param Texture     may be null, for an untextured emitter
	 * @param Blend       'additive', 'alpha', 'premultiplied' or 'opaque'
	 * @param bForMesh    a mesh renderer needs a different usage flag than a sprite
	 * @param PackagePath where to put it
	 */
	static UMaterialInterface* MaterialFor(UTexture2D* Texture, const FString& Blend,
		bool bForMesh, const FString& PackagePath, FVfxImportReport& Report);
};
