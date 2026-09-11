// Dump what Niagara calls things, so the mapping table can be written against
// facts instead of guesses. See the header for why this exists.
#include "VfxProbeCommandlet.h"

#include "NiagaraSystem.h"
#include "NiagaraEmitter.h"
#include "NiagaraScript.h"
#include "NiagaraExternalSystemEditorUtilities.h"

#include "NiagaraSpriteRendererProperties.h"
#include "NiagaraMeshRendererProperties.h"
#include "NiagaraRibbonRendererProperties.h"
#include "NiagaraDataInterface.h"
#include "NiagaraDataInterfaceVectorCurve.h"

DEFINE_LOG_CATEGORY_STATIC(LogVfxProbe, Log, All);

namespace
{
	// Every module the mapping intends to drive. Printed as
	//   MODULE <path>
	//     INPUT <name> : <type>
	// which is the table the builder is then written from.
	const TCHAR* ModulesToDump[] =
	{
		TEXT("/Niagara/Modules/Emitter/EmitterState.EmitterState"),
		TEXT("/Niagara/Modules/Emitter/SpawnRate.SpawnRate"),
		TEXT("/Niagara/Modules/Emitter/SpawnBurst_Instantaneous.SpawnBurst_Instantaneous"),
		TEXT("/Niagara/Modules/Spawn/Initialization/InitializeParticle.InitializeParticle"),
		TEXT("/Niagara/Modules/Spawn/Location/SphereLocation.SphereLocation"),
		TEXT("/Niagara/Modules/Spawn/Location/BoxLocation.BoxLocation"),
		TEXT("/Niagara/Modules/Spawn/Location/ConeLocation.ConeLocation"),
		TEXT("/Niagara/Modules/Spawn/Location/CylinderLocation.CylinderLocation"),
		TEXT("/Niagara/Modules/Spawn/Location/TorusLocation.TorusLocation"),
		TEXT("/Niagara/Modules/Spawn/Location/StaticMeshLocation.StaticMeshLocation"),
		TEXT("/Niagara/Modules/Spawn/Velocity/AddVelocity.AddVelocity"),
		TEXT("/Niagara/Modules/Spawn/Velocity/AddVelocityInCone.AddVelocityInCone"),
		TEXT("/Niagara/Modules/Spawn/Velocity/AddVelocityFromPoint.AddVelocityFromPoint"),
		TEXT("/Niagara/Modules/Update/Forces/GravityForce.GravityForce"),
		TEXT("/Niagara/Modules/Update/Forces/Drag.Drag"),
		TEXT("/Niagara/Modules/Update/Forces/CurlNoiseForce.CurlNoiseForce"),
		TEXT("/Niagara/Modules/Update/Forces/PointAttractionForce.PointAttractionForce"),
		TEXT("/Niagara/Modules/Update/Forces/VortexForce.VortexForce"),
		TEXT("/Niagara/Modules/Update/Forces/WindForce.WindForce"),
		TEXT("/Niagara/Modules/Update/Forces/LimitForce.LimitForce"),
		TEXT("/Niagara/Modules/Update/Size/ScaleSpriteSize.ScaleSpriteSize"),
		TEXT("/Niagara/Modules/Update/Color/ScaleColor.ScaleColor"),
		TEXT("/Niagara/Modules/Update/Color/Color.Color"),
		TEXT("/Niagara/Modules/Update/SubUV/SubUVAnimation.SubUVAnimation"),
		TEXT("/Niagara/Modules/Update/Position/ConstrainPositionToPlane.ConstrainPositionToPlane"),
		TEXT("/Niagara/Modules/Update/Lifetime/KillParticlesInVolume.KillParticlesInVolume"),
		TEXT("/Niagara/Modules/Solvers/SolveForcesAndVelocity.SolveForcesAndVelocity"),
	};

	// And the dynamic inputs the curve emitter needs: a vector read out of an
	// authored curve, plus the two things that can drive a position along it.
	const TCHAR* DynamicInputsToDump[] =
	{
		TEXT("/Niagara/DynamicInputs/ValueFromCurve/VectorFromCurve.VectorFromCurve"),
		TEXT("/Niagara/DynamicInputs/ValueFromCurve/FloatFromCurve.FloatFromCurve"),
		TEXT("/Niagara/DynamicInputs/ValueFromCurve/ColorFromCurve.ColorFromCurve"),
		TEXT("/Niagara/DynamicInputs/Execution/ReturnNormalizedExecIndex.ReturnNormalizedExecIndex"),
		TEXT("/Niagara/DynamicInputs/Random/FixedSeedRandomFloat.FixedSeedRandomFloat"),
		TEXT("/Niagara/DynamicInputs/UniformRange/UniformRangedFloat.UniformRangedFloat"),
		TEXT("/Niagara/DynamicInputs/UniformRange/UniformRangedVector.UniformRangedVector"),
	};

	void DumpInputs(const TArray<FNiagaraExt_StackInputSchema>& Inputs)
	{
		for (const FNiagaraExt_StackInputSchema& Input : Inputs)
		{
			UE_LOG(LogVfxProbe, Display, TEXT("    INPUT %s : %s%s%s"),
				*Input.Name.ToString(),
				*Input.Type.GetName(),
				Input.bSupportsExpressions ? TEXT(" [expr]") : TEXT(""),
				TEXT(""));
		}
	}

	void DumpModule(const TCHAR* Path, bool bDynamicInput)
	{
		UNiagaraScript* Script = LoadObject<UNiagaraScript>(nullptr, Path);
		if (Script == nullptr)
		{
			UE_LOG(LogVfxProbe, Warning, TEXT("  MODULE %s : NOT FOUND"), Path);
			return;
		}
		UE_LOG(LogVfxProbe, Display, TEXT("  MODULE %s"), Path);

		FNiagaraExternalEditContext Context;
		if (bDynamicInput)
		{
			FNiagaraExt_DynamicInputSchema Schema;
			UNiagaraExternalEditUtilities::GetDynamicInputSchema(Script, Schema, Context);
			DumpInputs(Schema.Inputs);
			for (const FNiagaraExt_Variable& Output : Schema.Outputs)
			{
				UE_LOG(LogVfxProbe, Display, TEXT("    OUTPUT %s : %s"),
					*Output.Name.ToString(), *Output.Type.GetName());
			}
		}
		else
		{
			FNiagaraExt_ModuleSchema Schema;
			UNiagaraExternalEditUtilities::GetModuleSchema(Script, Schema, Context);
			DumpInputs(Schema.Inputs);
		}
		for (const FText& Error : Context.Errors)
		{
			UE_LOG(LogVfxProbe, Warning, TEXT("    schemaError %s"), *Error.ToString());
		}
	}

	void DumpTopology(const FNiagaraExt_ScriptStackTopology& Stack)
	{
		UE_LOG(LogVfxProbe, Display, TEXT("  SCRIPT %s"), *Stack.ScriptName.ToString());
		for (const FNiagaraExt_ModuleTopology& Module : Stack.Modules)
		{
			UE_LOG(LogVfxProbe, Display, TEXT("    STACKMODULE %s  asset=%s setParams=%d"),
				*Module.ModuleName.ToString(),
				Module.ModuleScript ? *Module.ModuleScript->GetPathName() : TEXT("none"),
				Module.bIsSetParametersModule ? 1 : 0);
			for (const FNiagaraExt_StackInputTopology& Input : Module.Inputs)
			{
				UE_LOG(LogVfxProbe, Display, TEXT("      IN %s : %s%s%s"),
					*Input.Name.ToString(), *Input.Type.GetName(),
					Input.bIsDynamic ? TEXT(" [dynamic]") : TEXT(""),
					Input.bIsVisible ? TEXT("") : TEXT(" [hidden]"));
			}
		}
	}
}

int32 UVfxProbeCommandlet::Main(const FString& Params)
{
	TArray<FString> Tokens;
	TArray<FString> Switches;
	TMap<FString, FString> Arguments;
	ParseCommandLine(*Params, Tokens, Switches, Arguments);

	// THE ENUM ENTRY NAMES, which are what a static switch is actually set to.
	// Every shape, lifetime mode and colour mode in the mapping goes through one
	// of these, and an entry name that does not exist is accepted silently -
	// the input keeps its default and the effect imports looking almost right.
	const TCHAR* EnumsToDump[] =
	{
		TEXT("/Niagara/Enums/Location/ENiagara_LocationShapes.ENiagara_LocationShapes"),
		TEXT("/Niagara/Enums/Location/ENiagara_BoxPlaneMode.ENiagara_BoxPlaneMode"),
		TEXT("/Niagara/Enums/Location/ENiagara_ConeMode.ENiagara_ConeMode"),
		TEXT("/Niagara/Enums/Location/ENiagaraRingDiscMode.ENiagaraRingDiscMode"),
		TEXT("/Niagara/Enums/ENiagara_LifetimeMode.ENiagara_LifetimeMode"),
		TEXT("/Niagara/Enums/ENiagara_ColorInitializationMode.ENiagara_ColorInitializationMode"),
		TEXT("/Niagara/Enums/ENiagara_PositionInitializationMode.ENiagara_PositionInitializationMode"),
		TEXT("/Niagara/Enums/ENiagara_SizeScaleMode.ENiagara_SizeScaleMode"),
		TEXT("/Niagara/Enums/ENiagara_SpriteRotationMode.ENiagara_SpriteRotationMode"),
		TEXT("/Niagara/Enums/ENiagara_MassInitializationMode.ENiagara_MassInitializationMode"),
		TEXT("/Niagara/Enums/ENiagaraScaleColorMode.ENiagaraScaleColorMode"),
		TEXT("/Niagara/Enums/ENiagaraEmitterLifeCycleMode.ENiagaraEmitterLifeCycleMode"),
		TEXT("/Niagara/Enums/ENiagara_EmitterStateOptions.ENiagara_EmitterStateOptions"),
		TEXT("/Niagara/Enums/ENiagaraCoordinateSpace.ENiagaraCoordinateSpace"),
		TEXT("/Niagara/Enums/ENiagaraSphereDistributionMode.ENiagaraSphereDistributionMode"),
		TEXT("/Niagara/Enums/ENiagara_AttributeSamplingApplyOutput.ENiagara_AttributeSamplingApplyOutput"),
		TEXT("/Niagara/Enums/ENiagara_SizeScaleMode.ENiagara_SizeScaleMode"),
	};

	UE_LOG(LogVfxProbe, Display, TEXT("======== ENUMS ========"));
	for (const TCHAR* Path : EnumsToDump)
	{
		UEnum* Enum = LoadObject<UEnum>(nullptr, Path);
		if (Enum == nullptr)
		{
			UE_LOG(LogVfxProbe, Warning, TEXT("  ENUM %s : NOT FOUND"), Path);
			continue;
		}
		UE_LOG(LogVfxProbe, Display, TEXT("  ENUM %s"), Path);
		for (int32 i = 0; i < Enum->NumEnums() - 1; ++i)
		{
			UE_LOG(LogVfxProbe, Display, TEXT("    ENTRY %s = %s"),
				*Enum->GetNameStringByIndex(i),
				*Enum->GetDisplayNameTextByIndex(i).ToString());
		}
	}

	// VERIFY MODE: -system=/Game/ImportedVfx/Magic_Bolt
	//
	// READS THE ASSET BACK OFF DISK, under a context that never saw the import.
	// The importer reporting "no errors" and the asset actually containing a
	// four-key vector curve are different claims, and only the second one is
	// what an author opens. Everything here is printed from the reloaded object.
	if (Arguments.Contains(TEXT("system")))
	{
		const FString Path = Arguments[TEXT("system")];
		const FString ObjectPath = Path + TEXT(".") + FPaths::GetCleanFilename(Path);
		UNiagaraSystem* Loaded = LoadObject<UNiagaraSystem>(nullptr, *ObjectPath);
		if (Loaded == nullptr)
		{
			UE_LOG(LogVfxProbe, Error, TEXT("VERIFY could not load %s"), *ObjectPath);
			return 1;
		}

		FNiagaraExternalEditContext Verify(Loaded);
		FNiagaraExt_SystemSummary Summary;
		UNiagaraExternalEditUtilities::GetSystemSummary(Loaded, Summary, Verify);
		UE_LOG(LogVfxProbe, Display, TEXT("VERIFY %s emitters=%d"),
			*ObjectPath, Summary.Emitters.Num());

		for (const FNiagaraExt_EmitterSummary& Emitter : Summary.Emitters)
		{
			UE_LOG(LogVfxProbe, Display, TEXT("VERIFY emitter %s enabled=%d renderers=%d"),
				*Emitter.EmitterName.ToString(), Emitter.bEnabled ? 1 : 0,
				Emitter.RendererClasses.Num());

			FNiagaraExt_StackItemReference EmitterRef(Loaded, Emitter.EmitterName);
			FNiagaraExt_EmitterTopology Topology;
			Verify.Errors.Reset();
			UNiagaraExternalEditUtilities::GetEmitterTopology(EmitterRef, Topology, Verify);

			const FNiagaraExt_ScriptStackTopology* Stacks[] = {
				&Topology.EmitterUpdateScript, &Topology.ParticleSpawnScript,
				&Topology.ParticleUpdateScript };
			for (const FNiagaraExt_ScriptStackTopology* Stack : Stacks)
			{
				for (const FNiagaraExt_ModuleTopology& Module : Stack->Modules)
				{
					UE_LOG(LogVfxProbe, Display, TEXT("VERIFY   %s / %s"),
						*Stack->ScriptName.ToString(), *Module.ModuleName.ToString());

					for (const FNiagaraExt_StackInputTopology& Input : Module.Inputs)
					{
						if (!Input.bIsVisible) { continue; }
						FNiagaraExt_StackItemReference InputRef(Loaded, Emitter.EmitterName,
							Stack->ScriptName, Module.ModuleName);
						InputRef.InputNameStack = { Input.Name };
						FNiagaraExt_StackInputValue Value;
						Verify.Errors.Reset();
						UNiagaraExternalEditUtilities::GetStackInputData(InputRef, Value, Verify);

						FString Shown;
						if (const FNiagaraExt_StackInputData_DataInterface* Di =
							Value.GetPtr<FNiagaraExt_StackInputData_DataInterface>())
						{
							// The whole point of the exercise: what the curve
							// actually holds, not that something was assigned.
							Shown = FString::Printf(TEXT("DATAINTERFACE %s"),
								*Di->PropertyValues.Replace(TEXT("\n"), TEXT(" "))
									.Replace(TEXT("\t"), TEXT("")));
						}
						else if (const FNiagaraExt_StackInputData_DynamicInput* Dyn =
							Value.GetPtr<FNiagaraExt_StackInputData_DynamicInput>())
						{
							Shown = FString::Printf(TEXT("DYNAMIC %s"),
								Dyn->DynamicInputAsset ? *Dyn->DynamicInputAsset->GetName()
									: TEXT("none"));

							// AND WHAT IS INSIDE IT. "Position is a Vector From
							// Curve" is not the claim being checked - the claim
							// is that the curve holds the author's four points,
							// and only the chain shows that.
							FNiagaraExt_DynamicInputChainRef Chain;
							Verify.Errors.Reset();
							UNiagaraExternalEditUtilities::GetDynamicInputChain(
								InputRef, Chain, Verify);
							for (const FNiagaraExt_DynamicInputChainRef& SubRef
								: Chain.Get().Inputs)
							{
								const FNiagaraExt_DynamicInputChain& Sub = SubRef.Get();
								FString SubShown;
								if (const FNiagaraExt_StackInputData_DataInterface* SubDi =
									Sub.Value.GetPtr<FNiagaraExt_StackInputData_DataInterface>())
								{
									SubShown = SubDi->PropertyValues
										.Replace(TEXT("\r"), TEXT(""))
										.Replace(TEXT("\n"), TEXT(""))
										.Replace(TEXT("\t"), TEXT(""))
										.Replace(TEXT(" "), TEXT(""));
								}
								else if (const FNiagaraExt_StackInputData_DynamicInput* SubDyn =
									Sub.Value.GetPtr<FNiagaraExt_StackInputData_DynamicInput>())
								{
									SubShown = FString::Printf(TEXT("DYNAMIC %s"),
										SubDyn->DynamicInputAsset
											? *SubDyn->DynamicInputAsset->GetName() : TEXT("none"));
								}
								else if (Sub.Value.GetScriptStruct()
									== TVariantStructure<FVector3f>::Get())
								{
									const FVector3f* SubVec = reinterpret_cast<const FVector3f*>(
										Sub.Value.GetMemory());
									SubShown = FString::Printf(TEXT("vec %.1f %.1f %.1f"),
										SubVec->X, SubVec->Y, SubVec->Z);
								}
								else if (const FNiagaraFloat* SubNum =
									Sub.Value.GetPtr<FNiagaraFloat>())
								{
									SubShown = FString::Printf(TEXT("%.4f"), SubNum->Value);
								}
								else { continue; }
								UE_LOG(LogVfxProbe, Display, TEXT("VERIFY       . %-18s = %s"),
									*Sub.Name.ToString(), *SubShown);
							}
						}
						else if (const FNiagaraExt_StackInputData_Enum* Enum =
							Value.GetPtr<FNiagaraExt_StackInputData_Enum>())
						{
							Shown = FString::Printf(TEXT("ENUM %s (%s)"),
								*Enum->EnumName.ToString(), *Enum->DisplayName.ToString());
						}
						else if (const FNiagaraFloat* Number = Value.GetPtr<FNiagaraFloat>())
						{
							Shown = FString::Printf(TEXT("%.4f"), Number->Value);
						}
						else if (const FLinearColor* Colour = Value.GetPtr<FLinearColor>())
						{
							Shown = FString::Printf(TEXT("rgba %.3f %.3f %.3f %.3f"),
								Colour->R, Colour->G, Colour->B, Colour->A);
						}
						else if (Value.GetScriptStruct() == TVariantStructure<FVector3f>::Get())
						{
							// A variant core type, so GetPtr<FVector3f> does not
							// compile - there is no TBaseStructure for it.
							const FVector3f* Vector = reinterpret_cast<const FVector3f*>(
								Value.GetMemory());
							Shown = FString::Printf(TEXT("vec %.2f %.2f %.2f"),
								Vector->X, Vector->Y, Vector->Z);
						}
						else if (Value.GetScriptStruct() != nullptr)
						{
							Shown = Value.GetScriptStruct()->GetName();
						}
						else
						{
							continue;
						}
						UE_LOG(LogVfxProbe, Display, TEXT("VERIFY     %-30s = %s"),
							*Input.Name.ToString(), *Shown);
					}
				}
			}
		}
		UE_LOG(LogVfxProbe, Display, TEXT("VERIFY DONE"));
		return 0;
	}

	UE_LOG(LogVfxProbe, Display, TEXT("======== MODULE SCHEMAS ========"));
	for (const TCHAR* Path : ModulesToDump)
	{
		DumpModule(Path, /*bDynamicInput*/ false);
	}

	UE_LOG(LogVfxProbe, Display, TEXT("======== DYNAMIC INPUT SCHEMAS ========"));
	for (const TCHAR* Path : DynamicInputsToDump)
	{
		DumpModule(Path, /*bDynamicInput*/ true);
	}

	// WHAT A TEMPLATE STARTS WITH. The builder adds an emitter from one of
	// these and then edits it, so which modules are already present - and under
	// exactly which names - decides whether a mapping ADDS a module or SETS an
	// input on one that is already there. Getting this wrong produces an
	// emitter with two Initialize Particle modules, which behaves like neither.
	const TCHAR* TemplatesToDump[] =
	{
		TEXT("/Niagara/DefaultAssets/Templates/Emitters/Minimal.Minimal"),
		TEXT("/Niagara/DefaultAssets/Templates/Emitters/Fountain.Fountain"),
	};

	UE_LOG(LogVfxProbe, Display, TEXT("======== EMITTER TEMPLATES ========"));
	FNiagaraExternalEditContext CreateContext;
	UNiagaraSystem* System = UNiagaraExternalEditUtilities::CreateNiagaraSystem(
		TEXT("VfxSchemaProbe"), TEXT("/Game/VfxProbe"), nullptr, CreateContext);
	if (System == nullptr)
	{
		UE_LOG(LogVfxProbe, Error, TEXT("could not create a scratch system"));
		return 1;
	}

	FNiagaraExternalEditContext Context(System);
	int32 Index = 0;
	for (const TCHAR* TemplatePath : TemplatesToDump)
	{
		UNiagaraEmitter* Template = LoadObject<UNiagaraEmitter>(nullptr, TemplatePath);
		if (Template == nullptr)
		{
			UE_LOG(LogVfxProbe, Warning, TEXT("TEMPLATE %s : NOT FOUND"), TemplatePath);
			continue;
		}
		const FName EmitterName(*FString::Printf(TEXT("Probe%d"), Index++));
		Context.Errors.Reset();
		FNiagaraExt_EmitterTopology Topology;
		UNiagaraExternalEditUtilities::AddEmitter(Template, EmitterName, Topology, Context);
		for (const FText& Error : Context.Errors)
		{
			UE_LOG(LogVfxProbe, Warning, TEXT("  addEmitterError %s"), *Error.ToString());
		}

		UE_LOG(LogVfxProbe, Display, TEXT("TEMPLATE %s  as %s  renderers=%d"),
			TemplatePath, *Topology.EmitterName.ToString(), Topology.Renderers.Num());
		DumpTopology(Topology.EmitterSpawnScript);
		DumpTopology(Topology.EmitterUpdateScript);
		DumpTopology(Topology.ParticleSpawnScript);
		DumpTopology(Topology.ParticleUpdateScript);
	}

	// The renderer property sets, so the output mapping knows what it can set.
	UE_LOG(LogVfxProbe, Display, TEXT("======== RENDERER SCHEMAS ========"));
	const TSubclassOf<UNiagaraRendererProperties> RendererClasses[] =
	{
		UNiagaraSpriteRendererProperties::StaticClass(),
		UNiagaraMeshRendererProperties::StaticClass(),
		UNiagaraRibbonRendererProperties::StaticClass(),
	};
	for (const TSubclassOf<UNiagaraRendererProperties>& Class : RendererClasses)
	{
		FNiagaraExt_RendererSchema Schema;
		UNiagaraExternalEditUtilities::GetRendererSchema(Class, Schema);
		UE_LOG(LogVfxProbe, Display, TEXT("  RENDERER %s schema=%d chars"),
			*Class->GetName(), Schema.PropertySchema.Len());
		UE_LOG(LogVfxProbe, Display, TEXT("%s"), *Schema.PropertySchema);
	}

	// THE CURVE DATA INTERFACES, whose property JSON is how an authored path and
	// an authored colour ramp get INTO the asset. The shape of that JSON is the
	// one thing in this mapping that cannot be guessed: SetStackInputData takes
	// a string, and a key that does not match the schema is dropped without a
	// word, leaving a default curve and an effect that is subtly wrong.
	UE_LOG(LogVfxProbe, Display, TEXT("======== DATA INTERFACE SCHEMAS ========"));
	const TCHAR* DataInterfaceClasses[] =
	{
		TEXT("/Script/Niagara.NiagaraDataInterfaceVectorCurve"),
		TEXT("/Script/Niagara.NiagaraDataInterfaceCurve"),
		TEXT("/Script/Niagara.NiagaraDataInterfaceColorCurve"),
	};
	for (const TCHAR* ClassPath : DataInterfaceClasses)
	{
		UClass* Class = LoadObject<UClass>(nullptr, ClassPath);
		if (Class == nullptr)
		{
			UE_LOG(LogVfxProbe, Warning, TEXT("  DI %s : NOT FOUND"), ClassPath);
			continue;
		}
		FNiagaraExt_DataInterfaceSchema Schema;
		UNiagaraExternalEditUtilities::GetDataInterfaceSchema(Class, Schema);
		UE_LOG(LogVfxProbe, Display, TEXT("  DI %s"), ClassPath);
		UE_LOG(LogVfxProbe, Display, TEXT("%s"), *Schema.PropertySchema);

		// AND WHAT A DEFAULT ONE SERIALISES TO, which is the far more useful
		// half: the schema says what the keys are called, an actual instance
		// says what a value looks like in practice.
		UNiagaraDataInterface* Instance = NewObject<UNiagaraDataInterface>(GetTransientPackage(), Class);
		const FString Json = UNiagaraExternalEditUtilities::GetPropertyProvider()
			.GetObjectProperties(Instance, TArray<FName>());
		UE_LOG(LogVfxProbe, Display, TEXT("  DEFAULT %s"), *Json);
	}

	// A ROUND TRIP, which is the only version of this question worth asking. The
	// schema names the properties but describes a curve key as an empty object,
	// so the exact spelling of a key entry is unknown until a real one with real
	// keys is serialised back out. This prints the literal JSON the importer has
	// to produce.
	{
		UNiagaraDataInterfaceVectorCurve* Curve = NewObject<UNiagaraDataInterfaceVectorCurve>(
			GetTransientPackage());
		auto Fill = [](FRichCurve& Target, float A, float B)
		{
			FKeyHandle First = Target.AddKey(0.f, A);
			Target.SetKeyInterpMode(First, RCIM_Cubic);
			Target.SetKeyTangentMode(First, RCTM_Auto);
			FKeyHandle Last = Target.AddKey(1.f, B);
			Target.SetKeyInterpMode(Last, RCIM_Cubic);
			Target.SetKeyTangentMode(Last, RCTM_Auto);
		};
		Fill(Curve->XCurve, -1.f, 1.f);
		Fill(Curve->YCurve, 0.f, 2.f);
		Fill(Curve->ZCurve, 0.5f, -0.5f);
		// NAMED EXPLICITLY. An empty name list returns an empty object rather
		// than everything, which is the opposite of the obvious reading.
		const TArray<FName> Names = { TEXT("xCurve"), TEXT("yCurve"), TEXT("zCurve") };
		const FString Json = UNiagaraExternalEditUtilities::GetPropertyProvider()
			.GetObjectProperties(Curve, Names);
		UE_LOG(LogVfxProbe, Display, TEXT("======== VECTOR CURVE ROUND TRIP ========"));
		UE_LOG(LogVfxProbe, Display, TEXT("%s"), *Json);
	}

	// DOES SETTING A STATIC SWITCH ACTUALLY REVEAL WHAT IT GOVERNS? The importer
	// sets "Lifetime Mode" to Random and is then refused on "Lifetime Min" as
	// hidden - so either the switch write is silently dropped, or the stack's
	// visibility is cached and has to be re-resolved. This tells them apart.
	{
		UE_LOG(LogVfxProbe, Display, TEXT("======== STATIC SWITCH BEHAVIOUR ========"));
		UNiagaraEmitter* Template = LoadObject<UNiagaraEmitter>(nullptr,
			TEXT("/Niagara/DefaultAssets/Templates/Emitters/Minimal.Minimal"));
		FNiagaraExt_EmitterTopology Topology;
		UNiagaraExternalEditUtilities::AddEmitter(Template, FName(TEXT("SwitchProbe")),
			Topology, Context);

		const FName Emitter = Topology.EmitterName;
		const FName Script(TEXT("ParticleSpawnScript"));
		const FName Module(TEXT("InitializeParticle"));

		auto ShowVisibility = [&](const TCHAR* When)
		{
			FNiagaraExt_StackItemReference ModuleRef(System, Emitter, Script, Module);
			FNiagaraExt_ModuleTopology Mod;
			Context.Errors.Reset();
			UNiagaraExternalEditUtilities::GetModuleTopology(ModuleRef, Mod, Context);
			for (const FNiagaraExt_StackInputTopology& Input : Mod.Inputs)
			{
				const FString Name = Input.Name.ToString();
				if (Name.StartsWith(TEXT("Lifetime")))
				{
					UE_LOG(LogVfxProbe, Display, TEXT("  %s  %-22s visible=%d editable=%d switch=%d"),
						When, *Name, Input.bIsVisible ? 1 : 0, Input.bIsEditable ? 1 : 0,
						Input.bIsStaticSwitch ? 1 : 0);
				}
			}
		};

		ShowVisibility(TEXT("before"));

		UEnum* Enum = LoadObject<UEnum>(nullptr,
			TEXT("/Niagara/Enums/ENiagara_LifetimeMode.ENiagara_LifetimeMode"));
		for (int32 i = 0; Enum && i < Enum->NumEnums() - 1; ++i)
		{
			UE_LOG(LogVfxProbe, Display, TEXT("  entry short=%s full=%s display=%s"),
				*Enum->GetNameStringByIndex(i), *Enum->GetNameByIndex(i).ToString(),
				*Enum->GetDisplayNameTextByIndex(i).ToString());
		}

		// Write it, and say exactly what came back.
		FNiagaraExt_StackItemReference InputRef(System, Emitter, Script, Module);
		InputRef.InputNameStack = { FName(TEXT("Lifetime Mode")) };
		FNiagaraExt_StackInputData_Enum Payload;
		Payload.Enum = Enum;
		Payload.EnumName = Enum ? Enum->GetNameByIndex(1) : NAME_None;
		FNiagaraExt_StackInputValue Wrapped;
		static_cast<FInstancedStruct&>(Wrapped) = FInstancedStruct::Make(Payload);
		Context.Errors.Reset();
		UNiagaraExternalEditUtilities::SetStackInputData(InputRef, Wrapped, Context);
		UE_LOG(LogVfxProbe, Display, TEXT("  setSwitch errors=%d"), Context.Errors.Num());
		for (const FText& Error : Context.Errors)
		{
			UE_LOG(LogVfxProbe, Warning, TEXT("  setSwitchError %s"), *Error.ToString());
		}

		// And read it back: "no errors" and "it took" are different claims.
		FNiagaraExt_StackInputValue ReadBack;
		Context.Errors.Reset();
		UNiagaraExternalEditUtilities::GetStackInputData(InputRef, ReadBack, Context);
		UE_LOG(LogVfxProbe, Display, TEXT("  readBack type=%s"),
			ReadBack.GetScriptStruct() ? *ReadBack.GetScriptStruct()->GetName() : TEXT("none"));
		if (const FNiagaraExt_StackInputData_Enum* Got =
			ReadBack.GetPtr<FNiagaraExt_StackInputData_Enum>())
		{
			UE_LOG(LogVfxProbe, Display, TEXT("  readBack enumName=%s"), *Got->EnumName.ToString());
		}

		ShowVisibility(TEXT("after "));

		// The write took - the read-back proves it - so the stale part is the
		// stack's cached visibility. Two candidates for shaking it loose.
		System->WaitForCompilationComplete();
		ShowVisibility(TEXT("waited"));

		{
			FNiagaraExternalEditContext Fresh(System);
			FNiagaraExt_StackItemReference ModuleRef(System, Emitter, Script, Module);
			FNiagaraExt_ModuleTopology Mod;
			UNiagaraExternalEditUtilities::GetModuleTopology(ModuleRef, Mod, Fresh);
			for (const FNiagaraExt_StackInputTopology& Input : Mod.Inputs)
			{
				const FString Name = Input.Name.ToString();
				if (Name.StartsWith(TEXT("Lifetime")))
				{
					UE_LOG(LogVfxProbe, Display, TEXT("  fresh   %-22s visible=%d editable=%d"),
						*Name, Input.bIsVisible ? 1 : 0, Input.bIsEditable ? 1 : 0);
				}
			}

			// And can a fresh context WRITE the revealed input?
			FNiagaraExt_StackItemReference MinRef(System, Emitter, Script, Module);
			MinRef.InputNameStack = { FName(TEXT("Lifetime Min")) };
			FNiagaraFloat Value;
			Value.Value = 0.25f;
			FNiagaraExt_StackInputValue Wrapped2;
			static_cast<FInstancedStruct&>(Wrapped2) = FInstancedStruct::Make(Value);
			Fresh.Errors.Reset();
			UNiagaraExternalEditUtilities::SetStackInputData(MinRef, Wrapped2, Fresh);
			UE_LOG(LogVfxProbe, Display, TEXT("  freshWrite errors=%d"), Fresh.Errors.Num());
			for (const FText& Error : Fresh.Errors)
			{
				UE_LOG(LogVfxProbe, Warning, TEXT("  freshWriteError %s"), *Error.ToString());
			}
		}
	}

	// The modules the importer adds, dumped AS THEY APPEAR IN A STACK rather
	// than as a bare asset schema - the two differ, because a stack instance
	// carries the static switches that the schema view does not show.
	{
		UE_LOG(LogVfxProbe, Display, TEXT("======== ADDED MODULE STACK INPUTS ========"));
		UNiagaraEmitter* Template = LoadObject<UNiagaraEmitter>(nullptr,
			TEXT("/Niagara/DefaultAssets/Templates/Emitters/Minimal.Minimal"));
		FNiagaraExt_EmitterTopology Topology;
		UNiagaraExternalEditUtilities::AddEmitter(Template, FName(TEXT("StackProbe")),
			Topology, Context);
		const FName Emitter = Topology.EmitterName;

		const TCHAR* Wanted[] =
		{
			TEXT("/Niagara/Modules/Update/Size/ScaleSpriteSize.ScaleSpriteSize"),
			TEXT("/Niagara/Modules/Spawn/Velocity/AddVelocity.AddVelocity"),
		};
		for (const TCHAR* Path : Wanted)
		{
			UNiagaraScript* Script = LoadObject<UNiagaraScript>(nullptr, Path);
			if (Script == nullptr) { continue; }
			FNiagaraExt_StackItemReference Location(System, Emitter,
				FName(TEXT("ParticleUpdateScript")));
			FNiagaraExt_ModuleTopology Added;
			Context.Errors.Reset();
			UNiagaraExternalEditUtilities::AddModule(Location, Script, Added, Context);
			UE_LOG(LogVfxProbe, Display, TEXT("  ADDED %s as %s"), Path, *Added.ModuleName.ToString());
			for (const FNiagaraExt_StackInputTopology& Input : Added.Inputs)
			{
				UE_LOG(LogVfxProbe, Display, TEXT("    IN %-34s : %-24s vis=%d edit=%d switch=%d"),
					*Input.Name.ToString(), *Input.Type.GetName(),
					Input.bIsVisible ? 1 : 0, Input.bIsEditable ? 1 : 0,
					Input.bIsStaticSwitch ? 1 : 0);
			}
		}
	}

	UE_LOG(LogVfxProbe, Display, TEXT("PROBE DONE"));
	return 0;
}
