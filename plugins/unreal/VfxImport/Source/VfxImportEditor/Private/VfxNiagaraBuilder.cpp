#include "VfxNiagaraBuilder.h"

#include "VfxImportReport.h"

#include "NiagaraSystem.h"
#include "NiagaraEmitter.h"
#include "NiagaraScript.h"
#include "NiagaraTypes.h"
#include "NiagaraExternalSystemEditorUtilities.h"
#include "NiagaraSpriteRendererProperties.h"
#include "NiagaraMeshRendererProperties.h"

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

	GContextHolder.Reset();
	GContext = nullptr;
	return System;
}

void FVfxNiagaraBuilder::BuildEmitter(const TSharedPtr<FJsonObject>& SystemObject, FName EmitterName)
{
	CurrentLabel = EmitterName.ToString();
	bNeedsSolver = false;

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

	BuildEmitterState(SystemObject, EmitterName);
	BuildSpawn(SystemObject, EmitterName);
	BuildInitialize(SystemObject, EmitterName);
	BuildUpdate(SystemObject, EmitterName);
	BuildOutput(SystemObject, EmitterName);

	// THE SOLVER GOES LAST, always. It integrates the forces every other Update
	// module accumulated, so a solver placed before them integrates last frame's
	// forces - which looks like a one-frame lag at 60fps and like broken physics
	// at 10. Niagara does not enforce the order; the author would have to know.
	if (bNeedsSolver)
	{
		const FName Solver = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
			VfxNiagara::ModSolve, TEXT("solver"));
		if (!Solver.IsNone())
		{
			Report.Native(CurrentLabel, TEXT("Solve Forces and Velocity"),
				TEXT("added last, so it integrates the forces above it"));
		}
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

	SetFloat(EmitterName, VfxNiagara::EmitterUpdate, VfxNiagara::EmitterStateModule,
		{ TEXT("Loop Duration") }, Ir.Duration(), TEXT("loop duration"));

	// A clip that starts later than zero becomes the emitter's loop delay. One
	// clip maps exactly; more than one does not, and the author is told so
	// rather than finding out when only the first burst appears.
	const TSharedPtr<FJsonObject>* Schedule = nullptr;
	if (SystemObject->TryGetObjectField(TEXT("schedule"), Schedule))
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
		FString::Printf(TEXT("%s, %.2fs"), bLoops ? TEXT("looping") : TEXT("once"), Ir.Duration()));
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
				Report.Native(CurrentLabel, Type);
			}
			else if (Type == TEXT("initialize.positionCircle"))
			{
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Shape Primitive") },
					VfxNiagara::EnumShapes, TEXT("Ring / Disc"), Type);
				const FVfxBound Radius = Ir.Binding(Block, TEXT("radius"));
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Ring Radius") },
					FVfxConvert::Length(Radius.Constant), Type);
				const FVfxBound Thickness = Ir.Binding(Block, TEXT("thickness"));
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Disc Coverage") },
					FMath::Clamp(Thickness.Constant, 0.f, 1.f), Type);
				Report.Native(CurrentLabel, Type);
			}
			else if (Type == TEXT("initialize.positionCone"))
			{
				SetEnum(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Shape Primitive") },
					VfxNiagara::EnumShapes, TEXT("Cone"), Type);
				const FVfxBound Angle = Ir.Binding(Block, TEXT("angle"));
				const FVfxBound Radius = Ir.Binding(Block, TEXT("radius"));
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Cone Angle") },
					Angle.Constant, Type);
				SetFloat(EmitterName, VfxNiagara::ParticleSpawn, Shape, { TEXT("Cone Length") },
					FVfxConvert::Length(FMath::Max(0.01f, Radius.Constant)), Type);
				// The cone block is a shape AND a velocity in one, which Niagara
				// splits into two modules.
				const FVfxBound Speed = Ir.Binding(Block, TEXT("speed"));
				if (Speed.bFound && Speed.Constant != 0.f)
				{
					const FName Velocity = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
						VfxNiagara::ModAddVelocity, Type);
					if (!Velocity.IsNone())
					{
						SetVector(EmitterName, VfxNiagara::ParticleSpawn, Velocity,
							{ TEXT("Velocity") },
							FVector3f(0.f, 0.f, FVfxConvert::Length(Speed.Constant)), Type);
						bNeedsSolver = true;
					}
				}
				Report.Native(CurrentLabel, Type, TEXT("cone shape plus its speed"));
			}
			else if (Type == TEXT("initialize.positionMesh"))
			{
				Report.Dropped(CurrentLabel, Type,
					TEXT("mesh emission needs a Static Mesh data interface pointed at an ")
					TEXT("imported mesh, and this importer does not bring meshes in yet; ")
					TEXT("import the bundle's mesh yourself and add a Static Mesh Location ")
					TEXT("module pointed at it"));
			}
			else
			{
				Report.Dropped(CurrentLabel, Type, TEXT("no Niagara shape matches this"));
			}
		}
		else if (Type == TEXT("initialize.velocityDirection")
			|| Type == TEXT("initialize.velocityRandom")
			|| Type == TEXT("initialize.velocityOutward"))
		{
			const FName Velocity = AddModule(EmitterName, VfxNiagara::ParticleSpawn,
				VfxNiagara::ModAddVelocity, Type);
			if (Velocity.IsNone()) { continue; }
			bNeedsSolver = true;

			if (Type == TEXT("initialize.velocityDirection"))
			{
				const FVfxBound Direction = Ir.Binding(Block, TEXT("velocity"));
				SetVector(EmitterName, VfxNiagara::ParticleSpawn, Velocity, { TEXT("Velocity") },
					FVfxConvert::Vector(Direction.Vector), Type);
				Report.Native(CurrentLabel, Type);
			}
			else if (Type == TEXT("initialize.velocityRandom"))
			{
				const FVfxBound Velocity3 = Ir.Binding(Block, TEXT("velocity"));
				SetVector(EmitterName, VfxNiagara::ParticleSpawn, Velocity, { TEXT("Velocity") },
					FVfxConvert::Vector(Velocity3.bRandom ? Velocity3.HighVector : Velocity3.Vector),
					Type);
				Report.Approximated(CurrentLabel, Type,
					TEXT("became a constant velocity at the top of the authored range; the ")
					TEXT("per-axis random spread was not carried"));
			}
			else
			{
				const FVfxBound Speed = Ir.Binding(Block, TEXT("speed"));
				SetVector(EmitterName, VfxNiagara::ParticleSpawn, Velocity, { TEXT("Velocity") },
					FVector3f(0.f, 0.f, FVfxConvert::Length(Speed.Constant)), Type);
				Report.Approximated(CurrentLabel, Type,
					TEXT("outward-from-centre became a constant upward velocity; wire Add ")
					TEXT("Velocity from Point to the emitter origin to restore it"));
			}
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

	SetDataInterface(EmitterName, VfxNiagara::ParticleSpawn, Init,
		{ TEXT("Position"), TEXT("VectorCurve") }, PathCurveJson(Path), Label);

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
			FString::Printf(TEXT("the path survived as a %d-key vector curve, but fixed ")
				TEXT("spacing became even spread: Niagara has no walk-along-at-a-distance ")
				TEXT("mode, so the gap now depends on how many particles are alive"),
				Path.Num()));
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
		Report.Approximated(CurrentLabel, Label,
			TEXT("the path's thickness was not carried; particles sit exactly on the curve. ")
			TEXT("Add a Jitter Position module to scatter them around it"));
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
					PathTangentCurveJson(Path), Label);
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
	if (Placement == TEXT("even") || Placement == TEXT("spacing"))
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
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Noise Frequency") },
				Frequency.Constant, Type);
			bNeedsSolver = true;
			// BOTH ARE CURL NOISE, which is the rare case where the preview and
			// the engine agree on the character of the motion rather than only
			// its strength - unlike Unity, whose noise module is value noise.
			Report.Native(CurrentLabel, Type, TEXT("curl noise, same divergence-free field"));
		}
		else if (Type == TEXT("update.pointAttractor"))
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
			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Vortex Axis") },
				FVfxConvert::Direction(Axis.Vector), Type);
			SetFloat(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Vortex Force Amount") },
				FVfxConvert::Length(Strength.Constant), Type);
			bNeedsSolver = true;
			Report.Native(CurrentLabel, Type);
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
		else if (Type == TEXT("update.collidePlane"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModConstrainToPlane, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Height = Ir.Binding(Block, TEXT("height"));
			SetPosition(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Plane Position") },
				FVector3f(0.f, 0.f, FVfxConvert::Length(Height.Constant)), Type);
			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Plane Normal") },
				FVector3f(0.f, 0.f, 1.f), Type);
			Report.Approximated(CurrentLabel, Type,
				TEXT("became Constrain Position To Plane, which stops particles at the floor ")
				TEXT("but does not bounce them; the authored bounce and friction were not carried"));
		}
		else if (Type == TEXT("update.killBox"))
		{
			const FName Module = AddModule(EmitterName, VfxNiagara::ParticleUpdate,
				VfxNiagara::ModKillInVolume, Type);
			if (Module.IsNone()) { continue; }
			const FVfxBound Size = Ir.Binding(Block, TEXT("size"));
			FVector3f Extent = FVfxConvert::Vector(Size.Vector);
			Extent = FVector3f(FMath::Abs(Extent.X), FMath::Abs(Extent.Y), FMath::Abs(Extent.Z));
			SetBool(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Invert Volume") },
				true, Type);
			SetVector(EmitterName, VfxNiagara::ParticleUpdate, Module, { TEXT("Box Size") },
				Extent, Type);
			Report.Native(CurrentLabel, Type, TEXT("kill outside the box"));
		}
		else if (Type == TEXT("update.speedLimit"))
		{
			// Not a module: the solver owns the clamp, and clamping anywhere
			// else means clamping last frame's velocity while this frame's
			// acceleration immediately exceeds it again.
			const FVfxBound Limit = Ir.Binding(Block, TEXT("speed"));
			bNeedsSolver = true;
			Report.Approximated(CurrentLabel, Type,
				FString::Printf(TEXT("Niagara clamps speed inside Solve Forces and Velocity ")
					TEXT("rather than as its own module; set its Speed Limit to %.0f and ")
					TEXT("tick Clamp Velocity"), FVfxConvert::Length(Limit.Constant)));
		}
		else
		{
			Report.Dropped(CurrentLabel, Type, TEXT("no Niagara module matches this block"));
		}
	}
}

void FVfxNiagaraBuilder::BuildOutput(const TSharedPtr<FJsonObject>& SystemObject, FName EmitterName)
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

	// The Minimal template already carries a sprite renderer, which is what the
	// billboard and stretched modes want. A mesh effect needs a different
	// renderer class, and that is a bigger change than this pass makes.
	if (Mode == TEXT("mesh"))
	{
		Report.Dropped(CurrentLabel, TEXT("output.mode"),
			TEXT("mesh rendering needs a Mesh Renderer pointed at the imported mesh; the ")
			TEXT("emitter kept its sprite renderer"));
	}
	else if (Mode == TEXT("stretched"))
	{
		Report.Approximated(CurrentLabel, TEXT("output.mode"),
			TEXT("kept the sprite renderer; set its Alignment to Velocity Aligned and ")
			TEXT("Facing Mode to Custom Facing Vector to stretch along motion"));
	}
	else if (Mode == TEXT("trail") || Mode == TEXT("ribbon"))
	{
		Report.Dropped(CurrentLabel, TEXT("output.mode"),
			TEXT("a ribbon needs a Ribbon Renderer and ribbon ids on the particles"));
	}
	else
	{
		Report.Native(CurrentLabel, TEXT("output.mode"), TEXT("Sprite"));
	}

	// BLEND IS A MATERIAL DECISION IN UNREAL, not a renderer flag. Saying so
	// matters: an author who does not know that will look for an additive
	// checkbox on the renderer and conclude the import lost it.
	Report.Approximated(CurrentLabel, TEXT("output.blend"),
		FString::Printf(TEXT("'%s' is a material property in Unreal, not a renderer setting; ")
			TEXT("assign a material with that blend mode to the Sprite Renderer"), *Blend));
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

FString FVfxNiagaraBuilder::PathCurveJson(const TArray<FVector3f>& Path)
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
		const float T = Total > KINDA_SMALL_NUMBER ? Walked / Total
			: static_cast<float>(i) / FMath::Max(1, Path.Num() - 1);
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

FString FVfxNiagaraBuilder::PathTangentCurveJson(const TArray<FVector3f>& Path)
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
		const float T = Total > KINDA_SMALL_NUMBER ? Walked / Total
			: static_cast<float>(i) / FMath::Max(1, Path.Num() - 1);

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
