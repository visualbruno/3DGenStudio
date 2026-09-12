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
			// Importing the bundle's PNGs and GLBs the way a drag-and-drop
			// does, rather than re-implementing two importers here.
			"AssetTools",
			// A GLB import runs through Interchange, and Interchange runs
			// ASYNCHRONOUSLY - the importer has to wait for it before it can
			// point a renderer at the mesh.
			"InterchangeCore",
			"InterchangeEngine",
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
			// The menu entry and its folder picker.
			"ToolMenus",
			"DesktopPlatform",
			"Slate",
			"SlateCore",
		});
	}
}
