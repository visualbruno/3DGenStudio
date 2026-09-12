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
struct FNiagaraTypeDefinition;
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

	/**
	 * Sub-emitters: one emitter's deaths (or collisions) spawning another's.
	 *
	 * LAST, AND SYSTEM-WIDE, because it is the only part of the mapping that
	 * joins two emitters: the generator module goes on the SOURCE and the event
	 * handler on the LISTENER, and neither exists while the other is being
	 * built.
	 */
	void BuildEvents();

	/**
	 * The blocks that have to run AFTER the solver.
	 *
	 * Collision and kill-on-bounds are `afterIntegrate` in the app for the same
	 * reason they belong below Solve Forces and Velocity here: they read the
	 * position the integrator just wrote. Added above it they test last frame's
	 * position, which at 60fps is a particle that sinks a little into the floor
	 * every bounce and at 10fps is one that falls straight through.
	 */
	void BuildAfterSolve(FName EmitterName);

	/** The sheet, the frame count and the start frame, once the renderer exists. */
	void BuildFlipbook(const TSharedPtr<FJsonObject>& System, FName EmitterName,
		class UNiagaraSpriteRendererProperties* Sprite, int32 Cells);

	/** A shape emitter's offset and rotation. Every shape needs both. */
	void ApplyShapeTransform(FName EmitterName, FName Shape,
		const TSharedPtr<FJsonObject>& Block, const FString& Type);

	/** Velocity in a cone: the shared half of velocityDirection and the cone shape. */
	void AddConeVelocity(FName EmitterName, const FVector3f& Axis, float HalfAngleDegrees,
		const FVfxBound& Speed, const FString& Type);

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
	/** Link one input to a Niagara parameter, e.g. Emitter.Age. */
	bool SetLinked(FName EmitterName, FName ScriptName, FName ModuleName,
		const TArray<FName>& InputStack, const TCHAR* ParameterName,
		const FNiagaraTypeDefinition& Type, const FString& Label);

	/** An authored curve -> the JSON a NiagaraDataInterfaceCurve deserialises. */
	static FString FloatCurveJson(const TSharedPtr<FJsonObject>& Authored, float Scale);
	/** An authored gradient -> NiagaraDataInterfaceColorCurve JSON. */
	static FString ColourCurveJson(const TSharedPtr<FJsonObject>& Authored);
	/**
	 * A path -> NiagaraDataInterfaceVectorCurve JSON, one key per point.
	 *
	 * `KeyScale` is the range the keys are spread over: 1 when the curve is
	 * indexed by a 0..1 value, and the effect's DURATION when it is indexed by
	 * Emitter.Age instead - see SetPathIndexChain.
	 */
	static FString PathCurveJson(const TArray<FVector3f>& Path, float KeyScale);
	/** The same path's unit tangents, so particles can travel along it. */
	static FString PathTangentCurveJson(const TArray<FVector3f>& Path, float KeyScale);

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

	/** Blocks held back for BuildAfterSolve, in the order they were authored. */
	TArray<TSharedPtr<FJsonObject>> AfterSolve;

	/**
	 * update.speedLimit, in centimetres per second, or negative for none.
	 *
	 * Not a module: the solver owns the clamp. Clamping in a module of its own
	 * would clamp last frame's velocity and then let this frame's acceleration
	 * exceed it again immediately.
	 */
	float SolverSpeedLimit = -1.f;

	/**
	 * Whether anything in this emitter read Particles.ID.
	 *
	 * Niagara refuses to compile a read of Particles.ID unless the emitter has
	 * "Requires Persistent IDs" ticked, and it says so as a compile WARNING on
	 * the asset rather than an import error - so the effect saves, opens, and
	 * quietly does not run the script that needed it.
	 */
	bool bUsesParticleId = false;

	/** The emitter's renderer mode, needed by the modules the Update stage adds. */
	FString OutputMode;

	/**
	 * A mesh emitter's particle scale, held until the renderer exists.
	 *
	 * Initialize Particle only exposes Mesh Scale when the emitter HAS a mesh
	 * renderer - the input is otherwise "not part of the executing graph" and
	 * the write is refused - and the renderer is not swapped in until the
	 * Output stage. Negative means "not a mesh emitter".
	 */
	float PendingMeshScale = -1.f;

	/** Where the system is being written; generated materials go beside it. */
	FString PackageFolder;

	/** IR system id -> the emitter it became. Sub-emitters are wired by id. */
	TMap<FString, FName> EmitterBySystemId;

	/**
	 * A sub-emitter's burst count, by IR system id.
	 *
	 * A sub-emitter's burst is not a burst: it is how many particles ONE event
	 * makes, and Niagara spells that as the event handler's Spawn Number. Added
	 * to the emitter's own stack as well, it would also fire once at t=0 from
	 * the timeline - which is the "one impact at the centre, at the start"
	 * failure, in an engine that had never heard of the effect.
	 */
	TMap<FString, int32> SubEmitterBurst;

	/** True while building a system that listens to another one. */
	bool bIsSubEmitter = false;
};
