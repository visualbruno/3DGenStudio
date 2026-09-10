using UnrealBuildTool;

public class VfxImportEditor : ModuleRules
{
	public VfxImportEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			// Json is in the engine, so the bundle's manifest needs no
			// hand-rolled parser here - unlike the Unity side, where nothing
			// in the project could read JSON without one.
			"Json",
			"JsonUtilities",
			"UnrealEd",
			"AssetRegistry",
			"Projects",
			"Niagara",
			// THE MODULE THAT MATTERS. UNiagaraExternalEditUtilities lives here
			// and is C++ only - its header carries no UFUNCTION macros, so
			// Python and Blueprint cannot reach it despite the class deriving
			// from UBlueprintFunctionLibrary and its comment claiming
			// otherwise. Linking against this module is the whole reason this
			// plugin is C++ rather than a Python script.
			"NiagaraEditor",
		});
	}
}
