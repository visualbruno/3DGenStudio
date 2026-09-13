#include "VfxNiagaraBuilder.h"

#include "VfxImportReport.h"
#include "VfxAssetImport.h"

#include "NiagaraSystem.h"
#include "NiagaraEmitter.h"
#include "NiagaraScript.h"
#include "NiagaraTypes.h"
#include "NiagaraExternalSystemEditorUtilities.h"
#include "NiagaraSpriteRendererProperties.h"
#include "NiagaraMeshRendererProperties.h"
#include "NiagaraEmitterHandle.h"
#include "NiagaraGraph.h"
#include "NiagaraNodeInput.h"
#include "NiagaraNodeOutput.h"
#include "NiagaraScriptSource.h"
#include "ViewModels/Stack/NiagaraStackGraphUtilities.h"

#include "Engine/Texture2D.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "StructUtils/InstancedStruct.h"
#include "UObject/Package.h"

DEFINE_LOG_CATEGORY_STATIC(LogVfxImport, Log, All);

namespace VfxNiagara
{
	// The stack a Niagara emitter is made of. Measured, not guessed - see the
	// EMITTER TEMPLATES section of the probe dump.
	static const FName EmitterUpdate(TEXT("EmitterUpdateScript"));
	static const FName ParticleSpawn(TEXT("ParticleSpawnScript"));
	static const FName ParticleUpdate(TEXT("ParticleUpdateScript"));

	// What the Minimal template already contains, under exactly these names. A
	// mapping that ADDS one of these instead of editing it produces an emitter
	// with two Initialize Particle modules, which behaves like neither.
	static const FName EmitterStateModule(TEXT("EmitterState"));
	static const FName InitializeParticleModule(TEXT("InitializeParticle"));

	static const TCHAR* TemplateEmitter =
		TEXT("/Niagara/DefaultAssets/Templates/Emitters/Minimal.Minimal");

	static const TCHAR* ModSpawnRate = TEXT("/Niagara/Modules/Emitter/SpawnRate.SpawnRate");
	static const TCHAR* ModSpawnBurst =
		TEXT("/Niagara/Modules/Emitter/SpawnBurst_Instantaneous.SpawnBurst_Instantaneous");
	static const TCHAR* ModShapeLocation =
		TEXT("/Niagara/Modules/Spawn/Location/V2/ShapeLocation.ShapeLocation");
	static const TCHAR* ModAddVelocity =
		TEXT("/Niagara/Modules/Spawn/Velocity/AddVelocity.AddVelocity");
	static const TCHAR* ModGravity = TEXT("/Niagara/Modules/Update/Forces/GravityForce.GravityForce");
	static const TCHAR* ModDrag = TEXT("/Niagara/Modules/Update/Forces/Drag.Drag");
	static const TCHAR* ModCurlNoise =
		TEXT("/Niagara/Modules/Update/Forces/CurlNoiseForce.CurlNoiseForce");
	static const TCHAR* ModPointAttraction =
		TEXT("/Niagara/Modules/Update/Forces/PointAttractionForce.PointAttractionForce");
	static const TCHAR* ModVortex = TEXT("/Niagara/Modules/Update/Forces/VortexForce.VortexForce");
	static const TCHAR* ModWind = TEXT("/Niagara/Modules/Update/Forces/WindForce.WindForce");
	static const TCHAR* ModScaleColor = TEXT("/Niagara/Modules/Update/Color/ScaleColor.ScaleColor");
	static const TCHAR* ModScaleSpriteSize =
		TEXT("/Niagara/Modules/Update/Size/ScaleSpriteSize.ScaleSpriteSize");
	static const TCHAR* ModConstrainToPlane =
		TEXT("/Niagara/Modules/Update/Position/ConstrainPositionToPlane.ConstrainPositionToPlane");
	static const TCHAR* ModKillInVolume =
		TEXT("/Niagara/Modules/Update/Lifetime/KillParticlesInVolume.KillParticlesInVolume");
	static const TCHAR* ModSolve =
		TEXT("/Niagara/Modules/Solvers/SolveForcesAndVelocity.SolveForcesAndVelocity");
	// Found with the probe's -find mode rather than guessed; every one of these
	// was then dumped input by input with -modules before a line was written
	// against it.
	static const TCHAR* ModAddVelocityInCone =
		TEXT("/Niagara/Modules/Spawn/Velocity/AddVelocityInCone.AddVelocityInCone");
	static const TCHAR* ModAddVelocityFromPoint =
		TEXT("/Niagara/Modules/Spawn/Velocity/AddVelocityFromPoint.AddVelocityFromPoint");
	static const TCHAR* ModStaticMeshLocation =
		TEXT("/Niagara/Modules/Spawn/Location/StaticMeshLocation.StaticMeshLocation");
	static const TCHAR* ModSpriteRotationRate =
		TEXT("/Niagara/Modules/Update/Orientation/SpriteRotationRate.SpriteRotationRate");
	static const TCHAR* ModMeshRotationRate =
		TEXT("/Niagara/Modules/Update/Orientation/MeshRotationRate.MeshRotationRate");
	static const TCHAR* ModJitterPosition =
		TEXT("/Niagara/Modules/Update/Position/JitterPosition.JitterPosition");
	static const TCHAR* ModCollision = TEXT("/Niagara/Modules/Collision/Collision.Collision");
	static const TCHAR* ModSubUV =
		TEXT("/Niagara/Modules/Update/SubUV/V2/SubUVAnimation.SubUVAnimation");
	static const TCHAR* ModInheritVelocity =
		TEXT("/Niagara/Modules/Update/Velocity/InheritVelocity.InheritVelocity");
	static const TCHAR* ModGenerateDeathEvent =
		TEXT("/Niagara/Modules/Events/GenerateDeathEvent.GenerateDeathEvent");
	static const TCHAR* ModGenerateCollisionEvent =
		TEXT("/Niagara/Modules/Events/GenerateCollisionEvent.GenerateCollisionEvent");
	static const TCHAR* ModReceiveDeathEvent =
		TEXT("/Niagara/Modules/Events/ReceiveDeathEvent.ReceiveDeathEvent");
	static const TCHAR* ModReceiveCollisionEvent =
		TEXT("/Niagara/Modules/Events/ReceiveCollisionEvent.ReceiveCollisionEvent");

	static const TCHAR* DynUniformRangedVector =
		TEXT("/Niagara/DynamicInputs/UniformRange/UniformRangedVector.UniformRangedVector");

	static const TCHAR* DynVectorFromCurve =
		TEXT("/Niagara/DynamicInputs/ValueFromCurve/VectorFromCurve.VectorFromCurve");
	static const TCHAR* DynFloatFromCurve =
		TEXT("/Niagara/DynamicInputs/ValueFromCurve/FloatFromCurve.FloatFromCurve");
	static const TCHAR* DynNormalizedExecIndex =
		TEXT("/Niagara/DynamicInputs/Execution/ReturnNormalizedExecIndex.ReturnNormalizedExecIndex");
	static const TCHAR* DynUniformRangedFloat =
		TEXT("/Niagara/DynamicInputs/UniformRange/UniformRangedFloat.UniformRangedFloat");
	static const TCHAR* DynFixedSeedRandomFloat =
		TEXT("/Niagara/DynamicInputs/Random/FixedSeedRandomFloat.FixedSeedRandomFloat");
	static const TCHAR* DynParticleIdAsFloat =
		TEXT("/Niagara/DynamicInputs/Execution/ReturnParticleID_AsFloat.ReturnParticleID_AsFloat");

	static const TCHAR* EnumShapes =
		TEXT("/Niagara/Enums/Location/ENiagara_LocationShapes.ENiagara_LocationShapes");
	static const TCHAR* EnumLifetime = TEXT("/Niagara/Enums/ENiagara_LifetimeMode.ENiagara_LifetimeMode");
	static const TCHAR* EnumColorInit =
		TEXT("/Niagara/Enums/ENiagara_ColorInitializationMode.ENiagara_ColorInitializationMode");
	static const TCHAR* EnumPositionInit =
		TEXT("/Niagara/Enums/ENiagara_PositionInitializationMode.ENiagara_PositionInitializationMode");
	static const TCHAR* EnumSizeScale = TEXT("/Niagara/Enums/ENiagara_SizeScaleMode.ENiagara_SizeScaleMode");
	static const TCHAR* EnumScaleColor = TEXT("/Niagara/Enums/ENiagaraScaleColorMode.ENiagaraScaleColorMode");
	static const TCHAR* EnumLifeCycle =
		TEXT("/Niagara/Enums/ENiagaraEmitterLifeCycleMode.ENiagaraEmitterLifeCycleMode");
	static const TCHAR* EnumLoopBehavior =
		TEXT("/Niagara/Enums/ENiagara_EmitterStateOptions.ENiagara_EmitterStateOptions");
	static const TCHAR* EnumRotationMode =
		TEXT("/Niagara/Enums/Transforms/ENiagara_RotationMode.ENiagara_RotationMode");
	static const TCHAR* EnumCpuCollision =
		TEXT("/Niagara/Enums/ENiagara_CPUCollisionType.ENiagara_CPUCollisionType");
	static const TCHAR* EnumCoordinateSpace =
		TEXT("/Niagara/Enums/ENiagaraCoordinateSpace.ENiagaraCoordinateSpace");
	static const TCHAR* EnumSubUvMode =
		TEXT("/Niagara/Enums/ENiagara_SubUVLookupModeV2.ENiagara_SubUVLookupModeV2");
	static const TCHAR* EnumKillShape =
		TEXT("/Niagara/Enums/ENiagaraKillVolumeOptions.ENiagaraKillVolumeOptions");
	static const TCHAR* EnumMeshOrSprite =
		TEXT("/Niagara/Enums/ENiagaraMeshOrSprite.ENiagaraMeshOrSprite");

	/**
	 * An enum entry, BY DISPLAY NAME.
	 *
	 * These are user-defined enum assets: their internal entry names are
	 * NewEnumerator0, NewEnumerator1, ... and the numbering DOES NOT follow the
	 * display order. ENiagara_SizeScaleMode lists Unset, Uniform, Random
	 * Uniform, Non-Uniform, Random Non-Uniform - and "Uniform" is
	 * NewEnumerator3. Hard-coding an internal name is therefore not a shortcut,
	 * it is a coin flip that lands on the wrong mode and imports quietly.
	 */
	bool FindEnumEntry(UEnum* Enum, const TCHAR* DisplayName, FName& OutName)
	{
		if (Enum == nullptr) { return false; }
		for (int32 i = 0; i < Enum->NumEnums() - 1; ++i)
		{
			if (Enum->GetDisplayNameTextByIndex(i).ToString().Equals(DisplayName,
				ESearchCase::IgnoreCase))
			{
				// FULLY QUALIFIED - "ENiagara_LifetimeMode::NewEnumerator1", not
				// "NewEnumerator1". The short form is accepted without complaint
				// and then matches nothing, so the switch keeps its default and
				// every input that switch was supposed to reveal stays hidden.
				// That is how one wrong line here produced twenty "input is
				// hidden by static-switch" reports somewhere else.
				OutName = Enum->GetNameByIndex(i);
				return true;
			}
		}
		return false;
	}

	/**
	 * An FVector3f into an FInstancedStruct.
	 *
	 * NOT FInstancedStruct::Make. The core maths types are VARIANT structs -
	 * one UScriptStruct per float/double flavour - so TBaseStructure<FVector3f>
	 * does not exist and Make fails to compile on it. Every other payload here
	 * (FNiagaraFloat, FLinearColor, the Niagara data structs) is an ordinary
	 * USTRUCT and goes through Make as usual.
	 */
	template <typename T>
	FInstancedStruct MakeVariant(const T& Value)
	{
		FInstancedStruct Out;
		Out.InitializeAs(TVariantStructure<T>::Get(),
			reinterpret_cast<const uint8*>(&Value));
		return Out;
	}

	/** Catmull-Rom chord lengths, for placing a path's keys along its length. */
	float ChordLength(const TArray<FVector3f>& Path)
	{
		float Total = 0.f;
		for (int32 i = 1; i < Path.Num(); ++i) { Total += (Path[i] - Path[i - 1]).Size(); }
		return Total;
	}
}

// The edit session. Every stack call resolves through the system's view model,
// so a default-constructed context has none and fails with "System view model is
// invalid" - which reads like a broken asset rather than a missing constructor
// argument. Held here rather than passed through twenty signatures.
static TUniquePtr<FNiagaraExternalEditContext> GContextHolder;
static FNiagaraExternalEditContext* GContext = nullptr;

/**
 * Re-resolve the stack after a change that reshapes it.
 *
 * A STATIC SWITCH DOES NOT REVEAL ITS INPUTS UNTIL THE CONTEXT IS REBUILT, and
 * this was measured rather than assumed. Writing "Lifetime Mode = Random"
 * succeeds and reads back correctly - and "Lifetime Min" stays hidden, so the
 * very next write is refused as "hidden by static-switch logic". Waiting for
 * compilation to finish changes nothing; a NEW FNiagaraExternalEditContext on
 * the same system reveals Min and Max immediately, and the write then lands.
 *
 * So the context's view model caches the visible input set, and the cache has
 * no public invalidation. Rebuilding it is the whole fix. Without it an import
 * quietly keeps every default that a mode was supposed to unlock: random
 * lifetimes become fixed, colours stay white, and the curve emitter never gets
 * its path at all.
 */
static void RefreshContext(UNiagaraSystem* System)
{
	GContextHolder = MakeUnique<FNiagaraExternalEditContext>(System);
	GContext = GContextHolder.Get();
}

FVfxNiagaraBuilder::FVfxNiagaraBuilder(const FVfxIr& InIr, FVfxImportReport& InReport,
	const FVfxImportedAssets& InAssets)
	: Ir(InIr), Report(InReport), Assets(InAssets)
{
}

UNiagaraSystem* FVfxNiagaraBuilder::Build(const FString& AssetName, const FString& PackagePath)
{
	// RE-IMPORTING OVER AN EXISTING ASSET IS THE NORMAL CASE - an author tweaks
	// the effect and exports again - and it is fatal if the package is on disk
	// but not in memory: the save asserts with "cannot be saved as it has only
	// been partially loaded" and takes the editor down with it. Loading it fully
	// first turns that crash into an ordinary overwrite.
	PackageFolder = PackagePath;
	const FString LongPackageName = PackagePath / AssetName;
	if (FPackageName::DoesPackageExist(LongPackageName))
	{
		LoadPackage(nullptr, *LongPackageName, LOAD_None);
	}

	FNiagaraExternalEditContext CreateContext;
	System = UNiagaraExternalEditUtilities::CreateNiagaraSystem(
		AssetName, PackagePath, /*TemplateSystem*/ nullptr, CreateContext);
	for (const FText& Error : CreateContext.Errors)
	{
		Report.Fail(FString::Printf(TEXT("creating the system: %s"), *Error.ToString()));
	}
	if (System == nullptr)
	{
		Report.Fail(FString::Printf(TEXT("could not create %s in %s"), *AssetName, *PackagePath));
		return nullptr;
	}

	RefreshContext(System);

	int32 Index = 0;
	for (const TSharedPtr<FJsonValue>& Entry : Ir.Systems())
	{
		const TSharedPtr<FJsonObject> SystemObject = Entry->AsObject();
		if (!SystemObject.IsValid()) { continue; }

		FString Name = SystemObject->GetStringField(TEXT("name"));
		if (Name.IsEmpty()) { Name = FString::Printf(TEXT("Emitter%d"), Index); }
		// Niagara emitter names are identifiers, not labels.
		Name = Name.Replace(TEXT(" "), TEXT("")).Replace(TEXT("-"), TEXT(""));
		BuildEmitter(SystemObject, FName(*Name));
		++Index;
	}

	BuildEvents();

	GContextHolder.Reset();
	GContext = nullptr;
	return System;
}

void FVfxNiagaraBuilder::BuildEmitter(const TSharedPtr<FJsonObject>& SystemObject, FName EmitterName)
{
	CurrentLabel = EmitterName.ToString();
	bNeedsSolver = false;
	AfterSolve.Reset();
	SolverSpeedLimit = -1.f;
	PendingMeshScale = -1.f;
	bUsesParticleId = false;

	// THE RENDERER IS READ BEFORE THE STACK IS BUILT, because the Update stage
	// needs it: a spin is Sprite Rotation Rate on a sprite and Mesh Rotation
	// Rate on a mesh, and the two write different attributes. Reading it here
	// costs one field lookup; discovering it in BuildOutput, which runs last,
	// would mean either building the stack twice or getting it wrong.
	OutputMode.Reset();
	{
		const TArray<TSharedPtr<FJsonValue>>* Outputs = nullptr;
		if (SystemObject->TryGetArrayField(TEXT("outputs"), Outputs) && Outputs->Num() > 0)
		{
			const TSharedPtr<FJsonObject> First = (*Outputs)[0]->AsObject();
			if (First.IsValid()) { OutputMode = First->GetStringField(TEXT("mode")); }
		}
	}

	UNiagaraEmitter* Template = LoadObject<UNiagaraEmitter>(nullptr, VfxNiagara::TemplateEmitter);
	if (Template == nullptr)
	{
		Report.Fail(TEXT("the Minimal emitter template is missing - is the Niagara plugin enabled?"));
		return;
	}

	GContext->Errors.Reset();
	FNiagaraExt_EmitterTopology Topology;
	UNiagaraExternalEditUtilities::AddEmitter(Template, EmitterName, Topology, *GContext);
	for (const FText& Error : GContext->Errors)
	{
		Report.Fail(FString::Printf(TEXT("%s: adding the emitter: %s"),
			*CurrentLabel, *Error.ToString()));
	}
	if (Topology.EmitterName.IsNone())
	{
		Report.Fail(FString::Printf(TEXT("%s: the emitter was not added"), *CurrentLabel));
		return;
	}
	// AddEmitter may rename to avoid a collision, and every later reference has
	// to use the name it actually got.
	EmitterName = Topology.EmitterName;
	CurrentLabel = EmitterName.ToString();
	EmitterBySystemId.Add(SystemObject->GetStringField(TEXT("id")), EmitterName);
	bIsSubEmitter = SystemObject->HasField(TEXT("listen"));

	BuildEmitterState(SystemObject, EmitterName);
	BuildSpawn(SystemObject, EmitterName);
	BuildInitialize(SystemObject, EmitterName);
	BuildUpdate(SystemObject, EmitterName);
	BuildOutput(SystemObject, EmitterName);

	// THE SOLVER GOES LAST, always. It integrates the forces every other Update
	// module accumulated, so a solver placed before them integrates last frame's
	// forces - which looks like a one-frame lag at 60fps and like broken physics
	// at 10. Niagara does not enforce the order; the author would have to know.
	if (bNeedsSolver || SolverSpeedLimit >= 0.f || AfterSolve.Num() > 0)
	{
		const FName Solver = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
			VfxNiagara::ModSolve, TEXT("solver"));
		if (!Solver.IsNone())
		{
			if (SolverSpeedLimit >= 0.f)
			{
				// THE SPEED CAP LIVES HERE, and it is native rather than a note
				// telling the author to go and tick it themselves. Clamp
				// Velocity reveals Speed Limit, so the switch goes first.
				SetBool(EmitterName, VfxNiagara::ParticleUpdate, Solver,
					{ TEXT("Clamp Velocity") }, true, TEXT("update.speedLimit"));
				SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Solver,
					{ TEXT("Speed Limit") }, SolverSpeedLimit, TEXT("update.speedLimit"));
				Report.Native(CurrentLabel, TEXT("update.speedLimit"),
					FString::Printf(TEXT("Solve Forces and Velocity clamps at %.0f cm/s"),
						SolverSpeedLimit));
			}
			Report.Native(CurrentLabel, TEXT("Solve Forces and Velocity"),
				TEXT("added last, so it integrates the forces above it"));
		}
	}

	BuildAfterSolve(EmitterName);

	if (bUsesParticleId)
	{
		// PERSISTENT IDS, or the script that reads Particles.ID does not run.
		// Niagara reports this as an asset compile warning - "Before the
		// Particles.ID parameter can be used, the 'Requires persistent IDs'
		// option has to be activated" - which never reaches the import report,
		// so the effect saves clean and the curve emitter silently piles every
		// particle onto the same point.
		for (const FNiagaraEmitterHandle& Handle : System->GetEmitterHandles())
		{
			if (Handle.GetName() != EmitterName) { continue; }
			if (FVersionedNiagaraEmitterData* Data = Handle.GetEmitterData())
			{
				Data->bRequiresPersistentIDs = true;
				Report.Native(CurrentLabel, TEXT("persistent ids"),
					TEXT("enabled, because this emitter reads Particles.ID"));
			}
		}
	}
}

namespace
{
	/**
	 * An empty script stack for one usage: an input node feeding an output node.
	 *
	 * NOT FNiagaraStackGraphUtilities::ResetGraphForOutput, which is exactly
	 * this function and is declared in a public header WITHOUT an export macro
	 * - so it compiles against and links against nothing. (RelayoutGraph is in
	 * the same position, and is only cosmetic, so it is simply not called.)
	 *
	 * The shape is the one every Niagara script stack has: a Parameter Map in,
	 * a Parameter Map out, and modules inserted between them. AddScriptModuleToStack
	 * - which IS exported - does the inserting from there.
	 */
	UNiagaraNodeOutput* MakeEventScriptStack(UNiagaraGraph& Graph, const FGuid& UsageId)
	{
		if (UNiagaraNodeOutput* Existing = Graph.FindEquivalentOutputNode(
			ENiagaraScriptUsage::ParticleEventScript, UsageId))
		{
			return Existing;
		}

		FGraphNodeCreator<UNiagaraNodeInput> InputCreator(Graph);
		UNiagaraNodeInput* InputNode = InputCreator.CreateNode();
		InputNode->Input = FNiagaraVariable(FNiagaraTypeDefinition::GetParameterMapDef(),
			TEXT("InputMap"));
		InputNode->Usage = ENiagaraInputNodeUsage::Parameter;
		InputNode->NodePosX = -100;
		InputNode->NodePosY = 0;
		InputCreator.Finalize();

		FGraphNodeCreator<UNiagaraNodeOutput> OutputCreator(Graph);
		UNiagaraNodeOutput* OutputNode = OutputCreator.CreateNode();
		OutputNode->SetUsage(ENiagaraScriptUsage::ParticleEventScript);
		OutputNode->SetUsageId(UsageId);
		OutputNode->Outputs.Add(FNiagaraVariable(FNiagaraTypeDefinition::GetParameterMapDef(),
			TEXT("OutputMap")));
		OutputNode->NodePosX = 300;
		OutputNode->NodePosY = 0;
		OutputCreator.Finalize();

		UEdGraphPin* From = InputNode->GetOutputPin(0);
		UEdGraphPin* To = OutputNode->GetInputPin(0);
		if (From == nullptr || To == nullptr) { return nullptr; }
		From->MakeLinkTo(To);
		return OutputNode;
	}
}

void FVfxNiagaraBuilder::BuildEvents()
{
	const TArray<TSharedPtr<FJsonValue>>* Channels = nullptr;
	if (!Ir.Ir()->TryGetArrayField(TEXT("eventChannels"), Channels)) { return; }

	// The generator is added once per (source emitter, trigger) even when three
	// systems listen to the same one - a second Generate Death Event on the
	// same stack sends every death twice.
	TSet<FString> Generated;

	for (const TSharedPtr<FJsonValue>& Entry : Ir.Systems())
	{
		const TSharedPtr<FJsonObject> SystemObject = Entry->AsObject();
		if (!SystemObject.IsValid() || !SystemObject->HasField(TEXT("listen"))) { continue; }
		const TSharedPtr<FJsonObject>* Listen = nullptr;
		if (!SystemObject->TryGetObjectField(TEXT("listen"), Listen)) { continue; }

		const FString ChildId = SystemObject->GetStringField(TEXT("id"));
		const FName* ChildName = EmitterBySystemId.Find(ChildId);
		if (ChildName == nullptr) { continue; }
		CurrentLabel = ChildName->ToString();

		int32 ChannelIndex = -1;
		(*Listen)->TryGetNumberField(TEXT("channel"), ChannelIndex);
		if (!Channels->IsValidIndex(ChannelIndex)) { continue; }
		const TSharedPtr<FJsonObject> Channel = (*Channels)[ChannelIndex]->AsObject();
		if (!Channel.IsValid()) { continue; }

		const FString SourceId = Channel->GetStringField(TEXT("sourceSystemId"));
		const FName* SourceName = EmitterBySystemId.Find(SourceId);
		if (SourceName == nullptr)
		{
			Report.Dropped(CurrentLabel, TEXT("sub-emitter"),
				FString::Printf(TEXT("it listens to '%s', which is not in this effect"),
					*SourceId));
			continue;
		}

		FString Trigger = Channel->GetStringField(TEXT("trigger"));
		FString ListenTrigger;
		if ((*Listen)->TryGetStringField(TEXT("trigger"), ListenTrigger) && !ListenTrigger.IsEmpty())
		{
			Trigger = ListenTrigger;
		}
		const bool bCollision = Trigger == TEXT("onCollide");
		double Probability = 1.0;
		(*Listen)->TryGetNumberField(TEXT("probability"), Probability);

		// ---- the generator, on the source ------------------------------
		const FString GeneratorKey = SourceId + TEXT("/") + Trigger;
		if (!Generated.Contains(GeneratorKey))
		{
			Generated.Add(GeneratorKey);
			const FString SourceLabel = SourceName->ToString();
			const FString Saved = CurrentLabel;
			CurrentLabel = SourceLabel;
			const FName Generator = AddModule(*SourceName, VfxNiagara::ParticleUpdate,
				bCollision ? VfxNiagara::ModGenerateCollisionEvent
					: VfxNiagara::ModGenerateDeathEvent, TEXT("sub-emitter"));
			if (!Generator.IsNone())
			{
				// PROBABILITY IS NATIVE HERE, which it is not in Unity: the
				// generator rolls per event, exactly like the preview's
				// per-event roll, so "a quarter of the sparks make a puff"
				// survives as the same sentence rather than as a note.
				if (Probability < 1.0 && !bCollision)
				{
					SetBool(*SourceName, VfxNiagara::ParticleUpdate, Generator,
						{ TEXT("Use Event Probability") }, true, TEXT("sub-emitter"));
					SetFloat(*SourceName, VfxNiagara::ParticleUpdate, Generator,
						{ TEXT("Event Probability") }, static_cast<float>(Probability),
						TEXT("sub-emitter"));
				}
				Report.Native(SourceLabel, TEXT("sub-emitter"),
					FString::Printf(TEXT("generates %s events"),
						bCollision ? TEXT("collision") : TEXT("death")));
			}
			CurrentLabel = Saved;
		}

		// ---- the handler, on the listener ------------------------------
		FVersionedNiagaraEmitter Versioned;
		FGuid SourceHandleId;
		for (const FNiagaraEmitterHandle& Handle : System->GetEmitterHandles())
		{
			if (Handle.GetName() == *ChildName) { Versioned = Handle.GetInstance(); }
			if (Handle.GetName() == *SourceName) { SourceHandleId = Handle.GetId(); }
		}
		FVersionedNiagaraEmitterData* Data = Versioned.GetEmitterData();
		if (Versioned.Emitter == nullptr || Data == nullptr) { continue; }

		// BOTH SIDES NEED PERSISTENT IDS. The generator sends the dying
		// particle's id in the payload and the receiver reads it, so both
		// scripts touch Particles.ID - and Niagara refuses to run a script that
		// reads it without this, as an asset WARNING that never reaches the
		// import report. The effect then saves clean and does nothing.
		Data->bRequiresPersistentIDs = true;
		for (const FNiagaraEmitterHandle& Handle : System->GetEmitterHandles())
		{
			if (Handle.GetName() != *SourceName) { continue; }
			if (FVersionedNiagaraEmitterData* SourceData = Handle.GetEmitterData())
			{
				SourceData->bRequiresPersistentIDs = true;
			}
		}

		UNiagaraScriptSource* Source = Cast<UNiagaraScriptSource>(Data->GraphSource);
		if (Source == nullptr || Source->NodeGraph == nullptr)
		{
			Report.Dropped(CurrentLabel, TEXT("sub-emitter"),
				TEXT("this emitter has no editable graph to hang an event handler on"));
			continue;
		}

		// THE EXTERNAL EDIT API CANNOT REACH AN EVENT HANDLER: its stack
		// references name one of six scripts and an event handler is a seventh.
		// So this is the one place the importer talks to the graph directly -
		// the same four calls the editor's own "Add Event Handler" button makes.
		FNiagaraEventScriptProperties EventProperties;
		EventProperties.Script = NewObject<UNiagaraScript>(Versioned.Emitter,
			MakeUniqueObjectName(Versioned.Emitter, UNiagaraScript::StaticClass(),
				TEXT("EventScript")), RF_Transactional);
		EventProperties.Script->SetUsage(ENiagaraScriptUsage::ParticleEventScript);
		EventProperties.Script->SetUsageId(FGuid::NewGuid());
		EventProperties.Script->SetLatestSource(Source);
		EventProperties.SourceEmitterID = SourceHandleId;
		// THE EVENT'S NAME, WITHOUT WHICH NOTHING FIRES. A handler with no
		// SourceEventName matches no generator, so the emitter sits there
		// spawning nothing and the import report happily says the sub-emitter
		// was wired. Fire Storm imported with no impacts at all and the Ice
		// Wall with only its slabs, both from this one empty FName.
		//
		// These two names are what the stock modules actually declare, read
		// back off a compiled asset (`-run=VfxVerify` prints EVENT GENERATOR
		// lines) rather than guessed.
		EventProperties.SourceEventName = bCollision ? TEXT("CollisionEvent") : TEXT("DeathEvent");
		EventProperties.ExecutionMode = EScriptExecutionMode::SpawnedParticles;
		const int32* Burst = SubEmitterBurst.Find(ChildId);
		EventProperties.SpawnNumber = Burst != nullptr ? *Burst : 1;
		EventProperties.MaxEventsPerFrame = 1024;
		EventProperties.UpdateAttributeInitialValues = true;
		Versioned.Emitter->AddEventHandler(EventProperties, Versioned.Version);

		UNiagaraNodeOutput* Output = MakeEventScriptStack(*Source->NodeGraph,
			EventProperties.Script->GetUsageId());
		if (Output != nullptr)
		{
			// WITHOUT THIS THE CHILDREN ALL APPEAR AT THE ORIGIN. The handler
			// spawns them; only the Receive module copies the event's position
			// and velocity onto them, and an impact effect whose impacts are
			// all in the middle of the level is the classic symptom.
			UNiagaraScript* Receive = LoadObject<UNiagaraScript>(nullptr,
				bCollision ? VfxNiagara::ModReceiveCollisionEvent
					: VfxNiagara::ModReceiveDeathEvent);
			if (Receive != nullptr)
			{
				FNiagaraStackGraphUtilities::AddScriptModuleToStack(Receive, *Output);
			}
		}
		Source->NodeGraph->NotifyGraphChanged();

		// The stack was reshaped behind the context's back.
		RefreshContext(System);

		Report.Native(CurrentLabel, TEXT("sub-emitter"),
			FString::Printf(TEXT("%d particle(s) per %s event from %s%s"),
				EventProperties.SpawnNumber, bCollision ? TEXT("collision") : TEXT("death"),
				*SourceName->ToString(),
				Probability < 1.0
					? *FString::Printf(TEXT(", at %.0f%% of events"), Probability * 100.0)
					: TEXT("")));
		if (Probability < 1.0 && bCollision)
		{
			Report.Approximated(CurrentLabel, TEXT("sub-emitter"),
				TEXT("Generate Collision Event has no probability input, so every collision ")
				TEXT("spawns - the authored fraction was not carried"));
		}
	}
}

void FVfxNiagaraBuilder::BuildAfterSolve(FName EmitterName)
{
	for (const TSharedPtr<FJsonObject>& Block : AfterSolve)
	{
		const FString Type = FVfxIr::BlockType(Block);

		if (Type == TEXT("update.collidePlane"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModCollision, Type);
			if (Module.IsNone()) { continue; }

			// NOT Constrain Position To Plane, which is what this used to be.
			// That module stops a particle at the floor and holds it there: no
			// bounce, no friction, no sliding - so a spark shower arrived as a
			// carpet of stationary dots. The Collision module has an ANALYTICAL
			// PLANES mode that needs no scene geometry, and it carries
			// restitution and friction, which is the rest of the block.
			SetEnum(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ TEXT("CPU Collision Type") }, VfxNiagara::EnumCpuCollision,
				TEXT("Analytical Planes"), Type);

			const FVfxBound Height = Ir.Binding(Block, TEXT("height"));
			const FVfxBound Bounce = Ir.Binding(Block, TEXT("bounce"));
			const FVfxBound Friction = Ir.Binding(Block, TEXT("friction"));

			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ TEXT("Analytical Collision Normal 1") }, FVector3f(0.f, 0.f, 1.f), Type);
			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ TEXT("Analytical Collision Plane Position 1") },
				FVector3f(0.f, 0.f, FVfxConvert::Length(Height.Constant)), Type);
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ TEXT("Restitution") }, Bounce.bFound ? Bounce.Constant : 0.f, Type);
			SetBool(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ TEXT("Simple Friction") }, true, Type);
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ TEXT("Friction") }, Friction.bFound ? Friction.Constant : 0.f, Type);
			// The particle's own radius would make a sprite collide at its
			// visible edge, which is right for a rock and wrong for a spark;
			// the preview collides the point, so the scale is zero.
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ TEXT("Particle Radius Scale") }, 0.f, Type);
			Report.Native(CurrentLabel, Type,
				FString::Printf(TEXT("analytical plane at z=%.0f, bounce %.2f, friction %.2f"),
					FVfxConvert::Length(Height.Constant),
					Bounce.bFound ? Bounce.Constant : 0.f,
					Friction.bFound ? Friction.Constant : 0.f));
		}
		else if (Type == TEXT("update.killOnBounds"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModKillInVolume, Type);
			if (Module.IsNone()) { continue; }
			// THE SHAPE SWITCH FIRST, or Box Size is hidden and the write is
			// refused - the module defaults to a sphere, so a box authored here
			// arrived as a 100cm sphere and killed everything immediately.
			SetEnum(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Kill Shape") },
				VfxNiagara::EnumKillShape, TEXT("Box"), Type);
			const FVfxBound Size = Ir.Binding(Block, TEXT("size"));
			FVector3f Extent = FVfxConvert::Vector(Size.Vector);
			Extent = FVector3f(FMath::Abs(Extent.X), FMath::Abs(Extent.Y), FMath::Abs(Extent.Z));
			SetBool(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Invert Volume") },
				true, Type);
			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Box Size") },
				Extent, Type);
			Report.Native(CurrentLabel, Type, TEXT("kill outside the box"));
		}
	}
}

void FVfxNiagaraBuilder::ApplyShapeTransform(FName EmitterName, FName Shape,
	const TSharedPtr<FJsonObject>& Block, const FString& Type)
{
	// THE OFFSET, WHICH NOTHING USED TO CARRY. Every shape emitter in the IR
	// has one and Shape Location calls it Shape Origin, so an effect whose
	// systems are laid out in a row - which is every effect with more than one
	// thing happening in it - imported with all of them stacked on the origin.
	const FVfxBound Offset = Ir.Binding(Block, TEXT("offset"));
	if (Offset.bFound)
	{
		SetPosition(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Shape Origin") },
			FVfxConvert::Vector(Offset.Vector), Type);
	}

	const FVfxBound Rotation = Ir.Binding(Block, TEXT("rotation"));
	if (!Rotation.bFound) { return; }
	const FVector3f Euler = FVfxConvert::Euler(Rotation.Vector);
	if (Euler.IsNearlyZero()) { return; }

	SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Rotation Mode") },
		VfxNiagara::EnumRotationMode, TEXT("Yaw / Pitch / Roll"), Type);
	// Unreal orders this input Yaw, Pitch, Roll - rotation about Z, Y and X -
	// while FVfxConvert::Euler hands the angles back in X, Y, Z order like
	// every other vector. Reversed here rather than inside the converter,
	// which every other caller wants in axis order.
	SetVector(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Yaw / Pitch / Roll") },
		FVector3f(Euler.Z, Euler.Y, Euler.X), Type);
}

void FVfxNiagaraBuilder::AddConeVelocity(FName EmitterName, const FVector3f& Axis,
	float HalfAngleDegrees, const FVfxBound& Speed, const FString& Type)
{
	const FName Module = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
		VfxNiagara::ModAddVelocityInCone, Type);
	if (Module.IsNone()) { return; }
	bNeedsSolver = true;

	SetVector(EmitterName, VfxNiagara::ParticleSpawn, Module, { TEXT("Cone Axis") }, Axis, Type);
	// NIAGARA'S CONE ANGLE IS THE FULL OPENING, the app's is the half-angle
	// from the axis - the same convention difference the cone SHAPE has. A 30
	// degree jet authored here and imported literally is a 15 degree one.
	SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Module, { TEXT("Cone Angle") },
		FMath::Clamp(HalfAngleDegrees * 2.f, 0.f, 360.f), Type);
	SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Module,
		{ TEXT("Cone Axis Coordinate Space") }, VfxNiagara::EnumCoordinateSpace,
		TEXT("Local"), Type);

	if (Speed.bRandom)
	{
		if (SetDynamicInput(EmitterName, VfxNiagara::ParticleSpawn, Module,
			{ TEXT("Velocity Strength") }, VfxNiagara::DynUniformRangedFloat, Type))
		{
			SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Module,
				{ TEXT("Velocity Strength"), TEXT("Minimum") },
				FVfxConvert::Length(Speed.Low), Type);
			SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Module,
				{ TEXT("Velocity Strength"), TEXT("Maximum") },
				FVfxConvert::Length(Speed.High), Type);
		}
	}
	else
	{
		SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Module, { TEXT("Velocity Strength") },
			FVfxConvert::Length(Speed.Constant), Type);
	}
}

void FVfxNiagaraBuilder::BuildEmitterState(const TSharedPtr<FJsonObject>& SystemObject,
	FName EmitterName)
{
	// Self, not System: each IR system carries its own schedule, and letting the
	// Niagara system drive the life cycle would collapse five differently timed
	// emitters onto one clock.
	SetEnum(EmitterName, VfxNiagara::EmitterUpdate, VfxNiagara::EmitterStateModule,
		{ TEXT("Life Cycle Mode") }, VfxNiagara::EnumLifeCycle, TEXT("Self"),
		TEXT("life cycle"));

	const bool bLoops = Ir.Loops();
	SetEnum(EmitterName, VfxNiagara::EmitterUpdate, VfxNiagara::EmitterStateModule,
		{ TEXT("Loop Behavior") }, VfxNiagara::EnumLoopBehavior,
		bLoops ? TEXT("Infinite") : TEXT("Once"), TEXT("loop behavior"));

	// THE CLIP'S DURATION IS THE EMITTER'S, NOT THE EFFECT'S. This used to set
	// every emitter's Loop Duration to the whole effect length and carry only
	// the clip's start, which silently threw away the window: a channel meant
	// to emit for 0.3s emitted for the full 3.8s instead. On a spawn RATE that
	// is twelve times as many particles, and on a `spacing` path emitter - whose
	// walk is driven by Emitter.Age - it is a bolt that takes four seconds to
	// crawl to the ground instead of a third of one.
	const TSharedPtr<FJsonObject>* Schedule = nullptr;
	double ClipDuration = 0;
	if (SystemObject->TryGetObjectField(TEXT("schedule"), Schedule))
	{
		const TArray<TSharedPtr<FJsonValue>>* Clips = nullptr;
		if ((*Schedule)->TryGetArrayField(TEXT("clips"), Clips) && Clips->Num() > 0)
		{
			const TSharedPtr<FJsonObject> First = (*Clips)[0]->AsObject();
			if (First.IsValid()) { First->TryGetNumberField(TEXT("duration"), ClipDuration); }
		}
	}
	// A duration of zero means "opens here and never closes", which is the
	// effect's own length.
	EmitterLoopDuration = ClipDuration > 0.0
		? static_cast<float>(ClipDuration) : FMath::Max(0.01f, Ir.Duration());
	SetFloat(EmitterName, VfxNiagara::EmitterUpdate, VfxNiagara::EmitterStateModule,
		{ TEXT("Loop Duration") }, EmitterLoopDuration, TEXT("loop duration"));

	// A clip that starts later than zero becomes the emitter's loop delay. One
	// clip maps exactly; more than one does not, and the author is told so
	// rather than finding out when only the first burst appears.
	if (Schedule != nullptr)
	{
		const TArray<TSharedPtr<FJsonValue>>* Clips = nullptr;
		if ((*Schedule)->TryGetArrayField(TEXT("clips"), Clips) && Clips->Num() > 0)
		{
			const TSharedPtr<FJsonObject> First = (*Clips)[0]->AsObject();
			double At = 0;
			if (First.IsValid() && First->TryGetNumberField(TEXT("at"), At) && At > 0)
			{
				SetBool(EmitterName, VfxNiagara::EmitterUpdate, VfxNiagara::EmitterStateModule,
					{ TEXT("UseLoopDelay") }, true, TEXT("loop delay"));
				SetFloat(EmitterName, VfxNiagara::EmitterUpdate, VfxNiagara::EmitterStateModule,
					{ TEXT("Loop Delay") }, static_cast<float>(At), TEXT("loop delay"));
			}
			if (Clips->Num() > 1)
			{
				Report.Approximated(CurrentLabel, TEXT("timeline clips"),
					FString::Printf(TEXT("%d clips on this track became one; Niagara's Emitter ")
						TEXT("State has a single loop delay, so only the first start time ")
						TEXT("survived - split the track into separate systems to keep them all"),
						Clips->Num()));
			}
		}
	}
	Report.Native(CurrentLabel, TEXT("emitter state"),
		FString::Printf(TEXT("%s, %.2fs%s"), bLoops ? TEXT("looping") : TEXT("once"),
			EmitterLoopDuration,
			ClipDuration > 0.0 ? TEXT(" (the clip's window)") : TEXT("")));
}

void FVfxNiagaraBuilder::BuildSpawn(const TSharedPtr<FJsonObject>& SystemObject, FName EmitterName)
{
	const TArray<TSharedPtr<FJsonValue>>* Blocks = nullptr;
	if (!SystemObject->TryGetArrayField(TEXT("spawn"), Blocks)) { return; }

	for (const TSharedPtr<FJsonValue>& Entry : *Blocks)
	{
		const TSharedPtr<FJsonObject> Block = Entry->AsObject();
		const FString Type = FVfxIr::BlockType(Block);

		if (Type == TEXT("spawn.rate"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::EmitterUpdate,
				VfxNiagara::ModSpawnRate, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Rate = Ir.Binding(Block, TEXT("rate"));
			SetFloat(EmitterName, VfxNiagara::EmitterUpdate, Module,
				{ TEXT("SpawnRate") }, Rate.Constant, Type);
			Report.Native(CurrentLabel, Type, FString::Printf(TEXT("%.0f/s"), Rate.Constant));
		}
		else if (Type == TEXT("spawn.burst") && bIsSubEmitter)
		{
			// Held for the event handler - see SubEmitterBurst.
			const FVfxBound Count = Ir.Binding(Block, TEXT("count"));
			SubEmitterBurst.Add(SystemObject->GetStringField(TEXT("id")),
				FMath::Max(1, FMath::RoundToInt(Count.Constant)));
		}
		else if (Type == TEXT("spawn.burst") || Type == TEXT("spawn.periodicBurst"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::EmitterUpdate,
				VfxNiagara::ModSpawnBurst, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Count = Ir.Binding(Block, TEXT("count"));
			const FVfxBound At = Ir.Binding(Block, TEXT("time"));
			SetInt(EmitterName, VfxNiagara::EmitterUpdate, Module,
				{ TEXT("Spawn Count") }, FMath::RoundToInt(Count.Constant), Type);
			SetFloat(EmitterName, VfxNiagara::EmitterUpdate, Module,
				{ TEXT("Spawn Time") }, At.bFound ? At.Constant : 0.f, Type);

			if (Type == TEXT("spawn.periodicBurst"))
			{
				Report.Approximated(CurrentLabel, Type,
					TEXT("became a single instantaneous burst; Niagara repeats a burst by ")
					TEXT("repeating the module, so only the first one was imported"));
			}
			else
			{
				Report.Native(CurrentLabel, Type,
					FString::Printf(TEXT("%d at %.2fs"), FMath::RoundToInt(Count.Constant),
						At.bFound ? At.Constant : 0.f));
			}
		}
		else if (!Type.IsEmpty())
		{
			Report.Dropped(CurrentLabel, Type, TEXT("no Niagara spawn module matches this"));
		}
	}
}

void FVfxNiagaraBuilder::BuildInitialize(const TSharedPtr<FJsonObject>& SystemObject,
	FName EmitterName)
{
	const TArray<TSharedPtr<FJsonValue>>* Blocks = nullptr;
	if (!SystemObject->TryGetArrayField(TEXT("init"), Blocks)) { return; }

	const FName Init = VfxNiagara::InitializeParticleModule;

	for (const TSharedPtr<FJsonValue>& Entry : *Blocks)
	{
		const TSharedPtr<FJsonObject> Block = Entry->AsObject();
		const FString Type = FVfxIr::BlockType(Block);
		if (Type.IsEmpty()) { continue; }
		if (FVfxIr::HasOperators(Block))
		{
			Report.Approximated(CurrentLabel, Type,
				TEXT("a property here is driven by operators, which Niagara has no equivalent ")
				TEXT("for on a module input - flattened to the chain's average over the effect"));
		}

		if (Type == TEXT("initialize.setLifetime"))
		{
			const FVfxBound Life = Ir.Binding(Block, TEXT("lifetime"));
			if (Life.bRandom)
			{
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Lifetime Mode") },
					VfxNiagara::EnumLifetime, TEXT("Random"), Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init,
					{ TEXT("Lifetime Min") }, Life.Low, Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init,
					{ TEXT("Lifetime Max") }, Life.High, Type);
				Report.Native(CurrentLabel, Type,
					FString::Printf(TEXT("%.2f..%.2fs"), Life.Low, Life.High));
			}
			else
			{
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Lifetime Mode") },
					VfxNiagara::EnumLifetime, TEXT("Direct Set"), Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init,
					{ TEXT("Lifetime") }, Life.Constant, Type);
				Report.Native(CurrentLabel, Type, FString::Printf(TEXT("%.2fs"), Life.Constant));
			}
		}
		else if (Type == TEXT("initialize.setSize"))
		{
			const FVfxBound Size = Ir.Binding(Block, TEXT("size"));

			// A MESH IS NOT A SPRITE, and Sprite Size does nothing to one. The
			// mesh renderer reads Particles.Scale, so an emitter that draws a
			// mesh needs the size written there instead - otherwise every
			// instance draws at the mesh's own size, which for a rune authored
			// at 0.28 was a rune several metres tall.
			//
			// NO UNIT CONVERSION HERE, deliberately. Sprite size is a LENGTH and
			// goes metres -> centimetres; this is a MULTIPLIER on a mesh that
			// arrived in centimetres already, so scaling it by 100 would be the
			// same mistake in the other direction.
			if (OutputMode == TEXT("mesh"))
			{
				// HELD FOR THE OUTPUT STAGE. Mesh Scale is gated on the emitter
				// having a mesh renderer, and at this point it still has the
				// template's sprite one - so writing it here is refused as
				// "not part of the executing graph". See PendingMeshScale.
				PendingMeshScale = Size.bRandom ? (Size.Low + Size.High) * 0.5f : Size.Constant;
				continue;
			}

			if (Size.bRandom)
			{
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Sprite Size Mode") },
					VfxNiagara::EnumSizeScale, TEXT("Random Uniform"), Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init,
					{ TEXT("Uniform Sprite Size Min") }, FVfxConvert::Length(Size.Low), Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init,
					{ TEXT("Uniform Sprite Size Max") }, FVfxConvert::Length(Size.High), Type);
			}
			else
			{
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Sprite Size Mode") },
					VfxNiagara::EnumSizeScale, TEXT("Uniform"), Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init,
					{ TEXT("Uniform Sprite Size") }, FVfxConvert::Length(Size.Constant), Type);
			}
			Report.Native(CurrentLabel, Type, TEXT("sprite size, metres -> centimetres"));
		}
		else if (Type == TEXT("initialize.setColor"))
		{
			const FVfxBound Colour = Ir.Binding(Block, TEXT("color"));
			SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Color Mode") },
				VfxNiagara::EnumColorInit, TEXT("Direct Set"), Type);
			SetColour(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Color") },
				FVfxConvert::Colour(Colour.Vector, Colour.Width), Type);
			// HDR SURVIVES HERE, unlike on the Unity side where Gradient is LDR
			// and the intensity has to be folded away. FLinearColor is happy
			// above 1 and so is every Niagara material.
			Report.Native(CurrentLabel, Type, TEXT("linear colour, HDR preserved"));
		}
		else if (Type == TEXT("initialize.setMass"))
		{
			const FVfxBound Mass = Ir.Binding(Block, TEXT("mass"));
			SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Mass Mode") },
				TEXT("/Niagara/Enums/ENiagara_MassInitializationMode.ENiagara_MassInitializationMode"),
				TEXT("Direct Set"), Type);
			SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Mass") },
				Mass.Constant, Type);
			Report.Native(CurrentLabel, Type);
		}
		else if (Type == TEXT("initialize.setRotation"))
		{
			const FVfxBound Angle = Ir.Binding(Block, TEXT("rotation"));
			SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Sprite Rotation Mode") },
				TEXT("/Niagara/Enums/ENiagara_SpriteRotationMode.ENiagara_SpriteRotationMode"),
				Angle.bRandom ? TEXT("Random") : TEXT("Direct Angle (Degrees)"), Type);
			if (Angle.bRandom)
			{
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init,
					{ TEXT("Sprite Rotation Angle Min") }, Angle.Low, Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init,
					{ TEXT("Sprite Rotation Angle Max") }, Angle.High, Type);
			}
			else
			{
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Init,
					{ TEXT("Sprite Rotation Angle") }, Angle.Constant, Type);
			}
			Report.Native(CurrentLabel, Type);
		}
		else if (Type == TEXT("initialize.positionCurve") || Type == TEXT("initialize.positionLine"))
		{
			TArray<FVector3f> Path = Ir.Points(Block);
			if (Type == TEXT("initialize.positionLine"))
			{
				// A LINE IS A TWO-POINT PATH, so it goes down the same road
				// rather than becoming a thin box the way it must on the Unity
				// side. Same module, same fidelity, no apology needed.
				const FVfxBound Start = Ir.Binding(Block, TEXT("start"));
				const FVfxBound End = Ir.Binding(Block, TEXT("end"));
				Path = { FVfxConvert::Vector(Start.Vector), FVfxConvert::Vector(End.Vector) };
			}
			BuildPathLocation(EmitterName, Type, Path, Block,
				*FVfxIr::Mode(Block, TEXT("placement"), TEXT("random")));
		}
		else if (Type.StartsWith(TEXT("initialize.position")))
		{
			const FName Shape = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
				VfxNiagara::ModShapeLocation, Type);
			if (Shape.IsNone()) { continue; }

			// THE SWITCH FIRST. Every dimension below is hidden until the shape
			// is chosen, and SetStackInputData refuses a write to a hidden
			// input - so setting a radius before the shape writes nothing and
			// reports one line in a wall of them.
			if (Type == TEXT("initialize.positionSphere"))
			{
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Shape Primitive") },
					VfxNiagara::EnumShapes, TEXT("Sphere"), Type);
				const FVfxBound Radius = Ir.Binding(Block, TEXT("radius"));
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Sphere Radius") },
					FVfxConvert::Length(Radius.Constant), Type);
				const FString Fill = FVfxIr::Mode(Block, TEXT("fill"), TEXT("volume"));
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape,
					{ TEXT("Sphere Surface Distribution") }, Fill == TEXT("surface") ? 1.f : 0.f, Type);
				ApplyShapeTransform(EmitterName, Shape, Block, Type);
				Report.Native(CurrentLabel, Type, Fill == TEXT("surface")
					? TEXT("surface only") : TEXT("filled volume"));
			}
			else if (Type == TEXT("initialize.positionBox"))
			{
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Shape Primitive") },
					VfxNiagara::EnumShapes, TEXT("Box / Plane"), Type);
				const FVfxBound Size = Ir.Binding(Block, TEXT("size"));
				// A BOX EXTENT IS NOT A DIRECTION: the axis swap would negate
				// nothing here, but a size must never come out negative, so the
				// magnitude is taken after conversion.
				FVector3f Extent = FVfxConvert::Vector(Size.Vector);
				Extent = FVector3f(FMath::Abs(Extent.X), FMath::Abs(Extent.Y), FMath::Abs(Extent.Z));
				SetVector(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Box Size") },
					Extent, Type);
				ApplyShapeTransform(EmitterName, Shape, Block, Type);
				Report.Native(CurrentLabel, Type);
			}
			else if (Type == TEXT("initialize.positionCircle"))
			{
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Shape Primitive") },
					VfxNiagara::EnumShapes, TEXT("Ring / Disc"), Type);
				const FVfxBound Radius = Ir.Binding(Block, TEXT("radius"));
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Ring Radius") },
					FVfxConvert::Length(Radius.Constant), Type);
				// THICKNESS IS A BAND WIDTH IN METRES, not a fraction. The
				// kernel reads `inner = max(0, radius - thickness)`, and Disc
				// Coverage is the fraction of the radius the band covers - so
				// the conversion is a DIVISION that was missing. A ring 0.3m
				// wide on a 1m radius arrived claiming to cover 30% of the
				// radius by luck, and the same ring on a 3m radius arrived
				// covering 30% instead of 10%; anything thicker than a metre
				// was clamped to a filled disc.
				const FVfxBound Thickness = Ir.Binding(Block, TEXT("thickness"));
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Disc Coverage") },
					FMath::Clamp(Thickness.Constant / FMath::Max(0.0001f, Radius.Constant),
						0.f, 1.f), Type);
				ApplyShapeTransform(EmitterName, Shape, Block, Type);
				Report.Native(CurrentLabel, Type,
					FString::Printf(TEXT("ring %.2f-%.2fm"),
						FMath::Max(0.f, Radius.Constant - Thickness.Constant), Radius.Constant));
			}
			else if (Type == TEXT("initialize.positionCone"))
			{
				// A DISC PLUS A CONE OF VELOCITY, not a cone-shaped volume.
				// The kernel (shape.cone in kernels.js) puts the particle on
				// the cone's MOUTH - a disc of `radius` at the shape's origin -
				// and spends the angle on the VELOCITY. Niagara's Cone
				// primitive scatters the position through the cone's body over
				// Cone Length, which is a different emitter: it starts wide and
				// has no mouth. Splitting it into Ring / Disc + Add Velocity In
				// Cone reproduces the kernel exactly, and it is also what the
				// author sees in the preview.
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Shape Primitive") },
					VfxNiagara::EnumShapes, TEXT("Ring / Disc"), Type);
				const FVfxBound Angle = Ir.Binding(Block, TEXT("angle"));
				const FVfxBound Radius = Ir.Binding(Block, TEXT("radius"));
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Ring Radius") },
					FVfxConvert::Length(FMath::Max(0.0001f, Radius.Constant)), Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Disc Coverage") },
					1.f, Type);
				ApplyShapeTransform(EmitterName, Shape, Block, Type);

				const FVfxBound Speed = Ir.Binding(Block, TEXT("speed"));
				if (Speed.bFound && (Speed.Constant != 0.f || Speed.bRandom))
				{
					AddConeVelocity(EmitterName, FVector3f(0.f, 0.f, 1.f), Angle.Constant,
						Speed, Type);
				}
				Report.Native(CurrentLabel, Type,
					FString::Printf(TEXT("mouth disc of %.2fm, velocity in a %.0f degree cone"),
						Radius.Constant, Angle.Constant));
			}
			else if (Type == TEXT("initialize.positionMesh"))
			{
				// The ShapeLocation module already added above is the wrong one
				// for this: sampling a mesh is its own module with its own data
				// interface. Disabling is not possible through this API, so the
				// shape is left on its default sphere of radius 0 - harmless,
				// because Static Mesh Location writes the position after it.
				const int32 Index = FVfxIr::AssetSlot(Block, TEXT("mesh"));
				UStaticMesh* const* Found = Assets.Meshes.Find(Index);
				if (Found == nullptr || *Found == nullptr)
				{
					Report.Dropped(CurrentLabel, Type,
						TEXT("this emitter spawns over a mesh and the bundle carried none"));
					continue;
				}

				const FName Sampler = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
					VfxNiagara::ModStaticMeshLocation, Type);
				if (Sampler.IsNone()) { continue; }

				// A data interface is set from a property BLOB, not from a
				// pointer: the only way through SetStackInputData is the JSON
				// the provider serialises, and the mesh is a soft path inside it.
				const FString MeshJson = FString::Printf(
					TEXT("{\"defaultMesh\":\"%s\",\"sourceMode\":\"DefaultMeshOnly\"}"),
					*(*Found)->GetPathName());
				SetDataInterface(EmitterName, VfxNiagara::ParticleSpawn, Sampler,
					{ TEXT("Static Mesh") }, MeshJson, Type);

				const FString Sampling = FVfxIr::Mode(Block, TEXT("sampling"), TEXT("surface"));
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Sampler,
					{ TEXT("Mesh Sampling Type") },
					TEXT("/Niagara/Enums/StaticMesh/ENiagara_StaticSamplingMode.")
					TEXT("ENiagara_StaticSamplingMode"),
					Sampling == TEXT("vertex") ? TEXT("Vertices") : TEXT("Triangles"), Type);

				// NORMAL SPEED IS WHAT MAKES IT READ AS A SURFACE rather than
				// as a cloud in the shape of one, so it is carried rather than
				// dropped: the module can push the spawn point out along the
				// sampled normal, which is the same thing at birth.
				const FVfxBound NormalSpeed = Ir.Binding(Block, TEXT("normalSpeed"));
				if (NormalSpeed.bFound && NormalSpeed.Constant != 0.f)
				{
					// The module samples a normal but cannot turn it into a
					// velocity; what it can do is push the spawn point off the
					// surface along it, which reads the same at birth.
					SetBool(EmitterName, VfxNiagara::ParticleSpawn, Sampler,
						{ TEXT("OffsetAlongNormal") }, true, Type);
					SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Sampler,
						{ TEXT("Offset Position Along Sampled Normal") },
						FVfxConvert::Length(NormalSpeed.Constant * 0.05f), Type);
					Report.Approximated(CurrentLabel, Type,
						FString::Printf(TEXT("normal speed %.2f m/s became a %.1fcm offset along ")
							TEXT("the sampled normal: the module can push the spawn point off ")
							TEXT("the surface but cannot give it a velocity there"),
							NormalSpeed.Constant,
							FVfxConvert::Length(NormalSpeed.Constant * 0.05f)));
				}
				Report.Native(CurrentLabel, Type,
					FString::Printf(TEXT("%s of %s"),
						Sampling == TEXT("vertex") ? TEXT("vertices") : TEXT("surface"),
						*(*Found)->GetName()));
			}
			else if (Type == TEXT("initialize.positionPoint"))
			{
				// A POINT IS A SPHERE OF RADIUS `jitter`, which is exactly what
				// the kernel does, and it is the most common shape in any
				// effect - every sub-emitter and every "it happens here" system
				// uses it. Dropping it meant those emitters had no position
				// module at all and spawned wherever the template's default put
				// them.
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Shape Primitive") },
					VfxNiagara::EnumShapes, TEXT("Sphere"), Type);
				const FVfxBound Jitter = Ir.Binding(Block, TEXT("jitter"));
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Sphere Radius") },
					FVfxConvert::Length(FMath::Max(0.f, Jitter.Constant)), Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape,
					{ TEXT("Sphere Surface Distribution") }, 0.f, Type);
				ApplyShapeTransform(EmitterName, Shape, Block, Type);
				Report.Native(CurrentLabel, Type, Jitter.Constant > 0.f
					? *FString::Printf(TEXT("point, scattered by %.2fm"), Jitter.Constant)
					: TEXT("point"));
			}
			else
			{
				Report.Dropped(CurrentLabel, Type, TEXT("no Niagara shape matches this"));
			}
		}
		else if (Type == TEXT("initialize.velocityDirection"))
		{
			// PROPERTIES ARE direction, speed AND spread - not one "velocity"
			// vector, which is a property this block has never had. Binding()
			// returns bFound=false for a name that is not there and a caller
			// that ignores it gets a zero: every directional jet in every
			// imported effect launched at 0 cm/s, and the report called it
			// native.
			const FVfxBound Direction = Ir.Binding(Block, TEXT("direction"));
			const FVfxBound Speed = Ir.Binding(Block, TEXT("speed"));
			const FVfxBound Spread = Ir.Binding(Block, TEXT("spread"));
			FVector3f Axis = FVfxConvert::Direction(Direction.Vector);
			if (Axis.IsNearlyZero()) { Axis = FVector3f(0.f, 0.f, -1.f); }
			Axis.Normalize();

			// A cone of zero degrees IS a direction, so one module covers both
			// and the spread survives instead of being apologised for.
			AddConeVelocity(EmitterName, Axis, Spread.bFound ? Spread.Constant : 0.f,
				Speed, Type);
			Report.Native(CurrentLabel, Type,
				FString::Printf(TEXT("%.1f m/s in a %.0f degree cone"),
					Speed.bRandom ? Speed.High : Speed.Constant,
					Spread.bFound ? Spread.Constant : 0.f));
		}
		else if (Type == TEXT("initialize.velocityRandom"))
		{
			// PROPERTIES ARE min AND max, two vectors - again not "velocity".
			// Read under the wrong name this imported as zero; read under the
			// right one it is a uniform ranged vector, which Niagara has as a
			// dynamic input, so the per-axis spread survives rather than
			// collapsing to the top of the range.
			const FName Velocity = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
				VfxNiagara::ModAddVelocity, Type);
			if (Velocity.IsNone()) { continue; }
			bNeedsSolver = true;

			const FVfxBound Min = Ir.Binding(Block, TEXT("min"));
			const FVfxBound Max = Ir.Binding(Block, TEXT("max"));
			if (SetDynamicInput(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
				{ TEXT("Velocity") }, VfxNiagara::DynUniformRangedVector, Type))
			{
				SetVector(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
					{ TEXT("Velocity"), TEXT("Minimum") }, FVfxConvert::Vector(Min.Vector), Type);
				SetVector(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
					{ TEXT("Velocity"), TEXT("Maximum") }, FVfxConvert::Vector(Max.Vector), Type);
				Report.Native(CurrentLabel, Type, TEXT("uniform ranged vector, per axis"));
			}
			else
			{
				SetVector(EmitterName, VfxNiagara::ParticleSpawn, Velocity, { TEXT("Velocity") },
					FVfxConvert::Vector(Max.Vector), Type);
				Report.Approximated(CurrentLabel, Type,
					TEXT("became a constant velocity at the top of the authored range; this ")
					TEXT("engine has no Uniform Ranged Vector dynamic input"));
			}
		}
		else if (Type == TEXT("initialize.velocityRadial"))
		{
			// THE BLOCK IS CALLED velocityRadial. The handler here was written
			// for "initialize.velocityOutward", a name the catalog has never
			// used, so it never ran once - the block fell through to the
			// bottom and was reported as having no Niagara module, while the
			// module it wanted has shipped with Niagara all along.
			const FName Velocity = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
				VfxNiagara::ModAddVelocityFromPoint, Type);
			if (Velocity.IsNone()) { continue; }
			bNeedsSolver = true;
			const FVfxBound Speed = Ir.Binding(Block, TEXT("speed"));
			SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
				{ TEXT("Velocity Strength") }, FVfxConvert::Length(Speed.Constant), Type);
			SetVector(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
				{ TEXT("Velocity Origin") }, FVector3f::ZeroVector, Type);
			Report.Native(CurrentLabel, Type,
				FString::Printf(TEXT("%.1f m/s away from the emitter origin"), Speed.Constant));
		}
		else if (Type == TEXT("initialize.inheritVelocity"))
		{
			// Only meaningful on a system that is NOT a sub-emitter; on one
			// that is, the velocity comes from the event payload and is handled
			// where the event handler is built.
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
				VfxNiagara::ModInheritVelocity, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Scale = Ir.Binding(Block, TEXT("scale"));
			SetVector(EmitterName, VfxNiagara::ParticleSpawn, Module,
				{ TEXT("Inherited Velocity Amount Scale") },
				FVector3f(Scale.Constant, Scale.Constant, Scale.Constant), Type);
			Report.Native(CurrentLabel, Type,
				FString::Printf(TEXT("%.0f%% of the emitter's velocity"), Scale.Constant * 100.f));
		}
		else if (Type == TEXT("initialize.setFlipbookFrame"))
		{
			// Applied with the renderer - see BuildFlipbook. Skipped rather
			// than dropped, or the report claims a start frame was lost that
			// is in fact carried two stages later.
			continue;
		}
		else
		{
			Report.Dropped(CurrentLabel, Type, TEXT("no Niagara module matches this block"));
		}
	}
}

void FVfxNiagaraBuilder::BuildPathLocation(FName EmitterName, const FString& Label,
	const TArray<FVector3f>& Path, const TSharedPtr<FJsonObject>& Block,
	const TCHAR* PlacementMode)
{
	if (Path.Num() < 2)
	{
		Report.Dropped(CurrentLabel, Label, TEXT("the path has fewer than two points"));
		return;
	}

	// THE PATH BECOMES A VECTOR CURVE, and this is the one place where Unreal
	// carries more of the effect across than Unity does. Shuriken has no bending
	// emitter at all - the curve degrades there to the straight chord between
	// its end points - whereas Niagara can hold the authored path as an
	// FRichCurve per axis and sample it per particle. The bend survives, and so
	// does the author's ability to edit it on this side.
	const FName Init = VfxNiagara::InitializeParticleModule;

	SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Position Mode") },
		VfxNiagara::EnumPositionInit, TEXT("Direct Set"), Label);

	if (!SetDynamicInput(EmitterName, VfxNiagara::ParticleSpawn, Init, { TEXT("Position") },
		VfxNiagara::DynVectorFromCurve, Label))
	{
		return;
	}

	// A MARCHING CHAIN IS INDEXED BY TIME, NOT BY SPAWN INDEX. In `spacing`
	// mode the preview advances the emission point along the path by a fixed
	// distance per particle, so the point WALKS; the normalized execution index
	// only spreads the particles spawned in one frame, and at one particle per
	// frame that index is 0 every time - which is why the Ice Wall's slabs all
	// appeared at the start of the line, on top of each other. Keying the curve
	// in SECONDS and linking the index to Emitter.Age reproduces the walk.
	const bool bWalk = FString(PlacementMode) == TEXT("spacing");
	const float KeyScale = bWalk ? FMath::Max(0.01f, EmitterLoopDuration) : 1.f;

	SetDataInterface(EmitterName, VfxNiagara::ParticleSpawn, Init,
		{ TEXT("Position"), TEXT("VectorCurve") }, PathCurveJson(Path, KeyScale), Label);

	// WHERE ALONG THE PATH each particle lands. The curve is keyed by cumulative
	// chord length rather than by point index, so a uniform sweep of the curve's
	// parameter is a uniform sweep of its LENGTH - which is what makes "even"
	// mean evenly spaced rather than evenly indexed, and is the same thing the
	// preview's arc-length table buys.
	const FString Placement(PlacementMode);
	SetPathIndexChain(EmitterName, VfxNiagara::ParticleSpawn, Init,
		{ TEXT("Position"), TEXT("CurveIndex") }, PlacementMode, Label);

	if (Placement == TEXT("spacing"))
	{
		Report.Approximated(CurrentLabel, Label,
			FString::Printf(TEXT("the path survived as a %d-key vector curve and the emission ")
				TEXT("point walks it once per loop, driven by Emitter.Age - the preview ")
				TEXT("instead advances a fixed distance per particle, so the spacing follows ")
				TEXT("the spawn rate there and the clock here"), Path.Num()));
	}
	else
	{
		Report.Native(CurrentLabel, Label,
			FString::Printf(TEXT("%d-point path as a vector curve, %s along it"),
				Path.Num(), Placement == TEXT("even") ? TEXT("evenly spread") : TEXT("scattered")));
	}

	const FVfxBound Thickness = Ir.Binding(Block, TEXT("thickness"));
	if (Thickness.bFound && Thickness.Constant > 0.f)
	{
		// A JITTER MODULE, rather than a note telling the author to add one.
		// The kernel scatters the spawn point inside a ball of this radius
		// around the path, and Jitter Position with a delay of zero does
		// exactly that once, at birth - the two are the same thing.
		const FName Jitter = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
			VfxNiagara::ModJitterPosition, Label);
		if (!Jitter.IsNone())
		{
			SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Jitter, { TEXT("Jitter Amount") },
				FVfxConvert::Length(Thickness.Constant), Label);
			SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Jitter, { TEXT("Jitter Delay") },
				0.f, Label);
			Report.Native(CurrentLabel, Label,
				FString::Printf(TEXT("scattered %.2fm around the path"), Thickness.Constant));
		}
	}

	// TANGENT SPEED: particles leave ALONG the path, which is what makes it read
	// as flow rather than as a curved sprinkling - so it is the half of this
	// emitter that matters most, and it is carried rather than reported away.
	// A second vector curve holds the path's unit tangents, sampled at THE SAME
	// index as the position; see SetPathIndexChain for why that has to be the
	// same value and not merely the same kind of value.
	const FVfxBound Tangent = Ir.Binding(Block, TEXT("tangentSpeed"));
	if (Tangent.bFound && Tangent.Constant != 0.f)
	{
		const FName Velocity = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
			VfxNiagara::ModAddVelocity, Label);
		if (!Velocity.IsNone())
		{
			bNeedsSolver = true;
			if (SetDynamicInput(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
				{ TEXT("Velocity") }, VfxNiagara::DynVectorFromCurve, Label))
			{
				SetDataInterface(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
					{ TEXT("Velocity"), TEXT("VectorCurve") },
					PathTangentCurveJson(Path, KeyScale), Label);
				SetPathIndexChain(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
					{ TEXT("Velocity"), TEXT("CurveIndex") }, PlacementMode, Label);
				// The tangent curve is normalised, so the speed is the scale.
				const float Speed = FVfxConvert::Length(Tangent.Constant);
				SetVector(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
					{ TEXT("Velocity"), TEXT("Scale Curve") },
					FVector3f(Speed, Speed, Speed), Label);
				Report.Native(CurrentLabel, Label,
					FString::Printf(TEXT("tangent speed %.2f m/s as velocity along the path"),
						Tangent.Constant));
			}
		}
	}
}

void FVfxNiagaraBuilder::SetPathIndexChain(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const TCHAR* PlacementMode, const FString& Label)
{
	const FString Placement(PlacementMode);
	if (Placement == TEXT("spacing"))
	{
		// Emitter.Age, in seconds, against a curve keyed in seconds. Niagara
		// ships no "normalized loop age" dynamic input and the arithmetic to
		// build one out of Multiply and Modulo nodes would be three more
		// dynamic inputs deep; keying the curve to match the parameter is the
		// same answer with none of that.
		SetLinked(EmitterName, ScriptName, ModuleName, InputStack, TEXT("Emitter.Age"),
			FNiagaraTypeDefinition::GetFloatDef(), Label);
		return;
	}
	if (Placement == TEXT("even"))
	{
		SetDynamicInput(EmitterName, ScriptName, ModuleName, InputStack,
			VfxNiagara::DynNormalizedExecIndex, Label);
		return;
	}

	// RANDOM, BUT REPRODUCIBLE. A plain random draw here would give the position
	// and the tangent two different points on the same curve. Seeding a fixed
	// hash with the particle's own id gives a value that is different for every
	// particle and identical everywhere it is read.
	if (!SetDynamicInput(EmitterName, ScriptName, ModuleName, InputStack,
		VfxNiagara::DynFixedSeedRandomFloat, Label))
	{
		return;
	}
	// Reading Particles.ID needs the emitter to carry persistent ids, which
	// is off by default - see BuildEmitter.
	bUsesParticleId = true;
	TArray<FName> SeedStack = InputStack;
	SeedStack.Add(TEXT("Seed"));
	SetDynamicInput(EmitterName, ScriptName, ModuleName, SeedStack,
		VfxNiagara::DynParticleIdAsFloat, Label);
}

void FVfxNiagaraBuilder::BuildUpdate(const TSharedPtr<FJsonObject>& SystemObject, FName EmitterName)
{
	const TArray<TSharedPtr<FJsonValue>>* Blocks = nullptr;
	if (!SystemObject->TryGetArrayField(TEXT("update"), Blocks)) { return; }

	for (const TSharedPtr<FJsonValue>& Entry : *Blocks)
	{
		const TSharedPtr<FJsonObject> Block = Entry->AsObject();
		const FString Type = FVfxIr::BlockType(Block);
		if (Type.IsEmpty()) { continue; }
		if (FVfxIr::HasOperators(Block))
		{
			Report.Approximated(CurrentLabel, Type,
				TEXT("a property here is driven by operators, which Niagara has no equivalent ")
				TEXT("for on a module input - flattened to the chain's average over the effect"));
		}

		if (Type == TEXT("update.gravity"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModGravity, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Gravity = Ir.Binding(Block, TEXT("gravity"));
			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Gravity") },
				FVfxConvert::Vector(Gravity.Vector), Type);
			bNeedsSolver = true;
			Report.Native(CurrentLabel, Type,
				FString::Printf(TEXT("%.2f m/s2 -> %.0f cm/s2 on Z"),
					Gravity.Vector[1], FVfxConvert::Length(Gravity.Vector[1])));
		}
		else if (Type == TEXT("update.drag"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModDrag, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Drag = Ir.Binding(Block, TEXT("drag"));
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Drag") },
				Drag.Constant, Type);
			bNeedsSolver = true;
			Report.Native(CurrentLabel, Type);
		}
		else if (Type == TEXT("update.turbulence"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModCurlNoise, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Strength = Ir.Binding(Block, TEXT("strength"));
			const FVfxBound Frequency = Ir.Binding(Block, TEXT("frequency"));
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Noise Strength") },
				FVfxConvert::Length(Strength.Constant), Type);
			// FREQUENCY IS A RECIPROCAL LENGTH, so it converts the OTHER WAY.
			// The block's frequency is cycles per METRE; Niagara samples the
			// noise field at the particle's position, which is in CENTIMETRES.
			// Passing the number through unchanged made every metre of the
			// effect span a hundred cycles of noise - neighbouring particles
			// sampled uncorrelated directions, so a turbulence authored as
			// broad swirls arrived as static.
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Noise Frequency") },
				Frequency.Constant * 0.01f, Type);
			bNeedsSolver = true;
			// BOTH ARE CURL NOISE, which is the rare case where the preview and
			// the engine agree on the character of the motion rather than only
			// its strength - unlike Unity, whose noise module is value noise.
			Report.Native(CurrentLabel, Type, TEXT("curl noise, same divergence-free field"));
		}
		// NAMED update.attractor IN THE CATALOG. This was written against
		// "update.pointAttractor", which nothing has ever emitted, so the
		// handler below had never run once and every attractor in every effect
		// was reported as having no Niagara equivalent - next to the module
		// that is its exact equivalent.
		else if (Type == TEXT("update.attractor"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModPointAttraction, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Position = Ir.Binding(Block, TEXT("position"));
			const FVfxBound Strength = Ir.Binding(Block, TEXT("strength"));
			const FVfxBound Radius = Ir.Binding(Block, TEXT("radius"));
			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("AttractorPosition") },
				FVfxConvert::Vector(Position.Vector), Type);
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("AttractionStrength") },
				FVfxConvert::Length(Strength.Constant), Type);
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Attraction Radius") },
				FVfxConvert::Length(FMath::Max(0.01f, Radius.Constant)), Type);
			bNeedsSolver = true;
			Report.Native(CurrentLabel, Type);
		}
		else if (Type == TEXT("update.vortex"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModVortex, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Axis = Ir.Binding(Block, TEXT("axis"));
			const FVfxBound Strength = Ir.Binding(Block, TEXT("strength"));
			const FVfxBound Position = Ir.Binding(Block, TEXT("position"));
			const FVfxBound Inward = Ir.Binding(Block, TEXT("inward"));

			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Vortex Axis") },
				FVfxConvert::Direction(Axis.Vector), Type);
			SetEnum(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ TEXT("Vortex Axis Coordinate Space") }, VfxNiagara::EnumCoordinateSpace,
				TEXT("Local"), Type);
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Vortex Force Amount") },
				FVfxConvert::Length(Strength.Constant), Type);

			// THE AXIS IS NOT THE WHOLE VORTEX. Two inputs were missing and
			// both of them matter:
			//
			//   Vortex Origin - the line the particles turn around. Left at its
			//     default the column orbits a point that is not where the block
			//     put it, and a funnel emitted from a ring at the base LEANS as
			//     it rises, which is exactly what the Sand Tornado did.
			//   Origin Pull Amount - the block's `inward`. Without it nothing
			//     pulls the particles in, so the funnel never necks: it is a
			//     cylinder of rotation rather than a tornado.
			SetPosition(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Vortex Origin") },
				FVfxConvert::Vector(Position.Vector), Type);
			if (Inward.bFound && Inward.Constant != 0.f)
			{
				SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
					{ TEXT("Origin Pull Amount") }, FVfxConvert::Length(Inward.Constant), Type);
			}
			bNeedsSolver = true;
			Report.Native(CurrentLabel, Type,
				FString::Printf(TEXT("%.1f m/s2 around the axis, %.1f m/s2 inward"),
					Strength.Constant, Inward.bFound ? Inward.Constant : 0.f));
		}
		else if (Type == TEXT("update.wind"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModWind, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Wind = Ir.Binding(Block, TEXT("wind"));
			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Wind Speed") },
				FVfxConvert::Vector(Wind.Vector), Type);
			bNeedsSolver = true;
			Report.Native(CurrentLabel, Type);
		}
		else if (Type == TEXT("update.colorOverLife"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModScaleColor, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Colour = Ir.Binding(Block, TEXT("color"));
			if (!Colour.IsGradient())
			{
				Report.Dropped(CurrentLabel, Type, TEXT("the colour was not an authored gradient"));
				continue;
			}
			SetEnum(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Scale Mode") },
				VfxNiagara::EnumScaleColor, TEXT("RGBA Linear Color Curve"), Type);
			SetDataInterface(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ TEXT("Linear Color Curve") }, ColourCurveJson(Colour.Gradient), Type);
			// EVERY KEY SURVIVES, and the HDR intensity with it. Unity's Gradient
			// caps at eight keys per rail and cannot hold a value above 1, so the
			// same ramp arrives there with keys dropped and the glow flattened.
			Report.Native(CurrentLabel, Type,
				TEXT("gradient as an RGBA colour curve, all keys, HDR preserved"));
		}
		else if (Type == TEXT("update.sizeOverLife"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModScaleSpriteSize, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Scale = Ir.Binding(Block, TEXT("scale"));
			// THE MODULE ALREADY HAS A CURVE SLOT, and using it beats wiring a
			// Float From Curve dynamic input into a scalar: the curve lands
			// where an author expects to find it, and "Uniform Scale Factor" is
			// hidden behind the mode switch anyway.
			if (Scale.IsCurve())
			{
				SetDataInterface(EmitterName, VfxNiagara::ParticleUpdate, Module,
					{ TEXT("Uniform Curve Sprite Scale") },
					FloatCurveJson(Scale.Curve, Scale.Scale), Type);
				Report.Native(CurrentLabel, Type, TEXT("curve over life, keys and tangents"));
			}
			else
			{
				SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
					{ TEXT("Uniform Curve Scale") }, Scale.Constant, Type);
				Report.Native(CurrentLabel, Type);
			}
		}
		// SAME STORY AS THE ATTRACTOR: the block is update.killOnBounds and
		// this read update.killBox. Held back rather than added here - it tests
		// the position the solver is about to write.
		else if (Type == TEXT("update.killOnBounds") || Type == TEXT("update.collidePlane"))
		{
			AfterSolve.Add(Block);
		}
		else if (Type == TEXT("update.collideSphere") || Type == TEXT("update.collideBox"))
		{
			// Niagara's analytical collision does planes and nothing else; the
			// ray-traced mode needs real scene geometry. An implicit sphere or
			// box has no equivalent either way.
			const FVfxBound Radius = Ir.Binding(Block, TEXT("radius"));
			Report.Dropped(CurrentLabel, Type,
				FString::Printf(TEXT("Niagara collides against analytical PLANES or against ")
					TEXT("real scene geometry, never against an implicit shape. Put a %s ")
					TEXT("collider in the level and switch this emitter's Collision module to ")
					TEXT("Ray Traced, or keep the shape as a kill volume"),
					Type == TEXT("update.collideSphere")
						? *FString::Printf(TEXT("%.1fm sphere"), Radius.Constant)
						: TEXT("box")));
		}
		else if (Type == TEXT("update.speedLimit"))
		{
			// Recorded, and applied to the solver once it exists - see
			// BuildEmitter. It used to be a note asking the author to go and
			// tick two boxes by hand.
			const FVfxBound Limit = Ir.Binding(Block, TEXT("speed"));
			const float Cap = FVfxConvert::Length(Limit.Constant);
			if (Cap <= 0.f)
			{
				// CLAMPING AT ZERO FREEZES THE EMITTER. A cap of 0 is never an
				// authored intent - it is what a property the importer could
				// not resolve looks like - so it is refused and reported rather
				// than written.
				Report.Dropped(CurrentLabel, Type,
					TEXT("the speed cap resolved to 0, which would stop every particle dead, ")
					TEXT("so no clamp was applied"));
			}
			else
			{
				SolverSpeedLimit = Cap;
			}
			bNeedsSolver = true;
		}
		else if (Type == TEXT("update.spin"))
		{
			// Sprites spin in their billboard plane and meshes spin in three
			// axes, and Niagara splits that into two modules writing two
			// different attributes. Picking the wrong one is silent: the
			// attribute is written and the renderer never reads it.
			const bool bMesh = OutputMode == TEXT("mesh");
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				bMesh ? VfxNiagara::ModMeshRotationRate : VfxNiagara::ModSpriteRotationRate, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Speed = Ir.Binding(Block, TEXT("speed"));
			const float Degrees = Speed.bRandom
				? (FMath::Abs(Speed.Low) > FMath::Abs(Speed.High) ? Speed.Low : Speed.High)
				: Speed.Constant;

			// A SYMMETRIC RANGE IS THE WHOLE POINT OF A SPIN. Debris authored at
			// -320..320 deg/s and imported as a flat 320 has every fragment
			// turning the same way at the same rate, which reads as a conveyor
			// belt rather than as tumbling. The range survives as a Uniform
			// Ranged Float wired into the rate.
			const TCHAR* RateInput = bMesh ? TEXT("Roll") : TEXT("Rotation Rate");
			bool bRangeCarried = false;
			if (Speed.bRandom && SetDynamicInput(EmitterName, VfxNiagara::ParticleUpdate, Module,
				{ RateInput }, VfxNiagara::DynUniformRangedFloat, Type))
			{
				SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
					{ RateInput, TEXT("Minimum") }, FMath::Min(Speed.Low, Speed.High), Type);
				SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
					{ RateInput, TEXT("Maximum") }, FMath::Max(Speed.Low, Speed.High), Type);
				if (bMesh)
				{
					SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
						{ TEXT("Rotation Rate") }, 1.f, Type);
				}
				bRangeCarried = true;
				Report.Native(CurrentLabel, Type,
					FString::Printf(TEXT("%.0f..%.0f deg/s per particle, %s"),
						Speed.Low, Speed.High, bMesh ? TEXT("mesh") : TEXT("sprite")));
			}
			if (bRangeCarried) { continue; }

			if (bMesh)
			{
				// Roll is the spin about the sprite's own facing axis, which is
				// what the block means on a mesh too.
				SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Roll") },
					Degrees, Type);
				SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
					{ TEXT("Rotation Rate") }, 1.f, Type);
			}
			else
			{
				SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module,
					{ TEXT("Rotation Rate") }, Degrees, Type);
			}
			if (Speed.bRandom)
			{
				Report.Approximated(CurrentLabel, Type,
					FString::Printf(TEXT("the authored %.0f..%.0f deg/s became a single %.0f: ")
						TEXT("the rate module takes one number, and a per-particle range needs ")
						TEXT("a Uniform Ranged Float wired into it by hand"),
						Speed.Low, Speed.High, Degrees));
			}
			else
			{
				Report.Native(CurrentLabel, Type,
					FString::Printf(TEXT("%.0f deg/s, %s"), Degrees,
						bMesh ? TEXT("mesh") : TEXT("sprite")));
			}
		}
		else if (Type == TEXT("update.flipbook") || Type == TEXT("initialize.setFlipbookFrame"))
		{
			// Handled with the renderer, where the sheet layout lives: the
			// frame count and the play rate are here, the columns and rows are
			// on the Output, and Niagara wants all of it in one module that
			// also needs a reference to the renderer itself.
			continue;
		}
		else
		{
			Report.Dropped(CurrentLabel, Type, TEXT("no Niagara module matches this block"));
		}
	}
}

void FVfxNiagaraBuilder::BuildOutput(const TSharedPtr<FJsonObject>& SystemObject,
	FName EmitterName)
{
	const TArray<TSharedPtr<FJsonValue>>* Outputs = nullptr;
	if (!SystemObject->TryGetArrayField(TEXT("outputs"), Outputs) || Outputs->Num() == 0)
	{
		return;
	}
	const TSharedPtr<FJsonObject> Output = (*Outputs)[0]->AsObject();
	if (!Output.IsValid()) { return; }

	const FString Mode = Output->GetStringField(TEXT("mode"));
	const FString Blend = Output->GetStringField(TEXT("blend"));
	const FString Sort = Output->GetStringField(TEXT("sort"));

	// The sheet layout lives on the OUTPUT, not on the flipbook block: the
	// block says how many frames to play and how fast, the output says how the
	// sheet is cut up. Both halves are needed before either can be applied.
	int32 Columns = 1;
	int32 Rows = 1;
	const TArray<TSharedPtr<FJsonValue>>* Tiles = nullptr;
	if (Output->TryGetArrayField(TEXT("tiles"), Tiles) && Tiles->Num() >= 2)
	{
		Columns = FMath::Max(1, static_cast<int32>((*Tiles)[0]->AsNumber()));
		Rows = FMath::Max(1, static_cast<int32>((*Tiles)[1]->AsNumber()));
	}

	UTexture2D* Texture = nullptr;
	UStaticMesh* Mesh = nullptr;
	const TArray<TSharedPtr<FJsonValue>>* OutputBlocks = nullptr;
	if (Output->TryGetArrayField(TEXT("blocks"), OutputBlocks))
	{
		for (const TSharedPtr<FJsonValue>& Entry : *OutputBlocks)
		{
			const TSharedPtr<FJsonObject> Block = Entry->AsObject();
			if (!Block.IsValid()) { continue; }
			const TSharedPtr<FJsonObject>* Slots = nullptr;
			if (!Block->TryGetObjectField(TEXT("assetSlots"), Slots)) { continue; }
			int32 Index = -1;
			if ((*Slots)->TryGetNumberField(TEXT("texture"), Index))
			{
				if (UTexture2D* const* Found = Assets.Textures.Find(Index)) { Texture = *Found; }
			}
			if ((*Slots)->TryGetNumberField(TEXT("mesh"), Index))
			{
				if (UStaticMesh* const* Found = Assets.Meshes.Find(Index)) { Mesh = *Found; }
			}
		}
	}

	const bool bMesh = Mode == TEXT("mesh");
	const bool bRibbon = Mode == TEXT("trail") || Mode == TEXT("ribbon");
	UMaterialInterface* Material = FVfxAssetImport::MaterialFor(Texture, Blend, bMesh,
		PackageFolder, Report);

	// THE RENDERER THE TEMPLATE CAME WITH is a sprite renderer, which is right
	// for three of the four modes and useless for the fourth. Swapping it is
	// the only way to get a mesh onto the screen, and it has to happen through
	// the emitter rather than the stack API - renderers are not modules.
	FVersionedNiagaraEmitter Versioned;
	for (const FNiagaraEmitterHandle& Handle : System->GetEmitterHandles())
	{
		if (Handle.GetName() == EmitterName) { Versioned = Handle.GetInstance(); break; }
	}
	FVersionedNiagaraEmitterData* EmitterData = Versioned.GetEmitterData();
	if (Versioned.Emitter == nullptr || EmitterData == nullptr)
	{
		Report.Dropped(CurrentLabel, TEXT("output"), TEXT("the emitter could not be found again"));
		return;
	}

	UNiagaraSpriteRendererProperties* Sprite = nullptr;
	TArray<UNiagaraRendererProperties*> Existing(EmitterData->GetRenderers());
	for (UNiagaraRendererProperties* Renderer : Existing)
	{
		if (UNiagaraSpriteRendererProperties* AsSprite =
			Cast<UNiagaraSpriteRendererProperties>(Renderer))
		{
			Sprite = AsSprite;
		}
	}

	const ENiagaraSortMode SortMode =
		Sort == TEXT("depth") ? ENiagaraSortMode::ViewDepth
		: Sort == TEXT("age") ? ENiagaraSortMode::CustomAscending
		: ENiagaraSortMode::None;

	if (bMesh)
	{
		if (Mesh == nullptr)
		{
			Report.Dropped(CurrentLabel, TEXT("output.mode"),
				TEXT("this emitter draws a mesh and the bundle carried none, so it kept its ")
				TEXT("sprite renderer"));
		}
		else
		{
			UNiagaraMeshRendererProperties* MeshRenderer =
				NewObject<UNiagaraMeshRendererProperties>(Versioned.Emitter);
			// The GLB arrives with its own material, which was never compiled
			// with the Niagara mesh-particle usage flag - so without the
			// override every mesh particle draws as the grey checkerboard.
			MeshRenderer->bOverrideMaterials = true;
			FNiagaraMeshMaterialOverride Override;
			Override.ExplicitMat = Material;
			MeshRenderer->OverrideMaterials.Add(Override);
			MeshRenderer->SortMode = SortMode;
			if (Sprite != nullptr)
			{
				Versioned.Emitter->RemoveRenderer(Sprite, Versioned.Version);
				Sprite = nullptr;
			}
			Versioned.Emitter->AddRenderer(MeshRenderer, Versioned.Version);

			// THE MESH IS ASSIGNED AFTER AddRenderer, NOT BEFORE. Adding the
			// renderer to the emitter re-caches it from its compiled data,
			// which rebuilds the Meshes array - so a mesh set beforehand is
			// dropped on the way in, and the renderer arrives pointing at
			// nothing while the import report cheerfully names the mesh.
			FNiagaraMeshRendererMeshProperties MeshProperties;
			MeshProperties.Mesh = Mesh;
			// THE SCALE GOES ON THE RENDERER, not on Initialize Particle. That
			// module's Mesh Scale input reports itself visible and NOT EDITABLE
			// whatever Write Scale is set to and however often the context is
			// rebuilt, so every write is refused - while the renderer's own
			// per-mesh scale takes it without argument. The difference is that
			// this one value covers the whole emitter rather than varying per
			// particle, which for a size authored as a narrow random range is
			// the mean either way.
			if (PendingMeshScale >= 0.f)
			{
				// NO UNIT CONVERSION: sprite size is a length and goes metres ->
				// centimetres, but this is a MULTIPLIER on a mesh that arrived
				// in centimetres already. Scaling it by 100 would be the same
				// mistake in the other direction - and a rune several metres
				// tall is what the un-scaled version looked like.
				MeshProperties.Scale = FVector(PendingMeshScale);
			}
			MeshRenderer->Meshes.Reset();
			MeshRenderer->Meshes.Add(MeshProperties);
			MeshRenderer->PostEditChange();

			Report.Native(CurrentLabel, TEXT("output.mode"),
				MeshRenderer->Meshes.Num() > 0 && MeshRenderer->Meshes[0].Mesh != nullptr
					? *FString::Printf(TEXT("Mesh renderer, %s"), *Mesh->GetName())
					: TEXT("a Mesh renderer that would not hold the mesh"));

			if (PendingMeshScale >= 0.f)
			{
				Report.Native(CurrentLabel, TEXT("initialize.setSize"),
					FString::Printf(TEXT("mesh scale %.2f on the renderer"), PendingMeshScale));
			}
		}
	}
	else if (bRibbon)
	{
		// A ribbon needs one id per strand and an ordering within it, and the
		// IR has neither - its trail is a per-particle stretch, not a strand.
		// A ribbon renderer here would draw one tangle joining every particle.
		Report.Approximated(CurrentLabel, TEXT("output.mode"),
			TEXT("became a velocity-aligned sprite, not a Ribbon renderer: a ribbon needs a ")
			TEXT("ribbon id per strand and the effect has no strands, only particles"));
	}

	if (Sprite != nullptr)
	{
		Sprite->Material = Material;
		Sprite->SortMode = SortMode;

		if (Mode == TEXT("stretched") || bRibbon)
		{
			// Set here rather than described in a note. The two properties go
			// together: aligning to velocity without changing the facing mode
			// rotates the sprite and then lets the camera flatten it again.
			Sprite->Alignment = ENiagaraSpriteAlignment::VelocityAligned;
			Sprite->FacingMode = ENiagaraSpriteFacingMode::FaceCameraPlane;
			Report.Native(CurrentLabel, TEXT("output.mode"),
				TEXT("Sprite, velocity aligned"));
		}
		else if (!bMesh)
		{
			Report.Native(CurrentLabel, TEXT("output.mode"), TEXT("Sprite"));
		}

		if (Columns > 1 || Rows > 1)
		{
			Sprite->SubImageSize = FVector2D(Columns, Rows);
			Sprite->bSubImageBlend = false;
			BuildFlipbook(SystemObject, EmitterName, Sprite, Columns * Rows);
		}
		Sprite->PostEditChange();
	}

	// BLEND IS A MATERIAL DECISION IN UNREAL, and now it is one this importer
	// actually makes. It used to be a note asking the author to go and build
	// the material themselves, which is the single most common reason an
	// imported effect looked wrong: no texture, no blend, white squares.
	Report.Native(CurrentLabel, TEXT("output.blend"),
		FString::Printf(TEXT("'%s' as a generated unlit material%s"), *Blend,
			Texture != nullptr ? TEXT(" with the bundle's texture") : TEXT("")));
}

void FVfxNiagaraBuilder::BuildFlipbook(const TSharedPtr<FJsonObject>& SystemObject,
	FName EmitterName, UNiagaraSpriteRendererProperties* Sprite, int32 Cells)
{
	// THE FLIPBOOK IS SPREAD OVER THREE BLOCKS - the frame count and rate on
	// update.flipbook, the start frame on initialize.setFlipbookFrame, the
	// sheet layout on the output - and Niagara wants all of it in one module
	// that also needs a pointer back to the renderer it is animating. So it is
	// assembled here, after the renderer exists, rather than where the blocks
	// are walked.
	int32 Frames = Cells;
	float Rate = 0.f;
	FString Timing = TEXT("life");
	FVfxBound StartFrame;
	bool bFound = false;

	const TArray<TSharedPtr<FJsonValue>>* Blocks = nullptr;
	if (SystemObject->TryGetArrayField(TEXT("update"), Blocks))
	{
		for (const TSharedPtr<FJsonValue>& Entry : *Blocks)
		{
			const TSharedPtr<FJsonObject> Block = Entry->AsObject();
			if (FVfxIr::BlockType(Block) != TEXT("update.flipbook")) { continue; }
			bFound = true;
			const FVfxBound FrameCount = Ir.Binding(Block, TEXT("frames"));
			if (FrameCount.bFound) { Frames = FMath::Max(1, FMath::RoundToInt(FrameCount.Constant)); }
			Rate = Ir.Binding(Block, TEXT("rate")).Constant;
			Timing = FVfxIr::Mode(Block, TEXT("timing"), TEXT("life"));
		}
	}
	if (SystemObject->TryGetArrayField(TEXT("init"), Blocks))
	{
		for (const TSharedPtr<FJsonValue>& Entry : *Blocks)
		{
			const TSharedPtr<FJsonObject> Block = Entry->AsObject();
			if (FVfxIr::BlockType(Block) != TEXT("initialize.setFlipbookFrame")) { continue; }
			StartFrame = Ir.Binding(Block, TEXT("flipbookFrame"));
		}
	}
	if (!bFound)
	{
		Report.Native(CurrentLabel, TEXT("output.setFlipbook"),
			FString::Printf(TEXT("%dx%d sheet on the renderer, no animation block"),
				static_cast<int32>(Sprite->SubImageSize.X),
				static_cast<int32>(Sprite->SubImageSize.Y)));
		return;
	}

	const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
		VfxNiagara::ModSubUV, TEXT("update.flipbook"));
	if (Module.IsNone()) { return; }

	// "Infinite Loop" plays at a rate and wraps; "Linear" spreads the sheet
	// across the particle's life exactly once. That is precisely the two
	// timings the block offers, which is a rarer alignment than it sounds.
	SetEnum(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("SubUV Animation Mode") },
		VfxNiagara::EnumSubUvMode, Timing == TEXT("rate") ? TEXT("Infinite Loop") : TEXT("Linear"),
		TEXT("update.flipbook"));
	SetEnum(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Renderer Type") },
		VfxNiagara::EnumMeshOrSprite, TEXT("Sprite"), TEXT("update.flipbook"));

	if (Timing == TEXT("rate"))
	{
		// The loop length in seconds is what Infinite Loop takes, and the block
		// gives frames per second: a 36 frame sheet at 24fps loops every 1.5s.
		const float LoopSeconds = Rate > 0.f ? Frames / Rate : 1.f;
		SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Play Rate") },
			LoopSeconds, TEXT("update.flipbook"));
	}

	if (StartFrame.bFound)
	{
		SetBool(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Random Start Frame") },
			StartFrame.bRandom, TEXT("initialize.setFlipbookFrame"));
		if (!StartFrame.bRandom)
		{
			SetInt(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Start Frame Offset") },
				FMath::RoundToInt(StartFrame.Constant), TEXT("initialize.setFlipbookFrame"));
		}
		Report.Native(CurrentLabel, TEXT("initialize.setFlipbookFrame"),
			StartFrame.bRandom ? TEXT("random start frame")
				: *FString::Printf(TEXT("starts at frame %.0f"), StartFrame.Constant));
	}

	if (Frames < Cells)
	{
		Report.Approximated(CurrentLabel, TEXT("update.flipbook"),
			FString::Printf(TEXT("the block plays %d of the sheet's %d frames; Niagara's SubUV ")
				TEXT("module always walks the whole sheet, so the extra frames play too"),
				Frames, Cells));
	}
	else
	{
		Report.Native(CurrentLabel, TEXT("update.flipbook"),
			Timing == TEXT("rate")
				? *FString::Printf(TEXT("%d frames at %.0f fps, looping"), Frames, Rate)
				: *FString::Printf(TEXT("%d frames spread over the particle's life"), Frames));
	}
}

// ---------------------------------------------------------------------------
// Stack editing
// ---------------------------------------------------------------------------

FName FVfxNiagaraBuilder::AddModule(FName EmitterName, FName ScriptName,
	const TCHAR* ModuleAssetPath, const FString& Label)
{
	UNiagaraScript* Script = LoadObject<UNiagaraScript>(nullptr, ModuleAssetPath);
	if (Script == nullptr)
	{
		Report.Dropped(CurrentLabel, Label,
			FString::Printf(TEXT("the Niagara module %s is not in this engine install"),
				ModuleAssetPath));
		return NAME_None;
	}

	FNiagaraExt_StackItemReference Location(System, EmitterName, ScriptName);
	GContext->Errors.Reset();
	FNiagaraExt_ModuleTopology Topology;
	UNiagaraExternalEditUtilities::AddModule(Location, Script, Topology, *GContext);

	if (GContext->Errors.Num() > 0 || Topology.ModuleName.IsNone())
	{
		FString Why = GContext->Errors.Num() > 0
			? GContext->Errors[0].ToString() : TEXT("the module was not added");
		Report.Dropped(CurrentLabel, Label, Why);
		return NAME_None;
	}
	return Topology.ModuleName;
}

bool FVfxNiagaraBuilder::SetInput(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const FInstancedStruct& Value, const FString& Label)
{
	FNiagaraExt_StackItemReference Ref(System, EmitterName, ScriptName, ModuleName);
	Ref.InputNameStack = InputStack;

	FNiagaraExt_StackInputValue Wrapped;
	static_cast<FInstancedStruct&>(Wrapped) = Value;

	GContext->Errors.Reset();
	UNiagaraExternalEditUtilities::SetStackInputData(Ref, Wrapped, *GContext);

	if (GContext->Errors.Num() > 0)
	{
		// REPORTED, NOT LOGGED. A refused write leaves the input at its default,
		// so the effect imports looking almost right - which is the single
		// hardest kind of wrongness for an author to find.
		FString Path;
		for (const FName& Name : InputStack)
		{
			Path += (Path.IsEmpty() ? TEXT("") : TEXT(" > ")) + Name.ToString();
		}
		Report.Approximated(CurrentLabel, Label,
			FString::Printf(TEXT("could not set '%s': %s"), *Path,
				*GContext->Errors[0].ToString()));
		return false;
	}
	return true;
}

bool FVfxNiagaraBuilder::SetFloat(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, float Value, const FString& Label)
{
	FNiagaraFloat Payload;
	Payload.Value = Value;
	return SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		FInstancedStruct::Make(Payload), Label);
}

bool FVfxNiagaraBuilder::SetBool(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, bool Value, const FString& Label)
{
	FNiagaraBool Payload;
	Payload.SetValue(Value);
	return SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		FInstancedStruct::Make(Payload), Label);
}

bool FVfxNiagaraBuilder::SetInt(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, int32 Value, const FString& Label)
{
	FNiagaraInt32 Payload;
	Payload.Value = Value;
	return SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		FInstancedStruct::Make(Payload), Label);
}

bool FVfxNiagaraBuilder::SetVector(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const FVector3f& Value, const FString& Label)
{
	return SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		VfxNiagara::MakeVariant(Value), Label);
}

bool FVfxNiagaraBuilder::SetPosition(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const FVector3f& Value, const FString& Label)
{
	const FNiagaraPosition Payload(Value);
	return SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		FInstancedStruct::Make(Payload), Label);
}

bool FVfxNiagaraBuilder::SetColour(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const FLinearColor& Value, const FString& Label)
{
	return SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		FInstancedStruct::Make(Value), Label);
}

bool FVfxNiagaraBuilder::SetEnum(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const TCHAR* EnumAssetPath, const TCHAR* DisplayName,
	const FString& Label)
{
	UEnum* Enum = LoadObject<UEnum>(nullptr, EnumAssetPath);
	FName EntryName;
	if (!VfxNiagara::FindEnumEntry(Enum, DisplayName, EntryName))
	{
		Report.Approximated(CurrentLabel, Label,
			FString::Printf(TEXT("this engine's %s has no '%s' option, so the module kept its ")
				TEXT("default"), *FPaths::GetBaseFilename(EnumAssetPath), DisplayName));
		return false;
	}

	FNiagaraExt_StackInputData_Enum Payload;
	Payload.Enum = Enum;
	Payload.EnumName = EntryName;
	const bool bSet = SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		FInstancedStruct::Make(Payload), Label);
	// An enum is usually the static switch that governs the inputs written
	// next, so the stack has to be re-resolved before them. Refreshing after
	// every enum rather than only after a switch: telling them apart needs a
	// topology query that costs the same as the refresh.
	if (bSet) { RefreshContext(System); }
	return bSet;
}

bool FVfxNiagaraBuilder::SetDynamicInput(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const TCHAR* DynamicInputAssetPath, const FString& Label)
{
	UNiagaraScript* Asset = LoadObject<UNiagaraScript>(nullptr, DynamicInputAssetPath);
	if (Asset == nullptr)
	{
		Report.Approximated(CurrentLabel, Label,
			FString::Printf(TEXT("the dynamic input %s is not in this engine install"),
				DynamicInputAssetPath));
		return false;
	}
	FNiagaraExt_StackInputData_DynamicInput Payload;
	Payload.DynamicInputAsset = Asset;
	const bool bSet = SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		FInstancedStruct::Make(Payload), Label);
	// Same reason: until the context is rebuilt the input is still reported as
	// a plain literal, and writing into its chain is refused with "not a
	// dynamic input, but more inputs are specified in the path".
	if (bSet) { RefreshContext(System); }
	return bSet;
}

bool FVfxNiagaraBuilder::SetLinked(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const TCHAR* ParameterName,
	const FNiagaraTypeDefinition& ParameterType, const FString& Label)
{
	FNiagaraExt_StackInputData_Linked Payload;
	Payload.LinkedVariable.Name = ParameterName;
	Payload.LinkedVariable.Type = ParameterType;
	return SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		FInstancedStruct::Make(Payload), Label);
}

bool FVfxNiagaraBuilder::SetDataInterface(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const FString& PropertyValues, const FString& Label)
{
	FNiagaraExt_StackInputData_DataInterface Payload;
	Payload.PropertyValues = PropertyValues;
	return SetInput(EmitterName, ScriptName, ModuleName, InputStack,
		FInstancedStruct::Make(Payload), Label);
}

void FVfxNiagaraBuilder::SetScalarOrCurve(FName EmitterName, FName ScriptName, FName ModuleName,
	const TArray<FName>& InputStack, const FVfxBound& Bound, float UnitScale, const FString& Label)
{
	if (Bound.IsCurve())
	{
		TArray<FName> CurveStack = InputStack;
		CurveStack.Add(TEXT("FloatCurve"));
		SetDynamicInput(EmitterName, ScriptName, ModuleName, InputStack,
			VfxNiagara::DynFloatFromCurve, Label);
		SetDataInterface(EmitterName, ScriptName, ModuleName, CurveStack,
			FloatCurveJson(Bound.Curve, Bound.Scale * UnitScale), Label);
		return;
	}
	SetFloat(EmitterName, ScriptName, ModuleName, InputStack, Bound.Constant * UnitScale, Label);
}

// ---------------------------------------------------------------------------
// Curves
//
// THE JSON SHAPE IS MEASURED, NOT GUESSED. SetStackInputData takes a data
// interface as a property string, and a key the schema does not recognise is
// dropped in silence - leaving a default curve and an effect that is subtly
// wrong. So a real FRichCurve was serialised through the same provider and the
// output copied; see VECTOR CURVE ROUND TRIP in the probe dump.
// ---------------------------------------------------------------------------

namespace
{
	/** One FRichCurve, as the property provider serialises it. */
	void WriteRichCurve(const TSharedRef<TJsonWriter<>>& Writer, const FString& Field,
		const TArray<TPair<float, float>>& Keys, bool bCubic)
	{
		Writer->WriteObjectStart(Field);
		Writer->WriteArrayStart(TEXT("keys"));
		for (const TPair<float, float>& Key : Keys)
		{
			Writer->WriteObjectStart();
			// AUTO TANGENTS, deliberately. An auto tangent in FRichCurve is
			// (P[i+1] - P[i-1]) / 2 - which IS the Catmull-Rom tangent the
			// preview uses, so the imported path bends the same way rather than
			// merely passing through the same points.
			Writer->WriteValue(TEXT("interpMode"), bCubic ? TEXT("RCIM_Cubic") : TEXT("RCIM_Linear"));
			Writer->WriteValue(TEXT("tangentMode"), TEXT("RCTM_Auto"));
			Writer->WriteValue(TEXT("tangentWeightMode"), TEXT("RCTWM_WeightedNone"));
			Writer->WriteValue(TEXT("time"), Key.Key);
			Writer->WriteValue(TEXT("value"), Key.Value);
			Writer->WriteValue(TEXT("arriveTangent"), 0.f);
			Writer->WriteValue(TEXT("arriveTangentWeight"), 0.f);
			Writer->WriteValue(TEXT("leaveTangent"), 0.f);
			Writer->WriteValue(TEXT("leaveTangentWeight"), 0.f);
			Writer->WriteObjectEnd();
		}
		Writer->WriteArrayEnd();
		// Clamped at both ends, matching the authored curve's own wrap mode: a
		// looping extrapolation would make a size-over-life curve restart.
		Writer->WriteValue(TEXT("preInfinityExtrap"), TEXT("RCCE_Constant"));
		Writer->WriteValue(TEXT("postInfinityExtrap"), TEXT("RCCE_Constant"));
		Writer->WriteObjectEnd();
	}
}

FString FVfxNiagaraBuilder::PathCurveJson(const TArray<FVector3f>& Path, float KeyScale)
{
	// KEYED BY CUMULATIVE CHORD LENGTH, not by point index. The preview walks
	// the path by arc length so that "spacing" means metres and "even" means
	// evenly spaced; keying by index instead would bunch particles up wherever
	// the author placed two points close together, and the difference is
	// obvious the moment a path has one tight corner.
	TArray<TPair<float, float>> X, Y, Z;
	const float Total = VfxNiagara::ChordLength(Path);
	float Walked = 0.f;

	for (int32 i = 0; i < Path.Num(); ++i)
	{
		if (i > 0) { Walked += (Path[i] - Path[i - 1]).Size(); }
		const float T = (Total > KINDA_SMALL_NUMBER ? Walked / Total
			: static_cast<float>(i) / FMath::Max(1, Path.Num() - 1)) * KeyScale;
		X.Add({ T, Path[i].X });
		Y.Add({ T, Path[i].Y });
		Z.Add({ T, Path[i].Z });
	}

	FString Out;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	Writer->WriteObjectStart();
	WriteRichCurve(Writer, TEXT("xCurve"), X, /*bCubic*/ true);
	WriteRichCurve(Writer, TEXT("yCurve"), Y, /*bCubic*/ true);
	WriteRichCurve(Writer, TEXT("zCurve"), Z, /*bCubic*/ true);
	Writer->WriteObjectEnd();
	Writer->Close();
	return Out;
}

FString FVfxNiagaraBuilder::PathTangentCurveJson(const TArray<FVector3f>& Path, float KeyScale)
{
	// UNIT TANGENTS at the same key times as the path itself, by central
	// difference - which is the Catmull-Rom tangent, so the direction a particle
	// leaves in is the direction the drawn curve is actually heading.
	TArray<TPair<float, float>> X, Y, Z;
	const float Total = VfxNiagara::ChordLength(Path);
	float Walked = 0.f;

	for (int32 i = 0; i < Path.Num(); ++i)
	{
		if (i > 0) { Walked += (Path[i] - Path[i - 1]).Size(); }
		const float T = (Total > KINDA_SMALL_NUMBER ? Walked / Total
			: static_cast<float>(i) / FMath::Max(1, Path.Num() - 1)) * KeyScale;

		const FVector3f& Before = Path[FMath::Max(0, i - 1)];
		const FVector3f& After = Path[FMath::Min(Path.Num() - 1, i + 1)];
		FVector3f Direction = After - Before;
		// A degenerate segment leaves no direction to travel in; +X is an
		// arbitrary but finite answer, and a zero vector here would put a NaN
		// into every particle downstream of the normalise.
		Direction = Direction.IsNearlyZero() ? FVector3f(1.f, 0.f, 0.f)
			: Direction.GetSafeNormal();

		X.Add({ T, Direction.X });
		Y.Add({ T, Direction.Y });
		Z.Add({ T, Direction.Z });
	}

	FString Out;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	Writer->WriteObjectStart();
	WriteRichCurve(Writer, TEXT("xCurve"), X, /*bCubic*/ true);
	WriteRichCurve(Writer, TEXT("yCurve"), Y, /*bCubic*/ true);
	WriteRichCurve(Writer, TEXT("zCurve"), Z, /*bCubic*/ true);
	Writer->WriteObjectEnd();
	Writer->Close();
	return Out;
}

FString FVfxNiagaraBuilder::FloatCurveJson(const TSharedPtr<FJsonObject>& Authored, float Scale)
{
	TArray<TPair<float, float>> Keys;
	bool bCubic = true;
	const TArray<TSharedPtr<FJsonValue>>* Raw = nullptr;
	if (Authored.IsValid() && Authored->TryGetArrayField(TEXT("keys"), Raw))
	{
		for (const TSharedPtr<FJsonValue>& Entry : *Raw)
		{
			const TSharedPtr<FJsonObject> Key = Entry->AsObject();
			if (!Key.IsValid()) { continue; }
			Keys.Add({ static_cast<float>(Key->GetNumberField(TEXT("t"))),
				static_cast<float>(Key->GetNumberField(TEXT("v"))) * Scale });
			if (Key->GetStringField(TEXT("interp")) == TEXT("linear")) { bCubic = false; }
		}
	}
	if (Keys.Num() == 0) { Keys.Add({ 0.f, Scale }); }

	FString Out;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	Writer->WriteObjectStart();
	WriteRichCurve(Writer, TEXT("curve"), Keys, bCubic);
	Writer->WriteObjectEnd();
	Writer->Close();
	return Out;
}

FString FVfxNiagaraBuilder::ColourCurveJson(const TSharedPtr<FJsonObject>& Authored)
{
	// SEPARATE RAILS, kept separate. The authored gradient stores colour keys
	// and alpha keys as two lists because Unity's Gradient does and a merged
	// list cannot round-trip; Niagara stores four independent FRichCurves, so
	// the two rails land on red/green/blue and alpha with nothing resampled.
	TArray<TPair<float, float>> R, G, B, A;

	const TArray<TSharedPtr<FJsonValue>>* ColourKeys = nullptr;
	if (Authored.IsValid() && Authored->TryGetArrayField(TEXT("colorKeys"), ColourKeys))
	{
		for (const TSharedPtr<FJsonValue>& Entry : *ColourKeys)
		{
			const TSharedPtr<FJsonObject> Key = Entry->AsObject();
			if (!Key.IsValid()) { continue; }
			const float T = static_cast<float>(Key->GetNumberField(TEXT("t")));
			double Intensity = 1;
			Key->TryGetNumberField(TEXT("intensity"), Intensity);
			const FLinearColor Colour = FVfxConvert::FromHex(
				Key->GetStringField(TEXT("hex")), static_cast<float>(Intensity));
			R.Add({ T, Colour.R });
			G.Add({ T, Colour.G });
			B.Add({ T, Colour.B });
		}
	}

	const TArray<TSharedPtr<FJsonValue>>* AlphaKeys = nullptr;
	if (Authored.IsValid() && Authored->TryGetArrayField(TEXT("alphaKeys"), AlphaKeys))
	{
		for (const TSharedPtr<FJsonValue>& Entry : *AlphaKeys)
		{
			const TSharedPtr<FJsonObject> Key = Entry->AsObject();
			if (!Key.IsValid()) { continue; }
			A.Add({ static_cast<float>(Key->GetNumberField(TEXT("t"))),
				static_cast<float>(Key->GetNumberField(TEXT("a"))) });
		}
	}

	if (R.Num() == 0) { R.Add({ 0.f, 1.f }); G.Add({ 0.f, 1.f }); B.Add({ 0.f, 1.f }); }
	if (A.Num() == 0) { A.Add({ 0.f, 1.f }); }

	FString Out;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	Writer->WriteObjectStart();
	WriteRichCurve(Writer, TEXT("redCurve"), R, /*bCubic*/ false);
	WriteRichCurve(Writer, TEXT("greenCurve"), G, /*bCubic*/ false);
	WriteRichCurve(Writer, TEXT("blueCurve"), B, /*bCubic*/ false);
	WriteRichCurve(Writer, TEXT("alphaCurve"), A, /*bCubic*/ false);
	Writer->WriteObjectEnd();
	Writer->Close();
	return Out;
}
