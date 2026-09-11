// IR -> Niagara.
//
// STRUCTURAL, NOT TEMPLATE-BINDING. The plan assumed both engines would need a
// library of hand-authored templates with exposed properties, because that is
// the only thing Unity's VFX Graph allows. Niagara does not have that limit:
// UNiagaraExternalEditUtilities can create a system, add emitters, add modules
// to their stacks and set any module input - so an imported effect gets real
// emitters and real module stacks that an author can then open and edit. See
// ../../Spikes/probe-niagara-schema-5.8.2.txt for the API survey this is
// written against.
//
// EVERY NAME IN HERE WAS MEASURED, NOT GUESSED. Module paths, input names, and
// above all the enum entry names come from that probe dump. Two traps it found:
//
//   1. The shape, lifetime and colour modes are USER-DEFINED enums whose
//      internal entry names are NewEnumerator0, NewEnumerator1 ... and whose
//      ORDER IS NOT THE DISPLAY ORDER. In ENiagara_SizeScaleMode, "Uniform" is
//      NewEnumerator3, not NewEnumerator1. So an entry is resolved by DISPLAY
//      name at runtime; hard-coding the internal name silently selects a
//      different mode and the effect imports looking almost right.
//
//   2. Most module inputs are HIDDEN until the static switch that governs them
//      is set, and SetStackInputData refuses to write a non-editable input. So
//      a switch is always set BEFORE the inputs it reveals.
#pragma once

#include "CoreMinimal.h"
#include "VfxIr.h"

class FVfxImportReport;
class UNiagaraSystem;
class UTexture2D;
class UStaticMesh;
class UMaterialInterface;
struct FNiagaraExternalEditContext;
struct FNiagaraExt_StackItemReference;

/** Where the bundle's referenced assets ended up, by IR asset index. */
struct FVfxImportedAssets
{
	TMap<int32, UTexture2D*> Textures;
	TMap<int32, UStaticMesh*> Meshes;
};

class FVfxNiagaraBuilder
{
public:
	FVfxNiagaraBuilder(const FVfxIr& InIr, FVfxImportReport& InReport,
		const FVfxImportedAssets& InAssets);

	/** Build (or overwrite) the Niagara system asset. Null on hard failure. */
	UNiagaraSystem* Build(const FString& AssetName, const FString& PackagePath);

private:
	// --- one emitter ------------------------------------------------------
	void BuildEmitter(const TSharedPtr<FJsonObject>& System, FName EmitterName);
	void BuildEmitterState(const TSharedPtr<FJsonObject>& System, FName EmitterName);
	void BuildSpawn(const TSharedPtr<FJsonObject>& System, FName EmitterName);
	void BuildInitialize(const TSharedPtr<FJsonObject>& System, FName EmitterName);
	void BuildUpdate(const TSharedPtr<FJsonObject>& System, FName EmitterName);
	void BuildOutput(const TSharedPtr<FJsonObject>& System, FName EmitterName);

	/** The curve emitter: an authored path as a sampled vector curve. */
	void BuildPathLocation(FName EmitterName, const FString& Label,
		const TArray<FVector3f>& Path, const TSharedPtr<FJsonObject>& Block,
		const TCHAR* PlacementMode);

	// --- stack editing ----------------------------------------------------
	FName AddModule(FName EmitterName, FName ScriptName, const TCHAR* ModuleAssetPath,
		const FString& Label);

	bool SetInput(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const struct FInstancedStruct& Value,
		const FString& Label);

	bool SetFloat(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, float Value, const FString& Label);
	bool SetBool(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, bool Value, const FString& Label);
	bool SetInt(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, int32 Value, const FString& Label);
	bool SetVector(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const FVector3f& Value, const FString& Label);
	bool SetPosition(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const FVector3f& Value, const FString& Label);
	bool SetColour(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const FLinearColor& Value, const FString& Label);
	bool SetEnum(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const TCHAR* EnumAssetPath,
		const TCHAR* DisplayName, const FString& Label);
	bool SetDynamicInput(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const TCHAR* DynamicInputAssetPath,
		const FString& Label);
	bool SetDataInterface(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const FString& PropertyValues,
		const FString& Label);

	/** A float input that is either a constant or an authored curve over life. */
	void SetScalarOrCurve(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const FVfxBound& Bound, float UnitScale,
		const FString& Label);

	// --- curves -----------------------------------------------------------
	/** An authored curve -> the JSON a NiagaraDataInterfaceCurve deserialises. */
	static FString FloatCurveJson(const TSharedPtr<FJsonObject>& Authored, float Scale);
	/** An authored gradient -> NiagaraDataInterfaceColorCurve JSON. */
	static FString ColourCurveJson(const TSharedPtr<FJsonObject>& Authored);
	/** A path -> NiagaraDataInterfaceVectorCurve JSON, one key per point. */
	static FString PathCurveJson(const TArray<FVector3f>& Path);
	/** The same path's unit tangents, so particles can travel along it. */
	static FString PathTangentCurveJson(const TArray<FVector3f>& Path);

	/**
	 * Drive one input with "where along the path", the SAME way twice.
	 *
	 * The position and the tangent have to agree per particle, or a particle
	 * appears at one point on the curve and flies off along another - which
	 * looks like the path is wrong rather than like the two samples are
	 * decorrelated. So both go through this, and it only ever uses values that
	 * are reproducible: the normalized execution index, or a hash of the
	 * particle's own id.
	 */
	void SetPathIndexChain(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const TCHAR* PlacementMode, const FString& Label);

	const FVfxIr& Ir;
	FVfxImportReport& Report;
	const FVfxImportedAssets& Assets;

	UNiagaraSystem* System = nullptr;

	/** True once SolveForcesAndVelocity is needed for the emitter being built. */
	bool bNeedsSolver = false;
	FString CurrentLabel;
};
